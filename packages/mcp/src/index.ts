import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.SPACETRASH_URL ?? "http://127.0.0.1:3847";

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function apiSend(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  return apiSend("POST", path, body);
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const server = new McpServer({ name: "spacetrash", version: "0.1.9" });

server.tool("spacetrash_status", "SpaceTrash engine status: version, data dir, active scan", {}, async () => {
  try {
    return ok(await apiGet("/api/status"));
  } catch (err) {
    return fail(err);
  }
});

server.tool("spacetrash_list_volumes", "List fixed and other volumes SpaceTrash can scan", {}, async () => {
  try {
    return ok(await apiGet("/api/volumes"));
  } catch (err) {
    return fail(err);
  }
});

server.tool(
  "spacetrash_protect_root",
  "Mark a drive or folder as a protected archive: still scanned, never recommended for delete. Set protected=false to undo.",
  {
    path: z.string().describe("Absolute path of the drive or folder, e.g. \"E:\\\\\""),
    protected: z.boolean().describe("true to protect, false to allow recommendations again"),
  },
  async (args) => {
    try {
      return ok(await apiSend("PUT", "/api/protected", args));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "spacetrash_ignore_path",
  "Ignore or un-ignore a leftover app folder so SpaceTrash stops (or resumes) flagging it. Does not Protect the path from other rules.",
  {
    path: z.string().describe("Absolute folder path"),
    ignored: z.boolean().describe("true to ignore, false to flag it again"),
  },
  async (args) => {
    try {
      return ok(await apiSend("PUT", "/api/ignored", args));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool("spacetrash_archive_state", "Archive root, labeled kind folders, and ignored leftover paths", {}, async () => {
  try {
    return ok(await apiGet("/api/archive"));
  } catch (err) {
    return fail(err);
  }
});

server.tool(
  "spacetrash_set_archive_root",
  "Set the archive root (not inside the user profile). SpaceTrash can create Disk images / Installers / App leftovers folders here.",
  { root: z.string().describe("Absolute folder or drive, e.g. \"G:\\\\\"") },
  async (args) => {
    try {
      return ok(await apiSend("PUT", "/api/archive", args));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "spacetrash_start_scan",
  "Start a disk scan. Omit roots to scan all fixed volumes. Does not delete anything.",
  {
    roots: z.array(z.string()).optional().describe("Absolute paths to scan, e.g. [\"C:\\\\\", \"G:\\\\\"]"),
    installerMinBytes: z.number().optional(),
    largeMinBytes: z.number().optional(),
    unusedDays: z.number().optional(),
  },
  async (args) => {
    try {
      return ok(await apiPost("/api/scans", args));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "spacetrash_scan_status",
  "Read scan progress and result status",
  { scanId: z.string().describe("Scan id from spacetrash_start_scan") },
  async ({ scanId }) => {
    try {
      return ok(await apiGet(`/api/scans/${encodeURIComponent(scanId)}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "spacetrash_list_findings",
  "List classified issues for a completed scan",
  {
    scanId: z.string(),
    class: z.enum(["removable", "bloat", "archiveable", "keep"]).optional(),
  },
  async ({ scanId, class: cls }) => {
    try {
      const q = cls ? `?class=${encodeURIComponent(cls)}` : "";
      return ok(await apiGet(`/api/scans/${encodeURIComponent(scanId)}/findings${q}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "spacetrash_get_finding",
  "Get one finding: why, paths, proposed action, risk",
  { findingId: z.string() },
  async ({ findingId }) => {
    try {
      return ok(await apiGet(`/api/findings/${encodeURIComponent(findingId)}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "spacetrash_preview_action",
  "Preview a finding action and receive a one-time confirm token. Does not delete or move files.",
  {
    findingId: z.string(),
    action: z.enum(["recycle", "archive", "label", "ignore"]).optional(),
    archiveRoot: z.string().optional(),
  },
  async ({ findingId, action, archiveRoot }) => {
    try {
      return ok(
        await apiPost(`/api/findings/${encodeURIComponent(findingId)}/preview`, { action, archiveRoot }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "spacetrash_apply_action",
  "Apply a previously previewed action. Requires the preview token and confirm=true. Recycle, ignore a leftover app folder, label an archive folder, or move leftovers into Disk images / Installers / App leftovers.",
  {
    token: z.string().describe("Token from spacetrash_preview_action"),
    confirm: z.literal(true).describe("Must be true. Apply is rejected without it."),
  },
  async ({ token, confirm }) => {
    try {
      return ok(await apiPost("/api/actions/apply", { token, confirm }));
    } catch (err) {
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
