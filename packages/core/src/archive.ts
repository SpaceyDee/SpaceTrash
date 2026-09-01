import type { ArchiveKind } from "./types.ts";
import { copyFile, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { assertActionAllowed } from "./deny.ts";
import { normalizePath, parentPath, pathIsUnder, toCanonical, toNative } from "./paths.ts";

export const CLUSTER_MIN = 3;

export const KIND_FOLDER_NAME: Record<ArchiveKind, string> = {
  "disk-images": "Disk images",
  installers: "Installers",
};

const INSTALLER_NAME = /setup|installer|install_|cuda|jdk-|jre-|cursorsetup|rufus/i;

export function hotZoneRoot(): string {
  const override = process.env.SPACETRASH_HOT_ZONE;
  if (override) return override;
  return homedir();
}

export function isHotZonePath(nativePath: string): boolean {
  const hot = hotZoneRoot();
  if (!hot) return false;
  if (!pathIsUnder(nativePath, hot)) return false;
  const canon = toCanonical(nativePath).toLowerCase();
  if (canon.includes("/appdata/") || canon.endsWith("/appdata")) return false;
  if (canon.includes("/.config/") || canon.endsWith("/.config")) return false;
  if (canon.includes("/.local/") || canon.endsWith("/.local")) return false;
  if (canon.includes("/.cache/") || canon.endsWith("/.cache")) return false;
  return true;
}

export function fileKind(name: string, ext: string): ArchiveKind | null {
  const e = ext.toLowerCase();
  if (e === ".iso" || e === ".img") return "disk-images";
  if (e === ".msi" || e === ".msix") return "installers";
  if ((e === ".exe" || e === ".cab") && INSTALLER_NAME.test(name)) return "installers";
  return null;
}

export function kindTitle(kind: ArchiveKind): string {
  return KIND_FOLDER_NAME[kind];
}

export function assertArchiveRootAllowed(nativePath: string): void {
  const p = normalizePath(nativePath);
  if (!p) throw new Error("Archive root is empty");
  if (isHotZonePath(p)) {
    throw new Error("Archive root cannot be inside your user profile.");
  }
}

export function uniqueDestPath(destDir: string, fileName: string): string {
  const dir = toNative(destDir);
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  let candidate = join(dir, fileName);
  let n = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

function sameVolume(a: string, b: string): boolean {
  const left = toCanonical(a);
  const right = toCanonical(b);
  if (process.platform !== "win32") return true;
  return left.slice(0, 2).toLowerCase() === right.slice(0, 2).toLowerCase();
}

export async function moveIntoArchive(srcPath: string, destDir: string): Promise<string> {
  assertActionAllowed(srcPath);
  const src = toNative(srcPath);
  const dir = toNative(destDir);
  const st = await lstat(src);
  if (st.isSymbolicLink() || st.isDirectory()) {
    throw new Error(`Refusing to archive reparse or directory: ${src}`);
  }
  await mkdir(dir, { recursive: true });
  const dest = uniqueDestPath(dir, basename(src));
  if (sameVolume(src, dest)) {
    await rename(src, dest);
    return dest;
  }
  await copyFile(src, dest);
  const copied = await stat(dest);
  if (copied.size !== st.size) {
    await rm(dest, { force: true });
    throw new Error(`Copy size mismatch for ${src}`);
  }
  await rm(src, { force: true });
  return dest;
}

export function defaultKindDir(archiveRoot: string, kind: ArchiveKind): string {
  return join(toNative(archiveRoot), KIND_FOLDER_NAME[kind]);
}

export function inferredArchiveRoot(kindFolder: string): string {
  const parent = parentPath(kindFolder);
  return parent || normalizePath(kindFolder);
}
