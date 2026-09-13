import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { loadPluginConfig, saveApiKey, type PluginConfig } from "./config.js";
import { ElevenLabsSessionProvider } from "./elevenlabs.js";
import { HerdrClient } from "./herdr.js";
import { createCallServer, DEFAULT_BRAND, type PageBrand, type SessionProvider } from "./http.js";
import { provisionElevenLabsAgent } from "./provision.js";
import { renderQr } from "./qr.js";
import { ToolRelay } from "./relay.js";
import {
  createTailscaleRunner,
  deriveRuntimeSettings,
  discoverTailnet,
  ensureServe,
  type RuntimeSettings,
} from "./tailscale.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const CALL_SERVER_PORT = 47_831;
// Herdr 0.8.0 spoke protocol 19; 0.8.2 bumped it to 20 without removing any method
// this plugin calls, so accept both rather than pinning one exact number.
export const HERDR_PROTOCOLS = new Set([19, 20]);

async function main(): Promise<void> {
  const configDirectory = requiredEnvironment("HERDR_PLUGIN_CONFIG_DIR");
  let config = await loadPluginConfig(configDirectory);

  if (process.argv.includes("--provision-only")) {
    await provisionIfConfigured(config.elevenlabsApiKey, config.voiceId);
    if (!config.elevenlabsApiKey) {
      process.stdout.write(
        "Herdr Call setup pending: run `herdr plugin action invoke start --plugin herdr-call` to finish setup.\n",
      );
    }
    return;
  }

  config = await ensureApiKey(config, configDirectory);
  const provisionedAgentId = await provisionIfConfigured(config.elevenlabsApiKey, config.voiceId);

  const socketPath =
    process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
  const herdr = new HerdrClient({ socketPath });
  const ping = asRecord(await herdr.request("ping", {}));
  if (ping.type !== "pong" || !HERDR_PROTOCOLS.has(Number(ping.protocol))) {
    throw new Error(
      `Unsupported Herdr socket protocol ${String(ping.protocol)}: expected one of ${[...HERDR_PROTOCOLS].join(", ")}`,
    );
  }

  const tailscale = createTailscaleRunner();
  const discovery = await discoverTailnet(tailscale);
  const settings = deriveRuntimeSettings(config, discovery, CALL_SERVER_PORT);

  const relay = new ToolRelay({ herdr });
  const sessionProvider = createSessionProvider(config.elevenlabsApiKey, provisionedAgentId);
  const assetsDirectory = fileURLToPath(new URL("../page/", import.meta.url));
  const authToken = randomBytes(32).toString("base64url");
  const brand = await resolveBrand(config, configDirectory);
  const server = createCallServer({
    relay,
    sessionProvider,
    assetsDirectory,
    authToken,
    brand,
    ...(settings.tailnetUrl ? { tailnetUrl: settings.tailnetUrl } : {}),
    ...(settings.allowedTailnetUsers ? { allowedTailnetUsers: settings.allowedTailnetUsers } : {}),
  });

  server.listen(CALL_SERVER_PORT, LOOPBACK_HOST, () => {
    void announce(settings, tailscale);
  });

  const shutdown = () => {
    server.close(() => {
      void herdr.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/** First-run setup: ask for the API key right in the call pane and persist it. */
async function ensureApiKey(config: PluginConfig, configDirectory: string): Promise<PluginConfig> {
  if (config.elevenlabsApiKey) return config;
  if (!process.stdin.isTTY) {
    process.stdout.write(
      `Setup required: add elevenlabs_api_key to ${join(configDirectory, "config.toml")}\n`,
    );
    return config;
  }

  process.stdout.write(
    "\nHerdr Call needs your ElevenLabs API key (one-time setup).\n" +
      "Create one at https://elevenlabs.io/app/settings/api-keys — a key with only the\n" +
      "ElevenAgents write permission is all it needs; leave every other permission off.\n\n",
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await readline.question("Paste your ElevenLabs API key: ")).trim();
      if (!answer) continue;
      try {
        await saveApiKey(configDirectory, answer);
        process.stdout.write("Saved. The key stays in the plugin config, server-side only.\n\n");
        return await loadPluginConfig(configDirectory);
      } catch (error) {
        process.stdout.write(`${error instanceof Error ? error.message : String(error)}. Try again.\n`);
      }
    }
  } finally {
    readline.close();
  }
}

/** Post-listen report: configure Serve when appropriate and show how to take the call. */
async function announce(
  settings: RuntimeSettings,
  tailscale: ReturnType<typeof createTailscaleRunner>,
): Promise<void> {
  process.stdout.write(`Herdr Call is listening on http://${LOOPBACK_HOST}:${CALL_SERVER_PORT}\n`);
  process.stdout.write(
    "Leave this tab running while you want calls available. To return here later, run:\n" +
      "  herdr plugin action invoke start --plugin herdr-call\n",
  );

  if (settings.shouldServe) {
    const serve = await ensureServe(tailscale, CALL_SERVER_PORT);
    process.stdout.write(
      serve.ok ? "Tailscale Serve is configured (tailnet only).\n" : `Warning: ${serve.message}\n`,
    );
  } else if (!settings.tailnetUrl) {
    process.stdout.write(
      "Tailscale was not detected, so the call is reachable on this machine only.\n" +
        "Start Tailscale (or set tailnet_url in config.toml) to take calls from other devices.\n",
    );
  }

  if (settings.allowedTailnetUsers?.length) {
    process.stdout.write(
      `Only ${settings.allowedTailnetUsers.join(", ")} can drive this call over the tailnet.\n`,
    );
  } else if (settings.tailnetUrl) {
    process.stdout.write(
      "Warning: no identity allowlist is active; every authenticated device on your tailnet can drive this call. Set allowed_tailnet_users in config.toml to lock it down.\n",
    );
  }

  if (settings.tailnetUrl) {
    process.stdout.write(`\nTake the call from any device on your tailnet:\n\n`);
    process.stdout.write(`  ${settings.tailnetUrl}\n\n`);
    process.stdout.write(`${await renderQr(settings.tailnetUrl)}\n`);
  }
}

async function provisionIfConfigured(
  apiKey: string | undefined,
  voiceId: string | undefined,
): Promise<string | undefined> {
  if (!apiKey) return undefined;
  const stateDirectory = requiredEnvironment("HERDR_PLUGIN_STATE_DIR");
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("package.json has no valid version");
  }
  const promptPath = fileURLToPath(new URL("../agent/prompt.md", import.meta.url));
  const result = await provisionElevenLabsAgent({
    apiKey,
    pluginVersion: packageJson.version,
    promptPath,
    stateDirectory,
    ...(voiceId ? { voiceId } : {}),
  });
  process.stdout.write(
    result.changed
      ? `Provisioned ElevenLabs agent ${result.agentId}.\n`
      : `ElevenLabs agent ${result.agentId} is up to date.\n`,
  );
  return result.agentId;
}

/** Each environment brands its own call page from the plugin config directory:
 *  `brand_name` / `brand_tagline` in config.toml, and a logo either named by
 *  `brand_logo` or dropped next to it as logo.png / logo.svg / logo.jpg. Anything
 *  missing falls back to the bundled defaults. */
export async function resolveBrand(config: PluginConfig, configDirectory: string): Promise<PageBrand> {
  const candidates = [
    ...(config.brandLogo ? [expandHome(config.brandLogo)] : []),
    ...["logo.png", "logo.svg", "logo.jpg", "logo.jpeg", "logo.webp"].map((file) =>
      join(configDirectory, file),
    ),
  ];
  let logoPath: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      logoPath = candidate;
      break;
    } catch {
      // try the next candidate
    }
  }
  return {
    name: config.brandName?.trim() || DEFAULT_BRAND.name,
    tagline: config.brandTagline?.trim() || DEFAULT_BRAND.tagline,
    ...(logoPath ? { logoPath } : {}),
  };
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function createSessionProvider(apiKey: string | undefined, agentId: string | undefined): SessionProvider {
  if (apiKey && agentId) return new ElevenLabsSessionProvider({ apiKey, agentId });
  return {
    async createSession() {
      throw new Error(
        "ElevenLabs setup is incomplete. Configure elevenlabs_api_key in the plugin config.",
      );
    },
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
