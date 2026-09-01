import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { getEngine, stopEngine, type FindingClass } from "@spacetrash/core";

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return eval("__dirname") as string;
  }
}

const here = moduleDir();

export function buildApp(opts?: { rendererDir?: string }) {
  const engine = getEngine();
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/status", (_req, res) => {
    res.json({
      ...engine.status(),
      updateUrl: process.env.SPACETRASH_UPDATE_URL || null,
    });
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

  app.post("/api/shutdown", async (_req, res) => {
    res.json({ ok: true });
    setImmediate(() => {
      void stopServer();
    });
  });

  const rendererCandidates = [
    opts?.rendererDir,
    join(here, "../../desktop/renderer"),
    join(here, "../../../packages/desktop/renderer"),
    join(here, "../renderer"),
  ].filter((p): p is string => Boolean(p));
  const renderer = rendererCandidates.find((p) => existsSync(join(p, "index.html")));
  if (renderer) app.use(express.static(renderer));

  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "not found" });
    next();
  });

  return app;
}

let httpServer: Server | null = null;

export async function startServer(opts?: { port?: number; host?: string; rendererDir?: string }) {
  const port = opts?.port ?? Number(process.env.SPACETRASH_PORT ?? 3847);
  const host = opts?.host ?? process.env.SPACETRASH_HOST ?? "127.0.0.1";
  const app = buildApp({ rendererDir: opts?.rendererDir });
  return new Promise<{ port: number; host: string }>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      httpServer = server;
      console.log(`SpaceTrash API on http://${host}:${port}`);
      resolve({ port, host });
    });
    server.on("error", reject);
  });
}

export async function stopServer(): Promise<void> {
  stopEngine("SpaceTrash shut down");
  const server = httpServer;
  httpServer = null;
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1500);
  });
}
