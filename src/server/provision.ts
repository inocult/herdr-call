import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TOOL_DEFINITIONS,
  type JsonSchema,
  type VoiceToolDefinition,
} from "../shared/tools.js";

/** `TOOL_DEFINITIONS` is `as const`, so each entry narrows to its own literal type and optional
 *  fields are absent from the ones that omit them. Read it through the interface instead. */
const TOOLS: readonly VoiceToolDefinition[] = TOOL_DEFINITIONS;

const API_ROOT = "https://api.elevenlabs.io/v1/convai";
const STATE_FILE = "provisioning.json";

export const ELEVENLABS_AGENT_NAME = "herdr-voice";
export const ELEVENLABS_LLM = "qwen35-397b-a17b";
export const DEFAULT_VOICE_ID = "JSWO6cw2AyFE324d5kEr";

/** The placeholder the prompt uses wherever it names the organisation being run. */
const BRAND_NAME_PLACEHOLDER = "__BRAND_NAME__";
const DEFAULT_BRAND_NAME = "Herdr";

/** The greeting names the ENVIRONMENT, not the product. On a fleet where four
 *  machines answer in the same voice, "what would you like to do in Studio 3?"
 *  is the only thing that tells you which desk picked up. */
export function firstMessageFor(brandName?: string): string {
  return `Hey there — what would you like to do in ${brandName?.trim() || DEFAULT_BRAND_NAME}?`;
}

/** Four environments sharing one ElevenLabs account produce four agents. They are
 *  distinguished by their own state files, so this name exists purely so the
 *  account's dashboard is readable by a human. */
export function agentNameFor(brandName?: string): string {
  const brand = brandName?.trim();
  return brand && brand !== DEFAULT_BRAND_NAME
    ? `${ELEVENLABS_AGENT_NAME} (${brand})`
    : ELEVENLABS_AGENT_NAME;
}

export const ELEVENLABS_FIRST_MESSAGE = firstMessageFor();

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
  /** This environment's name, from `brand_name`. Substituted into the prompt and
   *  the greeting so the operator speaks as this desk rather than as "Herdr". */
  brandName?: string;
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
  const brandName = options.brandName?.trim() || DEFAULT_BRAND_NAME;
  const prompt = (await readFile(options.promptPath, "utf8")).replaceAll(
    BRAND_NAME_PLACEHOLDER,
    brandName,
  );
  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const firstMessage = firstMessageFor(brandName);
  const agentName = agentNameFor(brandName);
  // The prompt is stamped AFTER substitution, so renaming an environment in
  // config.toml is a real change and re-provisions rather than going unnoticed.
  const stamp = provisioningStamp(options.pluginVersion, prompt, voiceId, firstMessage, agentName);
  const previous = await readState(options.stateDirectory);
  if (previous?.stamp === stamp) {
    return { agentId: previous.agentId, stamp, changed: false };
  }

  const request = createApiRequester(options.apiKey, options.fetch ?? globalThis.fetch);
  const toolIds: Record<string, string> = {};
  for (const definition of TOOLS) {
    const body = {
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
    name: agentName,
    conversation_config: {
      agent: {
        first_message: firstMessage,
        language: "en",
        prompt: {
          prompt,
          llm: ELEVENLABS_LLM,
          tool_ids: TOOLS.map((definition) => toolIds[definition.name]),
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

function provisioningStamp(
  pluginVersion: string,
  prompt: string,
  voiceId: string,
  firstMessage: string,
  agentName: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        pluginVersion,
        prompt,
        voiceId,
        llm: ELEVENLABS_LLM,
        firstMessage,
        agentName,
        tools: TOOLS.map(
          ({ name, description, parameters, guarded, responseTimeoutSeconds }) => ({
            name,
            description,
            parameters,
            guarded,
            responseTimeoutSeconds,
          }),
        ),
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
