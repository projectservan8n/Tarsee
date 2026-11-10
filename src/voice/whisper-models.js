/**
 * The speech-to-text models: the official faster-whisper models Systran publishes on Hugging Face (the same ones
 * faster-whisper downloads by itself), pinned to a revision with each file's size and the hash Hugging Face publishes
 * for it (sha256 for model.bin, git's blob hash for the small files).
 *
 * Where a model can be, in the order they are looked at:
 *   downloaded  <models>/<name>/, downloaded from Settings > Voice (on the data volume on Railway, so it survives
 *               redeploys); .tarsee-model.json is written last, once every file has been checked
 *   image       <bundled>/<name>/, put there by the Docker build (TARSEE_WHISPER_BUNDLED_DIR, outside /data so the
 *               volume can't hide it); never deleted
 *   cache       <models>/hf_cache/hub/models--Systran--faster-whisper-<name>/snapshots/<rev>/, where the old version
 *               let faster-whisper download it (still used, and deletable)
 * faster-whisper is always handed the folder, never a model name, so it never downloads anything itself.
 *
 * This file imports nothing of Tarsee's but install-common.js: the Docker build runs it on its own,
 *   node whisper-models.js download base.en /opt/tarsee/whisper-models
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_HOSTS, guardedFetch, downloadFile, writeFileAtomic } from "./install-common.js";

export const DEFAULT_WHISPER_MODEL = "base.en";
export const MODEL_MARKER = ".tarsee-model.json";

const SHARED_EN = { tokenizer: [2128466, "15d7bdf9ba25718ca2504eec6a8f02bc55af0a6a"], vocabulary: [422309, "ee695b8d3e3c10d488304e04468efec4ca27554a"] };
const SHARED_MULTI = { tokenizer: [2203239, "7818adb6de9fa3064d3ff81226fdd675be1f6344"], vocabulary: [459861, "c9074644d9d1205686f16d411564729461324b75"] };

function model(name, revision, config, modelBin, shared, description) {
  return Object.freeze({
    name,
    repo: `Systran/faster-whisper-${name}`,
    revision,
    english: name.endsWith(".en"),
    description,
    files: Object.freeze([
      { name: "config.json", size: config[0], gitSha1: config[1] },
      { name: "model.bin", size: modelBin[0], sha256: modelBin[1] },
      { name: "tokenizer.json", size: shared.tokenizer[0], gitSha1: shared.tokenizer[1] },
      { name: "vocabulary.txt", size: shared.vocabulary[0], gitSha1: shared.vocabulary[1] },
    ]),
  });
}

/** The models, smallest first in each family. Sizes and hashes as Hugging Face lists them at these revisions. */
export const WHISPER_MODELS = Object.freeze({
  "tiny.en": model("tiny.en", "0d3d19a32d3338f10357c0889762bd8d64bbdeba",
    [2317, "4065bb3bed375b176d5465be117d2d202e210434"],
    [75537502, "1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a"], SHARED_EN,
    "English only. The fastest, and the least accurate."),
  "base.en": model("base.en", "3d3d5dee26484f91867d81cb899cfcf72b96be6c",
    [2227, "594369787efe617005d199b03739ee0ead7e3ab7"],
    [145216508, "2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef"], SHARED_EN,
    "English only. Quick and accurate: the one to start with."),
  "small.en": model("small.en", "d1d751a5f8271d482d14ca55d9e2deeebbae577f",
    [2657, "ced3fd5bbb3e9f7664658065d2d36164712cf1d5"],
    [483545366, "62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a"], SHARED_EN,
    "English only. The most accurate here, and the slowest."),
  tiny: model("tiny", "d90ca5fe260221311c53c58e660288d3deb8d356",
    [2249, "3baa18e2b321a2f489614607852a729fcd516480"],
    [75538270, "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1"], SHARED_MULTI,
    "Many languages, found by itself. The fastest, and the least accurate."),
  base: model("base", "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    [2309, "867cf1a0fece1394e01d55e287ba2f09a577c046"],
    [145217532, "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"], SHARED_MULTI,
    "Many languages, found by itself. Quick and accurate."),
  small: model("small", "536b0662742c02347bc0e980a01041f333bce120",
    [2370, "e5047537059bd8f182d9ca64c470201585015187"],
    [483546902, "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"], SHARED_MULTI,
    "Many languages, found by itself. The most accurate here, and the slowest."),
});

export const WHISPER_MODEL_NAMES = Object.freeze(Object.keys(WHISPER_MODELS));

function entryFor(name, catalog = WHISPER_MODELS) {
  const m = Object.hasOwn(catalog, name) ? catalog[name] : null;
  if (!m) throw Object.assign(new Error(`"${String(name).slice(0, 40)}" is not one of the speech models (${Object.keys(catalog).join(", ")})`), { code: "UNKNOWN_MODEL" });
  return m;
}

export function modelFileUrl(m, file) {
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${encodeURIComponent(file)}`;
}

/** A model's download size in bytes. */
export function modelBytes(name, catalog = WHISPER_MODELS) {
  return entryFor(name, catalog).files.reduce((a, f) => a + f.size, 0);
}

/** Every file there at its listed size (a cheap check: the hashes were checked when they were downloaded). */
function filesThere(dir, m) {
  try {
    return m.files.every((f) => fs.statSync(path.join(dir, f.name)).size === f.size);
  } catch {
    return false;
  }
}

/** The old version's Hugging Face cache: the pinned revision's snapshot first, then any complete one. */
function cacheSnapshot(cacheDir, m) {
  const snaps = path.join(cacheDir, "hub", `models--${m.repo.replace("/", "--")}`, "snapshots");
  let revs;
  try { revs = fs.readdirSync(snaps); } catch { return null; }
  revs.sort((a, b) => (b === m.revision) - (a === m.revision));
  for (const rev of revs) {
    const dir = path.join(snaps, rev);
    if (filesThere(dir, m)) return dir;
  }
  return null;
}

/**
 * Where a model is: { name, dir, source: "downloaded" | "image" | "cache" }, or null.
 * dirs: { models, bundled: [folders], caches: [Hugging Face cache folders] }.
 */
export function findWhisperModel(name, dirs, catalog = WHISPER_MODELS) {
  const m = Object.hasOwn(catalog, name) ? catalog[name] : null;
  if (!m) return null;
  const own = path.join(dirs.models, name);
  if (fs.existsSync(path.join(own, MODEL_MARKER)) && filesThere(own, m)) return { name, dir: own, source: "downloaded" };
  for (const b of dirs.bundled || []) {
    const dir = path.join(b, name);
    if (fs.existsSync(path.join(dir, MODEL_MARKER)) && filesThere(dir, m)) return { name, dir, source: "image" };
  }
  for (const c of dirs.caches || []) {
    const dir = cacheSnapshot(c, m);
    if (dir) return { name, dir, source: "cache" };
  }
  return null;
}

/**
 * Download a model into <root>/<name>/. Files already there that pass their checks are kept, so a retry picks up
 * where a failed one stopped. Resolves with the folder.
 * opts: fetch, onProgress({ bytesDone, bytesTotal, file }), log, retryDelayMs, catalog (tests).
 */
export async function downloadWhisperModel(name, root, { fetch: fetchImpl, onProgress, log = () => {}, retryDelayMs = 1000, catalog = WHISPER_MODELS } = {}) {
  const m = entryFor(name, catalog);
  const get = guardedFetch([OFFICIAL_HOSTS.huggingface], fetchImpl || globalThis.fetch);
  const dir = path.join(root, name);
  const total = m.files.reduce((a, f) => a + f.size, 0);
  let done = 0;
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, MODEL_MARKER), { force: true });
  log(`downloading ${name} (${Math.round(total / 1e6)} MB) from huggingface.co/${m.repo}`);
  onProgress?.({ bytesDone: 0, bytesTotal: total, file: null });
  for (const f of m.files) {
    await downloadFile({
      url: modelFileUrl(m, f.name),
      dest: path.join(dir, f.name),
      size: f.size,
      sha256: f.sha256,
      gitSha1: f.gitSha1,
      fetchImpl: get,
      retryDelayMs,
      progress: (n) => { done = Math.max(0, done + n); onProgress?.({ bytesDone: done, bytesTotal: total, file: f.name }); },
    });
  }
  writeFileAtomic(path.join(dir, MODEL_MARKER), JSON.stringify({ repo: m.repo, revision: m.revision, downloadedAt: new Date().toISOString() }, null, 2) + "\n");
  log(`${name} is ready in ${dir}`);
  return dir;
}

/**
 * Delete a model's downloaded copy and any copy in the old Hugging Face cache. A model that comes with the image is
 * left (it is part of Tarsee): { removed: [folders], kept: <image folder> | null }.
 */
export function deleteWhisperModel(name, dirs, catalog = WHISPER_MODELS) {
  const m = entryFor(name, catalog);
  const removed = [];
  const own = path.join(dirs.models, name);
  if (fs.existsSync(own)) { fs.rmSync(own, { recursive: true, force: true }); removed.push(own); }
  for (const c of dirs.caches || []) {
    const repoDir = path.join(c, "hub", `models--${m.repo.replace("/", "--")}`);
    if (fs.existsSync(repoDir)) { fs.rmSync(repoDir, { recursive: true, force: true }); removed.push(repoDir); }
  }
  const image = (dirs.bundled || []).map((b) => path.join(b, name)).find((d) => fs.existsSync(path.join(d, MODEL_MARKER)) && filesThere(d, m)) || null;
  return { removed, kept: image };
}

// ── Terminal (the Docker build) ──────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, name, root] = process.argv.slice(2);
  if (cmd !== "download" || !name || !root) {
    console.error("usage: node whisper-models.js download <model> <folder>");
    process.exit(2);
  }
  let shown = -10;
  downloadWhisperModel(name, root, {
    log: (msg) => console.log(`[stt] ${msg}`),
    onProgress: ({ bytesDone, bytesTotal }) => {
      const pct = Math.floor((bytesDone / bytesTotal) * 100);
      if (pct >= shown + 10) { shown = pct - (pct % 10); console.log(`[stt] ${name} ${shown}%`); }
    },
  }).then(() => process.exit(0), (err) => {
    console.error(`[stt] could not download ${name}: ${err.message}`);
    process.exit(1);
  });
}
