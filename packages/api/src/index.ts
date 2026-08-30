import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "./server.ts";

export { buildApp, startServer } from "./server.ts";

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return process.argv[1].replace(/\\/g, "/").endsWith("packages/api/src/index.ts");
  }
}

if (isDirectRun()) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
