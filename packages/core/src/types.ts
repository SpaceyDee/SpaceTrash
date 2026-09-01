export type FindingClass = "removable" | "bloat" | "archiveable" | "keep";
export type ActionKind = "recycle" | "archive" | "label" | "ignore" | "none";
export type ArchiveKind = "disk-images" | "installers" | "app-leftovers";
export type FindingStatus = "open" | "previewed" | "applied" | "failed";
export type Risk = "low" | "medium" | "high";
export type ScanStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export type VolumeKind = "fixed" | "removable" | "network" | "cdrom" | "unknown";

export interface Volume {
  id: string;
  path: string;
  label: string;
  fs: string;
  totalBytes: number;
  freeBytes: number;
  kind: VolumeKind;
  /** User-marked archive: still scanned, never recommended for delete. */
  protected?: boolean;
}

export interface ScanOptions {
  roots: string[];
  installerMinBytes?: number;
  largeMinBytes?: number;
  unusedDays?: number;
  leftoverMinBytes?: number;
}

export interface ScanJob {
  id: string;
  status: ScanStatus;
  roots: string[];
  filesSeen: number;
  bytesSeen: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  progress: number;
  currentPath?: string;
  filesSkipped?: number;
  filesWalked?: number;
}

export interface Finding {
  id: string;
  scanId: string;
  title: string;
  class: FindingClass;
  bytes: number;
  fileCount: number;
  confidence: number;
  why: string;
  paths: string[];
  action: ActionKind;
  risk: Risk;
  status: FindingStatus;
  kind?: ArchiveKind;
  allowedActions?: ActionKind[];
  destPath?: string;
  needsArchiveRoot?: boolean;
  programName?: string;
}

export interface ScanSummary {
  scanId: string;
  filesSeen: number;
  bytesSeen: number;
  byClass: Record<FindingClass, { count: number; bytes: number }>;
  keepBytes: number;
}

export interface Preview {
  token: string;
  findingId: string;
  action: ActionKind;
  paths: string[];
  bytes: number;
  expiresAt: number;
  destPath?: string;
  needsArchiveRoot?: boolean;
  allowedActions?: ActionKind[];
}

export interface ApplyResult {
  findingId: string;
  action: ActionKind;
  recycled: string[];
  moved: string[];
  failed: { path: string; error: string }[];
}

export interface ArchiveKindFolder {
  kind: ArchiveKind;
  path: string;
  name: string;
}

export interface ArchiveState {
  root: string | null;
  kinds: ArchiveKindFolder[];
  ignored: string[];
}

export interface EngineStatus {
  name: string;
  version: string;
  platform: string;
  dataDir: string;
  activeScanId: string | null;
  lastScanId: string | null;
  lastAppVersion?: string | null;
  needsScanWipe?: boolean;
}
