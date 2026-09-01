import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const VERSION = "0.1.5";

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

/** Forward-slash form for compares and SQL. */
export function toCanonical(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "") || p;
}

/** OS-native path for filesystem actions. */
export function toNative(p: string): string {
  const canon = toCanonical(p);
  return process.platform === "win32" ? canon.replace(/\//g, "\\") : canon;
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
  return c === p || c.startsWith(p + "/");
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i).toLowerCase();
}
