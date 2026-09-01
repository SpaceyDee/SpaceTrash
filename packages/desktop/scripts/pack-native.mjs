import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtime = process.argv[2] === "electron" ? "electron" : "node";
const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const mod = join(repo, "node_modules", "better-sqlite3");
if (!existsSync(mod)) {
  console.warn("better-sqlite3 not found, skipping native swap");
  process.exit(0);
}

const args =
  runtime === "electron"
    ? ["prebuild-install", "--runtime", "electron", "--target", "34.5.8"]
    : ["prebuild-install"];

const result = spawnSync("npx", args, { cwd: mod, stdio: "inherit", shell: true });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`native module: ${runtime}`);
