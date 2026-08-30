# SpaceTrash

Windows disk optimiser: scan drives, classify what is removable / bloat / archiveable / keep, then fix each issue with **Preview → Confirm**. Nothing is deleted or moved until you confirm. Confirmed recycles go to the Recycle Bin.

Independent of [Pulsar](https://github.com). Pulsar (or Cursor, or any MCP client) can attach it as a tool. See [docs/PULSAR.md](docs/PULSAR.md).

## Installer (separate Windows program)

Build a normal Windows installer from this repo. The result does **not** need Node or npm on the target PC.

```bash
npm install
npm run dist
```

Artifacts land in `dist/desktop/`:

- `SpaceTrash-Setup-0.1.0.exe` — NSIS installer (Start Menu + desktop shortcut, uninstall from Settings)
- `SpaceTrash-Portable-0.1.0.exe` — run without installing

The installed app is SpaceTrash.exe. It starts its own local engine on `127.0.0.1` and opens the UI. Pulsar can still attach over MCP while the app is running.

## Requirements (from source)

- Windows
- Node 22+

## Quick start (from source)

```bash
npm install
npm run api
```

Open [http://127.0.0.1:3847](http://127.0.0.1:3847). Pick volumes, or paste a folder path in **Folder override** to scan one tree. Or run the desktop shell:

```bash
npm run desktop
```

CLI (engine talks to the same local database):

```bash
npm run cli -- volumes
npm run cli -- scan --root G:\Projects\SpaceTrash
npm run cli -- findings <scanId>
```

## Safety

- Protected paths (Windows, Program Files, pagefile, Recycle Bin, …) are never proposed for delete.
- Junctions / reparse points are not followed.
- `POST /api/actions/apply` without a preview token, or with `confirm` not `true`, is rejected.
- Archive findings are preview-only in v1.

## Layout

- `packages/core` — walker, SQLite index, rules, Recycle Bin apply
- `packages/api` — localhost HTTP + the same UI the desktop loads
- `packages/mcp` — stdio MCP bridge over that HTTP API
- `packages/desktop` — Electron window

Data lives in `%LOCALAPPDATA%\SpaceTrash\` (override with `SPACETRASH_DATA`).
