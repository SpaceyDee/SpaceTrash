# App leftover folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each scan, treat program-named folders as leftover bloat only when they are not linked to an installed app or shortcut; Ignore, Move to `App leftovers`, or Recycle behind Preview → Confirm.

**Architecture:** Classify-time `ProgramIndex` (uninstall keys + `.lnk` targets, injectable via `SPACETRASH_PROGRAM_INDEX`). Matching and connectedness live in `packages/core/src/programs.ts`. Classifier emits one finding per orphan folder. Ignore persists in `ignored_paths`. Move reuses archive apply with directory support.

**Tech Stack:** TypeScript, Node 22, better-sqlite3, existing engine/API/desktop UI, PowerShell only for live Windows inventory.

## Global Constraints

- Preview → Confirm for ignore, move, and recycle. No silent file changes.
- Windows inventory in this version; other OS: empty index unless JSON injected.
- Do not flag AppData/ProgramData trees while a matching program is still installed.
- Publisher-only tokens do not match.
- Default leftover size floor 5 MB (`leftoverMinBytes`).
- Version 0.1.9. Do not commit `dist/` or secrets.
- Tests must set an empty program index so live registry cannot pollute fixtures.

---

### Task 1: Matching unit tests and `programs.ts`

**Files:**
- Create: `packages/core/src/programs.test.ts`
- Create: `packages/core/src/programs.ts`

**Interfaces:**
- Produces: `InstalledProgram`, `ProgramIndex`, `tokenizeName`, `strongTokens`, `folderMatchesProgram`, `bestMatchingProgram`, `isConnectedFolder`, `isLikelyLiveAppData`, `loadProgramIndex`, `resetProgramIndexCache`

- [ ] **Step 1: Write failing matching tests** (Chrome vs Google, connected install/shortcut, AppData heuristic, JSON loader).
- [ ] **Step 2: Run `npm test -w @spacetrash/core -- src/programs.test.ts` and confirm RED.**
- [ ] **Step 3: Implement `programs.ts` (no classifier yet).**
- [ ] **Step 4: Tests GREEN.**

### Task 2: Directory archive move

**Files:**
- Modify: `packages/core/src/archive.ts`
- Modify: `packages/core/src/types.ts` (`ArchiveKind` += `app-leftovers`, `ActionKind` += `ignore`, `ScanOptions.leftoverMinBytes`, optional `Finding.programName`)
- Test: extend `packages/core/src/engine.test.ts` or archive-focused tests in the leftover describe

- [ ] **Step 1: Test that moving a directory into a dest folder lands the tree and suffixes collisions.**
- [ ] **Step 2: Extend `moveIntoArchive` to allow non-reparse directories (same-volume rename, cross-volume copy + size verify + rm).**

### Task 3: Classifier + ignore table + engine apply

**Files:**
- Modify: `packages/core/src/db.ts` (`ignored_paths`, list/set helpers; keep on `clearScanIndex`)
- Modify: `packages/core/src/rules.ts` (replace hardcoded app-copies; `classifyAppLeftovers`)
- Modify: `packages/core/src/engine.ts` (apply `ignore`; preview allows it)
- Modify: `packages/core/src/engine.test.ts` (empty index at file top; leftover fixtures)
- Modify: `.gitignore` (`fixtures/app-leftover-generated/`)

- [ ] **Step 1: RED engine tests per spec tests 4–8.**
- [ ] **Step 2: Implement classifier, ignore apply, reclassify.**
- [ ] **Step 3: GREEN full `npm test`.**

### Task 4: API, UI, MCP, docs, version

**Files:**
- Modify: `packages/api/src/server.ts`
- Modify: `packages/desktop/renderer/index.html`, `app.js`
- Modify: `packages/mcp/src/index.ts`
- Modify: `packages/core/src/cli.ts` if scan options need leftover min
- Modify: `README.md`, `docs/RELEASE.md`
- Version `0.1.9` in package.json files, `paths.ts` VERSION, MCP server version

- [ ] **Step 1: Preview ignore button; kinds accept `app-leftovers`; MCP enum `ignore`.**
- [ ] **Step 2: Bump 0.1.9, RELEASE note, README safety line.**
- [ ] **Step 3: `npm test`, `npm run dist:win`, `python scripts/publish-update.py`.**
