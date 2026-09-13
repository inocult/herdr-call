export type JsonSchema = Record<string, unknown>;

export interface VoiceToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  guarded: boolean;
  socketMapping: string | readonly string[] | null;
  /** Seconds ElevenLabs should wait for this client tool before abandoning the call. Omitted
   *  means their 20s default, which suits every tool that answers from a single socket round-trip. */
  responseTimeoutSeconds?: number;
}

/**
 * ElevenLabs abandons a client tool once `response_timeout_secs` elapses and the agent then tells
 * the caller it hit a server error, mid-conversation. Their ceiling is 120s, so a tool that waits
 * has to keep its own wait, the socket deadline, and the declared budget in that order:
 *
 *   wait (<= 90s)  <  socket deadline (wait + 5s)  <  declared budget (110s)  <  ElevenLabs cap (120s)
 *
 * That ordering means a wait that runs long fails as a real "timed out waiting" answer the agent can
 * speak, instead of a silent abort. The default is deliberately well under the ceiling: a voice call
 * should not sit in dead air for a minute before saying anything.
 */
export const MAX_WAIT_SECONDS = 90;
export const DEFAULT_WAIT_SECONDS = 30;
export const WAIT_RESPONSE_TIMEOUT_SECONDS = 110;

export const TOOL_DEFINITIONS = [
  {
    name: "list_sessions",
    description:
      "List the current Herdr workspace, tab, pane, and coding-agent tree with semantic states. Use this before guessing ids or activity.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    guarded: false,
    socketMapping: ["workspace.list", "tab.list", "pane.list", "agent.list"],
  },
  {
    name: "read_agent",
    description:
      "Explain one coding agent and return a small recent-output excerpt suitable for summarizing aloud. Never read the raw output dump verbatim.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        target: { type: "string", description: "Agent name or exact pane id." },
        lines: { type: "integer", minimum: 1, maximum: 50, default: 30 },
      },
    },
    guarded: false,
    socketMapping: ["agent.explain", "agent.read"],
  },
  {
    name: "prompt_agent",
    description:
      "Send a natural-language instruction to a coding agent. Routine coding, edits, tests, builds, local installs, and commits need no confirmation. Ask once before calling only if the instruction explicitly orders irreversible deletion, closing or killing resources, deployment or publication, secret rotation or exposure, or shared-history rewriting.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target", "text"],
      properties: {
        target: { type: "string", description: "Agent name or exact pane id." },
        text: { type: "string", description: "The instruction to send." },
      },
    },
    guarded: false,
    socketMapping: "agent.prompt",
  },
  {
    name: "wait_for_agent",
    description: "Wait until an agent reaches one of the requested semantic Herdr states.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        target: { type: "string", description: "Agent name or exact pane id." },
        until: {
          type: "array",
          items: { type: "string", enum: ["idle", "working", "blocked", "done", "unknown"] },
          default: ["idle", "blocked", "done"],
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          default: DEFAULT_WAIT_SECONDS,
          // ElevenLabs drops `maximum` and `default` when it converts this schema, so the bound
          // only reaches the model if the description carries it. Without that it asks for waits
          // the relay has to refuse.
          description: `How long to wait, in seconds, up to ${MAX_WAIT_SECONDS}. Defaults to ${DEFAULT_WAIT_SECONDS}. Prefer a short wait and another check over one long one.`,
        },
      },
    },
    guarded: false,
    responseTimeoutSeconds: WAIT_RESPONSE_TIMEOUT_SECONDS,
    socketMapping: "agent.wait",
  },
  {
    name: "create_workspace",
    description: "Create a Herdr workspace with an initial tab and pane.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Absolute working directory." },
        label: { type: "string" },
        focus: { type: "boolean", default: false },
      },
    },
    guarded: false,
    socketMapping: "workspace.create",
  },
  {
    name: "create_tab",
    description: "Create a new terminal tab, optionally in a specified workspace.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspace_id: { type: "string" },
        cwd: { type: "string", description: "Absolute working directory." },
        label: { type: "string" },
        focus: { type: "boolean", default: false },
      },
    },
    guarded: false,
    socketMapping: "tab.create",
  },
  {
    name: "split_pane",
    description: "Split a Herdr pane to the right or down.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["direction"],
      properties: {
        direction: { type: "string", enum: ["right", "down"] },
        target_pane_id: { type: "string" },
        workspace_id: { type: "string" },
        cwd: { type: "string", description: "Absolute working directory." },
        ratio: { type: "number", minimum: 0.1, maximum: 0.9 },
        focus: { type: "boolean", default: false },
      },
    },
    guarded: false,
    socketMapping: "pane.split",
  },
  {
    name: "inspect_target",
    description:
      "Get detailed schema-backed information about one Herdr workspace, tab, pane, or coding agent. Use list_sessions first to discover the exact target.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target"],
      properties: {
        kind: { type: "string", enum: ["workspace", "tab", "pane", "agent"] },
        target: { type: "string", minLength: 1, maxLength: 200, description: "Exact id, or an agent name accepted by Herdr." },
      },
    },
    guarded: false,
    socketMapping: ["workspace.get", "tab.get", "pane.get", "agent.get"],
  },
  {
    name: "inspect_pane",
    description:
      "Inspect a pane's layout position, edges, neighboring pane, or foreground process without changing it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pane_id", "detail"],
      properties: {
        pane_id: { type: "string", minLength: 1, maxLength: 200 },
        detail: { type: "string", enum: ["layout", "edges", "neighbor", "process"] },
        direction: { type: "string", enum: ["left", "right", "up", "down"], description: "Required only when detail is neighbor." },
      },
    },
    guarded: false,
    socketMapping: ["pane.layout", "pane.edges", "pane.neighbor", "pane.process_info"],
  },
  {
    name: "read_pane",
    description:
      "Read a bounded text excerpt from any terminal pane, including panes that are not recognized coding agents. Summarize the result instead of reading a raw dump aloud.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pane_id"],
      properties: {
        pane_id: { type: "string", minLength: 1, maxLength: 200 },
        source: { type: "string", enum: ["visible", "recent", "recent_unwrapped", "detection"], default: "recent_unwrapped" },
        lines: { type: "integer", minimum: 1, maximum: 50, default: 30 },
      },
    },
    guarded: false,
    socketMapping: "pane.read",
  },
  {
    name: "wait_for_pane",
    description:
      "Wait for bounded terminal output containing a literal text fragment. Use only when the user asks to wait or a just-requested operation needs a short follow-up.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pane_id", "text"],
      properties: {
        pane_id: { type: "string", minLength: 1, maxLength: 200 },
        text: { type: "string", minLength: 1, maxLength: 200, description: "Literal substring to wait for; this is not a regular expression." },
        source: { type: "string", enum: ["visible", "recent", "recent_unwrapped", "detection"], default: "recent_unwrapped" },
        lines: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WAIT_SECONDS,
          default: DEFAULT_WAIT_SECONDS,
          // ElevenLabs drops `maximum` and `default` when it converts this schema, so the bound
          // only reaches the model if the description carries it. Without that it asks for waits
          // the relay has to refuse.
          description: `How long to wait, in seconds, up to ${MAX_WAIT_SECONDS}. Defaults to ${DEFAULT_WAIT_SECONDS}. Prefer a short wait and another check over one long one.`,
        },
      },
    },
    guarded: false,
    responseTimeoutSeconds: WAIT_RESPONSE_TIMEOUT_SECONDS,
    socketMapping: "pane.wait_for_output",
  },
  {
    name: "list_agent_types",
    description: "List the coding-agent kinds currently installed and startable by Herdr.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    guarded: false,
    socketMapping: "server.agent_manifests",
  },
  {
    name: "start_agent",
    description:
      "Start a named coding agent of an installed kind in an existing pane. Use list_agent_types and list_sessions first; arbitrary startup arguments are intentionally unavailable.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pane_id", "kind", "name"],
      properties: {
        pane_id: { type: "string", minLength: 1, maxLength: 200 },
        kind: { type: "string", minLength: 1, maxLength: 80, description: "Installed agent kind returned by list_agent_types." },
        name: { type: "string", minLength: 1, maxLength: 100, description: "Human-readable name for the new agent." },
      },
    },
    guarded: false,
    socketMapping: "agent.start",
  },
  {
    name: "rename_target",
    description: "Rename a Herdr workspace, tab, pane, or coding agent. Renaming is reversible and needs no confirmation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target", "label"],
      properties: {
        kind: { type: "string", enum: ["workspace", "tab", "pane", "agent"] },
        target: { type: "string", minLength: 1, maxLength: 200, description: "Exact id, or an agent target accepted by Herdr." },
        label: { type: "string", minLength: 1, maxLength: 100, description: "New label or agent name." },
      },
    },
    guarded: false,
    socketMapping: ["workspace.rename", "tab.rename", "pane.rename", "agent.rename"],
  },
  {
    name: "focus_target",
    description:
      "Focus a workspace, tab, pane, or coding agent, or move pane focus in a direction. This only changes navigation state.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["workspace", "tab", "pane", "agent", "direction"] },
        target: { type: "string", minLength: 1, maxLength: 200, description: "Required except for directional focus." },
        pane_id: { type: "string", minLength: 1, maxLength: 200, description: "Optional origin pane for directional focus." },
        direction: { type: "string", enum: ["left", "right", "up", "down"], description: "Required for directional focus." },
      },
    },
    guarded: false,
    socketMapping: ["workspace.focus", "tab.focus", "pane.focus", "agent.focus", "pane.focus_direction"],
  },
  {
    name: "reorder_target",
    description:
      "Reorder workspaces or tabs, or swap two panes. These operations preserve all sessions and are reversible.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["workspace", "tab", "pane_swap"] },
        target: { type: "string", minLength: 1, maxLength: 200, description: "Tab id or first pane id, depending on kind." },
        target_ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 200 }, description: "Workspace ids to move as a block." },
        before_target: { type: "string", minLength: 1, maxLength: 200, description: "Workspace id to insert before; omit to move to the end." },
        insert_index: { type: "integer", minimum: 0, maximum: 10000, description: "Required for tab reordering." },
        other_target: { type: "string", minLength: 1, maxLength: 200, description: "Second pane id for pane swapping." },
      },
    },
    guarded: false,
    socketMapping: ["workspace.move_block", "tab.move", "pane.swap"],
  },
  {
    name: "move_pane",
    description:
      "Move a pane into an existing tab, a new tab, or a new workspace without closing the pane or its process.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pane_id", "destination"],
      properties: {
        pane_id: { type: "string", minLength: 1, maxLength: 200 },
        destination: { type: "string", enum: ["tab", "new_tab", "new_workspace"] },
        tab_id: { type: "string", minLength: 1, maxLength: 200, description: "Required when moving into an existing tab." },
        target_pane_id: { type: "string", minLength: 1, maxLength: 200 },
        split: { type: "string", enum: ["right", "down"], default: "right" },
        ratio: { type: "number", minimum: 0.1, maximum: 0.9 },
        workspace_id: { type: "string", minLength: 1, maxLength: 200, description: "Optional destination workspace for a new tab." },
        label: { type: "string", minLength: 1, maxLength: 100 },
        focus: { type: "boolean", default: false },
      },
    },
    guarded: false,
    socketMapping: "pane.move",
  },
  {
    name: "adjust_pane",
    description: "Zoom or resize a pane, or adjust an existing layout split ratio. These changes are reversible.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["zoom", "resize", "split_ratio"] },
        pane_id: { type: "string", minLength: 1, maxLength: 200 },
        tab_id: { type: "string", minLength: 1, maxLength: 200 },
        zoom_mode: { type: "string", enum: ["toggle", "on", "off"], default: "toggle" },
        direction: { type: "string", enum: ["left", "right", "up", "down"] },
        amount: { type: "number", minimum: 0.01, maximum: 0.5 },
        path: { type: "array", maxItems: 32, items: { type: "boolean" }, description: "Split path returned by pane layout inspection." },
        ratio: { type: "number", minimum: 0.1, maximum: 0.9 },
      },
    },
    guarded: false,
    socketMapping: ["pane.zoom", "pane.resize", "layout.set_split_ratio"],
  },
  {
    name: "manage_worktree",
    description:
      "List, create, or open Git worktrees through Herdr. Removal and force operations are intentionally unavailable.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["list", "create", "open"] },
        workspace_id: { type: "string", minLength: 1, maxLength: 200 },
        cwd: { type: "string", minLength: 1, maxLength: 1000, description: "Absolute repository or worktree path." },
        path: { type: "string", minLength: 1, maxLength: 1000, description: "Explicit worktree path for create or open." },
        branch: { type: "string", minLength: 1, maxLength: 250 },
        base: { type: "string", minLength: 1, maxLength: 250, description: "Base revision used only when creating." },
        label: { type: "string", minLength: 1, maxLength: 100 },
        focus: { type: "boolean", default: false },
      },
    },
    guarded: false,
    socketMapping: ["worktree.list", "worktree.create", "worktree.open"],
  },
  {
    name: "inspect_plugins",
    description: "List installed Herdr plugins, their declared actions, or bounded recent plugin logs. This cannot invoke or modify plugins.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["detail"],
      properties: {
        detail: { type: "string", enum: ["plugins", "actions", "logs"] },
        plugin_id: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
    guarded: false,
    socketMapping: ["plugin.list", "plugin.action.list", "plugin.log.list"],
  },
  {
    name: "export_layout",
    description: "Export the current structured layout for one tab or pane without changing it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        tab_id: { type: "string", minLength: 1, maxLength: 200 },
        pane_id: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    guarded: false,
    socketMapping: "layout.export",
  },
  {
    name: "show_notification",
    description: "Show a concise local Herdr notification. Use only when the user asks for a notification or an important awaited result completes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 100 },
        body: { type: "string", maxLength: 300 },
        position: { type: "string", enum: ["top-left", "top-right", "bottom-left", "bottom-right"] },
        sound: { type: "string", enum: ["none", "done", "request"], default: "none" },
      },
    },
    guarded: false,
    socketMapping: "notification.show",
  },
  {
    name: "run_in_pane",
    description:
      "Prepare a direct shell command only when no free tool or routine prompt_agent instruction can do the job. Do not ask before preparing: this call cannot execute. Then read the returned description, ask exactly once, and call confirm_action only after a clear yes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pane_id", "command"],
      properties: {
        pane_id: { type: "string", description: "The exact Herdr pane id." },
        command: { type: "string", description: "The complete shell command to submit." },
      },
    },
    guarded: true,
    socketMapping: "pane.send_input",
  },
  {
    name: "send_keys",
    description:
      "Prepare literal key presses only when direct terminal interaction is necessary. Do not ask before preparing: this call cannot execute. Then read the returned description, ask exactly once, and use confirm_action only after a clear yes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pane_id", "keys"],
      properties: {
        pane_id: { type: "string", description: "The exact Herdr pane id." },
        keys: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Herdr key names such as enter, esc, ctrl+c, or shift+tab.",
        },
      },
    },
    guarded: true,
    socketMapping: "pane.send_keys",
  },
  {
    name: "close_target",
    description:
      "Prepare closing a workspace, tab, or pane. Do not ask before preparing: this call cannot execute. Then read the exact target aloud, ask exactly once, and use confirm_action only after a clear yes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target_id"],
      properties: {
        kind: { type: "string", enum: ["workspace", "tab", "pane"] },
        target_id: { type: "string", description: "The exact workspace, tab, or pane id." },
      },
    },
    guarded: true,
    socketMapping: ["workspace.close", "tab.close", "pane.close"],
  },
  {
    name: "confirm_action",
    description:
      "Execute one previously prepared guarded action after the user has verbally confirmed its exact description. Action ids are single-use and expire quickly.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action_id"],
      properties: {
        action_id: { type: "string", description: "The pending action id returned earlier." },
      },
    },
    guarded: false,
    socketMapping: null,
  },
] as const satisfies readonly VoiceToolDefinition[];

export type VoiceToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

export function getToolDefinition(name: string): VoiceToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

export function validateToolInput(definition: VoiceToolDefinition, input: unknown): Record<string, unknown> {
  const schema = definition.parameters;
  if (!isRecord(input)) throw new Error(`Invalid input for ${definition.name}: expected an object`);

  const properties = schema.properties as Record<string, JsonSchema>;
  const required = (schema.required as readonly string[] | undefined) ?? [];
  for (const key of required) {
    if (!(key in input)) throw new Error(`Invalid input for ${definition.name}: missing ${key}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) throw new Error(`Invalid input for ${definition.name}: unknown ${key}`);
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property) continue;
    validateValue(definition.name, key, value, property);
  }
  return input;
}

function validateValue(toolName: string, key: string, value: unknown, schema: JsonSchema): void {
  const type = schema.type;
  const fail = (message: string): never => {
    throw new Error(`Invalid input for ${toolName}: ${key} ${message}`);
  };
  if (type === "string" && typeof value !== "string") {
    fail("must be a string");
  }
  if (type === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) fail("is too short");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail("is too long");
  }
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    fail("must be a finite number");
  }
  if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    fail("must be an integer");
  }
  if ((type === "number" || type === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (type === "boolean" && typeof value !== "boolean") {
    fail("must be a boolean");
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    fail(`must be one of ${schema.enum.join(", ")}`);
  }
  if (type === "array") {
    const items: unknown[] = Array.isArray(value) ? value : fail("must be an array");
    if (typeof schema.minItems === "number" && items.length < schema.minItems) {
      fail(`must contain at least ${schema.minItems} item`);
    }
    if (typeof schema.maxItems === "number" && items.length > schema.maxItems) {
      fail(`must contain at most ${schema.maxItems} items`);
    }
    const itemSchema = schema.items as JsonSchema | undefined;
    if (itemSchema) {
      items.forEach((item, index) => validateValue(toolName, `${key}[${index}]`, item, itemSchema));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
