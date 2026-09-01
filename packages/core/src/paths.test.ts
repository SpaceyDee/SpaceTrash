import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePath, parentPath } from "./paths.ts";

describe("paths", () => {
  it("keeps a Windows drive root as a real directory", () => {
    if (process.platform !== "win32") return;
    assert.equal(normalizePath("G:\\"), "G:\\");
    assert.equal(normalizePath("G:/"), "G:\\");
    assert.equal(normalizePath("G:"), "G:\\");
    assert.equal(parentPath("G:\\"), "");
    assert.equal(parentPath("G:\\Projects"), "G:\\");
  });

  it("does not treat a folder as its own parent", () => {
    const folder = process.platform === "win32" ? "C:\\Users\\matt\\Downloads" : "/home/matt/Downloads";
    assert.notEqual(parentPath(folder), normalizePath(folder));
  });
});
