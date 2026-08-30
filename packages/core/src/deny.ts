import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePath, pathEquals, pathIsUnder } from "./paths.ts";

const SKIP_DIR_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "recovery",
  "efi",
  "$windows.~bt",
  "$windows.~ws",
]);

function windowsRoots(): string[] {
  const windir = process.env.WINDIR || "C:\\Windows";
  const systemDrive = process.env.SystemDrive || "C:";
  const home = homedir();
  return [
    windir,
    join(systemDrive, "Windows"),
    join(systemDrive, "Program Files"),
    join(systemDrive, "Program Files (x86)"),
    join(systemDrive, "ProgramData", "Microsoft"),
    join(systemDrive, "Recovery"),
    join(systemDrive, "Boot"),
    join(systemDrive, "EFI"),
    join(systemDrive, "System Volume Information"),
    join(systemDrive, "$Recycle.Bin"),
    join(home, "NTUSER.DAT"),
    join(home, "AppData", "Roaming"),
  ];
}

function protectedFileNames(): string[] {
  return ["pagefile.sys", "hiberfil.sys", "swapfile.sys", "ntuser.dat", "ntuser.dat.log1", "ntuser.dat.log2"];
}

/** Roots we do not walk at all. */
export function isDeniedForScan(fullPath: string, name?: string): boolean {
  const n = (name ?? fullPath.split(/[/\\]/).pop() ?? "").toLowerCase();
  if (SKIP_DIR_NAMES.has(n)) return true;
  const p = normalizePath(fullPath);
  const base = n;
  if (protectedFileNames().includes(base)) return true;
  for (const root of windowsRoots()) {
    if (pathEquals(p, root) || pathIsUnder(p, root)) {
      // Still walk Windows.old — leftover OS, classic bloat.
      if (n === "windows.old") return false;
      return true;
    }
  }
  return false;
}

/** Paths we must never recycle or move. */
export function isDeniedForAction(fullPath: string): boolean {
  const p = normalizePath(fullPath);
  const parts = p.split("\\");
  if (parts.length <= 1) return true;
  // Volume root like C:
  if (/^[a-z]:$/i.test(p)) return true;
  if (/^[a-z]:\\$/i.test(fullPath)) return true;
  if (isDeniedForScan(p)) return true;
  return false;
}

export function assertActionAllowed(fullPath: string): void {
  if (isDeniedForAction(fullPath)) {
    throw new Error(`Refusing to act on protected path: ${fullPath}`);
  }
}

export function scanSkipReason(fullPath: string, name?: string): string | null {
  return isDeniedForScan(fullPath, name) ? "protected" : null;
}
