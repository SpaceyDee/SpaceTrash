# SpaceTrash

Windows disk optimiser: scan drives, classify what is removable / bloat / archiveable / keep, then fix each issue with **Preview → Confirm**. Nothing is deleted or moved until you confirm. Confirmed recycles go to the Recycle Bin.

Independent of [Pulsar](https://github.com). Pulsar (or Cursor, or any MCP client) can attach it as a tool. See [docs/PULSAR.md](docs/PULSAR.md).

## Requirements

- Windows
- Node 22+

## Quick start

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
