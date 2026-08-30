import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat } from "node:fs/promises";
import { assertActionAllowed } from "./deny.ts";

const execFileAsync = promisify(execFile);

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export async function recyclePath(fullPath: string): Promise<void> {
  assertActionAllowed(fullPath);
  const st = await lstat(fullPath);
  if (process.platform !== "win32") {
    throw new Error("Recycle Bin apply is Windows-only in v1");
  }
  const isDir = st.isDirectory();
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `$p = ${psQuote(fullPath)}`,
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
