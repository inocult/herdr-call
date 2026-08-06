import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveRuntimeSettings,
  ensureServe,
  parseTailnetStatus,
  type CommandRunner,
} from "../src/server/tailscale.js";

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "workstation.example-tail.ts.net.", UserID: 42 },
  User: { "42": { ID: 42, LoginName: "alice@example.com" } },
});

test("parseTailnetStatus extracts the MagicDNS hostname and the machine's own login", () => {
  assert.deepEqual(parseTailnetStatus(STATUS), {
    hostname: "workstation.example-tail.ts.net",
    selfLogin: "alice@example.com",
  });
});

test("parseTailnetStatus reports the hostname without a login for a tagged device", () => {
  const status = JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "ci-box.example-tail.ts.net.", UserID: 7 },
    User: { "7": { ID: 7, LoginName: "tagged-devices" } },
  });
  assert.deepEqual(parseTailnetStatus(status), { hostname: "ci-box.example-tail.ts.net" });
});

test("parseTailnetStatus returns undefined when the backend is not running", () => {
  const status = JSON.stringify({
    BackendState: "Stopped",
    Self: { DNSName: "workstation.example-tail.ts.net.", UserID: 42 },
  });
  assert.equal(parseTailnetStatus(status), undefined);
});

test("parseTailnetStatus returns undefined for malformed output", () => {
  assert.equal(parseTailnetStatus("not json"), undefined);
  assert.equal(parseTailnetStatus(JSON.stringify({ BackendState: "Running", Self: {} })), undefined);
});

test("discovery fills in the tailnet URL, self-only allowlist, and serve default", () => {
  const settings = deriveRuntimeSettings(
    {},
    { hostname: "workstation.example-tail.ts.net", selfLogin: "alice@example.com" },
    47_831,
  );
  assert.deepEqual(settings, {
    tailnetUrl: "https://workstation.example-tail.ts.net:47831",
    allowedTailnetUsers: ["alice@example.com"],
    shouldServe: true,
  });
});

test("explicit config values win over discovered defaults", () => {
  const settings = deriveRuntimeSettings(
    {
      tailnetUrl: "https://custom.example-tail.ts.net",
      allowedTailnetUsers: ["alice@example.com", "bob@example.com"],
    },
    { hostname: "workstation.example-tail.ts.net", selfLogin: "alice@example.com" },
    47_831,
  );
  assert.equal(settings.tailnetUrl, "https://custom.example-tail.ts.net");
  assert.deepEqual(settings.allowedTailnetUsers, ["alice@example.com", "bob@example.com"]);
});

test("auto_serve = false disables serving without losing the discovered defaults", () => {
  const settings = deriveRuntimeSettings(
    { autoServe: false },
    { hostname: "workstation.example-tail.ts.net", selfLogin: "alice@example.com" },
    47_831,
  );
  assert.equal(settings.shouldServe, false);
  assert.equal(settings.tailnetUrl, "https://workstation.example-tail.ts.net:47831");
});

test("no discovery means no exposure: no URL, no allowlist default, no serving", () => {
  assert.deepEqual(deriveRuntimeSettings({}, undefined, 47_831), { shouldServe: false });
});

test("a tagged device serves but defaults to no identity allowlist", () => {
  const settings = deriveRuntimeSettings(
    {},
    { hostname: "ci-box.example-tail.ts.net" },
    47_831,
  );
  assert.equal(settings.shouldServe, true);
  assert.equal(settings.allowedTailnetUsers, undefined);
});

test("ensureServe runs the persistent background serve for the call port", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    return { ok: true, stdout: "", stderr: "" };
  };
  const result = await ensureServe(runner, 47_831);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [["serve", "--bg", "47831"]]);
});

test("a failed serve reports the manual command instead of throwing", async () => {
  const runner: CommandRunner = async () => ({
    ok: false,
    stdout: "",
    stderr: "Access denied: serve config denied",
  });
  const result = await ensureServe(runner, 47_831);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /tailscale serve --bg 47831/u);
  assert.match((result as { message: string }).message, /Access denied: serve config denied/u);
});
