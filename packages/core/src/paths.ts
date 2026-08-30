import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const VERSION = "0.1.0";

export function dataDir(): string {
  const override = process.env.SPACETRASH_DATA;
  if (override) return override;
  const local = process.env.LOCALAPPDATA;
  return local ? join(local, "SpaceTrash") : join(homedir(), ".spacetrash");
}

export function dbPath(): string {
  return join(dataDir(), "spacetrash.db");
}

export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "") || p;
}

export function pathEquals(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

export function pathIsUnder(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  return c === p || c.startsWith(p + "\\");
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i).toLowerCase();
}
