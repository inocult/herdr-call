import { execFile } from "node:child_process";

import type { PluginConfig } from "./config.js";

/** Tailnet logins that are device tags, not people; never a useful identity allowlist. */
const NON_PERSON_LOGIN = "tagged-devices";
const TAILSCALE_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

export interface TailnetDiscovery {
  hostname: string;
  selfLogin?: string;
}

export interface RuntimeSettings {
  tailnetUrl?: string;
  allowedTailnetUsers?: string[];
  shouldServe: boolean;
}

export type CommandRunner = (
  args: string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export function parseTailnetStatus(statusJson: string): TailnetDiscovery | undefined {
  let status: unknown;
  try {
    status = JSON.parse(statusJson);
  } catch {
    return undefined;
  }
  const root = asRecord(status);
  if (root.BackendState !== "Running") return undefined;
  const self = asRecord(root.Self);
  if (typeof self.DNSName !== "string" || !self.DNSName) return undefined;
  const hostname = self.DNSName.replace(/\.$/u, "");
  if (!hostname) return undefined;

  const users = asRecord(root.User);
  const owner = asRecord(users[String(self.UserID)]);
  const login = typeof owner.LoginName === "string" ? owner.LoginName : undefined;
  return login && login !== NON_PERSON_LOGIN ? { hostname, selfLogin: login } : { hostname };
}

/**
 * Exposure follows discovery, never invention: without a running tailnet there is no URL, no
 * identity default, and no serving. Explicit config always wins over a discovered default.
 */
export function deriveRuntimeSettings(
  config: Pick<PluginConfig, "tailnetUrl" | "allowedTailnetUsers" | "autoServe">,
  discovery: TailnetDiscovery | undefined,
  port: number,
): RuntimeSettings {
  const tailnetUrl = config.tailnetUrl ?? (discovery ? `https://${discovery.hostname}:${port}` : undefined);
  const allowedTailnetUsers =
    config.allowedTailnetUsers ?? (discovery?.selfLogin ? [discovery.selfLogin] : undefined);
  return {
    ...(tailnetUrl ? { tailnetUrl } : {}),
    ...(allowedTailnetUsers ? { allowedTailnetUsers } : {}),
    shouldServe: (config.autoServe ?? true) && discovery !== undefined,
  };
}

export async function discoverTailnet(runner: CommandRunner): Promise<TailnetDiscovery | undefined> {
  const result = await runner(["status", "--json"]);
  return result.ok ? parseTailnetStatus(result.stdout) : undefined;
}

/** Configure the persistent tailnet-only HTTPS mapping. Idempotent; never throws. */
export async function ensureServe(
  runner: CommandRunner,
  port: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await runner(["serve", "--bg", String(port)]);
  if (result.ok) return { ok: true };
  const reason = (result.stderr || result.stdout).trim();
  return {
    ok: false,
    message:
      `Could not configure Tailscale Serve automatically (${reason}). ` +
      `Run it manually: tailscale serve --bg ${port}`,
  };
}

/** Run the first tailscale binary that responds, remembering which one worked. */
export function createTailscaleRunner(): CommandRunner {
  let resolved: string | undefined;
  const run = (binary: string, args: string[]) =>
    new Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }>((resolve) => {
      execFile(binary, args, { timeout: 10_000 }, (error, stdout, stderr) => {
        const missing =
          error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ ok: error === null, stdout, stderr, missing });
      });
    });

  return async (args) => {
    for (const binary of resolved ? [resolved] : TAILSCALE_CANDIDATES) {
      const result = await run(binary, args);
      if (result.missing) continue;
      resolved = binary;
      return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
    }
    return { ok: false, stdout: "", stderr: "tailscale binary not found" };
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
