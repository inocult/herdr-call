import { loadPluginConfig } from "./config.js";
import { HerdrClient } from "./herdr.js";
import { startOrFocusCall } from "./launch.js";

async function main(): Promise<void> {
  // The startup hook runs on every Herdr server start, so it opens the call tab only
  // when this machine asked for it with open_on_startup, and never takes the focus.
  const fromStartup = process.argv.includes("--startup");
  if (fromStartup) {
    const config = await loadPluginConfig(requiredEnvironment("HERDR_PLUGIN_CONFIG_DIR"));
    if (!config.openOnStartup) return;
  }

  const herdr = new HerdrClient({
    socketPath: requiredEnvironment("HERDR_SOCKET_PATH"),
  });
  try {
    const result = await startOrFocusCall({
      herdr,
      pluginRoot: requiredEnvironment("HERDR_PLUGIN_ROOT"),
      focus: !fromStartup,
    });
    process.stdout.write(
      result.status === "focused"
        ? `Focused Herdr Call pane ${result.paneId}.\n`
        : `Opened Herdr Call pane ${result.paneId}.\n`,
    );
  } finally {
    await herdr.close();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
