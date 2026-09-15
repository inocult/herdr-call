import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeHexColour, type BrandPalette } from "./palette.js";

export interface PluginConfig {
  elevenlabsApiKey?: string;
  agentId?: string;
  voiceId?: string;
  tailnetUrl?: string;
  allowedTailnetUsers?: string[];
  autoServe?: boolean;
  /** Open the call tab from the plugin startup hook every time the Herdr server starts. */
  openOnStartup?: boolean;
  /** Environment branding shown on the call page; see resolveBrand in main.ts. */
  brandName?: string;
  brandTagline?: string;
  brandLogo?: string;
  /** Per-environment colour; see palette.ts. Absent keys keep the stock palette. */
  brandPalette?: BrandPalette;
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
  const palette = readPalette(values);
  return {
    ...(values.elevenlabs_api_key ? { elevenlabsApiKey: values.elevenlabs_api_key } : {}),
    ...(values.agent_id ? { agentId: values.agent_id } : {}),
    ...(values.voice_id ? { voiceId: values.voice_id } : {}),
    ...(values.tailnet_url ? { tailnetUrl: values.tailnet_url } : {}),
    ...(values.allowed_tailnet_users
      ? { allowedTailnetUsers: parseUserList(values.allowed_tailnet_users) }
      : {}),
    ...(values.auto_serve ? { autoServe: values.auto_serve === "true" } : {}),
    ...(values.open_on_startup ? { openOnStartup: values.open_on_startup === "true" } : {}),
    ...(values.brand_name ? { brandName: values.brand_name } : {}),
    ...(values.brand_tagline ? { brandTagline: values.brand_tagline } : {}),
    ...(values.brand_logo ? { brandLogo: values.brand_logo } : {}),
    ...(palette ? { brandPalette: palette } : {}),
  };
}

/** Reject a malformed colour at load, where the message can name the file and the
 *  key, rather than shipping a broken <style> block to the page. */
function readPalette(values: Record<string, string>): BrandPalette | undefined {
  const palette: BrandPalette = {
    ...maybe("color", normalizeHexColour(values.brand_color, "brand_color")),
    ...maybe("colorAlt", normalizeHexColour(values.brand_color_alt, "brand_color_alt")),
    ...maybe("deep", normalizeHexColour(values.brand_deep, "brand_deep")),
    ...maybe("bg", normalizeHexColour(values.brand_bg, "brand_bg")),
  };
  return Object.keys(palette).length > 0 ? palette : undefined;
}

function maybe<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
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
