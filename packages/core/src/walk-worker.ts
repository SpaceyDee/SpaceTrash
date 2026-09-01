import { parentPort, workerData } from "node:worker_threads";
import { lstat, opendir } from "node:fs/promises";
import type { Dir } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { isDeniedForScan } from "./deny.ts";
import { extOf, normalizePath } from "./paths.ts";
import { getInventory, listChildDirs, listInventoryChildren } from "./db.ts";
import type { WalkFileRow, WalkWorkerData, WalkWorkerOut } from "./walk-messages.ts";

const port = parentPort;
if (!port) throw new Error("walk-worker must run as a worker thread");

const { root, dbPath } = workerData as WalkWorkerData;
let cancelled = false;
port.on("message", (msg: { type?: string }) => {
  if (msg?.type === "cancel") cancelled = true;
});

function send(msg: WalkWorkerOut): void {
  port!.postMessage(msg);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnotdir(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOTDIR");
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 5000");

let filesSeen = 0;
let filesWalked = 0;
let filesSkipped = 0;
let bytesSeen = 0;
let lastTick = 0;
let batch: WalkFileRow[] = [];

const flush = () => {
  if (batch.length === 0) return;
  send({ type: "batch", rows: batch });
  batch = [];
};

const tick = (currentPath: string, force = false) => {
  if (!force && filesSeen - lastTick < 80) return;
  lastTick = filesSeen;
  send({
    type: "progress",
    filesSeen,
    filesWalked,
    filesSkipped,
    bytesSeen,
    currentPath,
  });
};

const record = (row: WalkFileRow) => {
  batch.push(row);
  filesSeen += 1;
  filesWalked += 1;
  if (!row.is_dir) bytesSeen += row.size;
  if (batch.length >= 200) flush();
  tick(row.path);
};

async function openDir(dir: string, isRoot: boolean): Promise<Dir | "not-dir" | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await opendir(dir);
    } catch (err) {
      if (isEnotdir(err)) return "not-dir";
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      if (isRoot) send({ type: "error", path: dir, message: errMessage(err) });
      return undefined;
    }
  }
  return undefined;
}

async function visit(dir: string, isRoot: boolean): Promise<void> {
  if (cancelled) return;
  const n = normalizePath(dir);
  if (isDeniedForScan(n)) return;

  let st;
  try {
    st = await lstat(n);
  } catch (err) {
    if (isRoot) send({ type: "error", path: n, message: errMessage(err) });
    return;
  }
  if (st.isSymbolicLink()) return;
  if (!st.isDirectory()) return;

  const mtimeMs = Math.floor(st.mtimeMs);
  const cached = getInventory(db, n);
  if (cached && cached.is_dir === 1 && cached.checked === 1 && cached.mtime_ms === mtimeMs) {
    const kids = listInventoryChildren(db, n);
    send({ type: "skipDir", parent: n });
    filesSeen += kids.length;
    filesSkipped += kids.length;
    bytesSeen += kids.filter((k) => k.is_dir === 0).reduce((sum, k) => sum + k.size, 0);
    tick(n, true);
    for (const child of listChildDirs(db, n)) {
      if (cancelled) return;
      await visit(child, false);
    }
    return;
  }

  const handle = await openDir(n, isRoot);
  if (handle === "not-dir") return;
  if (!handle) return;

  const seen = new Set<string>();
  let walked = 0;
  try {
    for await (const dirent of handle) {
      if (cancelled) return;
      const name = dirent.name;
      const full = normalizePath(join(n, name));
      if (isDeniedForScan(full, name)) continue;

      let isDir = false;
      let isLink = false;
      try {
        isLink = dirent.isSymbolicLink();
        isDir = dirent.isDirectory();
      } catch {
        continue;
      }
      if (isLink) continue;

      let size = 0;
      let childMtime = 0;
      try {
        const childSt = await lstat(full);
        size = childSt.size;
        childMtime = Math.floor(childSt.mtimeMs);
        if (childSt.isSymbolicLink()) continue;
        isDir = childSt.isDirectory();
      } catch {
        continue;
      }

      seen.add(full);
      record({
        path: full,
        parent: n,
        name,
        ext: extOf(name),
        size,
        mtime_ms: childMtime,
        is_dir: isDir ? 1 : 0,
      });
      walked += 1;
      if (walked % 32 === 0) await new Promise((r) => setImmediate(r));
      if (isDir) await visit(full, false);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (cancelled) return;

  const gone = listInventoryChildren(db, n)
    .map((row) => row.path)
    .filter((path) => !seen.has(path));
  if (gone.length) send({ type: "gone", paths: gone });

  send({
    type: "markChecked",
    path: n,
    parent: normalizePath(dirname(n)),
    name: n.split(/[/\\]/).filter(Boolean).pop() ?? n,
    size: st.size,
    mtime_ms: mtimeMs,
  });
}

async function main(): Promise<void> {
  const n = normalizePath(root);
  if (isDeniedForScan(n)) {
    send({ type: "done" });
    return;
  }
  try {
    await visit(n, true);
    flush();
    tick(n, true);
  } catch (err) {
    send({ type: "error", path: n, message: errMessage(err) });
  }
  send({ type: "done" });
}

void main().finally(() => {
  db.close();
});
