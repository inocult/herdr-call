import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";

import { CallEventHub, createCallServer, type CallServerOptions } from "../src/server/http.js";

const TOKEN = "test-auth-token";
const cleanups: Array<() => Promise<void>> = [];

/** Raw request so headers such as Host — which the fetch client may override — are sent verbatim. */
function rawRequest(
  base: string,
  options: { method?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(options.path ?? "/", base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startServer(overrides: Partial<CallServerOptions> = {}): Promise<string> {
  const server = createCallServer({
    authToken: TOKEN,
    relay: { async handle() {} },
    sessionProvider: {
      async createSession() {
        return { conversationToken: "short-lived-token", conversationId: "conversation-1" };
      },
    },
    ...overrides,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

const authHeader = { Authorization: `Bearer ${TOKEN}` };

test("POST /api/session returns only a short-lived conversation token", async () => {
  let created = 0;
  const base = await startServer({
    sessionProvider: {
      async createSession() {
        created += 1;
        return { conversationToken: "short-lived-token", conversationId: "conversation-1" };
      },
    },
  });

  const response = await fetch(`${base}/api/session`, { method: "POST", headers: authHeader });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(payload, {
    conversation_token: "short-lived-token",
    conversation_id: "conversation-1",
  });
  assert.equal(created, 1);
  assert.doesNotMatch(JSON.stringify(payload), /api[_-]?key/i);
});

test("POST /api/tool forwards one named client tool call to the relay", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const base = await startServer({
    relay: {
      async handle(name, input) {
        calls.push({ name, input });
        return { sessions: 2 };
      },
    },
  });

  const response = await fetch(`${base}/api/tool`, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "list_sessions", arguments: {} }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: { sessions: 2 } });
  assert.deepEqual(calls, [{ name: "list_sessions", input: {} }]);
});

test("API routes reject a request without the auth token", async () => {
  let handled = 0;
  const base = await startServer({
    relay: {
      async handle() {
        handled += 1;
      },
    },
  });

  const response = await fetch(`${base}/api/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "list_sessions", arguments: {} }),
  });

  assert.equal(response.status, 401);
  assert.equal(handled, 0);
});

test("API routes reject a forbidden Host header (DNS rebinding)", async () => {
  let handled = 0;
  const base = await startServer({
    relay: {
      async handle() {
        handled += 1;
      },
    },
  });

  const response = await rawRequest(base, {
    method: "POST",
    path: "/api/tool",
    headers: { ...authHeader, "Content-Type": "application/json", Host: "evil.example.com" },
  });

  assert.equal(response.status, 403);
  assert.equal(handled, 0);
});

test("POST /api/tool requires an application/json content type", async () => {
  let handled = 0;
  const base = await startServer({
    relay: {
      async handle() {
        handled += 1;
      },
    },
  });

  const response = await fetch(`${base}/api/tool`, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "text/plain" },
    body: JSON.stringify({ name: "list_sessions", arguments: {} }),
  });

  assert.equal(response.status, 415);
  assert.equal(handled, 0);
});

test("configured allowed_tailnet_users blocks an unlisted tailnet identity", async () => {
  const base = await startServer({
    tailnetUrl: "https://host.tailnet.ts.net",
    allowedTailnetUsers: ["alice@example.com"],
  });

  const blocked = await rawRequest(base, {
    method: "POST",
    path: "/api/session",
    headers: { ...authHeader, Host: "host.tailnet.ts.net", "Tailscale-User-Login": "mallory@evil.com" },
  });
  assert.equal(blocked.status, 403);

  const allowed = await rawRequest(base, {
    method: "POST",
    path: "/api/session",
    headers: { ...authHeader, Host: "host.tailnet.ts.net", "Tailscale-User-Login": "alice@example.com" },
  });
  assert.equal(allowed.status, 200);
});

test("GET /api/events flushes uncompressed server-sent events", async () => {
  const eventHub = new CallEventHub();
  const base = await startServer({ eventHub });
  const abort = new AbortController();

  const response = await fetch(`${base}/api/events`, { headers: authHeader, signal: abort.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("x-accel-buffering"), "no");

  eventHub.publish("context", { text: "The api agent is blocked." });
  const reader = response.body?.getReader();
  assert.ok(reader);
  let body = "";
  while (!body.includes("The api agent is blocked.")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    body += new TextDecoder().decode(chunk.value);
  }
  abort.abort();

  assert.match(body, /retry: 3000/);
  assert.match(body, /event: context/);
  assert.match(body, /data: \{"text":"The api agent is blocked\."\}/);
});

test("GET / serves the page with the token injected and a strict cookie", async () => {
  const { join } = await import("node:path");
  const assetsDirectory = join(process.cwd(), "src", "page");
  const base = await startServer({ assetsDirectory });

  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(`name="herdr-call-token" content="${TOKEN}"`));
  assert.doesNotMatch(html, /__HERDR_CALL_TOKEN__/);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /herdr_call_token=/);
  assert.match(cookie, /SameSite=Strict/i);
});
