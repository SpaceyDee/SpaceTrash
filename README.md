# SpaceTrash

Scan disks, classify what is removable / bloat / archiveable / keep, then fix each issue with **Preview → Confirm**. Nothing is deleted or moved until you confirm. Recycle goes to the Recycle Bin. Leftover installers, disk images, and unmatched app folders can move into labeled archive folders after Confirm.

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

Current app version: **0.1.9**.

## Using it

1. Click the pinwheels for the drives you want mapped. **Protect archive** on a drive or folder still scans it, but SpaceTrash will not recommend deleting anything there.
2. Optionally set an **archive root** (not inside your user profile). Confirmed tidy-ups create or use `Disk images`, `Installers`, and `App leftovers` under that root.
3. **Scan**. The first pass maps everything; later scans skip folders that have not changed.
4. Open an issue. **Preview**, then **Confirm**. Recycle uses the Recycle Bin. Moves go into the matching archive folder.
5. After an app update, SpaceTrash recommends **Clear scan data**. That drops the index so new rules can re-classify. Files on disk and labeled archives stay put.

Leftover app folders are checked against Windows uninstall entries and Start Menu / desktop shortcuts. If the live install or a shortcut still points at that folder (or it is AppData for an app that is still installed), it stays **keep**. Otherwise you get one card: **Ignore**, **Move** into App leftovers, or **Recycle**.

## Safety

- Protected OS paths (Windows, Program Files, `/usr`, `/System`, pagefile, Recycle Bin, …) are never proposed for delete.
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

Build installers:

```bash
npm run dist:win     # Windows
npm run dist:mac     # macOS (run on a Mac)
npm run dist:linux   # Linux (run on Linux)
```

Packaged Windows builds also check a local LAN update feed (`SPACETRASH_UPDATE_URL` overrides it). Public downloads are GitHub Releases. Maintainer publish steps: [docs/RELEASE.md](docs/RELEASE.md).

## MCP

Start the API, then add the stdio bridge from [docs/PULSAR.md](docs/PULSAR.md). Every mutating tool still requires Preview → Confirm.

## Layout

- `packages/core` — walker, SQLite index, rules, Trash / Recycle Bin apply
- `packages/api` — localhost HTTP + the same UI the desktop loads
- `packages/mcp` — stdio MCP bridge over that HTTP API
- `packages/desktop` — Electron shell and installer config

Data lives in `%LOCALAPPDATA%\SpaceTrash\` on Windows, `~/Library/Application Support/SpaceTrash` on macOS, and `~/.local/share/spacetrash` on Linux (`SPACETRASH_DATA` overrides).

License: [MIT](LICENSE).
