import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath, ensureDataDir, normalizePath, pathEquals, pathIsUnder, VERSION } from "./paths.ts";
import type { ActionKind, ArchiveKind, Finding, FindingClass, FindingStatus, ScanJob } from "./types.ts";

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

    CREATE TABLE IF NOT EXISTS inventory (
      path TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      is_dir INTEGER NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      last_seen_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS protected_roots (
      path TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archive_kinds (
      kind TEXT PRIMARY KEY,
      path TEXT NOT NULL
    );
  `);
  ensureColumn(db, "scans", "files_skipped", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "scans", "files_walked", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "findings", "meta_json", "TEXT");
  seedInventoryFromLatestScan(db);
  repairInventorySelfParents(db);
  seedAppVersion(db);
}

function seedAppVersion(db: Database.Database): void {
  if (getSetting(db, "last_app_version")) return;
  const hasScans = db.prepare(`SELECT 1 FROM scans LIMIT 1`).get();
  setSetting(db, "last_app_version", hasScans ? "0.0.0" : VERSION);
}

function ensureColumn(db: Database.Database, table: string, name: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((col) => col.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

export function repairInventorySelfParents(db: Database.Database): number {
  const info = db.prepare(`DELETE FROM inventory WHERE path = parent`).run();
  return info.changes;
}

export function seedInventoryFromLatestScan(db: Database.Database): number {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM inventory`).get() as { n: number };
  if (existing.n > 0) return 0;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO inventory (path, parent, name, ext, size, mtime_ms, is_dir, checked, last_seen_ms)
       SELECT f.path, f.parent, f.name, f.ext, f.size, f.mtime_ms, f.is_dir, 1, COALESCE(f.mtime_ms, 0)
       FROM files f
       INNER JOIN scans s ON s.id = f.scan_id
       WHERE s.status = 'complete'`,
    )
    .run();
  return info.changes;
}

export interface InventoryRow {
  path: string;
  parent: string;
  name: string;
  ext: string;
  size: number;
  mtime_ms: number;
  is_dir: number;
  checked: number;
  last_seen_ms: number;
}

export function getInventory(db: Database.Database, path: string): InventoryRow | undefined {
  return db.prepare(`SELECT * FROM inventory WHERE path = ?`).get(path) as InventoryRow | undefined;
}

const upsertInventorySql = `INSERT INTO inventory (path, parent, name, ext, size, mtime_ms, is_dir, checked, last_seen_ms)
     VALUES (@path, @parent, @name, @ext, @size, @mtime_ms, @is_dir, @checked, @last_seen_ms)
     ON CONFLICT(path) DO UPDATE SET
       parent = excluded.parent,
       name = excluded.name,
       ext = excluded.ext,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       is_dir = excluded.is_dir,
       checked = MAX(inventory.checked, excluded.checked),
       last_seen_ms = excluded.last_seen_ms`;

const upsertInventoryStmt = new WeakMap<Database.Database, Database.Statement>();

export function upsertInventory(db: Database.Database, row: InventoryRow): void {
  let stmt = upsertInventoryStmt.get(db);
  if (!stmt) {
    stmt = db.prepare(upsertInventorySql);
    upsertInventoryStmt.set(db, stmt);
  }
  stmt.run(row);
}

export function listInventoryChildren(db: Database.Database, parent: string): InventoryRow[] {
  return db.prepare(`SELECT * FROM inventory WHERE parent = ? AND path != parent`).all(parent) as InventoryRow[];
}

export function inventoryChildStats(db: Database.Database, parent: string): { rows: number; bytes: number } {
  return db
    .prepare(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(CASE WHEN is_dir = 0 THEN size ELSE 0 END), 0) AS bytes
       FROM inventory WHERE parent = ? AND path != parent`,
    )
    .get(parent) as { rows: number; bytes: number };
}

export function listChildDirs(db: Database.Database, parent: string): string[] {
  return (
    db
      .prepare(`SELECT path FROM inventory WHERE parent = ? AND is_dir = 1 AND path != parent`)
      .all(parent) as { path: string }[]
  ).map((row) => row.path);
}

export function deleteInventorySubtree(db: Database.Database, path: string): void {
  db.prepare(
    `DELETE FROM inventory
     WHERE path = ?
        OR path LIKE ? || '\\%'
        OR path LIKE ? || '/%'`,
  ).run(path, path, path);
}

export function copyInventoryChildrenToScan(
  db: Database.Database,
  scanId: string,
  parent: string,
): { rows: number; bytes: number } {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO files (scan_id, path, parent, name, ext, size, mtime_ms, is_dir)
       SELECT ?, path, parent, name, ext, size, mtime_ms, is_dir
       FROM inventory WHERE parent = ? AND path != parent`,
    )
    .run(scanId, parent);
  const bytes = db
    .prepare(`SELECT COALESCE(SUM(size), 0) AS bytes FROM inventory WHERE parent = ? AND is_dir = 0 AND path != parent`)
    .get(parent) as { bytes: number };
  return { rows: info.changes, bytes: Number(bytes.bytes) };
}

export function insertScan(db: Database.Database, job: ScanJob): void {
  db.prepare(
    `INSERT INTO scans (id, status, roots, files_seen, bytes_seen, started_at, finished_at, error, progress, current_path, files_skipped, files_walked)
     VALUES (@id, @status, @roots, @filesSeen, @bytesSeen, @startedAt, @finishedAt, @error, @progress, @currentPath, @filesSkipped, @filesWalked)`,
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
    filesSkipped: job.filesSkipped ?? 0,
    filesWalked: job.filesWalked ?? 0,
  });
}

export function updateScan(db: Database.Database, job: ScanJob): void {
  db.prepare(
    `UPDATE scans SET status=@status, files_seen=@filesSeen, bytes_seen=@bytesSeen,
      finished_at=@finishedAt, error=@error, progress=@progress, current_path=@currentPath,
      files_skipped=@filesSkipped, files_walked=@filesWalked
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
    filesSkipped: job.filesSkipped ?? 0,
    filesWalked: job.filesWalked ?? 0,
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
    filesSkipped: Number(row.files_skipped ?? 0),
    filesWalked: Number(row.files_walked ?? 0),
  };
}

export function getScan(db: Database.Database, id: string): ScanJob | null {
  const row = db.prepare(`SELECT * FROM scans WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToScan(row) : null;
}

export function latestScan(db: Database.Database): ScanJob | null {
  const complete = db
    .prepare(
      `SELECT * FROM scans
       WHERE status = 'complete' AND (error IS NULL OR error = '')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (complete) return rowToScan(complete);
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

export function abandonOpenScans(db: Database.Database, reason: string): number {
  const info = db
    .prepare(
      `UPDATE scans
       SET status = 'cancelled', finished_at = ?, error = ?, current_path = ''
       WHERE status IN ('queued', 'running')`,
    )
    .run(Date.now(), reason);
  return info.changes;
}

export function insertFinding(db: Database.Database, finding: Finding): void {
  const meta = {
    kind: finding.kind,
    allowedActions: finding.allowedActions,
    destPath: finding.destPath,
    needsArchiveRoot: finding.needsArchiveRoot,
  };
  db.prepare(
    `INSERT INTO findings (id, scan_id, title, class, bytes, file_count, confidence, why, paths_json, action, risk, status, meta_json)
     VALUES (@id, @scanId, @title, @class, @bytes, @fileCount, @confidence, @why, @pathsJson, @action, @risk, @status, @metaJson)`,
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
    metaJson: JSON.stringify(meta),
  });
}

function rowToFinding(row: Record<string, unknown>): Finding {
  let meta: {
    kind?: Finding["kind"];
    allowedActions?: ActionKind[];
    destPath?: string;
    needsArchiveRoot?: boolean;
  } = {};
  if (row.meta_json) {
    try {
      meta = JSON.parse(String(row.meta_json)) as typeof meta;
    } catch {
      meta = {};
    }
  }
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
    kind: meta.kind,
    allowedActions: meta.allowedActions,
    destPath: meta.destPath,
    needsArchiveRoot: meta.needsArchiveRoot,
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

export function resetClassification(db: Database.Database, scanId: string): void {
  db.prepare(
    `DELETE FROM previews WHERE finding_id IN (SELECT id FROM findings WHERE scan_id = ?)`,
  ).run(scanId);
  db.prepare(`DELETE FROM findings WHERE scan_id = ?`).run(scanId);
  db.prepare(`DELETE FROM classified WHERE scan_id = ?`).run(scanId);
}

export function listProtectedRoots(db: Database.Database): string[] {
  return (db.prepare(`SELECT path FROM protected_roots ORDER BY path`).all() as { path: string }[]).map((r) => r.path);
}

export function pathInProtectedRoots(nativePath: string, roots: string[]): boolean {
  const p = normalizePath(nativePath);
  return roots.some((root) => pathIsUnder(p, root));
}

export function setProtectedRoot(db: Database.Database, nativePath: string, on: boolean): void {
  const p = normalizePath(nativePath);
  if (!p) throw new Error("Protected path is empty");
  if (on) {
    if (listProtectedRoots(db).some((root) => pathEquals(root, p))) return;
    db.prepare(`INSERT OR IGNORE INTO protected_roots (path) VALUES (?)`).run(p);
    return;
  }
  for (const root of listProtectedRoots(db)) {
    if (pathEquals(root, p)) db.prepare(`DELETE FROM protected_roots WHERE path = ?`).run(root);
  }
}

export function isProtectedPath(db: Database.Database, nativePath: string): boolean {
  return pathInProtectedRoots(nativePath, listProtectedRoots(db));
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    key,
    value,
  );
}

export function getArchiveRoot(db: Database.Database): string | null {
  return getSetting(db, "archive_root");
}

export function setArchiveRootDb(db: Database.Database, nativePath: string): void {
  setSetting(db, "archive_root", normalizePath(nativePath));
}

export function listArchiveKinds(db: Database.Database): { kind: ArchiveKind; path: string }[] {
  return (db.prepare(`SELECT kind, path FROM archive_kinds`).all() as { kind: ArchiveKind; path: string }[]).map(
    (row) => ({ kind: row.kind, path: normalizePath(row.path) }),
  );
}

export function getArchiveKindPath(db: Database.Database, kind: ArchiveKind): string | null {
  const row = db.prepare(`SELECT path FROM archive_kinds WHERE kind = ?`).get(kind) as { path: string } | undefined;
  return row ? normalizePath(row.path) : null;
}

export function setArchiveKindPath(db: Database.Database, kind: ArchiveKind, nativePath: string): void {
  const p = normalizePath(nativePath);
  db.prepare(`INSERT INTO archive_kinds (kind, path) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET path = excluded.path`).run(
    kind,
    p,
  );
}

export function clearScanIndex(db: Database.Database): void {
  db.exec(`
    DELETE FROM previews;
    DELETE FROM findings;
    DELETE FROM classified;
    DELETE FROM files;
    DELETE FROM inventory;
    DELETE FROM scans;
  `);
}
