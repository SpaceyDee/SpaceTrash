import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { assertActionAllowed } from "./deny.ts";
import { toNative } from "./paths.ts";

const execFileAsync = promisify(execFile);

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export async function recyclePath(fullPath: string): Promise<void> {
  assertActionAllowed(fullPath);
  const native = toNative(fullPath);
  const st = await lstat(native);
  if (process.platform === "win32") {
    await recycleWindows(native, st.isDirectory());
    return;
  }
  if (process.platform === "darwin") {
    await recycleMac(native);
    return;
  }
  await recycleLinux(native);
}

async function recycleWindows(native: string, isDir: boolean): Promise<void> {
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$p = ${psQuote(native)}`,
    isDir
      ? "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')"
      : "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  ].join("; ");

  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 60_000 },
  );
}

async function recycleMac(native: string): Promise<void> {
  const escaped = native.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await execFileAsync(
    "osascript",
    ["-e", `tell application "Finder" to delete POSIX file "${escaped}"`],
    { timeout: 60_000 },
  );
}

async function recycleLinux(native: string): Promise<void> {
  try {
    await execFileAsync("gio", ["trash", native], { timeout: 60_000 });
    return;
  } catch {
    // fall through to XDG trash
  }
  const trash = join(homedir(), ".local", "share", "Trash");
  const filesDir = join(trash, "files");
  const infoDir = join(trash, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });
  const name = basename(native);
  let dest = join(filesDir, name);
  let info = join(infoDir, `${name}.trashinfo`);
  let n = 1;
  while (true) {
    try {
      await writeFile(info, "", { flag: "wx" });
      break;
    } catch {
      dest = join(filesDir, `${name}.${n}`);
      info = join(infoDir, `${name}.${n}.trashinfo`);
      n += 1;
    }
  }
  const now = new Date().toISOString().slice(0, 19);
  await writeFile(info, `[Trash Info]\nPath=${native}\nDeletionDate=${now}\n`);
  try {
    await rename(native, dest);
  } catch {
    await copyFile(native, dest);
    await rm(native, { recursive: true, force: true });
  }
}
