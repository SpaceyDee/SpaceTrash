import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathEquals, pathIsUnder } from "./paths.ts";

export interface InstalledProgram {
  displayName: string;
  installLocation: string | null;
  uninstallString: string | null;
  publisher?: string | null;
}

export interface ProgramIndex {
  programs: InstalledProgram[];
  shortcutTargets: string[];
}

const TOKEN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "app",
  "application",
  "software",
  "inc",
  "llc",
  "ltd",
  "microsoft",
  "windows",
  "win32",
  "win64",
  "setup",
  "update",
  "hotfix",
  "version",
  "runtime",
  "redistributable",
  "sdk",
  "driver",
  "tools",
  "tool",
  "pack",
  "plus",
  "pro",
  "home",
  "preview",
  "beta",
  "corp",
  "corporation",
  "gmbh",
  "com",
  "net",
  "org",
]);

const INDEX_TTL_MS = 60_000;
let cached: { at: number; index: ProgramIndex; fromFile: string | null } | null = null;

export function resetProgramIndexCache(): void {
  cached = null;
}

export function tokenizeName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !/^\d+(\.\d+)*$/.test(token))
    .filter((token) => !TOKEN_STOPWORDS.has(token));
}

function folderBase(installLocation: string | null): string {
  if (!installLocation) return "";
  const trimmed = installLocation.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function strongTokens(program: InstalledProgram): string[] {
  const tokens = new Set<string>();
  const base = folderBase(program.installLocation);
  if (base) {
    const lower = base.toLowerCase();
    if (lower.length >= 4 && !TOKEN_STOPWORDS.has(lower)) tokens.add(lower);
    for (const token of tokenizeName(base)) tokens.add(token);
  }
  const publisher = new Set(tokenizeName(program.publisher ?? ""));
  for (const token of tokenizeName(program.displayName)) {
    if (publisher.has(token)) continue;
    tokens.add(token);
  }
  return [...tokens];
}

function tokenBoundary(name: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(name);
}

export function folderMatchesProgram(folderName: string, program: InstalledProgram): boolean {
  const name = folderName.toLowerCase();
  const nameCompact = name.replace(/[^a-z0-9]+/g, "");
  const displayCompact = program.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (displayCompact.length >= 4 && nameCompact === displayCompact) return true;
  const base = folderBase(program.installLocation).toLowerCase();
  if (base.length >= 4 && (name === base || tokenBoundary(name, base))) return true;
  for (const token of strongTokens(program)) {
    if (tokenBoundary(name, token)) return true;
  }
  return false;
}

export function bestMatchingProgram(folderName: string, programs: InstalledProgram[]): InstalledProgram | null {
  let best: InstalledProgram | null = null;
  let bestLen = 0;
  for (const program of programs) {
    if (!folderMatchesProgram(folderName, program)) continue;
    const longest = Math.max(0, ...strongTokens(program).map((token) => token.length), folderBase(program.installLocation).length);
    if (longest > bestLen) {
      best = program;
      bestLen = longest;
    }
  }
  return best;
}

export function pathFromUninstallString(raw: string | null): string | null {
  if (!raw) return null;
  const quoted = raw.match(/"([a-zA-Z]:[^"]+\.(exe|msi|bat|cmd|msp))"/i);
  if (quoted) return quoted[1];
  const bare = raw.match(/([a-zA-Z]:\\[^\s"]+\.(exe|msi|bat|cmd|msp))/i);
  return bare ? bare[1] : null;
}

function targetInFolder(target: string | null | undefined, folder: string): boolean {
  if (!target) return false;
  const trimmed = target.replace(/[\\/]+$/, "");
  return pathEquals(trimmed, folder) || pathIsUnder(trimmed, folder);
}

export function isLikelyLiveAppData(folder: string, home = homedir()): boolean {
  if (home && pathIsUnder(folder, join(home, "AppData"))) return true;
  const drive = process.env.SystemDrive || "C:";
  if (pathIsUnder(folder, join(drive, "ProgramData"))) return true;
  return false;
}

export function isConnectedFolder(folder: string, index: ProgramIndex, home = homedir()): boolean {
  for (const program of index.programs) {
    if (targetInFolder(program.installLocation, folder)) return true;
    if (targetInFolder(pathFromUninstallString(program.uninstallString), folder)) return true;
  }
  for (const target of index.shortcutTargets) {
    if (targetInFolder(target, folder)) return true;
  }
  if (isLikelyLiveAppData(folder, home) && bestMatchingProgram(basename(folder), index.programs)) {
    return true;
  }
  return false;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseProgramIndex(raw: unknown): ProgramIndex {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const programsIn = Array.isArray(obj.programs) ? obj.programs : [];
  const shortcutsIn = Array.isArray(obj.shortcutTargets) ? obj.shortcutTargets : [];
  const programs: InstalledProgram[] = [];
  for (const row of programsIn) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const displayName = asString(rec.displayName);
    if (!displayName) continue;
    programs.push({
      displayName,
      installLocation: asString(rec.installLocation) || null,
      uninstallString: asString(rec.uninstallString) || null,
      publisher: asString(rec.publisher) || null,
    });
  }
  const shortcutTargets = shortcutsIn.map((item) => asString(item)).filter(Boolean);
  return { programs, shortcutTargets };
}

const COLLECT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$programs = @(foreach ($p in Get-ItemProperty $keys -ErrorAction SilentlyContinue) {
  if (-not $p.DisplayName) { continue }
  [ordered]@{
    displayName = [string]$p.DisplayName
    installLocation = [string]$p.InstallLocation
    uninstallString = [string]$p.UninstallString
    publisher = [string]$p.Publisher
  }
})
$lnkRoots = @(
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:USERPROFILE\\Desktop",
  "$env:PUBLIC\\Desktop"
)
$targets = New-Object System.Collections.Generic.List[string]
try {
  $sh = New-Object -ComObject WScript.Shell
  foreach ($root in $lnkRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $t = $sh.CreateShortcut($_.FullName).TargetPath
      if ($t) { [void]$targets.Add([string]$t) }
    }
  }
} catch {}
@{ programs = $programs; shortcutTargets = $targets } | ConvertTo-Json -Compress -Depth 6
`;

function collectWindowsProgramIndex(): ProgramIndex {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", COLLECT_SCRIPT], {
      windowsHide: true,
      timeout: 45_000,
      encoding: "utf8",
      maxBuffer: 12 * 1024 * 1024,
    });
    return parseProgramIndex(JSON.parse(out));
  } catch {
    return { programs: [], shortcutTargets: [] };
  }
}

export function loadProgramIndex(): ProgramIndex {
  const fromFile = process.env.SPACETRASH_PROGRAM_INDEX ?? null;
  if (cached && cached.fromFile === fromFile && Date.now() - cached.at < INDEX_TTL_MS) {
    return cached.index;
  }
  let index: ProgramIndex = { programs: [], shortcutTargets: [] };
  if (fromFile) {
    try {
      if (existsSync(fromFile)) {
        const text = readFileSync(fromFile, "utf8").replace(/^\uFEFF/, "");
        index = parseProgramIndex(JSON.parse(text));
      }
    } catch {
      index = { programs: [], shortcutTargets: [] };
    }
  } else if (process.platform === "win32") {
    index = collectWindowsProgramIndex();
  }
  cached = { at: Date.now(), index, fromFile };
  return index;
}

export function programHomeOverride(): string {
  return process.env.SPACETRASH_PROGRAM_HOME || process.env.SPACETRASH_HOT_ZONE || homedir();
}
