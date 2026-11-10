// Settings > Voice > Speech-to-text's installer (src/voice/stt-install.js): what is installed and with which Python,
// each model with its size and where it is; "Install faster-whisper" (a Python found here, else Tarsee's own copy
// downloaded; a private folder for faster-whisper; the pinned faster-whisper from pypi.org, ready-made builds only;
// then the default model), with progress and plain-words errors; per-model Download and Delete; one job at a time.
// A fake Python (a real process), a fake GitHub and a fake Hugging Face stand in: nothing is downloaded.
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePython, fakeInterpreter } from "./fakes/fake-python.js";
import { fakeDownloadHost } from "./fakes/fake-download-host.js";
import { makeTarGz } from "./fakes/tar.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-stt-install-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
delete process.env.TARSEE_STT_PYTHON;
delete process.env.TARSEE_WHISPER_BUNDLED_DIR;

const runtime = await import("../src/voice/python-runtime.js");
const stt = await import("../src/voice/stt-install.js");
const { WHISPER_MODELS, modelFileUrl, MODEL_MARKER } = await import("../src/voice/whisper-models.js");
const { gitBlobSha1 } = await import("../src/voice/install-common.js");

const py = fakePython(path.join(tmp, "fake"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const cand = (cmd, args = []) => ({ cmd, args, source: "system", label: [cmd, ...args].join(" ") });

// Small stand-ins for the six models (same names, repos and revisions; tiny files).
const MODEL_FILES = {};
const CATALOG = {};
for (const [name, m] of Object.entries(WHISPER_MODELS)) {
  const files = {
    "config.json": Buffer.from(`{"name": "${name}"}\n`),
    "model.bin": crypto.randomBytes(name.startsWith("small") ? 40_000 : 20_000),
    "tokenizer.json": Buffer.from("{}\n"),
    "vocabulary.txt": Buffer.from("a\n"),
  };
  MODEL_FILES[name] = files;
  CATALOG[name] = { ...m, files: Object.entries(files).map(([n, b]) => (n === "model.bin" ? { name: n, size: b.length, sha256: sha(b) } : { name: n, size: b.length, gitSha1: gitBlobSha1(b) })) };
}
const hfRoutes = (over = {}) => {
  const r = {};
  for (const [name, files] of Object.entries(MODEL_FILES)) for (const [n, b] of Object.entries(files)) r[modelFileUrl(CATALOG[name], n)] = { body: b, chunk: 4_000, delayMs: 1 };
  return { ...r, ...over };
};

// A standalone Python for this computer, as the fake GitHub serves it.
const target = runtime.pythonTarget();
const exeRel = path.relative("X", runtime.interpreterIn("X")).split(path.sep).join("/");
const ARCHIVE = makeTarGz([{ name: `python/${exeRel}`, body: fakeInterpreter("3.12.16"), mode: 0o755 }]);
const PIN = { ...runtime.STANDALONE_PYTHON, sha256: { [target.triple]: sha(ARCHIVE) } };
const ASSET = `cpython-${PIN.version}+${PIN.tag}-${target.triple}-install_only.tar.gz`;
const DL = `https://github.com/${PIN.repo}/releases/download/${PIN.tag}/${encodeURIComponent(ASSET)}`;
const ghRoutes = () => ({
  [`https://api.github.com/repos/${PIN.repo}/releases/tags/${PIN.tag}`]: { json: { assets: [{ name: ASSET, size: ARCHIVE.length, digest: `sha256:${sha(ARCHIVE)}`, browser_download_url: DL }] } },
  [DL]: { body: ARCHIVE, chunk: 256, delayMs: 1 },
});

let host;
const opts = () => ({ fetch: host.fetch, pin: PIN, retryDelayMs: 1 });

before(() => {
  runtime.__setForTests({ spawn: py.spawn, candidates: [cand("python3"), cand("python")] });
  stt.__setForTests({ catalog: CATALOG });
});
after(() => {
  runtime.__setForTests();
  stt.__setForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(tmp, "python"), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, "data", "whisper-models"), { recursive: true, force: true });
  py.set({ pythons: {}, pip: { mode: "ok", delayMs: 1 } });
  py.clearCalls();
  host = fakeDownloadHost({ ...hfRoutes(), ...ghRoutes() });
  stt.resetSttRuntime();
  stt.__resetJobsForTests();
});

/** Every job update until it ends. */
async function watch(job) {
  const seen = [];
  const t = setInterval(() => { const j = stt.sttJob(); if (j) seen.push(j); }, 5);
  const result = await job.done;
  clearInterval(t);
  return { result, seen };
}

describe("speech-to-text status", () => {
  it("nothing installed, no Python: says so in plain words; every model with its size, none downloaded, and where they go", async () => {
    const s = await stt.getSttStatus({ refresh: true });
    assert.equal(s.runtime.state, "not-installed");
    assert.equal(s.runtime.python, null);
    assert.equal(s.runtime.needsPythonDownload, true);
    assert.equal(s.runtime.canInstall, true);
    assert.match(s.runtime.summary, /not installed/i);
    assert.doesNotMatch(s.runtime.summary, /venv|pip|ENOENT|hf_cache/i, "no jargon");
    assert.deepEqual(s.models.map((m) => m.name), Object.keys(WHISPER_MODELS));
    for (const m of s.models) {
      assert.equal(m.state, "missing");
      assert.ok(m.bytes > 0 && typeof m.size === "string" && /\d+ (KB|MB)/.test(m.size), `${m.name}: ${m.size}`);
      assert.ok(m.description);
    }
    assert.equal(s.current, "base.en");
    assert.equal(s.modelsDir, path.join(tmp, "data", "whisper-models"));
    assert.equal(s.job, null);
  });

  it("a Python here with faster-whisper (the Docker image's) and a model that comes with the image: ready, nothing to do", async () => {
    py.set({ pythons: { python3: { version: "3.11.2", packages: { "faster-whisper": "1.2.1" }, executable: "/usr/bin/python3" } } });
    const image = path.join(tmp, "image-models");
    fs.mkdirSync(path.join(image, "base.en"), { recursive: true });
    for (const [n, b] of Object.entries(MODEL_FILES["base.en"])) fs.writeFileSync(path.join(image, "base.en", n), b);
    fs.writeFileSync(path.join(image, "base.en", MODEL_MARKER), "{}");
    process.env.TARSEE_WHISPER_BUNDLED_DIR = image;
    try {
      const s = await stt.getSttStatus({ refresh: true });
      assert.equal(s.runtime.state, "ready");
      assert.equal(s.runtime.fasterWhisper, "1.2.1");
      assert.equal(s.runtime.python.version, "3.11.2");
      assert.equal(s.runtime.python.executable, "/usr/bin/python3");
      assert.match(s.runtime.summary, /Ready/);
      const base = s.models.find((m) => m.name === "base.en");
      assert.equal(base.state, "image");
      assert.equal(base.deletable, false);
      assert.equal(base.where, path.join(image, "base.en"));
      assert.equal(base.current, true);
    } finally {
      delete process.env.TARSEE_WHISPER_BUNDLED_DIR;
    }
  });
});

describe("Install faster-whisper", () => {
  it("with a Python found here: a private folder for it, the pinned faster-whisper (ready-made builds, from pypi.org only), then the default model", async () => {
    // pip's lines come a little apart, as a real download's do: watch() looks every 5 ms, and lines 2 ms apart could
    // each be replaced by the next before it looks (a fast machine missed ctranslate2's).
    py.set({ pythons: { python3: { version: "3.11.4" } }, pip: { delayMs: 25 } });
    const job = stt.startSttInstall(opts());
    assert.equal(job.kind, "install");
    const { result, seen } = await watch(job);
    assert.equal(result.ok, true, result.error);
    const phases = [...new Set(seen.map((j) => j.phase))];
    assert.deepEqual(phases.filter((p) => p !== "python"), ["venv", "packages", "check", "model"], `phases: ${phases}`);
    assert.ok(seen.some((j) => /ctranslate2/.test(j.step || "")), "the step names what pip is downloading");
    const pcts = seen.map((j) => j.percent);
    assert.ok(pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), "progress only goes up");
    assert.ok(seen.every((j) => j.percent < 100));

    const pip = py.calls().find((c) => c.args?.includes("install"));
    assert.ok(pip, "pip ran");
    for (const flag of ["--isolated", "--only-binary=:all:", "--no-input", "--disable-pip-version-check"]) assert.ok(pip.args.includes(flag), `pip ${flag}`);
    assert.equal(pip.args[pip.args.indexOf("--index-url") + 1], "https://pypi.org/simple");
    assert.ok(pip.args.includes(`faster-whisper==${stt.FASTER_WHISPER_VERSION}`));
    assert.equal(pip.cmd, runtime.venvInterpreter(path.join(tmp, "python", "stt-venv")), "pip runs in Tarsee's own folder, not the system Python");

    const s = await stt.getSttStatus();
    assert.equal(s.runtime.state, "ready");
    assert.equal(s.runtime.source, "tarsee");
    assert.equal(s.models.find((m) => m.name === "base.en").state, "downloaded");
    assert.equal(host.requests.filter((r) => r.url.startsWith("https://api.github.com")).length, 0, "no Python was downloaded");
    const rt = await stt.findSttRuntime();
    assert.equal(rt.python.cmd, runtime.venvInterpreter(path.join(tmp, "python", "stt-venv")), "speech-to-text now uses that Python");
  });

  it("with no Python at all: Tarsee's own Python is downloaded first, then the rest", async () => {
    const { result, seen } = await watch(stt.startSttInstall(opts()));
    assert.equal(result.ok, true, result.error);
    assert.ok(seen.some((j) => j.phase === "python" && /Python 3\.12/.test(j.step)), "says it is downloading Python");
    assert.ok(runtime.standaloneReady(PIN));
    const s = await stt.getSttStatus();
    assert.equal(s.runtime.state, "ready");
    assert.equal(s.runtime.python.version, "3.12.16");
  });

  for (const [mode, words] of [
    ["fail-halfway", /disk is full/],
    ["offline", /could not reach pypi\.org/],
    ["no-wheel", /no ready-made build of ctranslate2/],
  ]) {
    it(`pip failing (${mode}) is said in plain words, the status shows it, and a retry works`, async () => {
      py.set({ pythons: { python3: { version: "3.11.4" } }, pip: { mode, delayMs: 1 } });
      const { result } = await watch(stt.startSttInstall(opts()));
      assert.equal(result.ok, false);
      assert.match(result.error, words);
      assert.match(result.error, /^Installing faster-whisper failed/);
      const s = await stt.getSttStatus({ refresh: true });
      assert.equal(s.runtime.state, "failed");
      assert.match(s.runtime.error, words);
      assert.equal(s.runtime.canInstall, true, "Try again");

      py.set({ pip: { mode: "ok", delayMs: 1 } });
      const again = await watch(stt.startSttInstall(opts()));
      assert.equal(again.result.ok, true, again.result.error);
      assert.equal((await stt.getSttStatus()).runtime.state, "ready");
    });
  }

  it("faster-whisper installed but the model's download failing: ready, with the error on that model's row", async () => {
    py.set({ pythons: { python3: { version: "3.11.4" } } });
    host = fakeDownloadHost(hfRoutes({ [modelFileUrl(CATALOG["base.en"], "model.bin")]: { body: crypto.randomBytes(20_000) } }));
    const { result } = await watch(stt.startSttInstall(opts()));
    assert.equal(result.ok, false);
    assert.match(result.error, /faster-whisper is installed, but downloading the base\.en model failed/);
    const s = await stt.getSttStatus();
    assert.equal(s.runtime.state, "ready");
    const base = s.models.find((m) => m.name === "base.en");
    assert.equal(base.state, "failed");
    assert.match(base.error, /sha256/);
  });

  it("a download of Python that fails is not silent either", async () => {
    host = fakeDownloadHost({ ...hfRoutes(), ...ghRoutes(), [DL]: { body: ARCHIVE, failAt: 10 } });
    const { result } = await watch(stt.startSttInstall(opts()));
    assert.equal(result.ok, false);
    assert.match(result.error, /Python/);
    assert.match(result.error, /cut off/);
    assert.equal((await stt.getSttStatus({ refresh: true })).runtime.state, "failed");
  });
});

describe("models: Download and Delete", () => {
  it("downloads one with progress, then deletes it", async () => {
    const job = stt.startModelDownload("small", opts());
    assert.equal(job.kind, "model");
    assert.equal(job.model, "small");
    const during = (await stt.getSttStatus()).models.find((m) => m.name === "small");
    assert.equal(during.state, "downloading");
    const { result, seen } = await watch(job);
    assert.equal(result.ok, true, result.error);
    assert.ok(seen.length > 2 && seen.some((j) => j.percent > 0 && j.percent < 100));
    let small = (await stt.getSttStatus()).models.find((m) => m.name === "small");
    assert.equal(small.state, "downloaded");
    assert.equal(small.deletable, true);
    assert.equal(small.where, path.join(tmp, "data", "whisper-models", "small"));

    const r = await stt.removeSttModel("small");
    assert.deepEqual(r.removed, [path.join(tmp, "data", "whisper-models", "small")]);
    small = (await stt.getSttStatus()).models.find((m) => m.name === "small");
    assert.equal(small.state, "missing");
  });

  it("a model download that fails its hash shows the error on that model", async () => {
    host = fakeDownloadHost(hfRoutes({ [modelFileUrl(CATALOG.tiny, "model.bin")]: { body: crypto.randomBytes(20_000) } }));
    const { result } = await watch(stt.startModelDownload("tiny", opts()));
    assert.equal(result.ok, false);
    assert.match(result.error, /sha256/);
    const tiny = (await stt.getSttStatus()).models.find((m) => m.name === "tiny");
    assert.equal(tiny.state, "failed");
    assert.match(tiny.error, /sha256/);
  });

  it("one job at a time: a second kind of job is turned away; asking for the same one again gets the running one", async () => {
    host = fakeDownloadHost(hfRoutes({ [modelFileUrl(CATALOG["small.en"], "model.bin")]: { body: MODEL_FILES["small.en"]["model.bin"], chunk: 500, delayMs: 3 } }));
    const a = stt.startModelDownload("small.en", opts());
    const same = stt.startModelDownload("small.en", opts());
    assert.equal(same.startedAt, a.startedAt);
    assert.throws(() => stt.startModelDownload("tiny.en", opts()), (err) => err.code === "BUSY" && err.status === 409 && /small\.en/.test(err.message));
    assert.throws(() => stt.startSttInstall(opts()), (err) => err.code === "BUSY");
    await a.done;
    assert.equal(stt.sttJob(), null);
    assert.ok(!fs.existsSync(path.join(tmp, "python", ".install.lock")), "the lock is let go");
  });

  it("an unknown model name is refused", async () => {
    assert.throws(() => stt.startModelDownload("../../etc", opts()), (err) => err.status === 400);
    await assert.rejects(stt.removeSttModel("large-v3"), (err) => err.status === 400);
  });
});
