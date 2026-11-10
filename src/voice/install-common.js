/**
 * What Tarsee's installers share: Phonon (phonon-install.js), faster-whisper and its models (stt-install.js,
 * whisper-models.js) and the standalone Python they can run on (python-runtime.js).
 *
 *   - Downloads come only from fixed official hosts, over https. Redirects (the hosts send big files to their CDNs)
 *     are followed by hand and each one is checked before anything is sent there (guardedFetch).
 *   - Every file is streamed to a temporary name, checked against the size and hash its source publishes, and only
 *     then renamed into place (downloadFile). A file never appears half written.
 *   - A lock file keeps two installs (the server and a terminal run) from racing (acquireLock).
 *
 * Nothing here imports Tarsee's config: the Docker build runs whisper-models.js (and so this file) on its own, to put
 * the default speech-to-text model in the image.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

// ── Official hosts ───────────────────────────────────────────────────────

/**
 * The hosts each kind of download may come from. `hosts` are exact names; `suffixes` cover a company's own CDN
 * names (Hugging Face sends its big files to <region>.cdn.hf.co and cdn-lfs*.huggingface.co).
 */
export const OFFICIAL_HOSTS = Object.freeze({
  huggingface: Object.freeze({ name: "Hugging Face", hosts: ["huggingface.co"], suffixes: [".huggingface.co", ".hf.co"] }),
  github: Object.freeze({
    name: "GitHub",
    hosts: ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"],
    suffixes: [],
  }),
});

const MAX_REDIRECTS = 5;

function hostOf(url) {
  try { return new URL(url).host || "an unknown host"; } catch { return "an unknown host"; }
}

/** Whether url is https on one of `sources`' hosts (sources: OFFICIAL_HOSTS entries). */
export function isOfficialUrl(url, sources) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return sources.some((s) => s.hosts.includes(host) || s.suffixes.some((suf) => host.endsWith(suf) && host.length > suf.length));
}

/**
 * A fetch that only ever talks to `sources`' hosts over https. Redirects are followed by hand (at most 5): one to any
 * other host, or to plain http, is refused (code HOST_REFUSED) before anything is sent there.
 */
export function guardedFetch(sources, fetchImpl = globalThis.fetch) {
  const names = [...new Set(sources.map((s) => s.name))].join(" or ");
  return async (url, init = {}) => {
    let current = String(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isOfficialUrl(current, sources)) {
        throw Object.assign(new Error(`refused to download from ${hostOf(current)}: only ${names} over https is allowed`), { code: "HOST_REFUSED" });
      }
      const res = await fetchImpl(current, { ...init, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.("location") : null;
      if (!location) return res;
      try { await res.body?.cancel?.(); } catch { /* nothing to drain */ }
      current = new URL(location, current).toString();
    }
    throw new Error(`too many redirects from ${hostOf(url)}`);
  };
}

// ── Hashes ───────────────────────────────────────────────────────────────

/** The hash git (and so Hugging Face, for files kept in git rather than LFS) gives a file: sha1("blob <size>\0" + data). */
export function gitBlobSha1(buf) {
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/** sha256 and git blob sha1 of a file on disk. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const s256 = crypto.createHash("sha256");
    const s1 = crypto.createHash("sha1").update(`blob ${size}\0`);
    fs.createReadStream(file)
      .on("data", (c) => { s256.update(c); s1.update(c); })
      .on("error", reject)
      .on("end", () => resolve({ sha256: s256.digest("hex"), gitSha1: s1.digest("hex"), size }));
  });
}

export async function sha256File(file) {
  return (await hashFile(file)).sha256;
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ── Downloads ────────────────────────────────────────────────────────────

const DOWNLOAD_ATTEMPTS = 3;
const STALL_MS = 60_000;

/** Whether a file already at dest is the one wanted: its size, and whichever hashes are given. */
async function matches(dest, { sha256, gitSha1, size }) {
  const st = fs.statSync(dest);
  if (st.size === 0 || (size !== undefined && st.size !== size)) return false;
  if (!sha256 && !gitSha1) return true;
  const h = await hashFile(dest);
  return (!sha256 || h.sha256 === sha256) && (!gitSha1 || h.gitSha1 === gitSha1);
}

/**
 * Stream url to dest, then rename into place. Checked first: the exact size when `size` is given (else the
 * Content-Length), the `sha256`, and the `gitSha1` (git's blob hash, which needs `size`). A file already at dest that
 * passes the same checks is kept without a download ("kept"). Retries a few times; a transfer with no data for 60s is
 * aborted. progress(n) gets each chunk's size, and minus what a failed attempt had counted.
 */
export async function downloadFile({ url, dest, sha256, gitSha1, size, fetchImpl = globalThis.fetch, progress = () => {}, attempts = DOWNLOAD_ATTEMPTS, retryDelayMs = 1000 }) {
  if (gitSha1 && size === undefined) throw new Error("downloadFile: a git hash needs the file's size");
  if (fs.existsSync(dest)) {
    if (await matches(dest, { sha256, gitSha1, size })) {
      progress(fs.statSync(dest).size);
      return "kept";
    }
    fs.rmSync(dest, { force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const name = path.basename(dest);

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const tmp = `${dest}.part`;
    const ac = new AbortController();
    let stall = null;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ac.abort(new Error(`no data for ${STALL_MS / 1000}s`)), STALL_MS);
      stall.unref?.();
    };
    let counted = 0;
    try {
      armStall();
      const res = await fetchImpl(url, { redirect: "follow", signal: ac.signal });
      if (!res.ok || !res.body) throw Object.assign(new Error(`${hostOf(url)} answered HTTP ${res.status} for ${name}`), { httpStatus: res.status });
      const s256 = crypto.createHash("sha256");
      const s1 = gitSha1 ? crypto.createHash("sha1").update(`blob ${size}\0`) : null;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          armStall();
          s256.update(chunk);
          s1?.update(chunk);
          counted += chunk.length;
          progress(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp));
      if (size !== undefined && counted !== size) {
        throw new Error(`${name} is the wrong size (${counted} bytes, not the ${size} its source lists)`);
      }
      // A compressed response's Content-Length is not the size of what we read.
      const expected = Number(res.headers?.get?.("content-length"));
      if (size === undefined && !res.headers?.get?.("content-encoding") && expected > 0 && counted !== expected) {
        throw new Error(`${name} was cut short (${counted} of ${expected} bytes)`);
      }
      const got = s256.digest("hex");
      const bad = sha256 && got !== sha256 ? "sha256" : s1 && s1.digest("hex") !== gitSha1 ? "hash" : null;
      if (bad) throw Object.assign(new Error(`${name} does not match its published ${bad}`), { code: "HASH_MISMATCH" });
      fs.renameSync(tmp, dest);
      return got;
    } catch (err) {
      lastErr = describeFetchError(err, url);
      progress(-counted);
      fs.rmSync(tmp, { force: true });
      // A refused host or a missing file won't change on a retry.
      if (err?.code === "HOST_REFUSED" || err?.httpStatus === 404) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    } finally {
      clearTimeout(stall);
    }
  }
  throw lastErr;
}

/**
 * fetch's own errors say nothing ("fetch failed", or "terminated" when a connection drops mid-file): name the host
 * and the cause instead.
 */
export function describeFetchError(err, url) {
  const host = hostOf(url);
  const cause = err?.cause?.code || err?.cause?.message || "network error";
  if (err?.message === "fetch failed") {
    return Object.assign(new Error(`could not reach ${host} (${cause})`), { cause: err });
  }
  if (err?.message === "terminated" || err?.code === "ECONNRESET" || err?.code === "UND_ERR_SOCKET") {
    return Object.assign(new Error(`the download from ${host} was cut off (${cause})`), { cause: err });
  }
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return Object.assign(new Error(`the download from ${host} stopped (${err.message})`), { cause: err });
  }
  return err;
}

// ── Lock ─────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 2 * 60 * 60_000;
// Lock files this process holds right now.
const _heldLocks = new Set();

/** Take <root>/.install.lock or throw (code LOCKED, "another <what> is already running"). Returns the release function. */
export function acquireLock(root, what = "Phonon install") {
  const file = path.join(root, ".install.lock");
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
      _heldLocks.add(file);
      return () => {
        _heldLocks.delete(file);
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!lockIsStale(file)) {
        throw Object.assign(new Error(`another ${what} is already running`), { code: "LOCKED" });
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw Object.assign(new Error(`could not take the ${what} lock`), { code: "LOCKED" });
}

function lockIsStale(file) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Unreadable: stale unless it was created a moment ago (being written).
    try { return Date.now() - fs.statSync(file).mtimeMs > 10_000; } catch { return true; }
  }
  if (info.pid === process.pid) {
    // Ours and held: a live lock. Ours but not held: left over from an earlier
    // container that ran with the same pid (common for PID 1-ish processes).
    return !_heldLocks.has(file);
  }
  const age = Date.now() - Date.parse(info.startedAt);
  if (!(age < LOCK_STALE_MS)) return true;
  try { process.kill(info.pid, 0); return false; } catch (err) { return err.code !== "EPERM"; }
}
