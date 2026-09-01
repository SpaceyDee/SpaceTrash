import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { closeDb, openDb } from "./db.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const data = join(repoRoot, "fixtures", "walk-generated", "data");
const tree = join(repoRoot, "fixtures", "walk-generated", "tree");
process.env.SPACETRASH_DATA = data;
closeDb();

const { walkRoots } = await import("./walker.ts");

async function walk(scanId: string, roots: string[]) {
  const db = openDb();
  return walkRoots(db, scanId, roots, () => undefined, () => false);
}

function filePaths(scanId: string): string[] {
  const db = openDb();
  return (
    db.prepare(`SELECT path FROM files WHERE scan_id = ? AND is_dir = 0`).all(scanId) as { path: string }[]
  ).map((row) => row.path.replace(/\\/g, "/").toLowerCase());
}

describe("incremental walk", () => {
  before(async () => {
    await rm(join(repoRoot, "fixtures", "walk-generated"), { recursive: true, force: true });
    await mkdir(data, { recursive: true });
    await mkdir(join(tree, "keep"), { recursive: true });
    await mkdir(join(tree, "tiles"), { recursive: true });
    await writeFile(join(tree, "keep", "notes.txt"), "keep me\n");
    await writeFile(join(tree, "tiles", "a.jpg"), Buffer.alloc(128, 1));
    await writeFile(join(tree, "tiles", "b.jpg"), Buffer.alloc(128, 2));
    closeDb();
  });

  after(() => {
    closeDb();
  });

  it("indexes the first deep sweep and reports no skips", async () => {
    const first = await walk("scan_first", [tree]);
    assert.equal(first.errors.length, 0, first.errors.map((e) => e.message).join("; "));
    assert.ok(first.filesWalked >= 3, `walked ${first.filesWalked}`);
    assert.equal(first.filesSkipped, 0);
    const paths = filePaths("scan_first");
    assert.ok(paths.some((p) => p.endsWith("notes.txt")));
    assert.ok(paths.some((p) => p.endsWith("a.jpg")));
  });

  it("skips unchanged folders on the next scan of the same tree", async () => {
    const second = await walk("scan_second", [tree]);
    assert.equal(second.errors.length, 0, second.errors.map((e) => e.message).join("; "));
    assert.ok(second.filesSkipped >= 3, `expected known files to be skipped, got ${second.filesSkipped}`);
    assert.ok(second.filesWalked < second.filesSeen, `walked ${second.filesWalked} of ${second.filesSeen}`);
    const paths = filePaths("scan_second");
    assert.ok(paths.some((p) => p.endsWith("notes.txt")), "skipped files must still be in this scan");
    assert.ok(paths.some((p) => p.endsWith("b.jpg")));
  });

  it("picks up a new file without re-walking unchanged siblings", async () => {
    await writeFile(join(tree, "keep", "new.bin"), Buffer.alloc(64, 7));
    const third = await walk("scan_third", [tree]);
    assert.equal(third.errors.length, 0, third.errors.map((e) => e.message).join("; "));
    const paths = filePaths("scan_third");
    assert.ok(
      paths.some((p) => p.endsWith("new.bin")),
      `missing new.bin in ${paths.join(" | ")}`,
    );
    assert.ok(third.filesWalked >= 1, "changed folder should be walked");
    assert.ok(third.filesSkipped >= 1, "unchanged tiles folder should still skip");
  });

  it("records a walk error instead of silently skipping a missing root", async () => {
    const missing = join(tree, "does-not-exist");
    const result = await walk("scan_missing", [missing]);
    assert.ok(result.errors.length >= 1, "expected a walk error");
    assert.match(result.errors[0].message, /opendir|ENOENT|no such|cannot find/i);
    assert.ok(result.rootProgress.some((r) => r.error));
  });

  it("walks selected roots at the same time", async () => {
    const a = join(tree, "..", "parallel-a");
    const b = join(tree, "..", "parallel-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    for (let i = 0; i < 400; i++) {
      await writeFile(join(a, `a-${i}.bin`), Buffer.alloc(16, 1));
      await writeFile(join(b, `b-${i}.bin`), Buffer.alloc(16, 2));
    }
    const snaps: { a: number; b: number; aDone?: boolean; bDone?: boolean }[] = [];
    const db = openDb();
    await walkRoots(
      db,
      "scan_parallel",
      [a, b],
      (p) => {
        const ra = p.rootProgress.find((r) => r.root === a);
        const rb = p.rootProgress.find((r) => r.root === b);
        snaps.push({
          a: ra?.filesWalked ?? 0,
          b: rb?.filesWalked ?? 0,
          aDone: ra?.done,
          bDone: rb?.done,
        });
      },
      () => false,
    );
    const last = snaps.at(-1);
    assert.ok(last && last.a > 0 && last.b > 0, `both roots should finish walking: ${JSON.stringify(snaps)}`);
  });

  it("does not loop when a folder is stored as its own inventory parent", { timeout: 20_000 }, async () => {
    const db = openDb();
    const root = (await import("./paths.ts")).normalizePath(tree);
    db.prepare(`UPDATE inventory SET parent = path WHERE path = ?`).run(root);
    const looped = await walkRoots(db, "scan_self_parent", [tree], () => undefined, () => false);
    assert.equal(looped.errors.length, 0, looped.errors.map((e) => e.message).join("; "));
    assert.ok(filePaths("scan_self_parent").some((p) => p.endsWith("notes.txt")));
  });

  it("reports every selected root in progress", async () => {
    const a = join(tree, "..", "walk-a");
    const b = join(tree, "..", "walk-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "only-a.bin"), Buffer.alloc(32, 3));
    await writeFile(join(b, "only-b.bin"), Buffer.alloc(32, 4));
    const result = await walk("scan_roots", [a, b]);
    assert.equal(result.errors.length, 0, result.errors.map((e) => e.message).join("; "));
    assert.equal(result.rootProgress.length, 2);
    const paths = filePaths("scan_roots");
    assert.ok(paths.some((p) => p.endsWith("only-a.bin")));
    assert.ok(paths.some((p) => p.endsWith("only-b.bin")));
  });
});
