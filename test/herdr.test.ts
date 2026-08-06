import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { HerdrClient, HerdrRequestError } from "../src/server/herdr.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test("request sends one NDJSON request and resolves its matching response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-test-"));
  const socketPath = join(directory, "herdr.sock");
  let received = "";

  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const newline = received.indexOf("\n");
      if (newline === -1) return;

      const request = JSON.parse(received.slice(0, newline)) as { id: string };
      socket.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new HerdrClient({ socketPath });
  cleanups.push(async () => client.close());

  const result = await client.request("ping", {});

  assert.deepEqual(result, { ok: true });
  const envelope = JSON.parse(received.trim()) as Record<string, unknown>;
  assert.equal(envelope.method, "ping");
  assert.deepEqual(envelope.params, {});
  assert.match(String(envelope.id), /^herdr-call-/);
});

test("request rejects a structured Herdr error response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-test-"));
  const socketPath = join(directory, "herdr.sock");
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8")) as { id: string };
      socket.write(
        `${JSON.stringify({
          id: request.id,
          error: { code: "not_found", message: "No such workspace" },
        })}\n`,
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new HerdrClient({ socketPath });
  cleanups.push(async () => client.close());

  await assert.rejects(client.request("workspace.get", { workspace_id: "missing" }), (error) => {
    assert.ok(error instanceof HerdrRequestError);
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "No such workspace");
    return true;
  });
});

test("onEvent receives fragmented subscription events without disturbing responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-test-"));
  const socketPath = join(directory, "herdr.sock");
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8")) as { id: string };
      const event = JSON.stringify({
        event: "pane.agent_status_changed",
        data: {
          pane_id: "pane-1",
          workspace_id: "workspace-1",
          agent_status: "blocked",
        },
      });
      const response = JSON.stringify({ id: request.id, result: { type: "subscription_started" } });
      socket.write(event.slice(0, 17));
      socket.write(`${event.slice(17)}\n${response}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new HerdrClient({ socketPath });
  cleanups.push(async () => client.close());
  const events: unknown[] = [];
  const removeListener = client.onEvent((event) => events.push(event));

  const result = await client.request("events.subscribe", {
    subscriptions: [{ type: "pane.agent_status_changed", pane_id: "pane-1" }],
  });

  removeListener();
  assert.deepEqual(result, { type: "subscription_started" });
  assert.deepEqual(events, [
    {
      event: "pane.agent_status_changed",
      data: {
        pane_id: "pane-1",
        workspace_id: "workspace-1",
        agent_status: "blocked",
      },
    },
  ]);
});

test("a closed socket rejects pending requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-test-"));
  const socketPath = join(directory, "herdr.sock");
  const server = createServer((socket) => {
    socket.once("data", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new HerdrClient({ socketPath });
  cleanups.push(async () => client.close());

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("test timed out")), 100);
  });
  await assert.rejects(Promise.race([client.request("ping", {}), timeout]), {
    message: "Herdr socket closed",
  });
});

test("request rejects when Herdr does not answer before the configured timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-test-"));
  const socketPath = join(directory, "herdr.sock");
  const server = createServer((socket) => socket.resume());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new HerdrClient({ socketPath, requestTimeoutMs: 20 });
  cleanups.push(async () => client.close());

  await assert.rejects(client.request("ping", {}), {
    message: "Herdr request timed out: ping",
  });
});

test("sequential requests use separate connections because Herdr closes after each response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-test-"));
  const socketPath = join(directory, "herdr.sock");
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    const connectionNumber = connections;
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8")) as { id: string };
      socket.end(
        `${JSON.stringify({ id: request.id, result: { connection: connectionNumber } })}\n`,
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const client = new HerdrClient({ socketPath });
  cleanups.push(async () => client.close());

  assert.deepEqual(await client.request("ping", {}), { connection: 1 });
  assert.deepEqual(await client.request("workspace.list", {}), { connection: 2 });
  assert.equal(connections, 2);
});
