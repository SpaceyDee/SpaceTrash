# Archive tidy-up

Date: 2026-09-01

SpaceTrash should stop treating a stash of installers or disk images as “issues to delete,” and instead help tidy leftover copies from the user profile into a user-chosen archive — always with Preview → Confirm.

## Problem

The leftover-installers / disk-images rule is one recycle bucket. An ISO on the Desktop and an ISO in a folder that is already a library look the same. Whole-drive **Protect** hides everything on that volume; it does not tidy junk in the profile, and it does not move keepers into an archive.

Archive apply is preview-only today. Confirm only Recycles.

## Goals

- Split **junk in the user profile** from **collections that are already archives**.
- Kind-aware archives: **Installers** vs **Disk images**, not one mixed pile.
- User picks an archive root (typically the archive drive). SpaceTrash creates default kind folders there; the user can rename them.
- Confirm once to label/create a kind archive. Later unused copies of that kind in the profile become **move** findings into that folder.
- If that kind has no archive yet, the finding offers **create archive at the root and move**, or **Recycle**.
- After a kind archive exists, the default action is **move**; Recycle stays available. Nothing moves or deletes without Preview → Confirm.
- Files already in labeled kind folders are monitored: not recycle issues. New profile leftovers of that kind keep being offered as moves.
- On app update, **recommend wiping scan index data**; the user can keep it. Never delete files in the archive root.

## Non-goals

- Silent moves, silent deletes, or silent archive labels.
- Putting archives next to `SpaceTrash.exe` or under `%LOCALAPPDATA%\SpaceTrash` (too small / wiped on update).
- Photos, video libraries, or generic “large unused file” relocation (existing archiveable/large rule stays as-is until a later spec).
- Content hashing / duplicate detection beyond kind + unused/hot-zone rules.
- Recycle of files that already live in a labeled kind folder.

## Kinds

| Kind id | Default folder name | Membership |
|---|---|---|
| `disk-images` | `Disk images` | `.iso`, `.img` |
| `installers` | `Installers` | `.msi`, `.msix`; `.exe` / `.cab` whose name matches setup/installer/install_/cuda/jdk-/jre-/cursorsetup/rufus (same name cues as today’s installer rule) |

A file matches at most one kind (`disk-images` first if both could apply). Size floor stays the current installer minimum (default 20 MB) so tiny stubs are not “archives.”

## Hot zone

The **user profile** (`homedir()` / `%USERPROFILE%`) is the junk-prone area, **except** `AppData` (and the Unix equivalents `.config` / `.local` / `.cache` if we scan a home tree).

- Files of a kind **inside the hot zone** are never used to auto-propose “this folder is an archive.”
- They are candidates for **Recycle** or **move into the matching kind archive**.
- Desktop, Downloads, Documents, Pictures, etc. are included because they sit under the profile.

The SpaceTrash data dir is under AppData, so it is already outside the hot zone.

## Archive root and kind folders

The user chooses one **archive root** (folder picker). It must not be inside the hot zone (refuse `C:\Users\…`). A drive root such as `G:\` is allowed.

On first confirm of a kind (create-archive), SpaceTrash creates `<root>\<default folder name>\` if needed. The user may rename that folder in the UI; SpaceTrash stores the **path**, not the display name, keyed by kind id.

Renaming in Explorer: next scan, if the stored path is missing, emit a finding “Disk images archive folder is gone — pick it again or recreate,” not a silent recreate that could duplicate a renamed folder.

**Protect** remains a separate lock: “never recommend deleting under this path.” A labeled kind folder is also never a recycle target. Protect on the whole archive drive is still valid; tidy-up **from the profile into** that drive still applies.

## Findings

All of these are issues in the existing Preview → Confirm flow. No new silent engine actions.

1. **Label existing cluster** — A non-hot parent folder contains **3 or more** files of the same kind (meeting the size floor). Propose: “This looks like a Disk images archive.” Confirm sets that folder as the kind archive path (and records the archive root as its ancestor drive/folder if none is set: the parent of the kind folder, or the folder itself if it is a drive root). Do not move files already in that folder.

2. **Create kind archive + move** — Kind files in the hot zone, and that kind has no labeled folder yet. Two actions on the same finding: **Create `<default name>` under the archive root and move these** (if no root yet, the preview step includes picking the root), or **Recycle**. Default highlighted action is create+move.

3. **Move to existing archive** — Kind files in the hot zone, kind folder already labeled. Default action **Move to \<folder name\>**. Recycle remains an alternate action. Confirm still required.

4. **Archive folder missing** — Stored kind path does not exist. Pick again / recreate empty folder. Do not recycle the missing archive’s former contents (they are gone or unmounted).

Files **already under** a labeled kind path are `keep`. They do not appear in (2) or (3).

Caches, Downloads\tmp scratch, Windows.old, node_modules, etc. stay on the existing recycle rules. They are not kind-archive members.

## Apply

- Recycle: existing Recycle Bin path; deny list unchanged.
- The issue card’s default action is stored on the finding (`archive` or `recycle`). Preview accepts an optional `action` of `recycle` or `archive` that must be allowed for that finding (move/create findings allow both; recycle-only findings do not allow `archive`). The preview token is bound to the chosen action.
- Move: after Confirm, relocate each path into the kind folder.
  - Same volume: `rename`.
  - Cross-volume: copy, verify size, then remove the source (if copy or verify fails, leave the source, report `failed`).
- Name collision: append ` (1)`, ` (2)`, … before the extension.
- Deny list and user-protected roots: refuse. Do not move *out of* a labeled kind folder.
- Partial success: `ApplyResult` lists recycled/moved vs failed; finding is `applied` if any succeeded, `failed` if none did.
- Preview token still one-time; Confirm must be true.

While a scan is running, do not apply.

## Monitoring

Later scans:

- Incremental walk unchanged.
- Re-classify with the new rules.
- New kind files in the hot zone → finding (2) or (3).
- Kind files that appear in an unlabeled cold cluster → finding (1) if that kind has no folder yet; if it already has a folder, do **not** auto-merge a second cluster (offer move into the labeled folder instead, same as (3), including cold-zone strays that are unused).

**Unused** for strays outside the hot zone: `unusedDays` (default 90). Hot-zone kind files do **not** need to be old; profile leftovers are tidy-up candidates regardless of mtime.

## App update and scan data

Compare `VERSION` to a stored `last_app_version`.

On a newer version, the UI shows a choice **before** using old findings:

- **Recommended: Clear scan data** — delete rows in `scans`, `files`, `findings`, `classified`, `previews`, `inventory`. Keep `protected_roots`, archive root, kind-folder rows, and the files on disk.
- **Keep scan data** — leave the index; next scan still incremental. Findings may be stale until the user scans again.

Never delete the archive root or kind-folder files as part of this prompt.

## Data

New tables (names can match implementation):

- `settings(key PRIMARY KEY, value TEXT)` — `archive_root`, `last_app_version`.
- `archive_kinds(kind TEXT PRIMARY KEY, path TEXT NOT NULL)` — labeled folder per kind.

Existing `protected_roots` unchanged.

## UI

- Drive pinwheels and Protect stay.
- First create+move (or a small settings control): pick archive root.
- Kind folders listed with current name (basename of path) and Rename (updates the stored path via folder picker or in-place rename + `rename` on disk if still under the root).
- Issue cards: title, why, default action, Recycle as secondary when the default is move/create+move.
- Classification wheel: moves use `archiveable` + `archive`; recycle uses `removable` / `bloat` as today.
- Update prompt on launch when `VERSION` ≠ `last_app_version` (and a previous version was stored). Fresh install writes `last_app_version` without prompting.

## Safety

- Junctions / reparse: still not followed on walk; do not move a reparse point as if it were a file.
- Unmounted archive root: findings explain; do not invent Recycle for files we cannot see.
- Archive root inside hot zone: rejected with a clear error.
- Cross-volume move never deletes the source until the copy verifies.

## Tests (fixture)

1. Profile-like hot folder with one ISO + a cold folder with three ISOs → cluster label finding for the cold folder; the hot ISO is create+move or recycle, not “this Desktop is an archive.”
2. After confirming the cold folder as `disk-images`, the hot ISO becomes a **move** finding, not recycle.
3. Confirm move: file lands in the kind folder; source gone; collision suffix if a same name exists.
4. File already in the kind folder: not in recycle/move findings.
5. Installer `.msi` does not enter the disk-images folder.
6. Apply without confirm / without token still rejected.
7. Deny-listed path refused.
8. Clear-scan-data keeps `archive_kinds` and disk files; drops `inventory` / findings.
9. Cluster of two ISOs in the cold folder: no label-cluster finding (threshold 3).

## Implementation order

1. Settings + `archive_kinds` + root picker validation.
2. Classifier split (hot zone, kinds, cluster, keep-in-archive) and findings (1)–(4).
3. Real archive move in `apply` (replace preview-only error).
4. UI: actions on issue cards, rename, update wipe prompt.
5. Tests above; bump version after the slice that users can run.

Ship as one version once 1–4 work; do not leave move as preview-only if label/create is already in the UI.
