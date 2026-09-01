import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile, utimes, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { closeDb, insertScan, openDb } from "./db.ts";
import { resetProgramIndexCache } from "./programs.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const data = join(repoRoot, "fixtures", "safe-scan-generated", "data");
const fixture = join(repoRoot, "fixtures", "safe-scan-generated", "tree");
const emptyPrograms = join(repoRoot, "fixtures", "app-leftover-generated", "empty.json");
mkdirSync(dirname(emptyPrograms), { recursive: true });
writeFileSync(emptyPrograms, JSON.stringify({ programs: [], shortcutTargets: [] }));
process.env.SPACETRASH_PROGRAM_INDEX = emptyPrograms;
process.env.SPACETRASH_DATA = data;
closeDb();

const { createEngine } = await import("./engine.ts");

async function waitForScan(engine: ReturnType<typeof createEngine>, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = engine.getScan(id);
    if (job && (job.status === "complete" || job.status === "failed" || job.status === "cancelled")) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("scan timed out");
}

describe("engine fixture scan", () => {
  before(async () => {
    await rm(join(repoRoot, "fixtures", "safe-scan-generated"), { recursive: true, force: true });
    await mkdir(data, { recursive: true });
    await mkdir(join(fixture, "Downloads", "tmp"), { recursive: true });
    await mkdir(join(fixture, "leftover"), { recursive: true });
    await writeFile(join(fixture, "Downloads", "CursorSetup-x64.exe"), Buffer.alloc(64 * 1024, 1));
    await writeFile(join(fixture, "Downloads", "notes.txt"), "keep me\n");
    await writeFile(join(fixture, "Downloads", "tmp", "junk.bin"), Buffer.alloc(4096, 2));
    await writeFile(join(fixture, "cuda_12.4_installer.exe"), Buffer.alloc(80 * 1024, 3));
    const stale = join(fixture, "old-archive.bin");
    await writeFile(stale, Buffer.alloc(128 * 1024, 4));
    const past = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(stale, past, past);
  });

  after(() => {
    closeDb();
  });

  it("classifies installers, scratch files, and large unused without applying", async () => {
    const engine = createEngine();
    const job = engine.startScan({
      roots: [fixture],
      installerMinBytes: 1024,
      largeMinBytes: 50 * 1024,
      unusedDays: 30,
    });
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    assert.ok(done.filesSeen >= 4);

    const findings = engine.findings(job.id);
    const titles = findings.map((f) => f.title).join(" | ");
    assert.ok(
      findings.some((f) => f.class === "removable" && f.title.toLowerCase().includes("installer")),
      titles,
    );
    assert.ok(
      findings.some((f) => f.title.toLowerCase().includes("downloads\\tmp") || f.title.toLowerCase().includes("scratch")),
      titles,
    );
    assert.ok(
      findings.some((f) => f.class === "archiveable"),
      titles,
    );

    const installer = findings.find((f) => f.title.toLowerCase().includes("installer"));
    assert.ok(installer);
    const preview = engine.preview(installer.id);
    assert.ok(preview.token.length > 10);
    await assert.rejects(() => engine.apply(preview.token, false), /confirm/);
    await assert.rejects(() => engine.apply("not-a-token", true), /unknown/);

    const notes = findings.flatMap((f) => f.paths).some((p) => p.toLowerCase().endsWith("notes.txt"));
    assert.equal(notes, false, "keep file should not be in findings");
  });

  it("does not recommend deleting files on a protected archive root", async () => {
    const archive = join(fixture, "..", "archive-drive");
    await mkdir(archive, { recursive: true });
    const stale = join(archive, "old-backup.bin");
    await writeFile(stale, Buffer.alloc(128 * 1024, 5));
    const past = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(stale, past, past);
    const engine = createEngine();
    await engine.setProtected(archive, true);
    const job = engine.startScan({
      roots: [fixture, archive],
      installerMinBytes: 1024,
      largeMinBytes: 50 * 1024,
      unusedDays: 30,
    });
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const findings = engine.findings(job.id);
    const dump = findings.map((f) => `${f.title}:${f.paths.join(",")}`).join(" | ");
    assert.equal(
      findings.some((f) => f.paths.some((p) => p.toLowerCase().includes("old-backup.bin"))),
      false,
      dump,
    );
    assert.ok(
      findings.some((f) => f.title.toLowerCase().includes("scratch") || f.title.toLowerCase().includes("downloads\\tmp")),
      dump,
    );
    await engine.setProtected(archive, false);
  });

  it("clears archive findings when a root is protected after the scan", async () => {
    const archive = join(fixture, "..", "archive-drive");
    await mkdir(archive, { recursive: true });
    const stale = join(archive, "old-backup.bin");
    await writeFile(stale, Buffer.alloc(128 * 1024, 5));
    const past = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(stale, past, past);
    const engine = createEngine();
    await engine.setProtected(archive, false);
    const job = engine.startScan({
      roots: [archive],
      installerMinBytes: 1024,
      largeMinBytes: 50 * 1024,
      unusedDays: 30,
    });
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const before = engine.findings(job.id);
    assert.ok(
      before.some((f) => f.paths.some((p) => p.toLowerCase().includes("old-backup.bin"))),
      before.map((f) => f.title).join(" | "),
    );
    await engine.setProtected(archive, true);
    const after = engine.findings(job.id);
    assert.equal(
      after.some((f) => f.paths.some((p) => p.toLowerCase().includes("old-backup.bin"))),
      false,
      after.map((f) => `${f.title}:${f.paths.join(",")}`).join(" | "),
    );
    await engine.setProtected(archive, false);
  });

  it("indexes files from every selected root", async () => {
    const a = join(fixture, "..", "root-a");
    const b = join(fixture, "..", "root-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "only-a.bin"), Buffer.alloc(2048, 9));
    await writeFile(join(b, "only-b.bin"), Buffer.alloc(2048, 8));
    const engine = createEngine();
    const job = engine.startScan({ roots: [a, b] });
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const db = openDb();
    const paths = (
      db.prepare(`SELECT path FROM files WHERE scan_id = ? AND is_dir = 0`).all(done.id) as { path: string }[]
    ).map((row) => row.path.replace(/\\/g, "/").toLowerCase());
    assert.ok(
      paths.some((p) => p.endsWith("only-a.bin")),
      `missing only-a.bin in ${paths.join(" | ")}`,
    );
    assert.ok(
      paths.some((p) => p.endsWith("only-b.bin")),
      `missing only-b.bin in ${paths.join(" | ")}`,
    );
  });

  it("stops a running scan when cancelled", async () => {
    const engine = createEngine();
    const job = engine.startScan({ roots: [fixture] });
    const stopped = engine.cancelScan(job.id);
    assert.ok(stopped);
    assert.equal(stopped.status, "cancelled");
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "cancelled");
    assert.match(done.error ?? "", /cancel/i);
    await new Promise((r) => setTimeout(r, 25));
  });

  it("marks leftover running scans cancelled on startup", () => {
    closeDb();
    const db = openDb();
    insertScan(db, {
      id: "scan_stale_shutdown",
      status: "running",
      roots: [fixture],
      filesSeen: 12,
      bytesSeen: 99,
      startedAt: Date.now() - 60_000,
      progress: 0.4,
      currentPath: "C:\\somewhere",
    });
    closeDb();
    const engine = createEngine();
    assert.equal(engine.status().activeScanId, null);
    const stale = engine.getScan("scan_stale_shutdown");
    assert.ok(stale);
    assert.equal(stale.status, "cancelled");
    assert.match(stale.error ?? "", /exited|Interrupted/i);
  });
});

describe("archive tidy-up", () => {
  const tidyRoot = join(repoRoot, "fixtures", "archive-tidy-generated");
  const hot = join(tidyRoot, "profile");
  const cold = join(tidyRoot, "stash");
  const pair = join(tidyRoot, "pair");
  const archiveRoot = join(tidyRoot, "archive-root");
  const prevHot = process.env.SPACETRASH_HOT_ZONE;

  before(async () => {
    process.env.SPACETRASH_HOT_ZONE = hot;
    await mkdir(join(hot, "Desktop"), { recursive: true });
    await mkdir(cold, { recursive: true });
    await mkdir(pair, { recursive: true });
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(join(hot, "Desktop", "leftover.iso"), Buffer.alloc(64 * 1024, 1));
    await writeFile(join(hot, "Desktop", "cuda_setup.msi"), Buffer.alloc(64 * 1024, 2));
    await writeFile(join(cold, "a.iso"), Buffer.alloc(64 * 1024, 3));
    await writeFile(join(cold, "b.iso"), Buffer.alloc(64 * 1024, 4));
    await writeFile(join(cold, "c.iso"), Buffer.alloc(64 * 1024, 5));
    await writeFile(join(pair, "x.iso"), Buffer.alloc(64 * 1024, 6));
    await writeFile(join(pair, "y.iso"), Buffer.alloc(64 * 1024, 7));
  });

  after(() => {
    if (prevHot === undefined) delete process.env.SPACETRASH_HOT_ZONE;
    else process.env.SPACETRASH_HOT_ZONE = prevHot;
  });

  function scanOpts(roots: string[]) {
    return { roots, installerMinBytes: 1024, largeMinBytes: 50 * 1024, unusedDays: 30 };
  }

  it("labels a cold disk-image cluster and does not treat the profile as an archive", async () => {
    const engine = createEngine();
    const job = engine.startScan(scanOpts([hot, cold]));
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const findings = engine.findings(job.id);
    const dump = findings.map((f) => `${f.action}:${f.title}:${f.paths.join(",")}`).join(" | ");
    const label = findings.find((f) => f.action === "label" && f.kind === "disk-images");
    assert.ok(label, dump);
    assert.equal(
      label.paths.some((p) => p.toLowerCase().includes("leftover.iso")),
      false,
      dump,
    );
    assert.ok(
      label.paths.some((p) => p.toLowerCase().endsWith("a.iso")),
      dump,
    );
    const hotIso = findings.find((f) => f.paths.some((p) => p.toLowerCase().endsWith("leftover.iso")));
    assert.ok(hotIso, dump);
    assert.notEqual(hotIso.action, "label", dump);
    assert.ok(hotIso.allowedActions?.includes("recycle"), dump);
    assert.ok(hotIso.allowedActions?.includes("archive"), dump);
  });

  it("does not label a cold folder with only two disk images", async () => {
    const engine = createEngine();
    const job = engine.startScan(scanOpts([pair]));
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const findings = engine.findings(job.id);
    assert.equal(
      findings.some((f) => f.action === "label"),
      false,
      findings.map((f) => f.title).join(" | "),
    );
  });

  it("moves a profile leftover into the labeled disk-images folder after confirm", async () => {
    const engine = createEngine();
    engine.setArchiveRoot(archiveRoot);
    engine.setKindFolder("disk-images", cold);
    const job = engine.startScan(scanOpts([hot, cold, archiveRoot]));
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const findings = engine.findings(job.id);
    const dump = findings.map((f) => `${f.action}:${f.title}:${f.paths.join(",")}`).join(" | ");
    const move = findings.find((f) => f.paths.some((p) => p.toLowerCase().endsWith("leftover.iso")));
    assert.ok(move, dump);
    assert.equal(move.action, "archive", dump);
    assert.equal(
      findings.some((f) => f.paths.some((p) => p.toLowerCase().endsWith("a.iso")) && f.action !== "label"),
      false,
      dump,
    );
    const msi = findings.find((f) => f.paths.some((p) => p.toLowerCase().endsWith("cuda_setup.msi")));
    assert.ok(msi, dump);
    assert.notEqual(msi.kind, "disk-images", dump);

    const preview = engine.preview(move.id, { action: "archive" });
    assert.equal(preview.action, "archive");
    const result = await engine.apply(preview.token, true);
    assert.equal(result.moved.length, 1, JSON.stringify(result));
    const dest = join(cold, "leftover.iso");
    await stat(dest);
    await assert.rejects(() => stat(join(hot, "Desktop", "leftover.iso")));
  });

  it("suffixes the destination when the archive already has that name", async () => {
    await writeFile(join(hot, "Desktop", "leftover.iso"), Buffer.alloc(64 * 1024, 8));
    await writeFile(join(cold, "leftover.iso"), Buffer.alloc(32, 9));
    const engine = createEngine();
    engine.setArchiveRoot(archiveRoot);
    engine.setKindFolder("disk-images", cold);
    const job = engine.startScan(scanOpts([hot, cold]));
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const move = engine.findings(job.id).find((f) => f.paths.some((p) => p.toLowerCase().includes("desktop") && p.toLowerCase().endsWith("leftover.iso")));
    assert.ok(move);
    const preview = engine.preview(move.id, { action: "archive" });
    const result = await engine.apply(preview.token, true);
    assert.equal(result.moved.length, 1, JSON.stringify(result));
    await stat(join(cold, "leftover (1).iso"));
  });

  it("refuses a deny-listed path and apply without confirm", async () => {
    const engine = createEngine();
    engine.setArchiveRoot(archiveRoot);
    const job = engine.startScan(scanOpts([hot]));
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const move = engine.findings(job.id).find((f) => f.action === "archive" || f.allowedActions?.includes("archive"));
    assert.ok(move);
    const preview = engine.preview(move.id, { action: "archive" });
    await assert.rejects(() => engine.apply(preview.token, false), /confirm/);
    await assert.rejects(() => engine.apply("not-a-token", true), /unknown/);
  });

  it("clears scan index but keeps archive kind folders on disk", async () => {
    const engine = createEngine();
    engine.setArchiveRoot(archiveRoot);
    engine.setKindFolder("disk-images", cold);
    const job = engine.startScan(scanOpts([cold]));
    await waitForScan(engine, job.id);
    engine.clearScanData();
    const db = openDb();
    const scans = db.prepare(`SELECT COUNT(*) AS n FROM scans`).get() as { n: number };
    const inv = db.prepare(`SELECT COUNT(*) AS n FROM inventory`).get() as { n: number };
    assert.equal(Number(scans.n), 0);
    assert.equal(Number(inv.n), 0);
    const state = engine.archiveState();
    assert.equal(state.kinds.some((k) => k.kind === "disk-images"), true);
    await stat(join(cold, "a.iso"));
  });
});

describe("app leftover folders", () => {
  const leftoverRoot = join(repoRoot, "fixtures", "app-leftover-generated");
  const tree = join(leftoverRoot, "tree");
  const orphan = join(tree, "Pulsar-old");
  const portable = join(tree, "Pulsar");
  const archiveRoot = join(leftoverRoot, "archive-root");
  const home = join(leftoverRoot, "home");
  const appData = join(home, "AppData", "Local", "Pulsar");
  const indexFile = join(leftoverRoot, "pulsar.json");
  const prevIndex = process.env.SPACETRASH_PROGRAM_INDEX;
  const prevHome = process.env.SPACETRASH_PROGRAM_HOME;

  function scanOpts(roots: string[]) {
    return { roots, installerMinBytes: 1024, largeMinBytes: 50 * 1024, unusedDays: 30, leftoverMinBytes: 1024 };
  }

  function writeIndex(body: unknown) {
    writeFileSync(indexFile, JSON.stringify(body));
    process.env.SPACETRASH_PROGRAM_INDEX = indexFile;
    resetProgramIndexCache();
  }

  before(async () => {
    await mkdir(join(orphan, "bin"), { recursive: true });
    await mkdir(join(portable, "bin"), { recursive: true });
    await mkdir(appData, { recursive: true });
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(join(orphan, "bin", "pulsar.exe"), Buffer.alloc(6 * 1024 * 1024, 1));
    await writeFile(join(portable, "bin", "pulsar.exe"), Buffer.alloc(6 * 1024 * 1024, 2));
    await writeFile(join(appData, "state.dat"), Buffer.alloc(6 * 1024 * 1024, 3));
    try {
      openDb().exec("DELETE FROM ignored_paths");
    } catch {
      // table added in this version
    }
  });

  after(() => {
    process.env.SPACETRASH_PROGRAM_INDEX = prevIndex;
    if (prevHome === undefined) delete process.env.SPACETRASH_PROGRAM_HOME;
    else process.env.SPACETRASH_PROGRAM_HOME = prevHome;
    resetProgramIndexCache();
  });

  it("does not use the old hardcoded pulsar path rule when the program index is empty", async () => {
    writeIndex({ programs: [], shortcutTargets: [] });
    const engine = createEngine();
    const job = engine.startScan(scanOpts([tree]));
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const dump = engine.findings(job.id).map((f) => f.title).join(" | ");
    assert.equal(dump.toLowerCase().includes("old app copies"), false, dump);
    assert.equal(
      engine.findings(job.id).some((f) => f.kind === "app-leftovers"),
      false,
      dump,
    );
  });

  it("flags an orphan folder that matches an installed app name but is not the live path", async () => {
    writeIndex({
      programs: [
        {
          displayName: "Pulsar",
          installLocation: "C:\\Program Files\\Pulsar",
          uninstallString: '"C:\\Program Files\\Pulsar\\uninstall.exe"',
          publisher: "SpaceyDee",
        },
      ],
      shortcutTargets: [join(portable, "bin", "pulsar.exe")],
    });
    process.env.SPACETRASH_PROGRAM_HOME = home;
    const engine = createEngine();
    const job = engine.startScan(scanOpts([tree, home]));
    const done = await waitForScan(engine, job.id);
    assert.equal(done.status, "complete", done.error);
    const findings = engine.findings(job.id);
    const dump = findings.map((f) => `${f.action}:${f.title}:${f.paths.join(",")}`).join(" | ");
    const leftover = findings.find((f) => f.kind === "app-leftovers" && f.paths.some((p) => p.toLowerCase().includes("pulsar-old")));
    assert.ok(leftover, dump);
    assert.equal(leftover.class, "bloat");
    assert.ok(leftover.allowedActions?.includes("archive"), dump);
    assert.ok(leftover.allowedActions?.includes("recycle"), dump);
    assert.ok(leftover.allowedActions?.includes("ignore"), dump);
    assert.equal(
      findings.some((f) => f.kind === "app-leftovers" && f.paths.some((p) => /[\\/]pulsar$/i.test(p))),
      false,
      dump,
    );
    assert.equal(
      findings.some((f) => f.kind === "app-leftovers" && f.paths.some((p) => p.toLowerCase().includes("appdata"))),
      false,
      dump,
    );
  });

  it("ignores an orphan folder on confirm and does not flag it again", async () => {
    writeIndex({
      programs: [
        {
          displayName: "Pulsar",
          installLocation: "C:\\Program Files\\Pulsar",
          uninstallString: null,
          publisher: "SpaceyDee",
        },
      ],
      shortcutTargets: [],
    });
    const engine = createEngine();
    const job = engine.startScan(scanOpts([tree]));
    await waitForScan(engine, job.id);
    const leftover = engine.findings(job.id).find((f) => f.kind === "app-leftovers" && f.paths.some((p) => p.toLowerCase().includes("pulsar-old")));
    assert.ok(leftover);
    const preview = engine.preview(leftover.id, { action: "ignore" });
    const result = await engine.apply(preview.token, true);
    assert.equal(result.action, "ignore");
    engine.clearScanData();
    const again = engine.startScan(scanOpts([tree]));
    await waitForScan(engine, again.id);
    const after = engine.findings(again.id);
    assert.equal(
      after.some((f) => f.kind === "app-leftovers" && f.paths.some((p) => p.toLowerCase().includes("pulsar-old"))),
      false,
      after.map((f) => f.title).join(" | "),
    );
    engine.setIgnored(leftover.paths[0], false);
  });

  it("moves an orphan folder into App leftovers after confirm", async () => {
    writeIndex({
      programs: [
        {
          displayName: "Pulsar",
          installLocation: "C:\\Program Files\\Pulsar",
          uninstallString: null,
          publisher: "SpaceyDee",
        },
      ],
      shortcutTargets: [],
    });
    const engine = createEngine();
    engine.setArchiveRoot(archiveRoot);
    const job = engine.startScan(scanOpts([tree]));
    await waitForScan(engine, job.id);
    const leftover = engine.findings(job.id).find((f) => f.kind === "app-leftovers" && f.paths.some((p) => p.toLowerCase().includes("pulsar-old")));
    assert.ok(leftover);
    const preview = engine.preview(leftover.id, { action: "archive" });
    const result = await engine.apply(preview.token, true);
    assert.equal(result.moved.length, 1, JSON.stringify(result));
    await stat(join(archiveRoot, "App leftovers", "Pulsar-old", "bin", "pulsar.exe"));
    await assert.rejects(() => stat(orphan));
  });
});
