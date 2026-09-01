import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  bestMatchingProgram,
  folderMatchesProgram,
  isConnectedFolder,
  isLikelyLiveAppData,
  loadProgramIndex,
  resetProgramIndexCache,
  strongTokens,
  tokenizeName,
  type InstalledProgram,
} from "./programs.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const indexFile = join(repoRoot, "fixtures", "app-leftover-generated", "index.json");

const chrome: InstalledProgram = {
  displayName: "Google Chrome",
  installLocation: "C:\\Program Files\\Google\\Chrome",
  uninstallString: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --uninstall',
  publisher: "Google LLC",
};

describe("program name matching", () => {
  it("drops tiny tokens, versions, and publisher-only words", () => {
    assert.deepEqual(tokenizeName("Google Chrome 128 x64"), ["google", "chrome"]);
    const strong = strongTokens(chrome);
    assert.ok(strong.includes("chrome"), strong.join(","));
    assert.equal(strong.includes("google"), false, strong.join(","));
  });

  it("matches Chrome folders but not a publisher-only Google folder", () => {
    assert.equal(folderMatchesProgram("Chrome", chrome), true);
    assert.equal(folderMatchesProgram("chrome-old", chrome), true);
    assert.equal(folderMatchesProgram("Google", chrome), false);
    assert.equal(folderMatchesProgram("Downloads", chrome), false);
  });

  it("picks the program with the longest strong token", () => {
    const cursor: InstalledProgram = {
      displayName: "Cursor",
      installLocation: "C:\\Users\\matt\\AppData\\Local\\Programs\\cursor",
      uninstallString: null,
      publisher: "Anysphere",
    };
    const hit = bestMatchingProgram("Cursor-old", [chrome, cursor]);
    assert.ok(hit);
    assert.equal(hit.displayName, "Cursor");
  });
});

describe("program folder connection", () => {
  it("treats install location and shortcut targets inside the folder as connected", () => {
    const portable = join("G:", "ChromePortable");
    const index = {
      programs: [
        {
          ...chrome,
          installLocation: join(portable, "App"),
        },
      ],
      shortcutTargets: [],
    };
    assert.equal(isConnectedFolder(portable, index), true);
    assert.equal(isConnectedFolder("G:\\Other", index), false);
    assert.equal(
      isConnectedFolder("G:\\ChromePortable", {
        programs: [chrome],
        shortcutTargets: [join("G:\\ChromePortable", "chrome.exe")],
      }),
      true,
    );
  });

  it("treats AppData trees as live when the matching program is still installed", () => {
    const local = join("C:", "Users", "matt", "AppData", "Local", "Google", "Chrome");
    assert.equal(isLikelyLiveAppData(local, "C:\\Users\\matt"), true);
    assert.equal(isLikelyLiveAppData("G:\\Chrome-old", "C:\\Users\\matt"), false);
    assert.equal(
      isConnectedFolder(local, { programs: [chrome], shortcutTargets: [] }, "C:\\Users\\matt"),
      true,
    );
  });
});

describe("program index loader", () => {
  after(() => {
    resetProgramIndexCache();
    delete process.env.SPACETRASH_PROGRAM_INDEX;
  });

  it("reads an injected JSON index", async () => {
    await mkdir(dirname(indexFile), { recursive: true });
    await writeFile(
      indexFile,
      JSON.stringify({
        programs: [chrome],
        shortcutTargets: ["G:\\Tools\\chrome.exe"],
      }),
    );
    process.env.SPACETRASH_PROGRAM_INDEX = indexFile;
    resetProgramIndexCache();
    const index = loadProgramIndex();
    assert.equal(index.programs[0]?.displayName, "Google Chrome");
    assert.equal(index.shortcutTargets.length, 1);
    await rm(dirname(indexFile), { recursive: true, force: true });
  });

  it("strips a UTF-8 BOM from an injected JSON index", async () => {
    await mkdir(dirname(indexFile), { recursive: true });
    await writeFile(indexFile, `\uFEFF${JSON.stringify({ programs: [chrome], shortcutTargets: [] })}`);
    process.env.SPACETRASH_PROGRAM_INDEX = indexFile;
    resetProgramIndexCache();
    const index = loadProgramIndex();
    assert.equal(index.programs[0]?.displayName, "Google Chrome");
    await rm(dirname(indexFile), { recursive: true, force: true });
  });
});
