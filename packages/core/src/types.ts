export type FindingClass = "removable" | "bloat" | "archiveable" | "keep";
export type ActionKind = "recycle" | "archive" | "none";
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
}

export interface ScanOptions {
  roots: string[];
  installerMinBytes?: number;
  largeMinBytes?: number;
  unusedDays?: number;
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
}

export interface ApplyResult {
  findingId: string;
  action: ActionKind;
  recycled: string[];
  failed: { path: string; error: string }[];
}

export interface EngineStatus {
  name: string;
  version: string;
  platform: string;
  dataDir: string;
  activeScanId: string | null;
  lastScanId: string | null;
}
