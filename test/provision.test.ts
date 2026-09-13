import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { provisionElevenLabsAgent, toElevenLabsParameters } from "../src/server/provision.js";
import { TOOL_DEFINITIONS, type VoiceToolDefinition } from "../src/shared/tools.js";

const TOOLS: readonly VoiceToolDefinition[] = TOOL_DEFINITIONS;

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

test("ElevenLabs parameter conversion gives every literal an LLM-provided description", () => {
  assert.deepEqual(
    toElevenLabsParameters({
      type: "object",
      properties: {
        count: { type: "integer" },
        values: { type: "array", items: { type: "string" } },
      },
    }),
    {
      type: "object",
      properties: {
        count: { type: "integer", description: "Value for count." },
        values: {
          type: "array",
          items: { type: "string", description: "Value for values item." },
        },
      },
    },
  );
});

test("the expanded direct surface excludes destructive and administrative Herdr methods", () => {
  const mappedMethods: string[] = TOOL_DEFINITIONS.flatMap((tool) => {
    if (tool.socketMapping === null) return [];
    return typeof tool.socketMapping === "string" ? [tool.socketMapping] : [...tool.socketMapping];
  });
  const forbidden = [
    "server.stop",
    "server.live_handoff",
    "server.reload_config",
    "server.reload_agent_manifests",
    "worktree.remove",
    "layout.apply",
    "plugin.action.invoke",
    "plugin.link",
    "plugin.unlink",
    "plugin.enable",
    "plugin.disable",
    "plugin.pane.open",
    "plugin.pane.close",
    "integration.install",
    "integration.uninstall",
    "pane.send_text",
    "agent.send_keys",
    "pane.clear_agent_authority",
    "pane.release_agent",
    "pane.report_agent",
    "pane.report_agent_session",
    "pane.report_metadata",
    "workspace.report_metadata",
    "pane.graphics.set",
    "pane.graphics.clear",
  ];
  forbidden.forEach((method) => assert.equal(mappedMethods.includes(method), false, method));
});

test("provisioning creates private client tools and the exact configured agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-provision-"));
  const promptPath = join(directory, "prompt.md");
  await writeFile(promptPath, "You manage Herdr safely.\n", "utf8");
  const requests: RecordedRequest[] = [];
  let toolNumber = 0;

  const result = await provisionElevenLabsAgent({
    apiKey: "server-only-secret",
    pluginVersion: "0.1.0",
    promptPath,
    stateDirectory: directory,
    voiceId: "voice_override",
    fetch: fakeElevenLabs(requests, () => `tool_${++toolNumber}`),
  });

  assert.equal(result.agentId, "agent_created");
  assert.equal(requests.length, TOOL_DEFINITIONS.length + 1);
  for (const [index, definition] of TOOLS.entries()) {
    const request = requests[index];
    assert.equal(request?.url, "https://api.elevenlabs.io/v1/convai/tools");
    assert.equal(request?.method, "POST");
    assert.equal(request?.headers.get("xi-api-key"), "server-only-secret");
    assert.deepEqual(request?.body, {
      tool_config: {
        type: "client",
        name: definition.name,
        description: definition.description,
        parameters: toElevenLabsParameters(definition.parameters),
        expects_response: true,
        ...(definition.responseTimeoutSeconds
          ? { response_timeout_secs: definition.responseTimeoutSeconds }
          : {}),
      },
    });
  }
  assert.equal(JSON.stringify(requests.slice(0, -1).map((request) => request.body)).includes("additionalProperties"), false);
  assert.equal(JSON.stringify(requests.slice(0, -1).map((request) => request.body)).includes('"default"'), false);

  const agentRequest = requests.at(-1);
  assert.equal(agentRequest?.url, "https://api.elevenlabs.io/v1/convai/agents/create");
  assert.equal(agentRequest?.method, "POST");
  assert.deepEqual(agentRequest?.body, {
    name: "herdr-voice",
    conversation_config: {
      agent: {
        first_message: "Hey there — what would you like to do in Herdr?",
        language: "en",
        prompt: {
          prompt: "You manage Herdr safely.\n",
          llm: "qwen35-397b-a17b",
          tool_ids: TOOL_DEFINITIONS.map((_, index) => `tool_${index + 1}`),
        },
      },
      tts: { voice_id: "voice_override" },
    },
    platform_settings: { auth: { enable_auth: true } },
  });
  assert.doesNotMatch(JSON.stringify(requests.map((request) => request.body)), /server-only-secret/);

  const state = JSON.parse(await readFile(join(directory, "provisioning.json"), "utf8")) as {
    agentId: string;
    stamp: string;
    toolIds: Record<string, string>;
  };
  assert.equal(state.agentId, "agent_created");
  assert.match(state.stamp, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(state.toolIds), TOOL_DEFINITIONS.map((tool) => tool.name));
});

test("provisioning is idempotent and patches owned resources when its stamp changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-provision-"));
  const promptPath = join(directory, "prompt.md");
  await writeFile(promptPath, "Prompt one.\n", "utf8");
  const requests: RecordedRequest[] = [];
  let toolNumber = 0;
  const fetch = fakeElevenLabs(requests, () => `tool_${++toolNumber}`);
  const options = {
    apiKey: "secret",
    pluginVersion: "0.1.0",
    promptPath,
    stateDirectory: directory,
    fetch,
  };

  const first = await provisionElevenLabsAgent(options);
  assert.equal(
    JSON.stringify(requests.at(-1)?.body).includes('"voice_id":"JSWO6cw2AyFE324d5kEr"'),
    true,
  );
  requests.length = 0;
  const unchanged = await provisionElevenLabsAgent(options);
  assert.equal(unchanged.agentId, first.agentId);
  assert.equal(unchanged.stamp, first.stamp);
  assert.equal(unchanged.changed, false);
  assert.equal(requests.length, 0);

  const voiceChanged = await provisionElevenLabsAgent({ ...options, voiceId: "voice_changed" });
  assert.equal(voiceChanged.changed, true);
  assert.equal(requests.at(-1)?.method, "PATCH");
  assert.equal(JSON.stringify(requests.at(-1)?.body).includes('"voice_id":"voice_changed"'), true);

  requests.length = 0;
  await writeFile(promptPath, "Prompt two.\n", "utf8");
  const changed = await provisionElevenLabsAgent(options);
  assert.equal(changed.agentId, "agent_created");
  assert.equal(requests.length, TOOL_DEFINITIONS.length + 1);
  TOOL_DEFINITIONS.forEach((_, index) => {
    assert.equal(requests[index]?.method, "PATCH");
    assert.equal(requests[index]?.url, `https://api.elevenlabs.io/v1/convai/tools/tool_${index + 1}`);
  });
  assert.equal(requests.at(-1)?.method, "PATCH");
  assert.equal(requests.at(-1)?.url, "https://api.elevenlabs.io/v1/convai/agents/agent_created");
});

function fakeElevenLabs(
  requests: RecordedRequest[],
  nextToolId: () => string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
    });
    if (url.endsWith("/agents/create")) {
      return Response.json({ agent_id: "agent_created" });
    }
    if (url.includes("/agents/")) return Response.json({ agent_id: "agent_created" });
    if ((init?.method ?? "GET") === "POST") return Response.json({ id: nextToolId() });
    return Response.json({ id: url.split("/").at(-1) });
  };
}
