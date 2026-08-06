import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TOOL_DEFINITIONS, type JsonSchema } from "../shared/tools.js";

const API_ROOT = "https://api.elevenlabs.io/v1/convai";
const STATE_FILE = "provisioning.json";

export const ELEVENLABS_AGENT_NAME = "herdr-voice";
export const ELEVENLABS_LLM = "qwen35-397b-a17b";
export const ELEVENLABS_FIRST_MESSAGE = "Hey there — what would you like to do in Herdr?";
export const DEFAULT_VOICE_ID = "JSWO6cw2AyFE324d5kEr";

interface ProvisioningState {
  stateVersion: 1;
  pluginVersion: string;
  stamp: string;
  agentId: string;
  toolIds: Record<string, string>;
}

export interface ProvisionOptions {
  apiKey: string;
  pluginVersion: string;
  promptPath: string;
  stateDirectory: string;
  voiceId?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ProvisionResult {
  agentId: string;
  stamp: string;
  changed: boolean;
}

export async function provisionElevenLabsAgent(
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const prompt = await readFile(options.promptPath, "utf8");
  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const stamp = provisioningStamp(options.pluginVersion, prompt, voiceId);
  const previous = await readState(options.stateDirectory);
  if (previous?.stamp === stamp) {
    return { agentId: previous.agentId, stamp, changed: false };
  }

  const request = createApiRequester(options.apiKey, options.fetch ?? globalThis.fetch);
  const toolIds: Record<string, string> = {};
  for (const definition of TOOL_DEFINITIONS) {
    const body = {
      tool_config: {
        type: "client",
        name: definition.name,
        description: definition.description,
        parameters: toElevenLabsParameters(definition.parameters),
        expects_response: true,
      },
    };
    const existingId = previous?.toolIds[definition.name];
    if (existingId) {
      await request(`/tools/${encodeURIComponent(existingId)}`, "PATCH", body);
      toolIds[definition.name] = existingId;
    } else {
      const response = await request("/tools", "POST", body);
      toolIds[definition.name] = requiredString(response, "id", "tool creation response");
    }
  }

  const agentBody = {
    name: ELEVENLABS_AGENT_NAME,
    conversation_config: {
      agent: {
        first_message: ELEVENLABS_FIRST_MESSAGE,
        language: "en",
        prompt: {
          prompt,
          llm: ELEVENLABS_LLM,
          tool_ids: TOOL_DEFINITIONS.map((definition) => toolIds[definition.name]),
        },
      },
      tts: { voice_id: voiceId },
    },
    platform_settings: { auth: { enable_auth: true } },
  };

  let agentId: string;
  if (previous?.agentId) {
    await request(`/agents/${encodeURIComponent(previous.agentId)}`, "PATCH", agentBody);
    agentId = previous.agentId;
  } else {
    const response = await request("/agents/create", "POST", agentBody);
    agentId = requiredString(response, "agent_id", "agent creation response");
  }

  const state: ProvisioningState = {
    stateVersion: 1,
    pluginVersion: options.pluginVersion,
    stamp,
    agentId,
    toolIds,
  };
  await writeState(options.stateDirectory, state);
  return { agentId, stamp, changed: true };
}

export async function loadProvisionedAgentId(
  stateDirectory: string,
): Promise<string | undefined> {
  return (await readState(stateDirectory))?.agentId;
}

/** Convert our standard JSON schemas to the subset accepted by current ElevenLabs client tools. */
export function toElevenLabsParameters(schema: JsonSchema): Record<string, unknown> {
  return convertSchema(schema, true, "parameters");
}

function convertSchema(schema: JsonSchema, root: boolean, label: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const type = schema.type;
  if (type === "object") {
    output.type = "object";
    const properties = isRecord(schema.properties) ? schema.properties : {};
    output.properties = Object.fromEntries(
      Object.entries(properties).map(([name, property]) => [
        name,
        convertSchema(isRecord(property) ? property : {}, false, name),
      ]),
    );
    if (Array.isArray(schema.required)) output.required = [...schema.required];
  } else if (type === "array") {
    output.type = "array";
    output.items = convertSchema(
      isRecord(schema.items) ? schema.items : { type: "string" },
      false,
      `${label} item`,
    );
  } else if (type === "string" || type === "integer" || type === "number" || type === "boolean") {
    output.type = type;
    if (Array.isArray(schema.enum)) output.enum = [...schema.enum];
    output.description =
      typeof schema.description === "string" ? schema.description : `Value for ${label}.`;
  } else if (root) {
    throw new Error("ElevenLabs tool parameters must have an object schema");
  }
  if (
    type !== "string" &&
    type !== "integer" &&
    type !== "number" &&
    type !== "boolean" &&
    typeof schema.description === "string"
  ) {
    output.description = schema.description;
  }
  return output;
}

function provisioningStamp(pluginVersion: string, prompt: string, voiceId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        pluginVersion,
        prompt,
        voiceId,
        llm: ELEVENLABS_LLM,
        firstMessage: ELEVENLABS_FIRST_MESSAGE,
        tools: TOOL_DEFINITIONS.map(({ name, description, parameters, guarded }) => ({
          name,
          description,
          parameters,
          guarded,
        })),
      }),
    )
    .digest("hex");
}

function createApiRequester(apiKey: string, fetchImplementation: typeof globalThis.fetch) {
  return async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchImplementation(`${API_ROOT}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.slice(0, 1_000).replaceAll(apiKey, "[redacted]");
      throw new Error(`ElevenLabs ${method} ${path} failed (${response.status}): ${detail}`);
    }
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error(`ElevenLabs ${method} ${path} returned invalid JSON`);
    return parsed;
  };
}

async function readState(stateDirectory: string): Promise<ProvisioningState | undefined> {
  let source: string;
  try {
    source = await readFile(join(stateDirectory, STATE_FILE), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (!isValidState(parsed)) throw new Error(`Invalid ${STATE_FILE}; remove it to reprovision`);
  return parsed;
}

async function writeState(stateDirectory: string, state: ProvisioningState): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const destination = join(stateDirectory, STATE_FILE);
  const temporary = join(stateDirectory, `.${STATE_FILE}.${process.pid}.${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || !result) throw new Error(`Missing ${key} in ${context}`);
  return result;
}

function isValidState(value: unknown): value is ProvisioningState {
  if (!isRecord(value) || value.stateVersion !== 1) return false;
  if (
    typeof value.pluginVersion !== "string" ||
    typeof value.stamp !== "string" ||
    typeof value.agentId !== "string" ||
    !isRecord(value.toolIds)
  ) {
    return false;
  }
  return Object.values(value.toolIds).every((id) => typeof id === "string" && id.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
