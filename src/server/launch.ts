import { HerdrRequestError } from "./herdr.js";

export interface HerdrRequester {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface StartOrFocusCallOptions {
  herdr: HerdrRequester;
  pluginRoot: string;
}

export type StartOrFocusCallResult =
  | { status: "focused"; paneId: string }
  | { status: "opened"; paneId: string };

export async function startOrFocusCall(
  options: StartOrFocusCallOptions,
): Promise<StartOrFocusCallResult> {
  const result = asRecord(await options.herdr.request("pane.list", {}));
  const panes = Array.isArray(result.panes) ? result.panes.map(asRecord) : [];

  for (const pane of panes) {
    if (
      pane.label !== "Herdr Call" ||
      pane.cwd !== options.pluginRoot ||
      typeof pane.pane_id !== "string"
    ) {
      continue;
    }

    try {
      await options.herdr.request("plugin.pane.focus", { pane_id: pane.pane_id });
      return { status: "focused", paneId: pane.pane_id };
    } catch (error) {
      if (
        !(error instanceof HerdrRequestError) ||
        error.code !== "plugin_pane_not_found"
      ) {
        throw error;
      }

      // A matching user-named pane is not necessarily owned by this plugin.
    }
  }

  const opened = asRecord(
    await options.herdr.request("plugin.pane.open", {
      plugin_id: "herdr-call",
      entrypoint: "call",
      placement: "tab",
      focus: true,
    }),
  );
  const pluginPane = asRecord(opened.plugin_pane);
  const pane = asRecord(pluginPane.pane);
  if (typeof pane.pane_id !== "string") {
    throw new Error("Herdr opened the call pane without returning its pane id");
  }
  return { status: "opened", paneId: pane.pane_id };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
