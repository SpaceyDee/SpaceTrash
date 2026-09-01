import { Command } from "commander";
import { getEngine } from "./engine.ts";
import { VERSION } from "./paths.ts";

const program = new Command();
program.name("spacetrash").description("Scan disks, classify bloat, confirm before acting").version(VERSION);

program.command("status").action(() => {
  console.log(JSON.stringify(getEngine().status(), null, 2));
});

program.command("volumes").action(async () => {
  console.log(JSON.stringify(await getEngine().volumes(), null, 2));
});

program
  .command("protect")
  .argument("<path>", "Drive or folder to treat as an archive")
  .option("--off", "Remove protection")
  .action(async (path: string, opts: { off?: boolean }) => {
    console.log(JSON.stringify(await getEngine().setProtected(path, !opts.off), null, 2));
  });

program
  .command("archive-root")
  .argument("[path]", "Folder that will hold Disk images / Installers")
  .action((path?: string) => {
    const engine = getEngine();
    if (path) console.log(JSON.stringify(engine.setArchiveRoot(path), null, 2));
    else console.log(JSON.stringify(engine.archiveState(), null, 2));
  });

program
  .command("scan")
  .option("-r, --root <path>", "Scan root (repeatable)", (v: string, acc: string[]) => {
    acc.push(v);
    return acc;
  }, [] as string[])
  .option("--installer-min <bytes>", "Installer size floor", (v) => Number(v))
  .option("--large-min <bytes>", "Large-unused size floor", (v) => Number(v))
  .option("--unused-days <n>", "Unused age in days", (v) => Number(v))
  .option("--leftover-min <bytes>", "Orphan app-folder size floor", (v) => Number(v))
  .action(async (opts: { root: string[]; installerMin?: number; largeMin?: number; unusedDays?: number; leftoverMin?: number }) => {
    const engine = getEngine();
    const job = engine.startScan({
      roots: opts.root,
      installerMinBytes: opts.installerMin,
      largeMinBytes: opts.largeMin,
      unusedDays: opts.unusedDays,
      leftoverMinBytes: opts.leftoverMin,
    });
    process.stdout.write(`scan ${job.id}\n`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      const live = engine.getScan(job.id);
      if (!live) break;
      process.stdout.write(
        `\r${live.status}  files=${live.filesSeen}  bytes=${live.bytesSeen}  ${live.progress.toFixed(2)}   `,
      );
      if (live.status === "complete" || live.status === "failed" || live.status === "cancelled") {
        process.stdout.write("\n");
        console.log(JSON.stringify(engine.summary(job.id), null, 2));
        if (live.error) console.error(live.error);
        process.exit(live.status === "complete" ? 0 : 1);
      }
    }
  });

program
  .command("findings")
  .argument("<scanId>")
  .option("--class <class>", "Filter by class")
  .action((scanId: string, opts: { class?: "removable" | "bloat" | "archiveable" | "keep" }) => {
    console.log(JSON.stringify(getEngine().findings(scanId, opts.class), null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
