import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { ActionKind, ArchiveKind, Finding, FindingClass, Risk, ScanOptions } from "./types.ts";
import {
  getArchiveRoot,
  insertFinding,
  listArchiveKinds,
  listProtectedRoots,
  markClassified,
  pathInProtectedRoots,
} from "./db.ts";
import { isDeniedForAction } from "./deny.ts";
import { CLUSTER_MIN, fileKind, isHotZonePath, kindTitle } from "./archive.ts";
import { pathIsUnder } from "./paths.ts";

interface FileRow {
  path: string;
  parent: string;
  name: string;
  ext: string;
  size: number;
  mtime_ms: number;
  is_dir: number;
}

function findingId(scanId: string, rule: string, key: string): string {
  const h = createHash("sha1").update(`${scanId}|${rule}|${key}`).digest("hex").slice(0, 12);
  return `find_${rule}_${h}`;
}

function takePaths(paths: string[], limit = 40): string[] {
  return paths.slice(0, limit);
}

function claim(
  db: Database.Database,
  scanId: string,
  paths: string[],
  cls: FindingClass,
  protectedRoots: string[],
): string[] {
  const kept: string[] = [];
  for (const p of paths) {
    if (isDeniedForAction(p) || pathInProtectedRoots(p, protectedRoots)) continue;
    if (markClassified(db, scanId, p, cls)) kept.push(p);
  }
  return kept;
}

function bytesFor(rows: FileRow[], claimed: Set<string>): number {
  let n = 0;
  for (const row of rows) {
    if (claimed.has(row.path)) n += row.size;
  }
  return n;
}

function claimKind(db: Database.Database, scanId: string, paths: string[], cls: FindingClass): string[] {
  const kept: string[] = [];
  for (const p of paths) {
    if (isDeniedForAction(p)) continue;
    if (markClassified(db, scanId, p, cls)) kept.push(p);
  }
  return kept;
}

function makeFinding(
  scanId: string,
  rule: string,
  key: string,
  title: string,
  cls: FindingClass,
  action: ActionKind,
  risk: Risk,
  confidence: number,
  why: string,
  paths: string[],
  bytes: number,
  extra: Partial<Finding> = {},
): Finding {
  return {
    id: findingId(scanId, rule, key),
    scanId,
    title,
    class: cls,
    bytes,
    fileCount: extra.fileCount ?? paths.length,
    confidence,
    why,
    paths: takePaths(paths),
    action,
    risk,
    status: "open",
    ...extra,
  };
}

function queryFiles(db: Database.Database, sql: string, ...params: unknown[]): FileRow[] {
  return db.prepare(sql).all(...params) as FileRow[];
}

function classifyKindArchives(
  db: Database.Database,
  scanId: string,
  installerMin: number,
  cutoff: number,
  push: (f: Finding) => void,
): void {
  const labeled = new Map(listArchiveKinds(db).map((row) => [row.kind, row.path] as const));
  const archiveRoot = getArchiveRoot(db);
  const rows = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND size >= ?`,
    scanId,
    installerMin,
  );

  for (const kind of ["disk-images", "installers"] as ArchiveKind[]) {
    const folder = labeled.get(kind) ?? null;
    if (folder && !existsSync(folder)) {
      push(
        makeFinding(
          scanId,
          "arch-missing",
          kind,
          `${kindTitle(kind)} archive folder is gone`,
          "archiveable",
          "label",
          "medium",
          0.9,
          "The saved archive folder is missing or unmounted. Pick it again or recreate it. Files already archived are not recycled.",
          [folder],
          0,
          { kind, allowedActions: ["label"], destPath: folder },
        ),
      );
    }
  }

  const byKind = new Map<ArchiveKind, FileRow[]>();
  for (const row of rows) {
    const kind = fileKind(row.name, row.ext);
    if (!kind) continue;
    const folder = labeled.get(kind);
    if (folder && existsSync(folder) && pathIsUnder(row.path, folder)) {
      markClassified(db, scanId, row.path, "keep");
      continue;
    }
    const list = byKind.get(kind) ?? [];
    list.push(row);
    byKind.set(kind, list);
  }

  for (const [kind, files] of byKind) {
    const folder = labeled.get(kind);
    const folderOk = Boolean(folder && existsSync(folder));
    const hot: FileRow[] = [];
    const coldByParent = new Map<string, FileRow[]>();
    for (const f of files) {
      if (isHotZonePath(f.path)) hot.push(f);
      else {
        const group = coldByParent.get(f.parent) ?? [];
        group.push(f);
        coldByParent.set(f.parent, group);
      }
    }

    if (!folderOk) {
      for (const [parent, group] of coldByParent) {
        if (group.length < CLUSTER_MIN) continue;
        const claimed = claimKind(db, scanId, group.map((f) => f.path), "archiveable");
        if (!claimed.length) continue;
        push(
          makeFinding(
            scanId,
            "arch-label",
            `${kind}:${parent}`,
            `This looks like a ${kindTitle(kind)} archive`,
            "archiveable",
            "label",
            "low",
            0.8,
            `A folder outside your profile holds ${group.length} ${kindTitle(kind).toLowerCase()}. Confirm to label it so leftovers elsewhere can be moved here instead of recycled.`,
            claimed,
            bytesFor(group, new Set(claimed)),
            { kind, allowedActions: ["label"], destPath: parent },
          ),
        );
      }
    }

    const moveRows: FileRow[] = [...hot];
    if (folderOk) {
      for (const group of coldByParent.values()) {
        for (const f of group) {
          if (f.mtime_ms <= cutoff) moveRows.push(f);
        }
      }
    }

    const uniqueMove = [...new Map(moveRows.map((f) => [f.path, f])).values()];
    if (!uniqueMove.length) continue;
    const claimed = claimKind(db, scanId, uniqueMove.map((f) => f.path), "archiveable");
    if (!claimed.length) continue;
    const needsRoot = !folderOk && !archiveRoot;
    if (folderOk && folder) {
      push(
        makeFinding(
          scanId,
          "arch-move",
          kind,
          `Move leftover ${kindTitle(kind).toLowerCase()} to ${basename(folder)}`,
          "archiveable",
          "archive",
          "low",
          0.84,
          `These sit in your profile (or unused outside it). Confirm to move them into the labeled ${kindTitle(kind)} folder, or Recycle instead.`,
          claimed,
          bytesFor(uniqueMove, new Set(claimed)),
          {
            kind,
            allowedActions: ["archive", "recycle"],
            destPath: folder,
            needsArchiveRoot: false,
          },
        ),
      );
    } else {
      push(
        makeFinding(
          scanId,
          "arch-create",
          kind,
          `Tidy leftover ${kindTitle(kind).toLowerCase()}`,
          "archiveable",
          "archive",
          "low",
          0.82,
          `Confirm to create a ${kindTitle(kind)} folder under your archive root and move these, or Recycle them.`,
          claimed,
          bytesFor(uniqueMove, new Set(claimed)),
          {
            kind,
            allowedActions: ["archive", "recycle"],
            needsArchiveRoot: needsRoot,
          },
        ),
      );
    }
  }
}

export function classifyScan(db: Database.Database, scanId: string, options: ScanOptions): Finding[] {
  const installerMin = options.installerMinBytes ?? 20 * 1024 * 1024;
  const largeMin = options.largeMinBytes ?? 100 * 1024 * 1024;
  const unusedMs = (options.unusedDays ?? 90) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - unusedMs;
  const findings: Finding[] = [];
  const protectedRoots = listProtectedRoots(db);

  const push = (f: Finding) => {
    if (f.fileCount === 0) return;
    insertFinding(db, f);
    findings.push(f);
  };

  const cacheHits = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND (
      lower(path) LIKE '%\\appdata\\local\\temp\\%'
      OR lower(path) LIKE '%\\appdata\\local\\npm-cache\\%'
      OR (lower(path) LIKE '%\\google\\chrome\\user data\\%' AND lower(path) LIKE '%\\cache%')
      OR (lower(path) LIKE '%\\microsoft\\edge\\user data\\%' AND lower(path) LIKE '%\\cache%')
      OR (lower(path) LIKE '%\\mozilla\\firefox\\profiles\\%' AND lower(path) LIKE '%\\cache%')
      OR lower(path) LIKE '%\\.npm\\_cacache\\%'
      OR lower(path) LIKE '%\\pip\\cache\\%'
    )`,
    scanId,
  );
  {
    const paths = claim(db, scanId, cacheHits.map((f) => f.path), "removable", protectedRoots);
    if (paths.length) {
      push(
        makeFinding(
          scanId,
          "cache",
          "temp-cache",
          "Temp and browser / package caches",
          "removable",
          "recycle",
          "low",
          0.92,
          "User temp, browser cache, and package-manager caches can be rebuilt. Sent to Recycle Bin after confirm.",
          paths,
          bytesFor(cacheHits, new Set(paths)),
        ),
      );
    }
  }

  const tmpHits = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND (
      lower(path) LIKE '%\\downloads\\tmp\\%' OR lower(path) LIKE '%\\downloads\\temp\\%'
    )`,
    scanId,
  );
  {
    const paths = claim(db, scanId, tmpHits.map((f) => f.path), "removable", protectedRoots);
    if (paths.length) {
      push(
        makeFinding(
          scanId,
          "dltmp",
          "downloads-tmp",
          "Scratch files in Downloads\\tmp",
          "removable",
          "recycle",
          "low",
          0.9,
          "Files sitting in a Downloads temp folder are almost always leftover downloads or extract debris.",
          paths,
          bytesFor(tmpHits, new Set(paths)),
        ),
      );
    }
  }

  classifyKindArchives(db, scanId, installerMin, cutoff, push);

  const installerHits = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND size >= ? AND (
      ext IN ('.iso', '.img', '.msi', '.msix')
      OR (
        ext IN ('.exe', '.cab')
        AND (
          lower(name) LIKE '%setup%'
          OR lower(name) LIKE '%installer%'
          OR lower(name) LIKE '%install_%'
          OR lower(name) LIKE '%cuda%'
          OR lower(name) LIKE '%jdk-%'
          OR lower(name) LIKE '%jre-%'
          OR lower(name) LIKE '%cursorsetup%'
          OR lower(name) LIKE '%rufus%'
          OR lower(path) LIKE '%\\downloads\\%'
          OR lower(path) LIKE '%\\desktop\\%'
          OR lower(path) LIKE '%\\tmp\\%'
        )
      )
    )`,
    scanId,
    installerMin,
  );
  {
    const paths = claim(db, scanId, installerHits.map((f) => f.path), "removable", protectedRoots);
    if (paths.length) {
      push(
        makeFinding(
          scanId,
          "inst",
          "installers",
          "Leftover installers and disk images",
          "removable",
          "recycle",
          "low",
          0.88,
          "Setup EXEs, MSI packages, and ISOs left in Downloads or matching installer names after the software is already installed.",
          paths,
          bytesFor(installerHits, new Set(paths)),
        ),
      );
    }
  }

  const winOld = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND lower(path) LIKE '%\\windows.old\\%'`,
    scanId,
  );
  {
    const paths = claim(db, scanId, winOld.map((f) => f.path), "bloat", protectedRoots);
    if (paths.length) {
      push(
        makeFinding(
          scanId,
          "winold",
          "windows-old",
          "Previous Windows install (Windows.old)",
          "bloat",
          "recycle",
          "medium",
          0.85,
          "Windows.old is a leftover OS tree from an upgrade. Recycle only if you do not need to roll back.",
          paths,
          bytesFor(winOld, new Set(paths)),
        ),
      );
    }
  }

  const nmFiles = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND lower(path) LIKE '%\\node_modules\\%'`,
    scanId,
  );
  {
    const groups = new Map<string, { bytes: number; paths: string[]; mtime: number }>();
    for (const f of nmFiles) {
      const lower = f.path.toLowerCase();
      const idx = lower.indexOf("\\node_modules\\");
      if (idx === -1) continue;
      const root = f.path.slice(0, idx + "\\node_modules".length);
      const cur = groups.get(root) ?? { bytes: 0, paths: [], mtime: 0 };
      cur.bytes += f.size;
      cur.paths.push(f.path);
      if (f.mtime_ms > cur.mtime) cur.mtime = f.mtime_ms;
      groups.set(root, cur);
    }
    const stale = [...groups.entries()].filter(([, v]) => v.mtime < cutoff && v.bytes > 5 * 1024 * 1024);
    const roots: string[] = [];
    let bytes = 0;
    for (const [root, v] of stale) {
      const claimed = claim(db, scanId, v.paths, "bloat", protectedRoots);
      if (claimed.length) {
        roots.push(root);
        bytes += v.bytes;
      }
    }
    if (roots.length) {
      push(
        makeFinding(
          scanId,
          "nm",
          "node-modules",
          "Stale node_modules folders",
          "bloat",
          "recycle",
          "medium",
          0.7,
          "node_modules trees that have not been touched in the unused window. Reinstall with npm/pnpm if you still need the project.",
          roots,
          bytes,
        ),
      );
    }
  }

  const leftoverCopies = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND (
      lower(path) LIKE '%pulsar%' OR lower(path) LIKE '%sencraft%' OR lower(path) LIKE '%senators-craft%' OR lower(path) LIKE '%senators craft%'
    ) AND (
      lower(path) LIKE '%\\old%' OR lower(path) LIKE '%copy%' OR lower(path) LIKE '%backup%' OR lower(path) LIKE '%leftover%'
      OR path LIKE '%0.%'
    )`,
    scanId,
  );
  {
    const paths = claim(db, scanId, leftoverCopies.map((f) => f.path), "bloat", protectedRoots);
    if (paths.length) {
      push(
        makeFinding(
          scanId,
          "copies",
          "app-copies",
          "Old app copies and leftover trees",
          "bloat",
          "recycle",
          "medium",
          0.65,
          "Folders that look like extra copies of known local apps (old versions, backups). Review before confirm — do not recycle the live install.",
          paths,
          bytesFor(leftoverCopies, new Set(paths)),
        ),
      );
    }
  }

  const empty = queryFiles(
    db,
    `SELECT d.* FROM files d
     WHERE d.scan_id = ? AND d.is_dir = 1
       AND (
         lower(d.name) IN ('tmp','temp','old','backup','copy','leftover','cache')
         OR lower(d.name) LIKE 'old-%'
         OR lower(d.name) LIKE '%leftover%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM files c WHERE c.scan_id = d.scan_id AND lower(c.parent) = lower(d.path)
       )`,
    scanId,
  );
  {
    const paths = claim(db, scanId, empty.map((d) => d.path), "bloat", protectedRoots);
    if (paths.length) {
      push(
        makeFinding(
          scanId,
          "empty",
          "empty-dirs",
          "Empty leftover folders",
          "bloat",
          "recycle",
          "low",
          0.75,
          "Empty directories named like tmp/old/backup/leftover.",
          paths,
          0,
        ),
      );
    }
  }

  const large = queryFiles(
    db,
    `SELECT * FROM files WHERE scan_id = ? AND is_dir = 0 AND size >= ? AND mtime_ms <= ?`,
    scanId,
    largeMin,
    cutoff,
  );
  {
    const paths = claim(db, scanId, large.map((f) => f.path), "archiveable", protectedRoots);
    if (paths.length) {
      push(
        makeFinding(
          scanId,
          "large",
          "unused-large",
          "Large files unused for a long time",
          "archiveable",
          "archive",
          "medium",
          0.6,
          "Big files that have not been written recently. v1 can only preview an archive move — confirm does not relocate them yet.",
          paths,
          bytesFor(large, new Set(paths)),
        ),
      );
    }
  }

  return findings;
}
