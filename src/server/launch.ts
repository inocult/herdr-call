import { HerdrRequestError } from "./herdr.js";

export interface HerdrRequester {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface StartOrFocusCallOptions {
  herdr: HerdrRequester;
  pluginRoot: string;
  /**
   * Whether the call pane should end up focused. The startup hook passes false so a
   * machine that opens the call on every Herdr start does not steal the focus the
   * restored session came back with.
   */
  focus?: boolean;
}

export type StartOrFocusCallResult =
  | { status: "focused"; paneId: string }
  | { status: "opened"; paneId: string };

export async function startOrFocusCall(
  options: StartOrFocusCallOptions,
): Promise<StartOrFocusCallResult> {
  const focus = options.focus ?? true;
  const result = asRecord(await options.herdr.request("pane.list", {}));
  const panes = Array.isArray(result.panes) ? result.panes.map(asRecord) : [];
  const previouslyFocused = panes.find((pane) => pane.focused === true);

  for (const pane of panes) {
    if (
      pane.label !== "Herdr Call" ||
      pane.cwd !== options.pluginRoot ||
      typeof pane.pane_id !== "string"
    ) {
      continue;
    }

    try {
      // Focusing is also how a plugin-owned pane is told apart from a pane the user
      // named "Herdr Call" or a dead one a session restore brought back as a shell.
      await options.herdr.request("plugin.pane.focus", { pane_id: pane.pane_id });
      if (!focus) await restoreFocus(options.herdr, previouslyFocused, pane.pane_id);
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
      focus,
    }),
  );
  const pluginPane = asRecord(opened.plugin_pane);
  const pane = asRecord(pluginPane.pane);
  if (typeof pane.pane_id !== "string") {
    throw new Error("Herdr opened the call pane without returning its pane id");
  }
  return { status: "opened", paneId: pane.pane_id };
}

/** Hand the focus back to the pane that had it before the ownership probe moved it. */
async function restoreFocus(
  herdr: HerdrRequester,
  previouslyFocused: Record<string, unknown> | undefined,
  callPaneId: string,
): Promise<void> {
  const paneId = previouslyFocused?.pane_id;
  if (typeof paneId !== "string" || paneId === callPaneId) return;
  await herdr.request("pane.focus", { pane_id: paneId });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
