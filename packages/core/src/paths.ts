import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

export const VERSION = "0.1.9";

export function dataDir(): string {
  const override = process.env.SPACETRASH_DATA;
  if (override) return override;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local ? join(local, "SpaceTrash") : join(homedir(), "AppData", "Local", "SpaceTrash");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "SpaceTrash");
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, "spacetrash") : join(homedir(), ".local", "share", "spacetrash");
}

export function dbPath(): string {
  return join(dataDir(), "spacetrash.db");
}

export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Forward-slash form for compares and SQL. Drive roots stay `G:/`. */
export function toCanonical(p: string): string {
  const swapped = p.replace(/\\/g, "/");
  const drive = swapped.match(/^([a-zA-Z]:)\/?$/);
  if (drive) return `${drive[1]}/`;
  return swapped.replace(/\/+$/, "") || swapped;
}

/** OS-native path for filesystem actions. Drive roots stay `G:\`. */
export function toNative(p: string): string {
  const canon = toCanonical(p);
  if (process.platform !== "win32") return canon;
  const drive = canon.match(/^([a-zA-Z]:)\/$/);
  if (drive) return `${drive[1]}\\`;
  return canon.replace(/\//g, "\\");
}

export function normalizePath(p: string): string {
  return toNative(p);
}

export function pathEquals(a: string, b: string): boolean {
  const left = toCanonical(a);
  const right = toCanonical(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function pathIsUnder(child: string, parent: string): boolean {
  const c = process.platform === "win32" ? toCanonical(child).toLowerCase() : toCanonical(child);
  const p = process.platform === "win32" ? toCanonical(parent).toLowerCase() : toCanonical(parent);
  if (c === p) return true;
  if (p.endsWith("/")) return c.startsWith(p);
  return c.startsWith(p + "/");
}

export function parentPath(p: string): string {
  const n = normalizePath(p);
  const d = normalizePath(dirname(n));
  if (!d || d === "." || pathEquals(d, n)) return "";
  return d;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i).toLowerCase();
}
