import assert from "node:assert/strict";
import { mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { closeDb } from "./db.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const data = join(repoRoot, "fixtures", "safe-scan-generated", "data");
const fixture = join(repoRoot, "fixtures", "safe-scan-generated", "tree");
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
});
