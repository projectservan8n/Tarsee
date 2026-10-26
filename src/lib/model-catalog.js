/**
 * Which Claude models exist right now, for the composer's picker and for
 * turning a family word ("opus", "sonnet") into the newest model of that
 * family.
 *
 * Why this is needed: the Agent SDK runs its OWN bundled copy of the Claude
 * Code CLI, pinned to the SDK's release, not the `claude` installed in the
 * image. That bundled CLI resolves the family words to whatever was newest
 * when it was built, so "opus" quietly ran a model several releases old. A
 * concrete id ("claude-opus-5-5") goes to the API as it is and runs that
 * model. So Tarsee resolves the family words itself, from the newest list it
 * can find, before each turn.
 *
 * Sources, newest wins:
 *  1. The catalog Claude Code fetched for the signed-in account, cached under
 *     <claude home>/cache/model-catalog/*-cc.json by the CLI (every Claude home
 *     is looked at: in Docker HOME is /root while the config lives at
 *     /home/node/.claude, see lib/claude-transcript.js).
 *  2. The catalog every CLI build carries, read from the installed `claude`
 *     (the image installs the latest at build time). Read once per CLI file,
 *     in chunks, off the request path.
 *  3. Tarsee's own model table (config/constants.js), as the floor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MODELS } from "../config/constants.js";
import { claudeHomes } from "./claude-transcript.js";
import { buildPicker, catalogFromBuildText, CATALOG_MARKER, FAMILIES, TARSEE_DEFAULT_EFFORT } from "./model-picker.js";

const CATALOG_RECHECK_MS = 60_000;
const CLI_RECHECK_MS = 60 * 60_000;
const CLI_CHUNK = 16 * 1024 * 1024;
const CLI_CATALOG_MAX = 512 * 1024;   // the catalog a build carries is some tens of KB
const MARKER = Buffer.from(CATALOG_MARKER);

let _cli = null;            // { bin, catalog: { issuedAt, config } | null }
let _cliReading = null;     // the read in progress
let _account = null;        // { fetchedAt, config, file, mtimeMs }
let _accountCheckedAt = 0;
let _catalogDirs = null;    // tests only: where to look instead of the Claude homes

/**
 * The real file behind the installed `claude` (CLAUDE_BIN, else the PATH), so
 * a CLI update shows up as a new path. Never the SDK's bundled copy: that one
 * is the stale one this module works around.
 */
export function resolveCliBin() {
  const name = process.env.CLAUDE_BIN || "claude";
  const candidates = name.includes("/")
    ? [name]
    : [...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, name)), path.join(os.homedir(), ".local", "bin", name)];
  for (const c of candidates) {
    try {
      if (!fs.statSync(c).isFile()) continue;
      const real = fs.realpathSync(c);
      if (real.includes(`${path.sep}claude-agent-sdk`)) continue;
      return real;
    } catch { /* next */ }
  }
  return null;
}

/** The catalog inside a CLI build (a native binary or a JS bundle): read in chunks, never blocking the server. */
export async function readCliCatalog(bin = resolveCliBin()) {
  if (!bin) return null;
  const fh = await fs.promises.open(bin, "r");
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(CLI_CHUNK + MARKER.length);
    for (let pos = 0; pos < size; pos += CLI_CHUNK) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      const at = buf.indexOf(MARKER);
      if (at === -1 || at >= Math.min(bytesRead, CLI_CHUNK)) continue;
      const len = Math.min(CLI_CATALOG_MAX, size - (pos + at));
      const out = Buffer.alloc(len);
      const r = await fh.read(out, 0, len, pos + at);
      try { return catalogFromBuildText(out.toString("utf8", 0, r.bytesRead)); } catch { return null; }
    }
    return null;
  } finally { await fh.close(); }
}

/** Read the installed CLI's catalog again when the CLI file changed (an update), at most hourly. */
function refreshCli() {
  if (_cliReading) return _cliReading;
  const bin = resolveCliBin();
  if (!bin || bin === _cli?.bin) return Promise.resolve(_cli);
  _cliReading = readCliCatalog(bin)
    .then((catalog) => {
      _cli = { bin, catalog };
      const n = catalog?.config?.models?.length || 0;
      console.log(`[models] Claude Code catalog: ${n} models (${path.basename(path.dirname(bin))}/${path.basename(bin)})`);
      return _cli;
    })
    .catch((err) => { console.warn(`[models] could not read Claude Code's catalog: ${err.message}`); _cli = { bin, catalog: null }; return _cli; })
    .finally(() => { _cliReading = null; });
  return _cliReading;
}

/**
 * The catalog Claude Code fetched for the signed-in account (the one its own
 * /model picker shows), from the CLI's cache in any Claude home: the newest
 * "cc" file. Re-read when a file changes, looked at once a minute at most.
 */
export function readAccountCatalog({ force = false } = {}) {
  if (!force && Date.now() - _accountCheckedAt < CATALOG_RECHECK_MS) return _account;
  _accountCheckedAt = Date.now();
  const dirs = _catalogDirs || claudeHomes().map((h) => path.join(h, "cache", "model-catalog"));
  let best = null;
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /-cc\.json$/.test(f)); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (_account?.file === file && _account.mtimeMs === st.mtimeMs) { if (!best || _account.fetchedAt > best.fetchedAt) best = _account; continue; }
      try {
        const doc = JSON.parse(fs.readFileSync(file, "utf8"));
        const config = doc?.catalog?.config;
        if (doc?.catalog?.surface !== "cc" || !Array.isArray(config?.models) || !config.models.length) continue;
        const entry = { fetchedAt: Number(doc.fetchedAt) || st.mtimeMs, config, file, mtimeMs: st.mtimeMs };
        if (!best || entry.fetchedAt > best.fetchedAt) best = entry;
      } catch { /* a file being written, or not one of these */ }
    }
  }
  _account = best;
  return _account;
}

/**
 * The composer's picker (lib/model-picker.js): Claude Code's catalog, the
 * account's or the installed build's, whichever is newer; with neither, the
 * models in Tarsee's table. Entries always carry exact ids, never a family
 * word (see the top of this file).
 */
export function getModelPicker({ defaultEffort } = {}) {
  const account = readAccountCatalog();
  const build = _cli?.catalog || null;
  const useBuild = build && (!account || (build.issuedAt || 0) > account.fetchedAt);
  const chosen = useBuild ? { config: build.config, at: build.issuedAt, source: "Claude Code's built-in catalog" }
    : account ? { config: account.config, at: account.fetchedAt, source: "Claude Code's catalog for this account" } : null;
  return buildPicker({
    catalog: chosen?.config || null,
    knownIds: CLAUDE_MODELS.filter((m) => !m.alias).map((m) => m.id),
    aliases: {},
    source: chosen?.source || null,
    fetchedAt: chosen?.at || null,
    defaultEffort: defaultEffort || TARSEE_DEFAULT_EFFORT,
  });
}

/**
 * A model as it should be sent for a turn: a bare family word ("opus",
 * "sonnet", "haiku", "fable", any case) becomes the newest model of that
 * family in the picker's list; anything else (an exact id, a word with no
 * known family) goes as it is.
 */
export function resolveModel(model) {
  const word = String(model || "").trim().toLowerCase();
  if (!FAMILIES.includes(word)) return model;
  try {
    const top = getModelPicker().main.find((e) => e.family === word);
    return top?.id || model;
  } catch { return model; }
}

/** Start reading the installed CLI's catalog (off the request path), and again when the CLI is updated. */
export function initModelCatalog() {
  refreshCli();
  setInterval(refreshCli, CLI_RECHECK_MS).unref?.();
}

/** Tests only. */
export function __setForTests({ catalogDirs, cli } = {}) {
  if (catalogDirs !== undefined) { _catalogDirs = catalogDirs; _account = null; _accountCheckedAt = 0; }
  if (cli !== undefined) _cli = cli;
}
