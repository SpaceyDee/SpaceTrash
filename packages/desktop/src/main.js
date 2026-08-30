import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const port = Number(process.env.SPACETRASH_PORT ?? 3847);
const host = process.env.SPACETRASH_HOST ?? "127.0.0.1";
const apiUrl = `http://${host}:${port}`;

let apiChild = null;

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function apiUp() {
  try {
    const res = await fetch(`${apiUrl}/api/status`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureApi() {
  if (await apiUp()) return;
  const cwd = existsSync(join(repoRoot, "package.json")) ? repoRoot : process.cwd();
  apiChild = spawn(npmCmd(), ["run", "api"], {
    cwd,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, SPACETRASH_PORT: String(port), SPACETRASH_HOST: host },
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await apiUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`SpaceTrash API did not start at ${apiUrl}`);
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    title: "SpaceTrash",
    backgroundColor: "#0e1116",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(apiUrl);
}

app.whenReady().then(async () => {
  await ensureApi();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (apiChild && !apiChild.killed) apiChild.kill();
});
