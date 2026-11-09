/**
 * settings-guard.js: the settings files the engines refuse to start a turn with, found ahead of time for Settings > AI,
 * and the one-click fix (design 4.5 R5 and section 5's banner).
 *
 * Before every turn the engines check the settings files they would load: Claude Code's settings.json files (the
 * provider's home, and the workspace's .claude/settings.json and settings.local.json for the sources it loads) must
 * not set a credential through their env block or define apiKeyHelper (engine-env.js settingsFileGuard), and Codex's
 * config.toml files (the home's, and the workspace's .codex/config.toml) may hold only the allowlisted root entries
 * (codexConfigGuard), and a Codex home may hold no .env at all (Codex loads it into its own environment). The agent's
 * own shell can write every one of these files, so a refusal is the safety: a planted entry could otherwise send a
 * key, or the turn, somewhere else.
 *
 *   settingsGuardFindings(opts)   every file a shipped provider's turn would refuse now:
 *                                 [{ file, kind: "claude"|"codex", entries, unreadable, dotenv?, providers, labels }]
 *                                 entries are names ("env.ANTHROPIC_BASE_URL", "apiKeyHelper", "openai_base_url"),
 *                                 never values; dotenv marks a Codex home's .env (never read, only set aside)
 *   fixSettingsFile(file, opts)   removes exactly those entries from that file (keeping everything else), or sets an
 *                                 unreadable file aside under another name; only for a file in the findings right now,
 *                                 so it can never be pointed at any other file
 * opts: stateDir (config.STATE_DIR), workspace (config.CLAUDE_WORKSPACE_DIR), homeDir (the Claude plan's home's
 * parent; the user's home), isShipped.
 */
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { PROVIDER_IDS, PROVIDERS, isShipped as registryShipped } from "./provider-registry.js";
import {
  CODEX, codexConfigFilesFor, codexConfigGuard, homeFor, isAuthEnvName, settingSourcesFor, settingsFileGuard,
  settingsFilesFor, stripCodexConfig,
} from "./engine-env.js";

function optionsOf(opts = {}) {
  return {
    stateDir: opts.stateDir || config.STATE_DIR,
    workspace: opts.workspace || config.CLAUDE_WORKSPACE_DIR,
    homeDir: opts.homeDir,
    isShipped: typeof opts.isShipped === "function" ? opts.isShipped : registryShipped,
  };
}

/** Every settings file a shipped provider's turn would refuse right now, once each, with the AIs it stops. */
export function settingsGuardFindings(opts = {}) {
  const o = optionsOf(opts);
  const byFile = new Map();
  for (const id of PROVIDER_IDS) {
    if (!o.isShipped(id)) continue;
    for (const engine of PROVIDERS[id].engines) {
      let home;
      try { home = homeFor(id, engine, { stateDir: o.stateDir, homeDir: o.homeDir }); } catch { continue; }
      const kind = engine === CODEX ? "codex" : "claude";
      const paths = kind === "codex"
        ? codexConfigFilesFor({ home, workspace: o.workspace })
        : settingsFilesFor(settingSourcesFor(id), { home, workspace: o.workspace });
      let result;
      try { result = kind === "codex" ? codexConfigGuard(paths) : settingsFileGuard(paths); } catch { continue; }
      for (const f of result.files || []) {
        const key = path.resolve(f.file);
        let entry = byFile.get(key);
        if (!entry) {
          entry = { file: f.file, kind, entries: [...(f.entries || [])], unreadable: !!f.unreadable, ...(f.dotenv ? { dotenv: true } : {}), providers: [] };
          byFile.set(key, entry);
        }
        if (!entry.providers.includes(id)) entry.providers.push(id);
      }
    }
  }
  return [...byFile.values()].map((e) => ({ ...e, labels: e.providers.map((id) => PROVIDERS[id].label) }));
}

/**
 * Fix one file the guards refuse: { ok, file, kind, removed, setAside? } or { ok: false, status, error }. Only a file
 * that is in settingsGuardFindings() right now is touched (400 for no file named, 404 for any other).
 */
export function fixSettingsFile(file, opts = {}) {
  if (typeof file !== "string" || !file.trim()) return { ok: false, status: 400, error: "Say which file to fix." };
  const finding = settingsGuardFindings(opts).find((f) => path.resolve(f.file) === path.resolve(file));
  if (!finding) return { ok: false, status: 404, error: "That file has nothing Tarsee needs to remove." };
  try {
    if (finding.unreadable) return setAside(finding);
    const text = fs.readFileSync(finding.file, "utf8");
    const fixed = finding.kind === "codex" ? stripCodexConfig(text) : stripClaudeSettings(text);
    fs.writeFileSync(finding.file, fixed.text);
    return { ok: true, file: finding.file, kind: finding.kind, removed: fixed.removed };
  } catch (err) {
    return { ok: false, status: 500, error: `Tarsee couldn't change ${finding.file}: ${err?.message || err}. Edit it by hand in the Terminal.` };
  }
}

/** A Claude Code settings file without the env entries a credential could come through, and without apiKeyHelper. */
function stripClaudeSettings(text) {
  const src = String(text);
  const json = JSON.parse(src.replace(/^\uFEFF/, ""));
  const removed = [];
  if (json.env && typeof json.env === "object" && !Array.isArray(json.env)) {
    for (const name of Object.keys(json.env)) {
      if (isAuthEnvName(name)) { delete json.env[name]; removed.push(`env.${name}`); }
    }
    if (!Object.keys(json.env).length) delete json.env;
  }
  if (Object.hasOwn(json, "apiKeyHelper")) { delete json.apiKeyHelper; removed.push("apiKeyHelper"); }
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  return { text: JSON.stringify(json, null, 2).split("\n").join(eol) + eol, removed };
}

/** A file that can't be read safely, renamed next to itself so nothing loads it (and nothing is lost). */
function setAside(finding) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = `${finding.file}.set-aside-${stamp}`;
  for (let n = 2; fs.existsSync(target); n++) target = `${finding.file}.set-aside-${stamp}-${n}`;
  fs.renameSync(finding.file, target);
  return { ok: true, file: finding.file, kind: finding.kind, removed: [], setAside: target };
}
