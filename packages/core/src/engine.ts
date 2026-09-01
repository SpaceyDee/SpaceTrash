import { randomBytes } from "node:crypto";
import type {
  ActionKind,
  ApplyResult,
  ArchiveKind,
  ArchiveState,
  EngineStatus,
  Finding,
  FindingClass,
  Preview,
  ScanJob,
  ScanOptions,
  ScanSummary,
  Volume,
} from "./types.ts";
import { VERSION, dataDir, ensureDataDir, pathEquals, pathIsUnder } from "./paths.ts";
import {
  abandonOpenScans,
  classifiedBytes,
  clearScanIndex,
  closeDb,
  getArchiveRoot,
  getFinding,
  getScan,
  getSetting,
  insertScan,
  isProtectedPath,
  latestScan,
  listArchiveKinds,
  listFindings,
  listProtectedRoots,
  openDb,
  resetClassification,
  runningScan,
  setArchiveKindPath,
  setArchiveRootDb,
  setFindingStatus,
  setProtectedRoot,
  setSetting,
  updateScan,
} from "./db.ts";
import { defaultScanRoots, listVolumes } from "./volumes.ts";
import { walkRoots } from "./walker.ts";
import { classifyScan } from "./rules.ts";
import { recyclePath } from "./recycle.ts";
import { assertActionAllowed } from "./deny.ts";
import {
  assertArchiveRootAllowed,
  defaultKindDir,
  inferredArchiveRoot,
  kindTitle,
  moveIntoArchive,
} from "./archive.ts";
import { basename } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PROTECTED_ACTION_ERROR =
  "That path is on a protected archive. SpaceTrash will not recycle it.";

export function createEngine() {
  ensureDataDir();
  const db = openDb();
  const cancel = new Set<string>();
  let stopped = false;

  const abandoned = abandonOpenScans(db, "Interrupted when SpaceTrash last exited");
  if (abandoned > 0) {
    console.log(`[spacetrash] cleared ${abandoned} leftover scan(s) from a previous run`);
  }

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
      lastAppVersion: getSetting(db, "last_app_version"),
      needsScanWipe: (getSetting(db, "last_app_version") ?? VERSION) !== VERSION,
    };
  }

  function decorateVolumes(vols: Volume[]): Volume[] {
    const roots = listProtectedRoots(db);
    return vols.map((v) => ({
      ...v,
      protected: roots.some((root) => pathEquals(root, v.path)),
    }));
  }

  function assertNotProtected(fullPath: string): void {
    if (isProtectedPath(db, fullPath)) throw new Error(PROTECTED_ACTION_ERROR);
  }

  function reclassifyLatestIfIdle(): void {
    if (runningScan(db)) return;
    const last = latestScan(db);
    if (!last || last.status !== "complete") return;
    resetClassification(db, last.id);
    classifyScan(db, last.id, { roots: last.roots });
  }

  async function volumes(): Promise<Volume[]> {
    return decorateVolumes(await listVolumes());
  }

  async function setProtected(root: string, on: boolean): Promise<Volume[]> {
    setProtectedRoot(db, root, on);
    reclassifyLatestIfIdle();
    return volumes();
  }

  function archiveState(): ArchiveState {
    return {
      root: getArchiveRoot(db),
      kinds: listArchiveKinds(db).map((row) => ({
        kind: row.kind,
        path: row.path,
        name: basename(row.path) || kindTitle(row.kind),
      })),
    };
  }

  function setArchiveRoot(root: string): ArchiveState {
    assertArchiveRootAllowed(root);
    setArchiveRootDb(db, root);
    reclassifyLatestIfIdle();
    return archiveState();
  }

  function setKindFolder(kind: ArchiveKind, folder: string): ArchiveState {
    setArchiveKindPath(db, kind, folder);
    if (!getArchiveRoot(db)) setArchiveRootDb(db, inferredArchiveRoot(folder));
    reclassifyLatestIfIdle();
    return archiveState();
  }

  function clearScanData(): void {
    clearScanIndex(db);
    setSetting(db, "last_app_version", VERSION);
  }

  function resolveScanWipe(wipe: boolean): void {
    if (wipe) clearScanIndex(db);
    setSetting(db, "last_app_version", VERSION);
  }

  function startScan(input: Partial<ScanOptions> & { roots?: string[] }): ScanJob {
    if (stopped) throw new Error("SpaceTrash is shutting down");
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

      let lastProgressWrite = 0;
      const walked = await walkRoots(
        db,
        id,
        roots,
        (p) => {
          let live;
          try {
            live = getScan(db, id);
          } catch {
            return;
          }
          if (!live || live.status === "cancelled" || cancel.has(id)) return;
          live.filesSeen = p.filesSeen;
          live.bytesSeen = p.bytesSeen;
          live.filesSkipped = p.filesSkipped;
          live.filesWalked = p.filesWalked;
          live.currentPath = p.currentPath;
          live.progress = Math.min(0.85, 0.05 + (p.filesWalked + p.filesSkipped) / 200_000);
          const now = Date.now();
          if (now - lastProgressWrite < 250) return;
          lastProgressWrite = now;
          if (db.open) updateScan(db, live);
        },
        () => cancel.has(id) || !db.open,
      );

      if (!db.open) return;
      const afterWalk = getScan(db, id);
      if (!afterWalk || afterWalk.status === "cancelled" || cancel.has(id) || stopped) {
        const live = afterWalk ?? getScan(db, id);
        if (live && live.status !== "cancelled") {
          live.status = "cancelled";
          live.finishedAt = Date.now();
          live.error = live.error ?? "Cancelled";
          live.progress = walked.filesSeen > 0 ? 1 : 0;
          updateScan(db, live);
        }
        return;
      }

      afterWalk.filesSeen = walked.filesSeen;
      afterWalk.bytesSeen = walked.bytesSeen;
      afterWalk.filesSkipped = walked.filesSkipped;
      afterWalk.filesWalked = walked.filesWalked;
      afterWalk.progress = 0.9;
      afterWalk.currentPath = walked.errors.length
        ? `classifying · ${walked.errors.length} walk warning(s)`
        : "classifying";
      if (walked.errors.length) {
        afterWalk.error = walked.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
      }
      const fatalWalk = walked.errors.some((e) =>
        /memory limit|heap out of memory|Worker terminated|walker exited/i.test(e.message),
      );
      if (fatalWalk) {
        afterWalk.status = "failed";
        afterWalk.finishedAt = Date.now();
        afterWalk.progress = 1;
        afterWalk.currentPath = "";
        updateScan(db, afterWalk);
        return;
      }
      updateScan(db, afterWalk);
      await new Promise((r) => setImmediate(r));
      if (!db.open || cancel.has(id) || stopped) return;

      classifyScan(db, id, { ...options, roots });

      const done = getScan(db, id)!;
      if (done.status === "cancelled" || cancel.has(id) || stopped) return;
      done.status = "complete";
      done.finishedAt = Date.now();
      done.progress = 1;
      done.currentPath = "";
      updateScan(db, done);
    } catch (err) {
      if (!db.open) return;
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

  function preview(findingId: string, opts?: { action?: ActionKind; archiveRoot?: string }): Preview {
    const f = getFinding(db, findingId);
    if (!f) throw new Error(`Finding ${findingId} not found`);
    if (f.status === "applied") throw new Error("This finding was already applied");
    const allowed = f.allowedActions ?? [f.action];
    const action = opts?.action ?? f.action;
    if (!allowed.includes(action)) {
      throw new Error(`Action ${action} is not allowed for this finding`);
    }
    if (action === "recycle") {
      for (const p of f.paths) {
        assertActionAllowed(p);
        assertNotProtected(p);
      }
    } else if (action === "archive") {
      for (const p of f.paths) assertActionAllowed(p);
    }
    if (opts?.archiveRoot) {
      assertArchiveRootAllowed(opts.archiveRoot);
      setArchiveRootDb(db, opts.archiveRoot);
    }
    if (action === "archive" && !f.destPath && !getArchiveRoot(db)) {
      throw new Error("Pick an archive root before moving files.");
    }
    const token = randomBytes(24).toString("hex");
    const now = Date.now();
    db.prepare(
      `INSERT INTO previews (token, finding_id, action, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(token, f.id, action, now, now + PREVIEW_TTL_MS);
    setFindingStatus(db, f.id, "previewed");
    return {
      token,
      findingId: f.id,
      action,
      paths: f.paths,
      bytes: f.bytes,
      expiresAt: now + PREVIEW_TTL_MS,
      destPath: f.destPath,
      needsArchiveRoot: f.needsArchiveRoot,
      allowedActions: allowed,
    };
  }

  async function apply(token: string, confirm: boolean): Promise<ApplyResult> {
    if (!confirm) throw new Error("Apply rejected: confirm must be true");
    if (!token) throw new Error("Apply rejected: preview token required");
    if (runningScan(db)) throw new Error("Apply rejected: a scan is running");
    const row = db.prepare(`SELECT * FROM previews WHERE token = ?`).get(token) as
      | { token: string; finding_id: string; action: string; expires_at: number; used: number }
      | undefined;
    if (!row) throw new Error("Apply rejected: unknown preview token");
    if (row.used) throw new Error("Apply rejected: preview token already used");
    if (Date.now() > row.expires_at) throw new Error("Apply rejected: preview token expired");

    const f = getFinding(db, row.finding_id);
    if (!f) throw new Error("Finding disappeared after preview");
    const action = row.action as ActionKind;

    db.prepare(`UPDATE previews SET used = 1 WHERE token = ?`).run(token);

    const recycled: string[] = [];
    const moved: string[] = [];
    const failed: { path: string; error: string }[] = [];

    if (action === "label") {
      const folder = f.destPath || f.paths[0];
      if (!folder) throw new Error("No archive folder to label");
      if (f.kind) setArchiveKindPath(db, f.kind, folder);
      if (!getArchiveRoot(db)) setArchiveRootDb(db, inferredArchiveRoot(folder));
      if (f.kind && !existsSync(folder)) mkdirSync(folder, { recursive: true });
      setFindingStatus(db, f.id, "applied");
      reclassifyLatestIfIdle();
      return { findingId: f.id, action, recycled, moved, failed };
    }

    if (action === "recycle") {
      for (const p of f.paths) {
        try {
          assertActionAllowed(p);
          assertNotProtected(p);
          await recyclePath(p);
          recycled.push(p);
        } catch (err) {
          failed.push({ path: p, error: err instanceof Error ? err.message : String(err) });
        }
      }
      setFindingStatus(db, f.id, failed.length && !recycled.length ? "failed" : "applied");
      return { findingId: f.id, action, recycled, moved, failed };
    }

    if (action !== "archive") {
      throw new Error(`Action ${action} cannot be applied`);
    }

    if (!f.kind && !f.destPath) {
      throw new Error(
        "Large unused-file archive moves are still preview-only. Use a Disk images or Installers finding, or move those files yourself.",
      );
    }

    let dest = f.destPath;
    if (!dest) {
      const root = getArchiveRoot(db);
      if (!root || !f.kind) throw new Error("Pick an archive root before moving files.");
      dest = defaultKindDir(root, f.kind);
      setArchiveKindPath(db, f.kind, dest);
    }
    mkdirSync(dest, { recursive: true });

    for (const p of f.paths) {
      try {
        if (f.destPath && pathIsUnder(p, dest)) {
          throw new Error("That file is already in the archive folder.");
        }
        assertActionAllowed(p);
        const landed = await moveIntoArchive(p, dest);
        moved.push(landed);
      } catch (err) {
        failed.push({ path: p, error: err instanceof Error ? err.message : String(err) });
      }
    }
    setFindingStatus(db, f.id, failed.length && !moved.length ? "failed" : "applied");
    return { findingId: f.id, action, recycled, moved, failed };
  }

  function cancelScan(id: string, reason = "Cancelled"): ScanJob | null {
    const job = getScan(db, id);
    if (!job) return null;
    if (job.status === "running" || job.status === "queued") {
      cancel.add(id);
      job.status = "cancelled";
      job.finishedAt = Date.now();
      job.error = reason;
      job.currentPath = "";
      updateScan(db, job);
    }
    return getScan(db, id);
  }

  function shutdown(reason = "SpaceTrash shut down"): void {
    if (stopped) return;
    stopped = true;
    const open = runningScan(db);
    if (open) cancelScan(open.id, reason);
    abandonOpenScans(db, reason);
    closeDb();
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
    setProtected,
    archiveState,
    setArchiveRoot,
    setKindFolder,
    clearScanData,
    resolveScanWipe,
    cancelScan,
    shutdown,
  };
}

export type Engine = ReturnType<typeof createEngine>;

let shared: Engine | null = null;
let hooksAttached = false;

export function getEngine(): Engine {
  if (!shared) {
    shared = createEngine();
    if (!hooksAttached) {
      hooksAttached = true;
      const stop = () => {
        stopEngine("SpaceTrash process exiting");
      };
      process.once("SIGINT", () => {
        stop();
        process.exit(0);
      });
      process.once("SIGTERM", () => {
        stop();
        process.exit(0);
      });
      process.once("exit", stop);
    }
  }
  return shared;
}

export function stopEngine(reason = "SpaceTrash shut down"): void {
  if (!shared) return;
  try {
    shared.shutdown(reason);
  } catch {
    // ignore
  }
  shared = null;
}
