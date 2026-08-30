import { randomBytes } from "node:crypto";
import type {
  ApplyResult,
  EngineStatus,
  Finding,
  FindingClass,
  Preview,
  ScanJob,
  ScanOptions,
  ScanSummary,
  Volume,
} from "./types.ts";
import { VERSION, dataDir, ensureDataDir } from "./paths.ts";
import {
  classifiedBytes,
  getFinding,
  getScan,
  insertScan,
  latestScan,
  listFindings,
  openDb,
  runningScan,
  setFindingStatus,
  updateScan,
} from "./db.ts";
import { defaultScanRoots, listVolumes } from "./volumes.ts";
import { walkRoots } from "./walker.ts";
import { classifyScan } from "./rules.ts";
import { recyclePath } from "./recycle.ts";
import { assertActionAllowed } from "./deny.ts";

const PREVIEW_TTL_MS = 10 * 60 * 1000;

export function createEngine() {
  ensureDataDir();
  const db = openDb();
  const cancel = new Set<string>();

  function status(): EngineStatus {
    const active = runningScan(db);
    const last = latestScan(db);
    return {
      name: "SpaceTrash",
      version: VERSION,
      platform: process.platform,
      dataDir: dataDir(),
      activeScanId: active?.id ?? null,
      lastScanId: last?.id ?? null,
    };
  }

  async function volumes(): Promise<Volume[]> {
    return listVolumes();
  }

  function startScan(input: Partial<ScanOptions> & { roots?: string[] }): ScanJob {
    const existing = runningScan(db);
    if (existing) {
      throw new Error(`A scan is already ${existing.status} (${existing.id})`);
    }
    const roots = (input.roots && input.roots.length > 0 ? input.roots : null) ?? [];
    const job: ScanJob = {
      id: `scan_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      status: "queued",
      roots,
      filesSeen: 0,
      bytesSeen: 0,
      startedAt: Date.now(),
      progress: 0,
    };
    insertScan(db, job);

    const options: ScanOptions = {
      roots,
      installerMinBytes: input.installerMinBytes,
      largeMinBytes: input.largeMinBytes,
      unusedDays: input.unusedDays,
    };

    void runScan(job.id, options);
    return getScan(db, job.id)!;
  }

  async function runScan(id: string, options: ScanOptions): Promise<void> {
    const job = getScan(db, id);
    if (!job) return;
    try {
      let roots = options.roots;
      if (roots.length === 0) {
        roots = defaultScanRoots(await listVolumes());
        job.roots = roots;
      }
      job.status = "running";
      job.progress = 0.02;
      updateScan(db, job);

      const walked = await walkRoots(
        db,
        id,
        roots,
        (p) => {
          const live = getScan(db, id);
          if (!live) return;
          live.filesSeen = p.filesSeen;
          live.bytesSeen = p.bytesSeen;
          live.currentPath = p.currentPath;
          live.progress = Math.min(0.85, 0.05 + p.filesSeen / 200_000);
          updateScan(db, live);
        },
        () => cancel.has(id),
      );

      if (cancel.has(id)) {
        const live = getScan(db, id)!;
        live.status = "cancelled";
        live.finishedAt = Date.now();
        live.progress = walked.filesSeen > 0 ? 1 : 0;
        updateScan(db, live);
        return;
      }

      const live = getScan(db, id)!;
      live.filesSeen = walked.filesSeen;
      live.bytesSeen = walked.bytesSeen;
      live.progress = 0.9;
      live.currentPath = "classifying";
      updateScan(db, live);

      classifyScan(db, id, { ...options, roots });

      const done = getScan(db, id)!;
      done.status = "complete";
      done.finishedAt = Date.now();
      done.progress = 1;
      done.currentPath = "";
      updateScan(db, done);
    } catch (err) {
      const live = getScan(db, id);
      if (!live) return;
      live.status = "failed";
      live.error = err instanceof Error ? err.message : String(err);
      live.finishedAt = Date.now();
      updateScan(db, live);
    }
  }

  function getScanJob(id: string): ScanJob | null {
    return getScan(db, id);
  }

  function findings(scanId: string, cls?: FindingClass): Finding[] {
    return listFindings(db, scanId, cls);
  }

  function finding(id: string): Finding | null {
    return getFinding(db, id);
  }

  function summary(scanId: string): ScanSummary | null {
    const job = getScan(db, scanId);
    if (!job) return null;
    const listed = listFindings(db, scanId);
    const byClass: ScanSummary["byClass"] = {
      removable: { count: 0, bytes: 0 },
      bloat: { count: 0, bytes: 0 },
      archiveable: { count: 0, bytes: 0 },
      keep: { count: 0, bytes: 0 },
    };
    for (const f of listed) {
      byClass[f.class].count += 1;
      byClass[f.class].bytes += f.bytes;
    }
    const classified = classifiedBytes(db, scanId);
    const flagged = classified.removable + classified.bloat + classified.archiveable;
    byClass.keep.bytes = Math.max(0, job.bytesSeen - flagged);
    return {
      scanId,
      filesSeen: job.filesSeen,
      bytesSeen: job.bytesSeen,
      byClass,
      keepBytes: byClass.keep.bytes,
    };
  }

  function preview(findingId: string): Preview {
    const f = getFinding(db, findingId);
    if (!f) throw new Error(`Finding ${findingId} not found`);
    if (f.status === "applied") throw new Error("This finding was already applied");
    for (const p of f.paths) assertActionAllowed(p);
    const token = randomBytes(24).toString("hex");
    const now = Date.now();
    db.prepare(
      `INSERT INTO previews (token, finding_id, action, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(token, f.id, f.action, now, now + PREVIEW_TTL_MS);
    setFindingStatus(db, f.id, "previewed");
    return {
      token,
      findingId: f.id,
      action: f.action,
      paths: f.paths,
      bytes: f.bytes,
      expiresAt: now + PREVIEW_TTL_MS,
    };
  }

  async function apply(token: string, confirm: boolean): Promise<ApplyResult> {
    if (!confirm) throw new Error("Apply rejected: confirm must be true");
    if (!token) throw new Error("Apply rejected: preview token required");
    const row = db.prepare(`SELECT * FROM previews WHERE token = ?`).get(token) as
      | { token: string; finding_id: string; action: string; expires_at: number; used: number }
      | undefined;
    if (!row) throw new Error("Apply rejected: unknown preview token");
    if (row.used) throw new Error("Apply rejected: preview token already used");
    if (Date.now() > row.expires_at) throw new Error("Apply rejected: preview token expired");

    const f = getFinding(db, row.finding_id);
    if (!f) throw new Error("Finding disappeared after preview");

    if (f.action === "archive") {
      throw new Error(
        "Archive moves are preview-only in v1. Recycle is the only apply action. Re-scan after you move files yourself, or wait for archive destinations in v1.1.",
      );
    }
    if (f.action !== "recycle") {
      throw new Error(`Action ${f.action} cannot be applied`);
    }

    db.prepare(`UPDATE previews SET used = 1 WHERE token = ?`).run(token);

    const recycled: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const p of f.paths) {
      try {
        assertActionAllowed(p);
        await recyclePath(p);
        recycled.push(p);
      } catch (err) {
        failed.push({ path: p, error: err instanceof Error ? err.message : String(err) });
      }
    }
    setFindingStatus(db, f.id, failed.length && !recycled.length ? "failed" : "applied");
    return { findingId: f.id, action: f.action, recycled, failed };
  }

  function cancelScan(id: string): ScanJob | null {
    const job = getScan(db, id);
    if (!job) return null;
    if (job.status === "running" || job.status === "queued") cancel.add(id);
    return job;
  }

  return {
    status,
    volumes,
    startScan,
    getScan: getScanJob,
    findings,
    finding,
    summary,
    preview,
    apply,
    cancelScan,
  };
}

export type Engine = ReturnType<typeof createEngine>;

let shared: Engine | null = null;
export function getEngine(): Engine {
  if (!shared) shared = createEngine();
  return shared;
}
