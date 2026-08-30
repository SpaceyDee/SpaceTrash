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

## Making the repo public

On GitHub: **Settings → General → Danger zone → Change repository visibility → Public**.

The release assets stay attached after you flip visibility. Download links use the same URL:

`https://github.com/SpaceyDee/SpaceTrash/releases/latest`
