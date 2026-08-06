import assert from "node:assert/strict";
import { test } from "node:test";

import { renderQr } from "../src/server/qr.js";

test("renderQr produces a terminal block grid for the call URL", async () => {
  const output = await renderQr("https://workstation.example-tail.ts.net:47831");
  const lines = output.split("\n").filter(Boolean);
  assert.ok(lines.length >= 10, `expected a multi-line QR grid, got ${lines.length} lines`);
  assert.match(output, /[█▄▀]/u, "expected unicode block characters");
});

test("renderQr output is deterministic for the same URL", async () => {
  const first = await renderQr("https://workstation.example-tail.ts.net:47831");
  const second = await renderQr("https://workstation.example-tail.ts.net:47831");
  assert.equal(first, second);
});
