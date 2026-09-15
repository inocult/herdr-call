import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPluginConfig } from "../src/server/config.js";
import { DEFAULT_BACKGROUND, normalizeHexColour, paletteCss, themeColour } from "../src/server/palette.js";
import { agentNameFor, firstMessageFor } from "../src/server/provision.js";

async function configDirectoryWith(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-palette-"));
  await writeFile(join(directory, "config.toml"), source, "utf8");
  return directory;
}

test("the four brand colours are read off config.toml", async () => {
  const directory = await configDirectoryWith(
    [
      'brand_color = "#4D94FF"',
      'brand_color_alt = "#8fd9ff"',
      'brand_deep = "#0f1c3d"',
      'brand_bg = "#0e1220"',
    ].join("\n"),
  );
  const config = await loadPluginConfig(directory);
  assert.deepEqual(config.brandPalette, {
    color: "#4d94ff",
    colorAlt: "#8fd9ff",
    deep: "#0f1c3d",
    bg: "#0e1220",
  });
});

test("an environment that sets no colour gets no palette at all", async () => {
  const directory = await configDirectoryWith('brand_name = "ubqty"\n');
  const config = await loadPluginConfig(directory);
  assert.equal(config.brandPalette, undefined);
  assert.equal(paletteCss({}), "");
});

test("a colour that is not hex is rejected by name rather than reaching the page", async () => {
  const directory = await configDirectoryWith('brand_color = "red; } body { display:none"\n');
  await assert.rejects(loadPluginConfig(directory), /brand_color must be a hex colour/u);
});

test("normalizeHexColour accepts both hex lengths and lowercases them", () => {
  assert.equal(normalizeHexColour("#ABC", "brand_color"), "#abc");
  assert.equal(normalizeHexColour("  #B8314F  ", "brand_color"), "#b8314f");
  assert.equal(normalizeHexColour("", "brand_color"), undefined);
  assert.equal(normalizeHexColour(undefined, "brand_color"), undefined);
});

test("the accent drives both the flat UI spot and the orb's desk tint", () => {
  const css = paletteCss({ color: "#49b3a8" });
  assert.match(css, /--spot:#49b3a8/u);
  assert.match(css, /--o-gold:#49b3a8/u);
});

test("a ground colour carries the neutrals and the button ink with it", () => {
  const css = paletteCss({ bg: "#0d1614" });
  assert.match(css, /--bg:#0d1614/u);
  // Ink on a primary button is the ground, so it stays legible on any accent.
  assert.match(css, /--spot-ink:#0d1614/u);
  for (const property of ["--grid", "--panel", "--mass", "--line", "--line-strong"]) {
    assert.match(css, new RegExp(`${property}:color-mix\\(in srgb, #0d1614 \\d+%, #ffffff\\)`, "u"));
  }
});

test("setting one key leaves every other token to the stylesheet", () => {
  const css = paletteCss({ colorAlt: "#b8e986" });
  assert.equal(css, ":root{--o-aqua:#b8e986}");
});

test("the phone's browser chrome follows the ground, falling back to the stock one", () => {
  assert.equal(themeColour({ bg: "#17101a" }), "#17101a");
  assert.equal(themeColour({}), DEFAULT_BACKGROUND);
});

test("the greeting names the environment, not the product", () => {
  assert.equal(firstMessageFor("Studio 3"), "Hey there — what would you like to do in Studio 3?");
  assert.equal(firstMessageFor("TAG"), "Hey there — what would you like to do in TAG?");
});

test("an unbranded environment keeps the stock greeting and agent name", () => {
  assert.equal(firstMessageFor(), "Hey there — what would you like to do in Herdr?");
  assert.equal(firstMessageFor("  "), "Hey there — what would you like to do in Herdr?");
  assert.equal(agentNameFor(), "herdr-voice");
  assert.equal(agentNameFor("Herdr"), "herdr-voice");
});

test("branded environments get their own agent name so one account stays readable", () => {
  assert.equal(agentNameFor("ubqty"), "herdr-voice (ubqty)");
  assert.equal(agentNameFor("At Bryde Ud"), "herdr-voice (At Bryde Ud)");
});
