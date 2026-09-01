# SpaceTrash

Scan disks, classify what is removable / bloat / archiveable / keep, then fix each issue with **Preview → Confirm**. Nothing is deleted or moved until you confirm. Recycle goes to the Recycle Bin. Confirmed installer/ISO tidy-ups move into your archive folders.

Independent of Pulsar. Pulsar (or Cursor, or any MCP client) can attach it as a tool. See [docs/PULSAR.md](docs/PULSAR.md).

## Download

Latest installers: **[GitHub Releases](https://github.com/SpaceyDee/SpaceTrash/releases/latest)**

| Package | Platform |
|---|---|
| `SpaceTrash-Setup-*.exe` | Windows installer |
| `SpaceTrash-Portable-*.exe` | Windows, no install |
| `SpaceTrash-*-mac-universal.dmg` | macOS (CI) |
| `SpaceTrash-*-linux-*.AppImage` / `.deb` | Linux (CI) |

v0.1 is Windows-first. macOS and Linux installers are produced by the release workflow when a `v*` tag is pushed. How to cut a release: [docs/RELEASE.md](docs/RELEASE.md).

## Safety

- Protected OS paths (Windows, Program Files, `/usr`, `/System`, pagefile, Recycle Bin, …) are never proposed for delete.
- Archive drives you mark **Protect** are still scanned, but SpaceTrash will not recommend deleting anything on them.
- Leftover installers and disk images in your user profile can be moved into labeled archive folders after Confirm. Large unused-file archives stay preview-only.
- Junctions / reparse points are not followed.
- Apply without a preview token, or without `confirm: true`, is rejected.
- Closing the app cancels any scan in progress so the next launch is clean.

## Run from source

Needs Node 22+.

```bash
npm install
npm run api
```

Open [http://127.0.0.1:3847](http://127.0.0.1:3847). Or:

```bash
npm run desktop
```

```bash
npm run cli -- volumes
npm run cli -- scan --root .
```

Build installers on this machine:

```bash
npm run dist:win     # Windows
npm run dist:mac     # macOS (run on a Mac)
npm run dist:linux   # Linux (run on Linux)
```

Windows installers check `http://192.168.0.100/spacetrash` for updates (override with `SPACETRASH_UPDATE_URL`). Publish a new build with `python scripts/publish-update.py`.

The first scan of a drive is a full sweep. Later scans skip unchanged folders and look for new files.

## Layout

- `packages/core` — walker, SQLite index, rules, Trash / Recycle Bin apply
- `packages/api` — localhost HTTP + the same UI the desktop loads
- `packages/mcp` — stdio MCP bridge over that HTTP API
- `packages/desktop` — Electron shell and installer config

Data lives in `%LOCALAPPDATA%\SpaceTrash\` on Windows, `~/Library/Application Support/SpaceTrash` on macOS, and `~/.local/share/spacetrash` on Linux (`SPACETRASH_DATA` overrides).

License: [MIT](LICENSE).
