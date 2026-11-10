// What Tarsee's installers share (src/voice/install-common.js, src/voice/tar-extract.js): downloads only from fixed
// official hosts over https (redirects followed by hand and checked), every file checked against its published size
// and hash before it is put in place, a lock so two installs never run at once, and an archive extractor that never
// writes outside its folder. All against a fake download host: nothing here reaches the network.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeDownloadHost } from "./fakes/fake-download-host.js";
import { makeTarGz } from "./fakes/tar.js";

const { OFFICIAL_HOSTS, guardedFetch, isOfficialUrl, downloadFile, acquireLock, gitBlobSha1 } = await import("../src/voice/install-common.js");
const { extractTarGz } = await import("../src/voice/tar-extract.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-installer-dl-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = path.join(tmp, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const HF = [OFFICIAL_HOSTS.huggingface];
const GH = [OFFICIAL_HOSTS.github];

describe("official hosts only", () => {
  it("knows Hugging Face's and GitHub's hosts, https only", () => {
    assert.equal(isOfficialUrl("https://huggingface.co/Systran/x/resolve/r/model.bin", HF), true);
    assert.equal(isOfficialUrl("https://us.aws.cdn.hf.co/xet-bridge-us/abc", HF), true, "Hugging Face's CDN");
    assert.equal(isOfficialUrl("https://cdn-lfs.huggingface.co/repos/x", HF), true);
    assert.equal(isOfficialUrl("http://huggingface.co/x", HF), false, "never plain http");
    assert.equal(isOfficialUrl("https://huggingface.co.evil.example/x", HF), false);
    assert.equal(isOfficialUrl("https://evilhf.co/x", HF), false);
    assert.equal(isOfficialUrl("https://github.com/astral-sh/python-build-standalone/releases/download/x", HF), false, "each installer names its hosts");
    assert.equal(isOfficialUrl("https://release-assets.githubusercontent.com/github-production-release-asset/1", GH), true);
    assert.equal(isOfficialUrl("https://raw.githubusercontent.com/someone/thing/main/x", GH), false, "not anyone's files on GitHub");
    assert.equal(isOfficialUrl("not a url", GH), false);
  });

  it("follows a redirect to the CDN, and refuses one anywhere else before sending anything there", async () => {
    const host = fakeDownloadHost({
      "https://huggingface.co/a": { redirect: "https://us.aws.cdn.hf.co/xet/a" },
      "https://us.aws.cdn.hf.co/xet/a": { body: "ok" },
      "https://huggingface.co/b": { redirect: "https://evil.example/b" },
      "https://huggingface.co/c": { redirect: "http://cdn-lfs.huggingface.co/c" },
      "https://huggingface.co/d": { redirect: "/api/resolve-cache/d" },
      "https://huggingface.co/api/resolve-cache/d": { body: "relative" },
      "https://huggingface.co/loop": { redirect: "https://huggingface.co/loop" },
    });
    const get = guardedFetch(HF, host.fetch);
    assert.equal(await (await get("https://huggingface.co/a")).text(), "ok");
    assert.equal(host.requests[0].redirect, "manual", "redirects are never followed blindly");
    await assert.rejects(get("https://huggingface.co/b"), (err) => err.code === "HOST_REFUSED" && /evil\.example/.test(err.message));
    assert.equal(host.hits["https://evil.example/b"], undefined, "nothing was sent to the other host");
    await assert.rejects(get("https://huggingface.co/c"), (err) => err.code === "HOST_REFUSED");
    assert.equal(await (await get("https://huggingface.co/d")).text(), "relative", "a relative Location stays on the host");
    await assert.rejects(get("https://huggingface.co/loop"), /redirect/);
    await assert.rejects(get("https://example.com/x"), (err) => err.code === "HOST_REFUSED");
  });
});

describe("downloadFile: sizes and hashes", () => {
  const body = crypto.randomBytes(200_000);

  it("streams with progress and renames into place only when size and sha256 match", async () => {
    const dir = fresh();
    const host = fakeDownloadHost({ "https://huggingface.co/f": { body, chunk: 10_000 } });
    const seen = [];
    const dest = path.join(dir, "model.bin");
    await downloadFile({ url: "https://huggingface.co/f", dest, sha256: sha(body), size: body.length, fetchImpl: host.fetch, progress: (d) => seen.push(d) });
    assert.ok(fs.readFileSync(dest).equals(body));
    assert.ok(seen.length >= 20, "progress for each chunk");
    assert.equal(seen.reduce((a, b) => a + b, 0), body.length);
  });

  it("a file that stops halfway is retried; one that always stops fails in plain words and leaves nothing", async () => {
    const dir = fresh();
    const flaky = fakeDownloadHost({ "https://huggingface.co/f": (_u, hit) => (hit === 1 ? { body, failAt: 50_000 } : { body }) });
    const dest = path.join(dir, "a.bin");
    const seen = [];
    await downloadFile({ url: "https://huggingface.co/f", dest, sha256: sha(body), size: body.length, fetchImpl: flaky.fetch, retryDelayMs: 1, progress: (d) => seen.push(d) });
    assert.equal(flaky.hits["https://huggingface.co/f"], 2);
    assert.equal(seen.reduce((a, b) => a + b, 0), body.length, "the dropped attempt's bytes are taken back off the progress");

    const dead = fakeDownloadHost({ "https://huggingface.co/f": { body, failAt: 50_000 } });
    const dest2 = path.join(dir, "b.bin");
    await assert.rejects(
      downloadFile({ url: "https://huggingface.co/f", dest: dest2, sha256: sha(body), size: body.length, fetchImpl: dead.fetch, retryDelayMs: 1 }),
      (err) => /cut off|huggingface\.co/.test(err.message) && !/^terminated$/.test(err.message),
    );
    assert.equal(fs.existsSync(dest2), false);
    assert.equal(fs.existsSync(`${dest2}.part`), false);
  });

  it("a bad hash or a wrong size is refused", async () => {
    const dir = fresh();
    const host = fakeDownloadHost({ "https://huggingface.co/f": { body } });
    await assert.rejects(
      downloadFile({ url: "https://huggingface.co/f", dest: path.join(dir, "x"), sha256: sha(Buffer.from("other")), size: body.length, fetchImpl: host.fetch, retryDelayMs: 1 }),
      (err) => err.code === "HASH_MISMATCH",
    );
    await assert.rejects(
      downloadFile({ url: "https://huggingface.co/f", dest: path.join(dir, "y"), size: body.length + 1, fetchImpl: host.fetch, retryDelayMs: 1 }),
      /size|bytes/,
    );
    assert.deepEqual(fs.readdirSync(dir), [], "nothing is left behind");
  });

  it("checks Hugging Face's git hash (the one it publishes for small files)", async () => {
    const dir = fresh();
    const small = Buffer.from('{"alignment_heads": [[1, 0]]}\n');
    const host = fakeDownloadHost({ "https://huggingface.co/c": { body: small }, "https://huggingface.co/bad": { body: Buffer.from('{"alignment_heads": [[9, 9]]}\n') } });
    assert.equal(gitBlobSha1(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a", "the same hash as git hash-object");
    await downloadFile({ url: "https://huggingface.co/c", dest: path.join(dir, "config.json"), gitSha1: gitBlobSha1(small), size: small.length, fetchImpl: host.fetch });
    await assert.rejects(
      downloadFile({ url: "https://huggingface.co/bad", dest: path.join(dir, "bad.json"), gitSha1: gitBlobSha1(small), size: small.length, fetchImpl: host.fetch, retryDelayMs: 1 }),
      (err) => err.code === "HASH_MISMATCH",
    );
  });

  it("a file already in place that matches is kept without a download; one that doesn't is fetched again", async () => {
    const dir = fresh();
    const host = fakeDownloadHost({ "https://huggingface.co/f": { body } });
    const dest = path.join(dir, "m.bin");
    fs.writeFileSync(dest, body);
    assert.equal(await downloadFile({ url: "https://huggingface.co/f", dest, sha256: sha(body), size: body.length, fetchImpl: host.fetch }), "kept");
    assert.equal(host.hits["https://huggingface.co/f"], undefined);
    fs.writeFileSync(dest, body.subarray(0, 10));
    await downloadFile({ url: "https://huggingface.co/f", dest, sha256: sha(body), size: body.length, fetchImpl: host.fetch });
    assert.equal(host.hits["https://huggingface.co/f"], 1);
  });
});

describe("the install lock", () => {
  it("says what is running", () => {
    const dir = fresh();
    const release = acquireLock(dir, "speech-to-text install");
    assert.throws(() => acquireLock(dir, "speech-to-text install"), (err) => err.code === "LOCKED" && /speech-to-text install/.test(err.message));
    release();
    acquireLock(dir)();
  });
});

describe("extractTarGz", () => {
  let archives;
  before(() => {
    archives = fresh();
  });
  const write = (name, entries) => {
    const f = path.join(archives, name);
    fs.writeFileSync(f, makeTarGz(entries));
    return f;
  };

  it("extracts files, folders, a long (pax) name and same-folder symlinks, stripping the top folder", async () => {
    const file = write("ok.tar.gz", [
      { name: "python/", type: "dir" },
      { name: "python/bin/python3.12", body: "interpreter", mode: 0o755 },
      { name: "python/bin/python3", type: "symlink", linkname: "python3.12" },
      { name: `python/lib/${"long-folder-name/".repeat(8)}module.py`, body: "print(1)" },
      { name: "python/lib/python3.12/config/libpython.a", type: "symlink", linkname: "../../libpython.a" },
      { name: "python/lib/libpython.a", body: "lib" },
    ]);
    const dest = path.join(fresh(), "out");
    const r = await extractTarGz(file, dest, { strip: 1 });
    assert.equal(fs.readFileSync(path.join(dest, "bin", "python3.12"), "utf8"), "interpreter");
    assert.equal(fs.readFileSync(path.join(dest, "lib", ..."long-folder-name/".repeat(8).split("/").filter(Boolean), "module.py"), "utf8"), "print(1)");
    if (process.platform !== "win32") {
      assert.equal(fs.readlinkSync(path.join(dest, "bin", "python3")), "python3.12");
      assert.equal(fs.statSync(path.join(dest, "bin", "python3.12")).mode & 0o111, 0o111, "executables stay executable");
    }
    assert.ok(r.files >= 3);
  });

  for (const [what, entries] of [
    ["a path out of the folder", [{ name: "python/../../escape.txt", body: "x" }]],
    ["an absolute path", [{ name: "/etc/escape.txt", body: "x" }]],
    ["a Windows drive path", [{ name: "C:/escape.txt", body: "x" }]],
    ["a symlink pointing out", [{ name: "python/link", type: "symlink", linkname: "../../../outside" }]],
    ["an absolute symlink", [{ name: "python/link", type: "symlink", linkname: "/etc/passwd" }]],
    ["a file written through a symlink", [
      { name: "python/sub/", type: "dir" },
      { name: "python/up", type: "symlink", linkname: "sub" },
      { name: "python/up/x.txt", body: "x" },
    ]],
    ["two symlinks that together lead out", [
      { name: "python/a/", type: "dir" },
      { name: "python/a/x", type: "symlink", linkname: ".." },
      { name: "python/a/l", type: "symlink", linkname: "x/../.." },
    ]],
    ["a damaged header", [{ name: "python/x.txt", body: "x", badChecksum: true }]],
  ]) {
    it(`refuses ${what}, and leaves nothing behind`, async () => {
      const file = write(`bad-${n}.tar.gz`, entries);
      const parent = fresh();
      const dest = path.join(parent, "out");
      await assert.rejects(extractTarGz(file, dest, { strip: 1 }), /archive/i);
      assert.equal(fs.existsSync(dest), false, "the half-made folder is removed");
      assert.deepEqual(fs.readdirSync(parent), [], "nothing next to it either");
      assert.equal(fs.existsSync(path.join(tmp, "escape.txt")), false);
    });
  }

  it("a file that is not a gzip archive is refused", async () => {
    const f = path.join(archives, "not.tar.gz");
    fs.writeFileSync(f, "<html>not found</html>");
    await assert.rejects(extractTarGz(f, path.join(fresh(), "out")), /archive/i);
  });
});
