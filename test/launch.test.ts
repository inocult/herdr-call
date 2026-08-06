import assert from "node:assert/strict";
import { test } from "node:test";

import { HerdrRequestError } from "../src/server/herdr.js";
import { startOrFocusCall } from "../src/server/launch.js";

test("start focuses an existing Herdr Call plugin pane", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const result = await startOrFocusCall({
    pluginRoot: "/plugins/herdr-call",
    herdr: {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "pane.list") {
          return {
            panes: [
              {
                pane_id: "w1:p1",
                label: "Herdr Call",
                cwd: "/plugins/herdr-call",
              },
            ],
          };
        }
        return { type: "plugin_pane_focused" };
      },
    },
  });

  assert.deepEqual(result, { status: "focused", paneId: "w1:p1" });
  assert.deepEqual(calls, [
    { method: "pane.list", params: {} },
    { method: "plugin.pane.focus", params: { pane_id: "w1:p1" } },
  ]);
});

test("start opens and focuses a new Herdr Call tab when none exists", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const result = await startOrFocusCall({
    pluginRoot: "/plugins/herdr-call",
    herdr: {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "pane.list") return { panes: [] };
        return {
          plugin_pane: {
            pane: {
              pane_id: "w1:p2",
            },
          },
        };
      },
    },
  });

  assert.deepEqual(result, { status: "opened", paneId: "w1:p2" });
  assert.deepEqual(calls, [
    { method: "pane.list", params: {} },
    {
      method: "plugin.pane.open",
      params: {
        plugin_id: "herdr-call",
        entrypoint: "call",
        placement: "tab",
        focus: true,
      },
    },
  ]);
});

test("start does not open a duplicate when focusing the existing pane fails unexpectedly", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  await assert.rejects(
    startOrFocusCall({
      pluginRoot: "/plugins/herdr-call",
      herdr: {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "pane.list") {
            return {
              panes: [
                {
                  pane_id: "w1:p1",
                  label: "Herdr Call",
                  cwd: "/plugins/herdr-call",
                },
              ],
            };
          }
          throw new HerdrRequestError("server_unavailable", "Herdr is temporarily unavailable");
        },
      },
    }),
    {
      message: "Herdr is temporarily unavailable",
    },
  );

  assert.deepEqual(calls, [
    { method: "pane.list", params: {} },
    { method: "plugin.pane.focus", params: { pane_id: "w1:p1" } },
  ]);
});
