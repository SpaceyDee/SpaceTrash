import { homedir } from "node:os";
import { join } from "node:path";
import { pathEquals, pathIsUnder, toCanonical } from "./paths.ts";

const SKIP_DIR_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "recovery",
  "efi",
  "$windows.~bt",
  "$windows.~ws",
  "proc",
  "sys",
  "dev",
  ".trash",
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

function unixActionRoots(): string[] {
  const roots = [
    "/bin",
    "/sbin",
    "/usr",
    "/etc",
    "/lib",
    "/lib64",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
    "/run",
    "/System",
    "/Library",
    "/private/var/vm",
  ];
  if (process.platform === "darwin") {
    roots.push("/System/Volumes");
  }
  return roots;
}

function protectedFileNames(): string[] {
  return ["pagefile.sys", "hiberfil.sys", "swapfile.sys", "ntuser.dat", "ntuser.dat.log1", "ntuser.dat.log2"];
}

function looksWindows(p: string): boolean {
  return /^[a-z]:/i.test(p) || p.includes("\\");
}

function looksUnix(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~/");
}

/** Roots we do not walk at all. */
export function isDeniedForScan(fullPath: string, name?: string): boolean {
  const n = (name ?? fullPath.split(/[/\\]/).pop() ?? "").toLowerCase();
  if (SKIP_DIR_NAMES.has(n)) return true;
  const p = toCanonical(fullPath);
  if (protectedFileNames().includes(n)) return true;

  if (looksWindows(fullPath) || process.platform === "win32") {
    for (const root of windowsRoots()) {
      if (pathEquals(p, root) || pathIsUnder(p, root)) {
        if (n === "windows.old") return false;
        return true;
      }
    }
  }

  if (looksUnix(fullPath) || process.platform !== "win32") {
    const unixSkip = ["/proc", "/sys", "/dev", "/run", "/private/var/vm"];
    for (const root of unixSkip) {
      if (pathEquals(p, root) || pathIsUnder(p, root)) return true;
    }
  }
  return false;
}

/** Paths we must never recycle or move. */
export function isDeniedForAction(fullPath: string): boolean {
  const p = toCanonical(fullPath);
  if (/^[a-z]:\/?$/i.test(p)) return true;
  if (p === "/" || p === "") return true;
  if (isDeniedForScan(fullPath)) return true;

  if (looksUnix(fullPath) || process.platform !== "win32") {
    for (const root of unixActionRoots()) {
      if (pathEquals(p, root) || pathIsUnder(p, root)) return true;
    }
  }
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
