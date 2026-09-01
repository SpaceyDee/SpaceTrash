# App leftover folders

Date: 2026-09-01

SpaceTrash should stop treating a folder as leftover just because its name looks like an app. After each scan, classify-time matching against **installed programs** (uninstall registry) and **Start Menu / desktop shortcuts** decides whether a named folder is still in use. Live folders stay `keep`. Orphaned folders become one bloat finding each: **Ignore**, **Move** into `App leftovers`, or **Recycle**. Always Preview → Confirm.

## Problem

The “old app copies” rule is a hardcoded name match (Pulsar / Sencraft plus `old` / `copy` / `backup`). A live portable install, a data folder, or an extra copy on another drive all look the same. Caches and installer tidy-up stay separate; this spec is the **bloat** slice for program-named folders.

## Goals

- At **classify** time (not during the walk), build a program index from Windows uninstall keys plus `.lnk` targets.
- Match scanned folders by **install-folder basename** and **DisplayName tokens** (skip tiny tokens and version numbers). Publisher-only tokens are not enough.
- **Connected** folder (install path, uninstall exe, or a shortcut target lives in that folder) → `keep`, no issue.
- Folders under **AppData** or **ProgramData** that still match an installed program are treated as in use even when InstallLocation is under Program Files (typical user-data trees).
- **Orphaned** folder (name matches, not connected, program may still be installed elsewhere) → one finding for that folder.
- Actions: **Ignore** (persist, this rule only), **Move** into archive kind `app-leftovers` (`App leftovers` under the existing archive root), **Recycle**.
- Replace the hardcoded Pulsar/Sencraft leftover-copies rule.

## Non-goals

- Scanning running processes or services.
- Matching publisher/company folders alone (`Google`, `Adobe`).
- Silent ignore / move / delete.
- Splitting other finding types (caches, Windows.old) into per-file cards.
- Generic large-file relocate (still preview-only).
- macOS/Linux program inventory in this version (index is empty there unless tests inject one).

## Program index

Collected once per classify (process cache ~60s). Tests inject JSON via `SPACETRASH_PROGRAM_INDEX`.

**Programs** (Windows):

- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
- `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`
- `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`

Fields: `DisplayName`, `InstallLocation`, `UninstallString`, `Publisher`. Skip entries with no DisplayName.

**Shortcuts**: recurse `*.lnk` under

- `%ProgramData%\Microsoft\Windows\Start Menu\Programs`
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs`
- user Desktop
- Public Desktop

Resolve `TargetPath`. Ignore empty / broken links.

Collector failure → empty index; other classify rules still run. Do not fail the scan.

## Matching

Tokens: split on non-alphanumeric, drop length &lt; 4, drop numeric/version tokens (`12`, `x64` is a stopword), drop stopwords (`the`, `app`, `microsoft`, `windows`, `setup`, `update`, `runtime`, `redistributable`, `sdk`, `pro`, `home`, `preview`, `beta`, …).

**Strong tokens** for a program:

- Install-folder basename (and its tokens), if length ≥ 4 and not a stopword.
- DisplayName tokens that are **not** also tokens of `Publisher`.

A scanned **directory** matches if its name equals the install basename, equals the compacted DisplayName, or contains a strong token on a token boundary (`chrome`, `chrome-old`, `old-chrome`; not `chromedriver` unless `chrome` is a whole token).

One folder → at most one finding (best match: longest strong token).

## Connected vs orphan

A folder is **connected** if any of:

- `InstallLocation` equals the folder or is under it.
- The exe/msi path parsed from `UninstallString` equals the folder or is under it.
- A shortcut target equals the folder or is under it.
- The folder is under the user `AppData` tree or `%ProgramData%` **and** a matching program is still in the index.

Otherwise a name-matched folder is an **orphan** candidate.

Skip: deny-listed paths, protected roots, ignored paths, scan roots, drive roots, labeled kind-archive folders (and anything under them), directories with descendant file bytes below `leftoverMinBytes` (default 5 MB; tests may pass 1024).

## Findings

Class `bloat`. Rule id `applet`. **One finding per folder.** `paths` is the folder (the unit to move/recycle), not every file. `fileCount` / `bytes` are descendant files.

- Default action `archive` (move). `kind: app-leftovers`. `allowedActions: ["archive","recycle","ignore"]`.
- If no archive root yet, `needsArchiveRoot: true` (same picker as installer tidy-up).
- If the kind folder exists, `destPath` is that folder (the leftover directory is moved *into* it).
- Title like `Leftover {DisplayName}: {folder name}`. Why explains it is not the live install/shortcut path.

Ignore Confirm writes `ignored_paths` and reclassifies. It does not Protect the folder; other rules can still flag caches inside if they were not claimed. This rule will not flag that folder again until un-ignored.

Move: same archive apply as installers, but the source **may be a directory**. Same volume `rename`; cross-volume copy tree, verify total file size, then remove source. Collision: `name (1)`. Refuse reparse/junctions. Recycle uses existing Recycle Bin for directories.

## Apply and safety

Preview → Confirm unchanged. Ignore, move, and recycle each bind a preview token.

Deny list, Protect, and “do not apply while a scan is running” unchanged.

Clear scan data keeps `ignored_paths`, `protected_roots`, and archive settings.

## Data

- `ignored_paths(path PRIMARY KEY)` — persist Ignore for this rule.
- `archive_kinds` gains kind `app-leftovers`.
- `ScanOptions.leftoverMinBytes` optional.
- Finding meta may include `programName`.

## UI / API / MCP

Issue drawer: Preview move (default), Preview recycle, Preview ignore; Confirm copy matches the chosen action.

Archive root copy mentions App leftovers alongside Disk images / Installers.

`PUT /api/archive/kinds` accepts `app-leftovers`. Preview `action` accepts `ignore`.

MCP preview enum includes `ignore`. Apply description mentions leftover app folders.

## Tests

1. Tokenize / strong tokens: `Google Chrome` + publisher Google → `chrome` matches folder `Chrome`; folder `Google` does not.
2. Connected via InstallLocation or shortcut target → no leftover finding.
3. AppData folder matching an installed program → no leftover finding.
4. Orphan folder on another root with injected index → one bloat finding, allowed ignore/archive/recycle.
5. Ignore persist: second classify of the same scan data does not re-emit that folder.
6. Confirm move: directory lands under `App leftovers`; source gone; collision suffix.
7. Empty program index (default in tests) does not invent leftover findings on existing fixtures.
8. Hardcoded Pulsar/Sencraft path rule is gone (no finding unless the index says so).

## Implementation order

1. `programs.ts` matching + index loader (injectable JSON).
2. Classifier + `ignored_paths` + directory archive move.
3. Engine apply `ignore`; API/UI/MCP.
4. Tests; version **0.1.9**.
