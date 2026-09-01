import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "../..");
const outdir = join(desktop, "build");
mkdirSync(outdir, { recursive: true });

await build({
  absWorkingDir: repo,
  entryPoints: [join(repo, "packages/api/src/server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: join(outdir, "server.cjs"),
  sourcemap: true,
  external: ["better-sqlite3"],
  logLevel: "info",
});

console.log(`bundled ${join(outdir, "server.cjs")}`);

await build({
  absWorkingDir: repo,
  entryPoints: [join(repo, "packages/core/src/walk-worker.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: join(outdir, "walk-worker.cjs"),
  sourcemap: true,
  external: ["better-sqlite3"],
  logLevel: "info",
});

console.log(`bundled ${join(outdir, "walk-worker.cjs")}`);
