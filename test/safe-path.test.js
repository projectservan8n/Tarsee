import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { safePath, sanitizeFilename, looksSafeTarPath } from "../src/lib/safe-path.js";

describe("safePath", () => {
  // Use platform-appropriate temp paths for testing
  const testRoot = path.join(os.tmpdir(), "opusclaw-test-roots");
  const roots = [path.join(testRoot, "workspace"), path.join(testRoot, "state")];

  it("allows paths within allowed roots", () => {
    const result = safePath("myproject", roots);
    assert.equal(result, path.join(roots[0], "myproject"));
    const result2 = safePath("myproject/src/file.js", roots);
    assert.equal(result2, path.join(roots[0], "myproject", "src", "file.js"));
  });

  it("rejects path traversal attempts", () => {
    assert.throws(() => safePath("../../../etc/passwd", roots), /outside allowed/);
    assert.throws(() => safePath("../../root/.ssh/id_rsa", roots), /outside allowed/);
  });

  it("rejects absolute paths outside roots", () => {
    // Use platform-appropriate paths
    const outsidePath = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd";
    assert.throws(() => safePath(outsidePath, roots), /outside allowed/);
  });

  it("rejects null/empty paths", () => {
    assert.throws(() => safePath("", roots), /Invalid path/);
    assert.throws(() => safePath(null, roots), /Invalid path/);
  });

  it("rejects when no roots configured", () => {
    assert.throws(() => safePath("test", []), /No allowed roots/);
  });
});

describe("sanitizeFilename", () => {
  it("strips quotes", () => {
    assert.equal(sanitizeFilename('file"name.txt'), "file_name.txt");
  });

  it("strips newlines", () => {
    assert.equal(sanitizeFilename("file\nname.txt"), "file_name.txt");
  });

  it("strips non-ASCII", () => {
    assert.equal(sanitizeFilename("file\u0000name.txt"), "file_name.txt");
  });

  it("limits length", () => {
    const long = "a".repeat(300);
    assert.ok(sanitizeFilename(long).length <= 255);
  });

  it("returns 'download' for empty input", () => {
    assert.equal(sanitizeFilename(""), "download");
  });
});

describe("looksSafeTarPath", () => {
  it("allows relative paths", () => {
    assert.ok(looksSafeTarPath("workspace/file.txt"));
    assert.ok(looksSafeTarPath(".opusclaw/config.json"));
  });

  it("rejects absolute paths", () => {
    assert.ok(!looksSafeTarPath("/etc/passwd"));
    assert.ok(!looksSafeTarPath("\\windows\\system32"));
  });

  it("rejects path traversal", () => {
    assert.ok(!looksSafeTarPath("../../../etc/passwd"));
    assert.ok(!looksSafeTarPath("foo/../../bar"));
  });

  it("rejects Windows drive paths", () => {
    assert.ok(!looksSafeTarPath("C:\\Windows\\System32"));
  });

  it("rejects empty/null", () => {
    assert.ok(!looksSafeTarPath(""));
    assert.ok(!looksSafeTarPath(null));
  });
});
