import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Volume, VolumeKind } from "./types.ts";

const execFileAsync = promisify(execFile);

function driveKind(driveType: number): VolumeKind {
  switch (driveType) {
    case 2:
      return "removable";
    case 3:
      return "fixed";
    case 4:
      return "network";
    case 5:
      return "cdrom";
    default:
      return "unknown";
  }
}

interface CimDisk {
  DeviceID?: string;
  VolumeName?: string;
  FileSystem?: string;
  Size?: number;
  FreeSpace?: number;
  DriveType?: number;
}

export async function listVolumes(): Promise<Volume[]> {
  if (process.platform === "win32") {
    return listWindowsVolumes();
  }
  return listUnixVolumes();
}

async function listWindowsVolumes(): Promise<Volume[]> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]") as CimDisk | CimDisk[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row) => row.DeviceID)
      .map((row) => {
        const id = String(row.DeviceID);
        return {
          id,
          path: id.endsWith("\\") ? id : `${id}\\`,
          label: row.VolumeName || "",
          fs: row.FileSystem || "",
          totalBytes: Number(row.Size ?? 0),
          freeBytes: Number(row.FreeSpace ?? 0),
          kind: driveKind(Number(row.DriveType ?? 0)),
        };
      });
  } catch {
    return fallbackLetterScan();
  }
}

function fallbackLetterScan(): Volume[] {
  const out: Volume[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const path = `${letter}:\\`;
    if (!existsSync(path)) continue;
    out.push({
      id: `${letter}:`,
      path,
      label: "",
      fs: "",
      totalBytes: 0,
      freeBytes: 0,
      kind: "fixed",
    });
  }
  return out;
}

async function listUnixVolumes(): Promise<Volume[]> {
  const home = homedir();
  const out: Volume[] = [
    {
      id: "home",
      path: home,
      label: "Home",
      fs: "",
      totalBytes: 0,
      freeBytes: 0,
      kind: "fixed",
    },
  ];
  try {
    const { stdout } = await execFileAsync("df", ["-Pk"], { timeout: 10_000 });
    const seen = new Set<string>([home]);
    for (const line of stdout.trim().split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const mount = parts.slice(5).join(" ");
      const totalBytes = Number(parts[1]) * 1024;
      const freeBytes = Number(parts[3]) * 1024;
      if (!mount.startsWith("/") || seen.has(mount)) continue;
      if (/^\/(dev|proc|sys|run|snap|boot\/efi)(\/|$)/.test(mount)) continue;
      seen.add(mount);
      const extra =
        mount.startsWith("/Volumes/") || mount.startsWith("/mnt/") || mount.startsWith("/media/");
      out.push({
        id: mount,
        path: mount.endsWith("/") ? mount : `${mount}/`,
        label: mount === "/" ? "System" : mount.split("/").filter(Boolean).pop() || mount,
        fs: parts[0],
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
        freeBytes: Number.isFinite(freeBytes) ? freeBytes : 0,
        kind: mount === "/" ? "unknown" : extra ? "fixed" : "unknown",
      });
    }
  } catch {
    // Home card is enough to start a scan.
  }
  return out;
}

export function defaultScanRoots(volumes: Volume[]): string[] {
  return volumes.filter((v) => v.kind === "fixed").map((v) => v.path);
}
