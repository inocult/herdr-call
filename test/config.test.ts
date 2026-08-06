import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPluginConfig, saveApiKey } from "../src/server/config.js";

async function configDirectoryWith(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-config-"));
  await writeFile(join(directory, "config.toml"), source, "utf8");
  return directory;
}

test("auto_serve = false is parsed as a bare boolean", async () => {
  const directory = await configDirectoryWith('elevenlabs_api_key = "sk_test"\nauto_serve = false\n');
  const config = await loadPluginConfig(directory);
  assert.equal(config.autoServe, false);
});

test("auto_serve = true is parsed as a bare boolean", async () => {
  const directory = await configDirectoryWith("auto_serve = true\n");
  const config = await loadPluginConfig(directory);
  assert.equal(config.autoServe, true);
});

test("autoServe is absent when config.toml does not set it", async () => {
  const directory = await configDirectoryWith('elevenlabs_api_key = "sk_test"\n');
  const config = await loadPluginConfig(directory);
  assert.equal(config.autoServe, undefined);
});

test("saveApiKey creates config.toml when none exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-config-"));
  await saveApiKey(directory, "sk_fresh");
  const config = await loadPluginConfig(directory);
  assert.equal(config.elevenlabsApiKey, "sk_fresh");
});

test("saveApiKey preserves the other keys already in config.toml", async () => {
  const directory = await configDirectoryWith('voice_id = "voice-1"\nauto_serve = false\n');
  await saveApiKey(directory, "sk_added");
  const config = await loadPluginConfig(directory);
  assert.equal(config.elevenlabsApiKey, "sk_added");
  assert.equal(config.voiceId, "voice-1");
  assert.equal(config.autoServe, false);
});

test("saveApiKey replaces an existing key instead of duplicating the line", async () => {
  const directory = await configDirectoryWith('elevenlabs_api_key = "sk_old"\nvoice_id = "voice-1"\n');
  await saveApiKey(directory, "sk_new");
  const config = await loadPluginConfig(directory);
  assert.equal(config.elevenlabsApiKey, "sk_new");
  const source = await readFile(join(directory, "config.toml"), "utf8");
  assert.equal(source.match(/elevenlabs_api_key/gu)?.length, 1);
});

test("saveApiKey rejects a key that would break the config file syntax", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-call-config-"));
  await assert.rejects(saveApiKey(directory, 'sk_bad"\nallowed_tailnet_users = "mallory@evil.com'), {
    message: /control characters|quotes|invalid/iu,
  });
});
