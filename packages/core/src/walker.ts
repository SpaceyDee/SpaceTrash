import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import { isDeniedForScan } from "./deny.ts";
import { extOf, normalizePath } from "./paths.ts";
import { copyInventoryChildrenToScan, deleteInventorySubtree, upsertInventory } from "./db.ts";
import type { WalkWorkerData, WalkWorkerOut } from "./walk-messages.ts";

export interface WalkError {
  path: string;
  message: string;
}

export interface RootProgress {
  root: string;
  filesSeen: number;
  filesSkipped: number;
  filesWalked: number;
  bytesSeen: number;
  currentPath: string;
  error?: string;
  done?: boolean;
}

export interface WalkProgress {
  filesSeen: number;
  bytesSeen: number;
  filesSkipped: number;
  filesWalked: number;
  currentPath: string;
  rootProgress: RootProgress[];
  errors: WalkError[];
}

function rootLabel(root: string): string {
  const n = normalizePath(root);
  const drive = n.match(/^[a-zA-Z]:/);
  if (drive) return drive[0];
  return n.replace(/\\/g, "/").split("/").filter(Boolean).pop() || n;
}

function summarize(roots: RootProgress[]): string {
  return roots
    .map((r) => {
      const label = rootLabel(r.root);
      if (r.done && !r.error) return `${label} done`;
      if (r.error && !r.currentPath) return `${label} ${r.error}`;
      const extra = r.done ? " done" : "";
      return `${label} ${r.currentPath || ""}${extra}`.trim();
    })
    .join(" · ");
}

function workerExecArgv(workerPath: string): string[] {
  if (!workerPath.endsWith(".ts")) return [];
  const out: string[] = [];
  const args = process.execArgv;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--import" || args[i] === "--require") && args[i + 1]) {
      out.push(args[i], args[++i]);
    }
  }
  if (out.length === 0) out.push("--import", "tsx");
  return out;
}

function resolveWorker(): string {
  const fromEnv = process.env.SPACETRASH_WALK_WORKER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const meta = import.meta as { url?: string };
    if (meta.url) {
      const here = dirname(fileURLToPath(meta.url));
      const ts = join(here, "walk-worker.ts");
      if (existsSync(ts)) return ts;
      const cjs = join(here, "walk-worker.cjs");
      if (existsSync(cjs)) return cjs;
    }
  } catch {
    // bundled CJS has no import.meta.url
  }
  throw new Error("SpaceTrash walk worker not found");
}

function dbFile(db: Database.Database): string {
  const name = (db as Database.Database & { name?: string }).name;
  if (name && name !== ":memory:") return name;
  throw new Error("walk workers need a file-backed database");
}

export async function walkRoots(
  db: Database.Database,
  scanId: string,
  roots: string[],
  onProgress: (p: WalkProgress) => void,
  shouldCancel: () => boolean,
): Promise<WalkProgress> {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO files (scan_id, path, parent, name, ext, size, mtime_ms, is_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rows: { path: string; parent: string; name: string; ext: string; size: number; mtime_ms: number; is_dir: number }[]) => {
    for (const row of rows) {
      insert.run(scanId, row.path, row.parent, row.name, row.ext, row.size, row.mtime_ms, row.is_dir);
      upsertInventory(db, {
        path: row.path,
        parent: row.parent,
        name: row.name,
        ext: row.ext,
        size: row.size,
        mtime_ms: row.mtime_ms,
        is_dir: row.is_dir,
        checked: 0,
        last_seen_ms: Date.now(),
      });
    }
  });

  const errors: WalkError[] = [];
  const rootProgress: RootProgress[] = roots.map((root) => ({
    root,
    filesSeen: 0,
    filesSkipped: 0,
    filesWalked: 0,
    bytesSeen: 0,
    currentPath: "",
  }));

  const snapshot = (): WalkProgress => {
    let filesSeen = 0;
    let bytesSeen = 0;
    let filesSkipped = 0;
    let filesWalked = 0;
    for (const r of rootProgress) {
      filesSeen += r.filesSeen;
      filesSkipped += r.filesSkipped;
      filesWalked += r.filesWalked;
      bytesSeen += r.bytesSeen;
    }
    return {
      filesSeen,
      bytesSeen,
      filesSkipped,
      filesWalked,
      currentPath: summarize(rootProgress),
      rootProgress: rootProgress.map((r) => ({ ...r })),
      errors: [...errors],
    };
  };

  const emit = () => {
    if (!db.open) return;
    onProgress(snapshot());
  };

  const pending: { root: RootProgress; msg: WalkWorkerOut }[] = [];
  let pumpScheduled = false;
  let lastEmit = 0;

  const apply = (root: RootProgress, msg: WalkWorkerOut) => {
    if (!db.open) return;
    switch (msg.type) {
      case "batch":
        insertMany(msg.rows);
        break;
      case "skipDir":
        copyInventoryChildrenToScan(db, scanId, msg.parent);
        break;
      case "gone":
        for (const path of msg.paths) deleteInventorySubtree(db, path);
        break;
      case "markChecked":
        upsertInventory(db, {
          path: msg.path,
          parent: msg.parent,
          name: msg.name,
          ext: extOf(msg.name),
          size: msg.size,
          mtime_ms: msg.mtime_ms,
          is_dir: 1,
          checked: 1,
          last_seen_ms: Date.now(),
        });
        break;
      case "progress":
        root.filesSeen = msg.filesSeen;
        root.filesWalked = msg.filesWalked;
        root.filesSkipped = msg.filesSkipped;
        root.bytesSeen = msg.bytesSeen;
        root.currentPath = msg.currentPath;
        break;
      case "error":
        errors.push({ path: msg.path, message: msg.message });
        if (!root.error) root.error = msg.message;
        break;
      case "done":
        root.done = !root.error;
        break;
    }
  };

  const pump = () => {
    pumpScheduled = false;
    if (!db.open || shouldCancel()) {
      pending.length = 0;
      return;
    }
    const deadline = Date.now() + 8;
    try {
      while (pending.length && Date.now() < deadline) {
        const item = pending.shift();
        if (!item) break;
        apply(item.root, item.msg);
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/not open|closed/i.test(text)) {
        pending.length = 0;
        return;
      }
      errors.push({ path: "", message: text });
    }
    const now = Date.now();
    if (now - lastEmit >= 250) {
      lastEmit = now;
      emit();
    }
    if (pending.length) {
      pumpScheduled = true;
      setImmediate(pump);
    }
  };

  const enqueue = (root: RootProgress, msg: WalkWorkerOut) => {
    pending.push({ root, msg });
    if (pumpScheduled) return;
    pumpScheduled = true;
    setImmediate(pump);
  };

  const drain = async () => {
    while (pending.length || pumpScheduled) {
      if (!pumpScheduled && pending.length) {
        pumpScheduled = true;
        setImmediate(pump);
      }
      await new Promise((r) => setImmediate(r));
    }
  };

  const workerPath = resolveWorker();
  const dbPath = dbFile(db);
  const workers: Worker[] = [];

  const runRoot = (root: RootProgress) =>
    new Promise<void>((resolve, reject) => {
      const n = normalizePath(root.root);
      if (shouldCancel() || isDeniedForScan(n)) {
        root.done = true;
        emit();
        resolve();
        return;
      }
      const worker = new Worker(workerPath, {
        workerData: { root: root.root, dbPath } satisfies WalkWorkerData,
        execArgv: workerExecArgv(workerPath),
      });
      workers.push(worker);
      let settled = false;
      let cancelWatch: ReturnType<typeof setInterval> | undefined;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (cancelWatch) clearInterval(cancelWatch);
        if (err) reject(err);
        else resolve();
      };
      const stop = () => {
        worker.postMessage({ type: "cancel" });
        void worker.terminate();
      };
      cancelWatch = setInterval(() => {
        if (shouldCancel()) stop();
      }, 50);
      worker.on("message", (msg: WalkWorkerOut) => {
        try {
          enqueue(root, msg);
          if (msg.type === "done") finish();
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          if (/not open|closed/i.test(text)) {
            finish();
            return;
          }
          finish(err instanceof Error ? err : new Error(text));
        }
      });
      worker.on("error", (err) => {
        errors.push({ path: root.root, message: err.message });
        root.error = err.message;
        root.done = false;
        finish();
      });
      worker.on("exit", (code) => {
        if (!root.done && !root.error && code !== 0) {
          root.error = `walker exited ${code}`;
          errors.push({ path: root.root, message: root.error });
        }
        if (!root.done && !root.error) root.done = true;
        finish();
      });
    });

  try {
    await Promise.all(rootProgress.map((root) => runRoot(root)));
    await drain();
  } finally {
    for (const worker of workers) {
      void worker.terminate();
    }
  }
  emit();
  return snapshot();
}
