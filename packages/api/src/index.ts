import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEngine, type FindingClass } from "@spacetrash/core";

const here = dirname(fileURLToPath(import.meta.url));
const rendererCandidates = [
  join(here, "../../desktop/renderer"),
  join(here, "../../../packages/desktop/renderer"),
];

export function buildApp() {
  const engine = getEngine();
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/status", (_req, res) => {
    res.json(engine.status());
  });

  app.get("/api/volumes", async (_req, res) => {
    res.json(await engine.volumes());
  });

  app.post("/api/scans", (req, res) => {
    try {
      const body = req.body ?? {};
      const job = engine.startScan({
        roots: Array.isArray(body.roots) ? body.roots : [],
        installerMinBytes: body.installerMinBytes,
        largeMinBytes: body.largeMinBytes,
        unusedDays: body.unusedDays,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/scans/:id", (req, res) => {
    const job = engine.getScan(req.params.id);
    if (!job) return res.status(404).json({ error: "scan not found" });
    res.json(job);
  });

  app.post("/api/scans/:id/cancel", (req, res) => {
    const job = engine.cancelScan(req.params.id);
    if (!job) return res.status(404).json({ error: "scan not found" });
    res.json(job);
  });

  app.get("/api/scans/:id/summary", (req, res) => {
    const summary = engine.summary(req.params.id);
    if (!summary) return res.status(404).json({ error: "scan not found" });
    res.json(summary);
  });

  app.get("/api/scans/:id/findings", (req, res) => {
    const job = engine.getScan(req.params.id);
    if (!job) return res.status(404).json({ error: "scan not found" });
    const cls = req.query.class as FindingClass | undefined;
    res.json(engine.findings(req.params.id, cls));
  });

  app.get("/api/findings/:id", (req, res) => {
    const finding = engine.finding(req.params.id);
    if (!finding) return res.status(404).json({ error: "finding not found" });
    res.json(finding);
  });

  app.post("/api/findings/:id/preview", (req, res) => {
    try {
      res.json(engine.preview(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/actions/apply", async (req, res) => {
    const token = String(req.body?.token ?? "");
    const confirm = req.body?.confirm === true;
    try {
      res.json(await engine.apply(token, confirm));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const renderer = rendererCandidates.find((p) => existsSync(join(p, "index.html")));
  if (renderer) app.use(express.static(renderer));

  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "not found" });
    next();
  });

  return app;
}

export async function startServer(opts?: { port?: number; host?: string }) {
  const port = opts?.port ?? Number(process.env.SPACETRASH_PORT ?? 3847);
  const host = opts?.host ?? process.env.SPACETRASH_HOST ?? "127.0.0.1";
  const app = buildApp();
  return new Promise<{ port: number; host: string }>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`SpaceTrash API on http://${host}:${port}`);
      resolve({ port, host });
    });
    server.on("error", reject);
  });
}

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
