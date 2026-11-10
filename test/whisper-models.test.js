// The speech-to-text models (src/voice/whisper-models.js): the six official Systran faster-whisper models on Hugging
// Face (the same ones faster-whisper fetches itself), pinned to a revision with every file's size and published hash.
// A download goes into its own folder in the models folder, checked file by file, with its marker written last; a
// model the Docker image ships is found where the image put it and is never deleted; a model the old version left in
// Hugging Face's cache is still found and used. A fake Hugging Face stands in for the real one.
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeDownloadHost } from "./fakes/fake-download-host.js";

const {
  WHISPER_MODELS, DEFAULT_WHISPER_MODEL, modelFileUrl, modelBytes, findWhisperModel, downloadWhisperModel, deleteWhisperModel,
} = await import("../src/voice/whisper-models.js");
const { gitBlobSha1 } = await import("../src/voice/install-common.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-whisper-models-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** A fake "tiny.en" with small files, its catalog entry, and a host serving it (model.bin through the CDN redirect). */
function fakeModel(over = {}) {
  const files = {
    "config.json": Buffer.from('{"alignment_heads": [[1, 0]], "lang_ids": []}\n'),
    "model.bin": crypto.randomBytes(300_000),
    "tokenizer.json": Buffer.from('{"version": "1.0"}\n'),
    "vocabulary.txt": Buffer.from("a\nb\nc\n"),
  };
  const entry = {
    ...WHISPER_MODELS["tiny.en"],
    files: Object.entries(files).map(([name, buf]) => (name === "model.bin"
      ? { name, size: buf.length, sha256: sha(buf) }
      : { name, size: buf.length, gitSha1: gitBlobSha1(buf) })),
  };
  const catalog = { ...WHISPER_MODELS, "tiny.en": entry };
  const routes = {};
  for (const [name, buf] of Object.entries(files)) {
    const url = modelFileUrl(entry, name);
    if (name === "model.bin") {
      routes[url] = { redirect: "https://us.aws.cdn.hf.co/xet-bridge-us/abc/model" };
      routes["https://us.aws.cdn.hf.co/xet-bridge-us/abc/model"] = over.modelBin || { body: buf, chunk: 8_000, delayMs: 0 };
    } else {
      routes[url] = { body: buf };
    }
  }
  return { files, entry, catalog, host: fakeDownloadHost({ ...routes, ...(over.routes || {}) }) };
}

let dirs;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(tmp, "case-"));
  dirs = { models: path.join(base, "whisper-models"), bundled: [path.join(base, "image")], caches: [path.join(base, "whisper-models", "hf_cache")] };
});

describe("the pinned models", () => {
  it("are the six official Systran repos, at fixed revisions, every file with a size and its published hash", () => {
    assert.deepEqual(Object.keys(WHISPER_MODELS).sort(), ["base", "base.en", "small", "small.en", "tiny", "tiny.en"]);
    assert.equal(DEFAULT_WHISPER_MODEL, "base.en");
    for (const [name, m] of Object.entries(WHISPER_MODELS)) {
      assert.equal(m.repo, `Systran/faster-whisper-${name}`);
      assert.match(m.revision, /^[0-9a-f]{40}$/);
      assert.deepEqual(m.files.map((f) => f.name).sort(), ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]);
      for (const f of m.files) {
        assert.ok(f.size > 0, `${name}/${f.name} has a size`);
        assert.ok(f.name === "model.bin" ? /^[0-9a-f]{64}$/.test(f.sha256) : /^[0-9a-f]{40}$/.test(f.gitSha1), `${name}/${f.name} has its hash`);
      }
      assert.equal(m.english, name.endsWith(".en"));
      assert.ok(m.description && !/ctranslate|int8|hf_cache|snapshot/i.test(m.description), "said in plain words");
      assert.match(modelFileUrl(m, "model.bin"), new RegExp(`^https://huggingface\\.co/Systran/faster-whisper-${name.replace(".", "\\.")}/resolve/${m.revision}/model\\.bin$`));
    }
    assert.ok(modelBytes("base.en") > 140e6 && modelBytes("base.en") < 160e6, "base.en is about 148 MB");
    assert.ok(modelBytes("small") > 480e6);
  });
});

describe("downloading a model", () => {
  it("fetches every file through Hugging Face's CDN with progress, checks each, and writes its marker last", async () => {
    const { host, catalog, files } = fakeModel();
    const seen = [];
    const where = await downloadWhisperModel("tiny.en", dirs.models, { fetch: host.fetch, catalog, onProgress: (p) => seen.push(p) });
    assert.equal(where, path.join(dirs.models, "tiny.en"));
    for (const [name, buf] of Object.entries(files)) assert.ok(fs.readFileSync(path.join(where, name)).equals(buf), name);
    assert.ok(seen.length > 10, "progress while downloading");
    const last = seen.at(-1);
    assert.equal(last.bytesDone, last.bytesTotal);
    const found = findWhisperModel("tiny.en", dirs, catalog);
    assert.deepEqual(found, { name: "tiny.en", dir: where, source: "downloaded" });
  });

  it("a model.bin that doesn't match its hash fails, is not marked downloaded, and a retry keeps the files already checked", async () => {
    const bad = fakeModel({ modelBin: { body: crypto.randomBytes(300_000) } });
    await assert.rejects(downloadWhisperModel("tiny.en", dirs.models, { fetch: bad.host.fetch, catalog: bad.catalog, retryDelayMs: 1 }), /sha256/);
    assert.equal(findWhisperModel("tiny.en", dirs, bad.catalog), null);
    assert.equal(fs.existsSync(path.join(dirs.models, "tiny.en", "model.bin")), false);

    // The same small files, a good model.bin.
    const good = fakeModel();
    good.files["config.json"] = bad.files["config.json"];
    const catalog = { ...good.catalog, "tiny.en": { ...good.entry, files: good.entry.files.map((f) => (f.name === "model.bin" ? f : bad.entry.files.find((b) => b.name === f.name))) } };
    const host = fakeDownloadHost({
      ...Object.fromEntries(["config.json", "tokenizer.json", "vocabulary.txt"].map((n) => [modelFileUrl(catalog["tiny.en"], n), { body: bad.files[n] }])),
      [modelFileUrl(catalog["tiny.en"], "model.bin")]: { body: good.files["model.bin"] },
    });
    await downloadWhisperModel("tiny.en", dirs.models, { fetch: host.fetch, catalog });
    assert.equal(host.hits[modelFileUrl(catalog["tiny.en"], "config.json")], undefined, "checked files are kept");
    assert.equal(findWhisperModel("tiny.en", dirs, catalog).source, "downloaded");
  });

  it("a download that keeps stopping halfway fails in plain words and leaves the model not downloaded", async () => {
    const { host, catalog, files } = fakeModel({ modelBin: { body: Buffer.alloc(0), failAt: 0 } });
    void files;
    await assert.rejects(downloadWhisperModel("tiny.en", dirs.models, { fetch: host.fetch, catalog, retryDelayMs: 1 }), /cut off/);
    assert.equal(findWhisperModel("tiny.en", dirs, catalog), null);
  });

  it("refuses a redirect off Hugging Face, and a name that isn't one of the models", async () => {
    const { host, catalog, entry } = fakeModel({ routes: {} });
    const evil = fakeDownloadHost({ ...Object.fromEntries(entry.files.map((f) => [modelFileUrl(entry, f.name), { redirect: "https://evil.example/m" }])) });
    void host;
    await assert.rejects(downloadWhisperModel("tiny.en", dirs.models, { fetch: evil.fetch, catalog, retryDelayMs: 1 }), /refused/);
    assert.equal(evil.hits["https://evil.example/m"], undefined);
    await assert.rejects(downloadWhisperModel("../evil", dirs.models, { fetch: evil.fetch }), /not one of/);
    await assert.rejects(downloadWhisperModel("large-v3", dirs.models, { fetch: evil.fetch }), /not one of/);
  });
});

describe("finding and deleting models", () => {
  const writeModel = (dir, entry, files, marker = true) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
    if (marker) fs.writeFileSync(path.join(dir, ".tarsee-model.json"), JSON.stringify({ repo: entry.repo, revision: entry.revision }));
    else fs.rmSync(path.join(dir, ".tarsee-model.json"), { force: true });
  };

  it("one that comes with the image is found there and is never deleted", async () => {
    const { entry, catalog, files } = fakeModel();
    writeModel(path.join(dirs.bundled[0], "tiny.en"), entry, files);
    assert.deepEqual(findWhisperModel("tiny.en", dirs, catalog), { name: "tiny.en", dir: path.join(dirs.bundled[0], "tiny.en"), source: "image" });
    const r = deleteWhisperModel("tiny.en", dirs, catalog);
    assert.deepEqual(r.removed, []);
    assert.equal(r.kept, path.join(dirs.bundled[0], "tiny.en"));
    assert.ok(fs.existsSync(path.join(dirs.bundled[0], "tiny.en", "model.bin")));
  });

  it("one the old version left in Hugging Face's cache is found, and deleting it frees that space", async () => {
    const { entry, catalog, files } = fakeModel();
    const repoDir = path.join(dirs.caches[0], "hub", "models--Systran--faster-whisper-tiny.en");
    writeModel(path.join(repoDir, "snapshots", entry.revision), entry, files, false);
    fs.mkdirSync(path.join(repoDir, "blobs"), { recursive: true });
    const found = findWhisperModel("tiny.en", dirs, catalog);
    assert.equal(found.source, "cache");
    assert.equal(found.dir, path.join(repoDir, "snapshots", entry.revision));
    const r = deleteWhisperModel("tiny.en", dirs, catalog);
    assert.deepEqual(r.removed, [repoDir]);
    assert.equal(fs.existsSync(repoDir), false);
    assert.equal(findWhisperModel("tiny.en", dirs, catalog), null);
  });

  it("a folder missing a file, or with a file of the wrong size, is not a model; a downloaded one deletes", async () => {
    const { entry, catalog, files } = fakeModel();
    const dir = path.join(dirs.models, "tiny.en");
    writeModel(dir, entry, { ...files, "model.bin": files["model.bin"].subarray(0, 10) });
    assert.equal(findWhisperModel("tiny.en", dirs, catalog), null);
    writeModel(dir, entry, files, false);
    assert.equal(findWhisperModel("tiny.en", dirs, catalog), null, "no marker: the download never finished");
    writeModel(dir, entry, files);
    assert.equal(findWhisperModel("tiny.en", dirs, catalog).source, "downloaded");
    assert.deepEqual(deleteWhisperModel("tiny.en", dirs, catalog).removed, [dir]);
    assert.equal(fs.existsSync(dir), false);
  });
});
