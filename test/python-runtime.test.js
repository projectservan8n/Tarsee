// The Python that faster-whisper and Phonon run on (src/voice/python-runtime.js): a usable Python 3.9+ with venv is
// found on this computer (the Windows py launcher, python3, python; never the Microsoft Store shortcut), else a
// standalone CPython from astral-sh/python-build-standalone is downloaded into Tarsee's state folder: the right asset
// for the OS and CPU from the GitHub releases API, checked against the pinned sha256 and the size GitHub lists,
// extracted safely, and run once to prove it works. A fake Python (a real process) and a fake GitHub stand in.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePython, fakeInterpreter } from "./fakes/fake-python.js";
import { fakeDownloadHost } from "./fakes/fake-download-host.js";
import { makeTarGz } from "./fakes/tar.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-python-runtime-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");

const rt = await import("../src/voice/python-runtime.js");
const {
  STANDALONE_PYTHON, pythonHome, standaloneDir, interpreterIn, venvInterpreter, pythonTarget, systemCandidates,
  probePython, findPythons, findBasePython, ensureBasePython, runPython, standaloneReady, __setForTests,
} = rt;

const py = fakePython(path.join(tmp, "fake"));
after(() => {
  __setForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cand = (cmd, args = []) => ({ cmd, args, source: "system", label: [cmd, ...args].join(" ") });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

describe("which Python build fits this computer", () => {
  it("picks the install_only asset for each OS and CPU", () => {
    assert.equal(pythonTarget({ platform: "win32", arch: "x64" }).triple, "x86_64-pc-windows-msvc");
    assert.equal(pythonTarget({ platform: "win32", arch: "arm64" }).triple, "aarch64-pc-windows-msvc");
    assert.equal(pythonTarget({ platform: "darwin", arch: "arm64" }).triple, "aarch64-apple-darwin");
    assert.equal(pythonTarget({ platform: "darwin", arch: "x64" }).triple, "x86_64-apple-darwin");
    assert.equal(pythonTarget({ platform: "linux", arch: "x64", glibc: "2.36" }).triple, "x86_64-unknown-linux-gnu");
    assert.equal(pythonTarget({ platform: "linux", arch: "arm64", glibc: "2.36" }).triple, "aarch64-unknown-linux-gnu");
    assert.match(pythonTarget({ platform: "linux", arch: "x64", glibc: null }).error, /musl|Alpine/);
    assert.match(pythonTarget({ platform: "win32", arch: "ia32" }).error, /32-bit/);
    assert.match(pythonTarget({ platform: "freebsd", arch: "x64" }).error, /freebsd/i);
    for (const t of ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
      assert.match(STANDALONE_PYTHON.sha256[t], /^[0-9a-f]{64}$/, `a pinned sha256 for ${t}`);
    }
  });

  it("looks for the Windows py launcher first on Windows, and python3 elsewhere", () => {
    const win = systemCandidates("win32");
    assert.equal(win[0].cmd, "py");
    assert.ok(win.some((c) => c.cmd === "python"));
    const linux = systemCandidates("linux");
    assert.ok(linux.some((c) => c.cmd === "python3"));
    assert.ok(!linux.some((c) => c.cmd === "py"));
  });

  it("knows where a venv's python is on each OS", () => {
    assert.equal(venvInterpreter("C:\\t\\venv", "win32"), "C:\\t\\venv\\Scripts\\python.exe");
    assert.equal(venvInterpreter("/t/venv", "linux"), "/t/venv/bin/python");
    assert.equal(interpreterIn("C:\\t\\cpython", "win32"), "C:\\t\\cpython\\python.exe");
    assert.equal(interpreterIn("/t/cpython", "darwin"), "/t/cpython/bin/python3");
    assert.ok(standaloneDir().startsWith(pythonHome()));
    assert.ok(pythonHome().startsWith(tmp), "in Tarsee's state folder");
  });
});

describe("finding a Python on this computer", () => {
  beforeEach(() => {
    py.set({ pythons: {} });
    __setForTests({ spawn: py.spawn, candidates: [cand("py", ["-3.12"]), cand("python3"), cand("python")] });
  });

  it("no Python at all: nothing found, and without a download allowed it says so in plain words", async () => {
    assert.equal(await findBasePython(), null);
    const all = await findPythons();
    assert.ok(all.every((p) => !p.found), JSON.stringify(all));
    await assert.rejects(ensureBasePython({ allowDownload: false }), (err) => /no Python 3\.9 or newer/i.test(err.message) && !/ENOENT/.test(err.message));
  });

  it("the Microsoft Store shortcut is not a Python", async () => {
    py.set({ pythons: { python: { store: true }, python3: { store: true } } });
    const p = await probePython(cand("python"));
    assert.equal(p.found, true);
    assert.equal(p.usable, false);
    assert.match(p.problem, /Microsoft Store/);
    assert.equal(await findBasePython(), null);
    // The py launcher asked for a version it doesn't have says "open the Microsoft Store" too: that's "not found".
    py.set({ pythons: { "py -3.13": { version: "3.13.7" } } });
    const missing = await probePython(cand("py", ["-3.12"]));
    assert.equal(missing.found, false);
    assert.equal(missing.problem, "not found");
  });

  it("skips one too old, one too new and one without venv, and takes the first that fits", async () => {
    py.set({
      pythons: {
        "py -3.12": { version: "3.8.10" },
        python3: { version: "3.11.4", venv: false },
        python: { version: "3.12.1" },
      },
    });
    const all = await findPythons();
    assert.match(all.find((p) => p.label === "py -3.12").problem, /too old|3\.9/);
    assert.match(all.find((p) => p.label === "python3").problem, /venv/);
    const best = await findBasePython();
    assert.equal(best.label, "python");
    assert.equal(best.version, "3.12.1");
    assert.equal(best.usable, true);
    py.set({ pythons: { python: { version: "3.15.0" } } });
    assert.match((await probePython(cand("python"))).problem, /newer/);
  });

  it("a Python that never answers is given up on", async () => {
    py.set({ pythons: { python3: { probeHang: true } } });
    const p = await probePython(cand("python3"), { timeout: 500 });
    assert.equal(p.usable, false);
    assert.match(p.problem, /did not answer/);
  });

  it("runPython: a missing program, a failure and the output line by line", async () => {
    await assert.rejects(runPython(cand("nope"), ["-c", "x"]), (err) => err.code === "ENOENT" && /not found/.test(err.message));
    py.set({ pythons: { python3: { version: "3.12.1" } } });
    await assert.rejects(runPython(cand("python3"), ["-I", "-c", "import faster_whisper"]), /No module named 'faster_whisper'/);
    const lines = [];
    await runPython(cand("python3"), ["-I", "-c", "print('TARSEE-PROBE')"], { onLine: (l) => lines.push(l) });
    assert.ok(lines.some((l) => l.startsWith("TARSEE-PROBE ")));
  });
});

describe("downloading a standalone Python", () => {
  const target = pythonTarget();
  const exeRel = path.relative("X", interpreterIn("X")).split(path.sep).join("/");
  const archive = makeTarGz([
    { name: "python/", type: "dir" },
    { name: `python/${exeRel}`, body: fakeInterpreter("3.12.16"), mode: 0o755 },
    { name: "python/lib/python3.12/os.py", body: "# os" },
  ]);
  const pin = { ...STANDALONE_PYTHON, sha256: { [target.triple]: sha(archive) } };
  const assetName = `cpython-${pin.version}+${pin.tag}-${target.triple}-install_only.tar.gz`;
  const api = `https://api.github.com/repos/${pin.repo}/releases/tags/${pin.tag}`;
  const dl = `https://github.com/${pin.repo}/releases/download/${pin.tag}/${encodeURIComponent(assetName)}`;
  const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/162334160/abc";
  const release = (over = {}) => ({
    json: {
      tag_name: pin.tag,
      assets: [
        { name: `cpython-${pin.version}+${pin.tag}-${target.triple}-install_only_stripped.tar.gz`, size: 1, digest: "sha256:00", browser_download_url: `${dl}-stripped` },
        { name: assetName, size: archive.length, digest: `sha256:${sha(archive)}`, browser_download_url: dl, ...over },
        { name: "SHA256SUMS", size: 10, browser_download_url: `https://github.com/${pin.repo}/releases/download/${pin.tag}/SHA256SUMS` },
      ],
    },
  });

  before(() => {
    if (target.error) throw new Error(`this test machine has no python-build-standalone target: ${target.error}`);
  });
  beforeEach(() => {
    fs.rmSync(pythonHome(), { recursive: true, force: true });
    py.set({ pythons: {} });
    __setForTests({ spawn: py.spawn, candidates: [cand("python3")] });
  });

  it("no Python here: downloads the pinned build (with progress), extracts it, runs it once, and uses it from then on", async () => {
    const host = fakeDownloadHost({ [api]: release(), [dl]: { redirect: cdn }, [cdn]: { body: archive, chunk: 64, delayMs: 1 } });
    const seen = [];
    const ref = await ensureBasePython({ allowDownload: true, fetch: host.fetch, pin, onProgress: (p) => seen.push(p) });
    assert.equal(ref.source, "tarsee");
    assert.equal(ref.version, "3.12.16");
    assert.equal(ref.cmd, interpreterIn(standaloneDir(pin)));
    assert.ok(standaloneReady(pin));
    assert.ok(seen.length > 5, "progress while downloading");
    assert.ok(seen.at(-1).bytesDone >= archive.length && seen.at(-1).bytesTotal === archive.length);
    assert.equal(host.requests.find((r) => r.url === api).headers["User-Agent"] !== undefined, true, "GitHub asks for a User-Agent");
    assert.deepEqual(fs.readdirSync(pythonHome()).sort(), [path.basename(standaloneDir(pin))], "the archive is gone once extracted");

    const again = await ensureBasePython({ allowDownload: true, fetch: host.fetch, pin });
    assert.equal(again.cmd, ref.cmd);
    assert.equal(host.hits[api], 1, "no second download");
    assert.equal((await findBasePython()).source, "tarsee", "Tarsee's own Python comes first once it is there");
  });

  it("a usable Python on this computer is used, and nothing is downloaded", async () => {
    py.set({ pythons: { python3: { version: "3.11.4" } } });
    const host = fakeDownloadHost({});
    const ref = await ensureBasePython({ allowDownload: true, fetch: host.fetch, pin });
    assert.equal(ref.label, "python3");
    assert.equal(host.requests.length, 0);
  });

  const leavesNothing = () => {
    assert.equal(fs.existsSync(standaloneDir(pin)), false, "no Python folder");
    const left = fs.existsSync(pythonHome()) ? fs.readdirSync(pythonHome()).filter((f) => f !== ".install.lock") : [];
    assert.deepEqual(left.filter((f) => !fs.statSync(path.join(pythonHome(), f)).isDirectory() || fs.readdirSync(path.join(pythonHome(), f)).length), [], `left behind: ${left}`);
  };

  it("GitHub listing a different file than the pinned one is refused before downloading", async () => {
    const host = fakeDownloadHost({ [api]: release({ digest: `sha256:${"ab".repeat(32)}` }), [dl]: { body: archive } });
    await assert.rejects(ensureBasePython({ allowDownload: true, fetch: host.fetch, pin }), /does not match|different/);
    assert.equal(host.hits[dl], undefined);
    leavesNothing();
  });

  it("a file that does not match its hash is refused, and nothing is extracted", async () => {
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 20] ^= 0xff;
    const host = fakeDownloadHost({ [api]: release(), [dl]: { body: tampered } });
    await assert.rejects(ensureBasePython({ allowDownload: true, fetch: host.fetch, pin, retryDelayMs: 1 }), /hash|sha256/);
    leavesNothing();
  });

  it("a download that keeps stopping halfway fails in plain words", async () => {
    const host = fakeDownloadHost({ [api]: release(), [dl]: { body: archive, failAt: Math.floor(archive.length / 2) } });
    await assert.rejects(ensureBasePython({ allowDownload: true, fetch: host.fetch, pin, retryDelayMs: 1 }), /cut off/);
    leavesNothing();
  });

  it("GitHub turning the request away (rate limit) says to try again later", async () => {
    const host = fakeDownloadHost({ [api]: { status: 403, text: '{"message":"API rate limit exceeded"}', headers: { "x-ratelimit-remaining": "0" } } });
    await assert.rejects(ensureBasePython({ allowDownload: true, fetch: host.fetch, pin }), (err) => /GitHub/.test(err.message) && /try again/i.test(err.message));
  });

  it("a release whose download link points anywhere else is refused", async () => {
    const host = fakeDownloadHost({ [api]: release({ browser_download_url: "https://evil.example/python.tar.gz" }) });
    await assert.rejects(ensureBasePython({ allowDownload: true, fetch: host.fetch, pin }), /not the official|refused/);
    assert.equal(host.hits["https://evil.example/python.tar.gz"], undefined);
  });

  it("an archive whose Python does not run is not kept", async () => {
    const broken = makeTarGz([{ name: `python/${exeRel}`, body: "not a python at all", mode: 0o755 }]);
    const pin2 = { ...pin, sha256: { [target.triple]: sha(broken) } };
    const host = fakeDownloadHost({ [api]: { json: { assets: [{ name: assetName, size: broken.length, digest: `sha256:${sha(broken)}`, browser_download_url: dl }] } }, [dl]: { body: broken } });
    await assert.rejects(ensureBasePython({ allowDownload: true, fetch: host.fetch, pin: pin2 }), /did not run|could not run/);
    assert.equal(fs.existsSync(standaloneDir(pin2)), false);
  });
});
