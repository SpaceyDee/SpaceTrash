import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeniedForAction, isDeniedForScan } from "./deny.ts";

describe("deny list", () => {
  it("blocks Windows and Program Files from scan and action", () => {
    assert.equal(isDeniedForScan("C:\\Windows\\System32\\kernel32.dll", "kernel32.dll"), true);
    assert.equal(isDeniedForAction("C:\\Windows\\Temp\\foo.tmp"), true);
    assert.equal(isDeniedForAction("C:\\Program Files\\Git\\git.exe"), true);
    assert.equal(isDeniedForAction("C:\\Program Files (x86)\\Foo\\bar.exe"), true);
    assert.equal(isDeniedForAction("C:\\ProgramData\\Microsoft\\Windows\\Caches\\c.dat"), true);
  });

  it("blocks volume roots, pagefile, and recycle bin", () => {
    assert.equal(isDeniedForAction("C:"), true);
    assert.equal(isDeniedForAction("C:\\"), true);
    assert.equal(isDeniedForScan("C:\\pagefile.sys", "pagefile.sys"), true);
    assert.equal(isDeniedForScan("C:\\$Recycle.Bin", "$Recycle.Bin"), true);
    assert.equal(isDeniedForScan("C:\\System Volume Information", "System Volume Information"), true);
  });

  it("allows user downloads and Windows.old leftovers", () => {
    assert.equal(isDeniedForScan("C:\\Users\\matt\\Downloads\\CursorSetup.exe", "CursorSetup.exe"), false);
    assert.equal(isDeniedForAction("C:\\Users\\matt\\Downloads\\CursorSetup.exe"), false);
    assert.equal(isDeniedForScan("C:\\Windows.old\\Windows\\foo.dll", "foo.dll"), false);
  });
});
