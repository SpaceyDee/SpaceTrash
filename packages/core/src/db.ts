import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath, ensureDataDir } from "./paths.ts";
import type { Finding, FindingClass, FindingStatus, ScanJob } from "./types.ts";

let singleton: Database.Database | null = null;

export function openDb(path = dbPath()): Database.Database {
  if (singleton) return singleton;
  mkdirSync(dirname(path), { recursive: true });
  ensureDataDir();
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  singleton = db;
  return db;
}

export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      roots TEXT NOT NULL,
      files_seen INTEGER NOT NULL DEFAULT 0,
      bytes_seen INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      progress REAL NOT NULL DEFAULT 0,
      current_path TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      scan_id TEXT NOT NULL,
      path TEXT NOT NULL,
      parent TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      is_dir INTEGER NOT NULL,
      PRIMARY KEY (scan_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_files_ext ON files(scan_id, ext);
    CREATE INDEX IF NOT EXISTS idx_files_size ON files(scan_id, size);
    CREATE INDEX IF NOT EXISTS idx_files_parent ON files(scan_id, parent);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      title TEXT NOT NULL,
      class TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      confidence REAL NOT NULL,
      why TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      action TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);

    CREATE TABLE IF NOT EXISTS classified (
      scan_id TEXT NOT NULL,
      path TEXT NOT NULL,
      class TEXT NOT NULL,
      PRIMARY KEY (scan_id, path)
    );

    CREATE TABLE IF NOT EXISTS previews (
      token TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function insertScan(db: Database.Database, job: ScanJob): void {
  db.prepare(
    `INSERT INTO scans (id, status, roots, files_seen, bytes_seen, started_at, finished_at, error, progress, current_path)
     VALUES (@id, @status, @roots, @filesSeen, @bytesSeen, @startedAt, @finishedAt, @error, @progress, @currentPath)`,
  ).run({
    id: job.id,
    status: job.status,
    roots: JSON.stringify(job.roots),
    filesSeen: job.filesSeen,
    bytesSeen: job.bytesSeen,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    error: job.error ?? null,
    progress: job.progress,
    currentPath: job.currentPath ?? null,
  });
}

export function updateScan(db: Database.Database, job: ScanJob): void {
  db.prepare(
    `UPDATE scans SET status=@status, files_seen=@filesSeen, bytes_seen=@bytesSeen,
      finished_at=@finishedAt, error=@error, progress=@progress, current_path=@currentPath
     WHERE id=@id`,
  ).run({
    id: job.id,
    status: job.status,
    filesSeen: job.filesSeen,
    bytesSeen: job.bytesSeen,
    finishedAt: job.finishedAt ?? null,
    error: job.error ?? null,
    progress: job.progress,
    currentPath: job.currentPath ?? null,
  });
}

export function rowToScan(row: Record<string, unknown>): ScanJob {
  return {
    id: String(row.id),
    status: row.status as ScanJob["status"],
    roots: JSON.parse(String(row.roots)),
    filesSeen: Number(row.files_seen),
    bytesSeen: Number(row.bytes_seen),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
    error: row.error == null ? undefined : String(row.error),
    progress: Number(row.progress),
    currentPath: row.current_path == null ? undefined : String(row.current_path),
  };
}

export function getScan(db: Database.Database, id: string): ScanJob | null {
  const row = db.prepare(`SELECT * FROM scans WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToScan(row) : null;
}

export function latestScan(db: Database.Database): ScanJob | null {
  const row = db.prepare(`SELECT * FROM scans ORDER BY started_at DESC LIMIT 1`).get() as
    | Record<string, unknown>
    | undefined;
  return row ? rowToScan(row) : null;
}

export function runningScan(db: Database.Database): ScanJob | null {
  const row = db.prepare(`SELECT * FROM scans WHERE status IN ('queued','running') ORDER BY started_at DESC LIMIT 1`).get() as
    | Record<string, unknown>
    | undefined;
  return row ? rowToScan(row) : null;
}

export function insertFinding(db: Database.Database, finding: Finding): void {
  db.prepare(
    `INSERT INTO findings (id, scan_id, title, class, bytes, file_count, confidence, why, paths_json, action, risk, status)
     VALUES (@id, @scanId, @title, @class, @bytes, @fileCount, @confidence, @why, @pathsJson, @action, @risk, @status)`,
  ).run({
    id: finding.id,
    scanId: finding.scanId,
    title: finding.title,
    class: finding.class,
    bytes: finding.bytes,
    fileCount: finding.fileCount,
    confidence: finding.confidence,
    why: finding.why,
    pathsJson: JSON.stringify(finding.paths),
    action: finding.action,
    risk: finding.risk,
    status: finding.status,
  });
}

function rowToFinding(row: Record<string, unknown>): Finding {
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    title: String(row.title),
    class: row.class as FindingClass,
    bytes: Number(row.bytes),
    fileCount: Number(row.file_count),
    confidence: Number(row.confidence),
    why: String(row.why),
    paths: JSON.parse(String(row.paths_json)),
    action: row.action as Finding["action"],
    risk: row.risk as Finding["risk"],
    status: row.status as FindingStatus,
  };
}

export function listFindings(db: Database.Database, scanId: string, cls?: FindingClass): Finding[] {
  const rows = cls
    ? (db.prepare(`SELECT * FROM findings WHERE scan_id = ? AND class = ? ORDER BY bytes DESC`).all(scanId, cls) as Record<string, unknown>[])
    : (db.prepare(`SELECT * FROM findings WHERE scan_id = ? ORDER BY bytes DESC`).all(scanId) as Record<string, unknown>[]);
  return rows.map(rowToFinding);
}

export function getFinding(db: Database.Database, id: string): Finding | null {
  const row = db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToFinding(row) : null;
}

export function setFindingStatus(db: Database.Database, id: string, status: FindingStatus): void {
  db.prepare(`UPDATE findings SET status = ? WHERE id = ?`).run(status, id);
}

export function markClassified(db: Database.Database, scanId: string, path: string, cls: FindingClass): boolean {
  const info = db.prepare(`INSERT OR IGNORE INTO classified (scan_id, path, class) VALUES (?, ?, ?)`).run(scanId, path, cls);
  return info.changes > 0;
}

export function classifiedBytes(db: Database.Database, scanId: string): Record<FindingClass, number> {
  const rows = db
    .prepare(
      `SELECT c.class AS class, COALESCE(SUM(f.size), 0) AS bytes
       FROM classified c
       LEFT JOIN files f ON f.scan_id = c.scan_id AND f.path = c.path
       WHERE c.scan_id = ?
       GROUP BY c.class`,
    )
    .all(scanId) as { class: FindingClass; bytes: number }[];
  const out: Record<FindingClass, number> = { removable: 0, bloat: 0, archiveable: 0, keep: 0 };
  for (const row of rows) out[row.class] = Number(row.bytes);
  return out;
}
