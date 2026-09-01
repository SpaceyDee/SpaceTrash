export interface WalkWorkerData {
  root: string;
  dbPath: string;
}

export interface WalkFileRow {
  path: string;
  parent: string;
  name: string;
  ext: string;
  size: number;
  mtime_ms: number;
  is_dir: number;
}

export type WalkWorkerOut =
  | { type: "batch"; rows: WalkFileRow[] }
  | { type: "skipDir"; parent: string }
  | { type: "gone"; paths: string[] }
  | { type: "markChecked"; path: string; parent: string; name: string; size: number; mtime_ms: number }
  | { type: "progress"; filesSeen: number; filesWalked: number; filesSkipped: number; bytesSeen: number; currentPath: string }
  | { type: "error"; path: string; message: string }
  | { type: "done" };
