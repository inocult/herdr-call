import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PluginConfig {
  elevenlabsApiKey?: string;
  agentId?: string;
  voiceId?: string;
  tailnetUrl?: string;
  allowedTailnetUsers?: string[];
  autoServe?: boolean;
  /** Environment branding shown on the call page; see resolveBrand in main.ts. */
  brandName?: string;
  brandTagline?: string;
  brandLogo?: string;
}

export async function loadPluginConfig(configDirectory: string): Promise<PluginConfig> {
  const path = join(configDirectory, "config.toml");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }

  const values = parseFlatToml(source);
  return {
    ...(values.elevenlabs_api_key ? { elevenlabsApiKey: values.elevenlabs_api_key } : {}),
    ...(values.agent_id ? { agentId: values.agent_id } : {}),
    ...(values.voice_id ? { voiceId: values.voice_id } : {}),
    ...(values.tailnet_url ? { tailnetUrl: values.tailnet_url } : {}),
    ...(values.allowed_tailnet_users
      ? { allowedTailnetUsers: parseUserList(values.allowed_tailnet_users) }
      : {}),
    ...(values.auto_serve ? { autoServe: values.auto_serve === "true" } : {}),
    ...(values.brand_name ? { brandName: values.brand_name } : {}),
    ...(values.brand_tagline ? { brandTagline: values.brand_tagline } : {}),
    ...(values.brand_logo ? { brandLogo: values.brand_logo } : {}),
  };
}

/** Persist the API key from the first-run prompt, keeping any keys the user already set. */
export async function saveApiKey(configDirectory: string, apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key || !/^[\x21-\x7e]+$/u.test(key) || key.includes('"') || key.includes("'")) {
    throw new Error("The API key contains quotes or control characters and is invalid");
  }

  const path = join(configDirectory, "config.toml");
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const keyLine = `elevenlabs_api_key = "${key}"`;
  const lines = source.split(/\r?\n/u);
  const existing = lines.findIndex((line) => /^\s*elevenlabs_api_key\s*=/u.test(line));
  if (existing === -1) {
    source = source && !source.endsWith("\n") ? `${source}\n${keyLine}\n` : `${source}${keyLine}\n`;
  } else {
    lines[existing] = keyLine;
    source = lines.join("\n");
  }

  await mkdir(configDirectory, { recursive: true });
  const temporary = join(configDirectory, `.config.toml.${process.pid}.tmp`);
  await writeFile(temporary, source, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/** Accepts a comma-separated list of Tailscale login identities, e.g. "alice@example.com, bob@example.com". */
function parseUserList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseFlatToml(source: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match =
      /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false)\s*(?:#.*)?$/u.exec(
        line,
      );
    if (!match?.[1] || !match[2]) {
      throw new Error(`Unsupported config.toml syntax on line ${index + 1}`);
    }
    output[match[1]] = match[2].startsWith('"')
      ? (JSON.parse(match[2]) as string)
      : match[2].startsWith("'")
        ? match[2].slice(1, -1)
        : match[2];
  }
  return output;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
