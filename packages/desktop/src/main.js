import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");
const defaultPort = Number(process.env.SPACETRASH_PORT ?? 3847);
const host = process.env.SPACETRASH_HOST ?? "127.0.0.1";
const DEFAULT_UPDATE_URL = "http://192.168.0.100/spacetrash";
const bundledWorker = join(desktopRoot, "build/walk-worker.cjs");
if (existsSync(bundledWorker)) {
  process.env.SPACETRASH_WALK_WORKER ??= bundledWorker;
}

let apiChild = null;
let apiUrl = `http://${host}:${defaultPort}`;
let ownedApi = false;
let quitting = false;
let installingUpdate = false;

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function apiUp(url) {
  try {
    const res = await fetch(`${url}/api/status`);
    return res.ok;
  } catch {
    return false;
  }
}

function rendererDir() {
  const nextToApp = join(desktopRoot, "renderer");
  if (existsSync(join(nextToApp, "index.html"))) return nextToApp;
  return join(repoRoot, "packages/desktop/renderer");
}

async function startInProcess(port) {
  const bundled = join(desktopRoot, "build/server.cjs");
  if (!existsSync(bundled)) {
    throw new Error(`Missing bundled server at ${bundled}`);
  }
  const require = createRequire(import.meta.url);
  const mod = require(bundled);
  await mod.startServer({ port, host, rendererDir: rendererDir() });
  ownedApi = true;
}

async function startDevChild(port) {
  const cwd = existsSync(join(repoRoot, "package.json")) ? repoRoot : process.cwd();
  apiChild = spawn(npmCmd(), ["run", "api"], {
    cwd,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, SPACETRASH_PORT: String(port), SPACETRASH_HOST: host },
  });
  ownedApi = true;
}

async function ensureApi() {
  if (await apiUp(apiUrl)) return;

  const packaged = app.isPackaged;
  let lastError;
  for (let port = defaultPort; port < defaultPort + 8; port++) {
    const url = `http://${host}:${port}`;
    if (await apiUp(url)) {
      apiUrl = url;
      return;
    }
    try {
      if (packaged) {
        await startInProcess(port);
      } else {
        try {
          await startInProcess(port);
        } catch {
          await startDevChild(port);
        }
      }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await apiUp(url)) {
          apiUrl = url;
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      lastError = new Error(`SpaceTrash API did not start at ${url}`);
    } catch (err) {
      lastError = err;
      if (err && err.code === "EADDRINUSE") continue;
    }
  }
  throw lastError ?? new Error("SpaceTrash API failed to start");
}

function setupUpdates() {
  if (!app.isPackaged) return;
  const require = createRequire(import.meta.url);
  const { autoUpdater } = require("electron-updater");
  const feed = process.env.SPACETRASH_UPDATE_URL || DEFAULT_UPDATE_URL;
  autoUpdater.setFeedURL({ provider: "generic", url: feed });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.platform === "win32") {
    autoUpdater.verifyUpdateCodeSignature = false;
  }
  autoUpdater.on("before-quit-for-update", () => {
    installingUpdate = true;
  });
  autoUpdater.on("update-available", (info) => {
    void dialog.showMessageBox({
      type: "info",
      title: "SpaceTrash update",
      message: `Version ${info.version} is available. Downloading now.`,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    void dialog
      .showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "SpaceTrash update",
        message: `Version ${info.version} is ready. Restart to install.`,
      })
      .then(({ response }) => {
        if (response === 0) {
          installingUpdate = true;
          autoUpdater.quitAndInstall();
        }
      });
  });
  autoUpdater.on("error", (err) => {
    console.error("[spacetrash] update check failed", err);
  });
  void autoUpdater.checkForUpdates().catch((err) => {
    console.error("[spacetrash] update check failed", err);
  });
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.setName("SpaceTrash");
  if (process.platform === "win32") {
    app.setAppUserModelId("com.spacetrash.app");
  }

  app.whenReady().then(async () => {
    if (app.isPackaged) {
      process.env.SPACETRASH_UPDATE_URL ??= DEFAULT_UPDATE_URL;
    }
    await ensureApi();
    await createWindow();
    setupUpdates();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
}

async function cleanShutdown() {
  if (ownedApi) {
    try {
      const bundled = join(desktopRoot, "build/server.cjs");
      if (existsSync(bundled)) {
        const require = createRequire(import.meta.url);
        const mod = require(bundled);
        if (typeof mod.stopServer === "function") await mod.stopServer();
      } else {
        await fetch(`${apiUrl}/api/shutdown`, { method: "POST" });
      }
    } catch {
      // already gone
    }
  }
  if (apiChild && !apiChild.killed) apiChild.kill();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (installingUpdate) return;
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void cleanShutdown().finally(() => app.quit());
});
