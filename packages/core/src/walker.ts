import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { isDeniedForScan } from "./deny.ts";
import { extOf, normalizePath } from "./paths.ts";

export interface WalkProgress {
  filesSeen: number;
  bytesSeen: number;
  currentPath: string;
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
  const insertMany = db.transaction((rows: unknown[][]) => {
    for (const row of rows) insert.run(...row);
  });

  let filesSeen = 0;
  let bytesSeen = 0;
  let batch: unknown[][] = [];
  let lastTick = 0;

  const flush = () => {
    if (batch.length === 0) return;
    insertMany(batch);
    batch = [];
  };

  const visit = async (dir: string): Promise<void> => {
    if (shouldCancel()) return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }

    try {
      for await (const dirent of handle) {
        if (shouldCancel()) return;
        const name = dirent.name;
        const full = normalizePath(join(dir, name));

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
        let mtimeMs = 0;
        try {
          const st = await lstat(full);
          size = st.size;
          mtimeMs = st.mtimeMs;
          if (st.isSymbolicLink()) continue;
        } catch {
          continue;
        }

        batch.push([scanId, full, normalizePath(dir), name, extOf(name), size, Math.floor(mtimeMs), isDir ? 1 : 0]);
        filesSeen += 1;
        if (!isDir) bytesSeen += size;

        if (batch.length >= 400) flush();
        if (filesSeen - lastTick >= 250) {
          lastTick = filesSeen;
          onProgress({ filesSeen, bytesSeen, currentPath: full });
        }

        if (isDir) await visit(full);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  for (const root of roots) {
    if (shouldCancel()) break;
    const n = normalizePath(root);
    if (isDeniedForScan(n)) continue;
    await visit(n);
  }
  flush();
  onProgress({ filesSeen, bytesSeen, currentPath: "" });
  return { filesSeen, bytesSeen, currentPath: "" };
}
