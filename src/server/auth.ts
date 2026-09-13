import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TAILNET_HOST_SUFFIX = ".ts.net";

export interface AuthPolicyOptions {
  token: string;
  tailnetUrl?: string;
  allowedTailnetUsers?: readonly string[];
}

export interface AuthPolicy {
  readonly token: string;
  readonly tailnetHost?: string;
  readonly allowedTailnetUsers: ReadonlySet<string>;
}

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

export function createAuthPolicy(options: AuthPolicyOptions): AuthPolicy {
  if (!options.token) throw new Error("An auth token is required");
  return {
    token: options.token,
    ...(options.tailnetUrl ? { tailnetHost: hostnameOf(options.tailnetUrl) } : {}),
    allowedTailnetUsers: new Set(
      (options.allowedTailnetUsers ?? []).map((user) => user.trim().toLowerCase()).filter(Boolean),
    ),
  };
}

/**
 * Authorize one API request. Layers, in order:
 *  1. Host allowlist — defeats DNS rebinding (a rebound request carries the attacker's Host).
 *  2. Bearer token — defeats cross-site CSRF (the token is same-origin-only, so a foreign page
 *     cannot read it to forge the header).
 *  3. Tailscale identity — when `allowed_tailnet_users` is configured, only those verified logins
 *     may drive the relay from the tailnet; local loopback callers are the operator themselves.
 */
export function authorizeRequest(policy: AuthPolicy, request: IncomingMessage): AuthResult {
  const hostCheck = authorizeHost(policy, request);
  if (!hostCheck.ok) return hostCheck;

  if (!hasValidToken(policy, request)) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  if (policy.allowedTailnetUsers.size > 0) {
    const login = headerValue(request, "tailscale-user-login")?.toLowerCase();
    const local = isLoopbackHost(requestHostname(request));
    if (login) {
      if (!policy.allowedTailnetUsers.has(login)) {
        return { ok: false, status: 403, message: "User is not allowed" };
      }
    } else if (!local) {
      return { ok: false, status: 403, message: "Tailscale identity required" };
    }
  }

  return { ok: true };
}

/** Host-only gate for routes that must load before a token exists (the page and its assets). */
export function authorizeHost(policy: AuthPolicy, request: IncomingMessage): AuthResult {
  const host = request.headers.host;
  if (!host || !isAllowedHost(policy, hostnameOf(`http://${host}`))) {
    return { ok: false, status: 403, message: "Forbidden host" };
  }
  return { ok: true };
}

function isAllowedHost(policy: AuthPolicy, hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  if (policy.tailnetHost && hostname === policy.tailnetHost) return true;
  return hostname.endsWith(TAILNET_HOST_SUFFIX);
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function hasValidToken(policy: AuthPolicy, request: IncomingMessage): boolean {
  const presented = bearerToken(request) ?? cookieToken(request);
  if (!presented) return false;
  return constantTimeEquals(presented, policy.token);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = headerValue(request, "authorization");
  if (!header) return undefined;
  const match = /^Bearer[ ]+(.+)$/u.exec(header.trim());
  return match?.[1];
}

function cookieToken(request: IncomingMessage): string | undefined {
  const cookie = headerValue(request, "cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME && rest.length > 0) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export const COOKIE_NAME = "herdr_call_token";

/** A SameSite=Strict cookie is never sent on cross-site requests, closing the CSRF path for the
 * header-less EventSource endpoint. No Secure flag so the same cookie works on loopback http. */
export function tokenCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The hostname the client addressed us by, from the Host header. Tailscale Serve rewrites this
 *  to the tailnet name, so a loopback value really does mean a caller on this machine. */
function requestHostname(request: IncomingMessage): string {
  const host = request.headers.host;
  return hostnameOf(`http://${typeof host === "string" ? host : ""}`);
}

function hostnameOf(candidate: string): string {
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return candidate.toLowerCase();
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
