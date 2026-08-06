import { HerdrClient } from "./herdr.js";
import { startOrFocusCall } from "./launch.js";

async function main(): Promise<void> {
  const herdr = new HerdrClient({
    socketPath: requiredEnvironment("HERDR_SOCKET_PATH"),
  });
  try {
    const result = await startOrFocusCall({
      herdr,
      pluginRoot: requiredEnvironment("HERDR_PLUGIN_ROOT"),
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
