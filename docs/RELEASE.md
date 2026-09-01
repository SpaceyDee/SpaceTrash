# Public releases

Installers are **not** stored in git (they are ~70 MB each). GitHub Releases is the distribution channel.

## What a release contains

| File | Platform |
|---|---|
| `SpaceTrash-Setup-x.y.z.exe` | Windows installer (Start Menu + desktop shortcut) |
| `SpaceTrash-Portable-x.y.z.exe` | Windows, no install |
| `SpaceTrash-x.y.z-mac-universal.dmg` | macOS |
| `SpaceTrash-x.y.z-linux-x64.AppImage` | Linux (run in place) |
| `SpaceTrash-x.y.z-linux-x64.deb` | Debian / Ubuntu |

Mac and Linux packages are built by CI on tag. Windows can also be built on this machine with `npm run dist:win`.

## Cut a release

1. Bump `version` in the root and `packages/desktop` `package.json` files if needed.
2. Commit and push `main`.
3. Tag and push:

```bash
git tag v0.1.0
git push origin v0.1.0
```

4. GitHub Actions (`.github/workflows/release.yml`) builds all three OS installers and attaches them to the GitHub Release.

Manual Windows-only build:

```bash
npm run dist:win
```

Artifacts land in `dist/desktop/`.

## LAN auto-update (Windows)

Packaged builds check `http://192.168.0.100/spacetrash` (LXC 100 on the Proxmox host). Override with `SPACETRASH_UPDATE_URL`.

After `npm run dist:win`:

```bash
python scripts/publish-update.py --setup
```

`--setup` is only needed the first time (nginx location + directory). Later publishes omit it.

v0.1.0 installs do not contain the updater — install 0.1.1 once, then later versions can apply themselves.

From 0.1.4, worker results are applied in short slices on the UI thread so the window stays responsive (and Stop works) while several drives write into SQLite at once.

From 0.1.3, each selected drive is walked in its own worker thread so disks are scanned at the same time, and **Stop scan** cancels a run from the UI.

From 0.1.2, a completed scan is remembered. The next scan of the same drive skips folders whose timestamps have not changed and only walks new or changed files. The first 0.1.2 launch also seeds that memory from the last completed 0.1.1 scan.

## Making the repo public

On GitHub: **Settings → General → Danger zone → Change repository visibility → Public**.

The release assets stay attached after you flip visibility. Download links use the same URL:

`https://github.com/SpaceyDee/SpaceTrash/releases/latest`
