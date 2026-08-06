import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repositoryRoot, "dist");
if (dirname(outputDirectory) !== repositoryRoot || outputDirectory === repositoryRoot) {
  throw new Error("Refusing to clean an unexpected build directory");
}

await rm(outputDirectory, { recursive: true, force: true });

const typeScript = spawnSync(
  process.execPath,
  [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (typeScript.status !== 0) process.exit(typeScript.status ?? 1);

await build({
  entryPoints: [join(repositoryRoot, "src", "page", "app.ts")],
  bundle: true,
  outfile: join(outputDirectory, "page", "app.js"),
  platform: "browser",
  format: "esm",
  target: ["safari16.4"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

await mkdir(join(outputDirectory, "page"), { recursive: true });
await mkdir(join(outputDirectory, "agent"), { recursive: true });
const [indexSource, stylesSource, appSource] = await Promise.all([
  readFile(join(repositoryRoot, "src", "page", "index.html"), "utf8"),
  readFile(join(repositoryRoot, "src", "page", "styles.css"), "utf8"),
  readFile(join(outputDirectory, "page", "app.js")),
]);
const assetVersion = createHash("sha256")
  .update(stylesSource)
  .update(appSource)
  .digest("hex")
  .slice(0, 12);
const builtIndex = indexSource.replaceAll("__ASSET_VERSION__", assetVersion);
await Promise.all([
  writeFile(join(outputDirectory, "page", "index.html"), builtIndex, "utf8"),
  writeFile(join(outputDirectory, "page", "styles.css"), stylesSource, "utf8"),
  copyFile(join(repositoryRoot, "src", "agent", "prompt.md"), join(outputDirectory, "agent", "prompt.md")),
]);
