#!/usr/bin/env node
/**
 * smoke-backends.mjs: run Verify's four-step probe (src/ai/verify-model.js) on each AI and print the results.
 *
 * Each AI gets the same check the owner's Verify button runs: a plain reply, a call to Tarsee's tarsee_datetime tool,
 * a shell command, and a resumed turn that must remember the first. Run it on every engine bump (design 4.11): the
 * shipped verified list must not go stale. --json prints the results in the shape that list is built from.
 *
 *   node scripts/smoke-backends.mjs                     every AI whose credential is in the environment
 *   node scripts/smoke-backends.mjs deepseek openrouter:z-ai/glm-5.3 chatgpt
 *   options: --json   --engines=claude-code,codex   --no-efforts   --help
 *
 * Credentials come from environment variables ONLY: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
 * DEEPSEEK_API_KEY, TARSEE_LOCAL_AI_URL (and TARSEE_LOCAL_AI_KEY if the server wants one). The run uses a fresh,
 * empty settings database, so a key saved in Settings is never picked up. The Claude plan runs on its own sign-in
 * (CLAUDE_CODE_OAUTH_TOKEN, or `claude login`) and the ChatGPT plan on Codex's sign-in: name them to run them (the
 * Claude plan also runs by itself when CLAUDE_CODE_OAUTH_TOKEN is set). No ChatGPT model is ever named: the account's
 * own default is used unless one is given.
 *
 * Nothing it prints carries a key: every credential value in the environment is blanked out of the output, then the
 * usual secret patterns are. Nothing is recorded in Settings.
 *
 * Exit code: 0 when every AI passed, 1 when any failed or was asked for without a credential, 2 when there was nothing
 * to run or Tarsee couldn't be set up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, PROVIDER_IDS, normalizeProviderId, resolveModelFor } from "../src/ai/provider-registry.js";
import { redactSecrets } from "../src/lib/redact.js";

const STEPS = ["reply", "tool", "shell", "resume"];
const ENGINES = ["claude-code", "codex"];

/** The Claude plan's sign-in variables that mean "this machine can run the plan headless". */
const PLAN_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"];

const USAGE = `Usage: node scripts/smoke-backends.mjs [provider[:model] ...] [--json] [--engines=claude-code,codex] [--no-efforts]
Providers: ${PROVIDER_IDS.join(", ")}
With no provider named, every AI whose credential is in the environment is checked:
  ${PROVIDER_IDS.map((id) => credentialNames(id).join(" or ")).filter(Boolean).join(", ")}
`;

/** The command line: { targets: [{provider, model}], json, engines, efforts, help }. Throws on anything unknown. */
export function parseArgs(argv = []) {
  const out = { targets: [], json: false, engines: null, efforts: true, help: false };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg === "--no-efforts") out.efforts = false;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--engines=")) {
      const list = arg.slice("--engines=".length).split(",").map((s) => s.trim()).filter(Boolean);
      const bad = list.filter((e) => !ENGINES.includes(e));
      if (bad.length || !list.length) throw new Error(`Unknown engine in ${arg}: use ${ENGINES.join(" or ")}.`);
      out.engines = list;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}.`);
    } else {
      // The model may hold colons of its own (OpenRouter's ":free"): only the first one splits.
      const i = arg.indexOf(":");
      const name = i < 0 ? arg : arg.slice(0, i);
      const model = i < 0 ? "" : arg.slice(i + 1).trim();
      const provider = normalizeProviderId(name);
      if (!provider) throw new Error(`Unknown AI "${name}": use one of ${PROVIDER_IDS.join(", ")}.`);
      out.targets.push({ provider, model: model || null });
    }
  }
  return out;
}

/** The environment variables that carry a provider's credential (names only). */
function credentialNames(id) {
  const p = PROVIDERS[id];
  if (id === "claude") return PLAN_ENV;
  if (id === "local") return [p.urlEnv];
  return p.envKey ? [p.envKey] : [];
}

/**
 * What to run: one entry per provider, { provider, model, credential, skip? }. credential names where it comes from
 * ("env:NAME" or "sign-in"), never its value. With no targets, every provider with a credential in `env` (the ChatGPT
 * plan only when named). A named provider without one gets `skip` with the variable it needs.
 */
export function planRuns({ targets = [], env = process.env } = {}) {
  const has = (name) => typeof env?.[name] === "string" && env[name].trim() !== "";
  const credentialOf = (id) => {
    const name = credentialNames(id).find(has);
    if (name) return `env:${name}`;
    return PROVIDERS[id].kind === "subscription" ? "sign-in" : null;
  };
  const chosen = targets.length
    ? targets
    : PROVIDER_IDS.filter((id) => id !== "chatgpt" && credentialNames(id).some(has)).map((provider) => ({ provider, model: null }));
  return chosen.map(({ provider, model }) => {
    const credential = credentialOf(provider);
    const run = { provider, model: model || defaultModel(provider), credential };
    if (!credential) run.skip = `no ${credentialNames(provider).join(" or ")} in the environment`;
    return run;
  });
}

/** The provider's own default model; null for the ChatGPT plan (the account's default) and a Local AI not yet asked. */
function defaultModel(id) {
  if (id === "chatgpt") return null;
  return resolveModelFor(id, "") || null;
}

/**
 * Run it. deps (all optional; tests inject them): argv, env, verify(provider, model, opts) (default: the real probe
 * on a scratch database), write / writeErr (stdout / stderr). Returns the exit code.
 */
export async function main({ argv = process.argv.slice(2), env = process.env, verify, write, writeErr } = {}) {
  const secrets = secretValues(env);
  const clean = (s) => scrub(s, secrets);
  const out = (s) => (write || ((x) => process.stdout.write(x)))(clean(s));
  const err = (s) => (writeErr || ((x) => process.stderr.write(x)))(clean(s));

  let args;
  try { args = parseArgs(argv); } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }

  const runs = planRuns({ targets: args.targets, env });
  if (!runs.some((r) => !r.skip)) {
    err(`Nothing to check. Set one of these variables, or name an AI to run on its sign-in:\n  ${PROVIDER_IDS.flatMap(credentialNames).join("\n  ")}\n`);
    for (const r of runs) err(`  ${r.provider}: ${r.skip}\n`);
    return 2;
  }

  let real = null;
  if (!verify) {
    real = await prepareReal({ env, err });
    if (!real.ok) {
      err(`${real.error}\n`);
      return 2;
    }
    verify = real.verify;
  }

  const results = [];
  try {
    for (const run of runs) {
      if (run.skip) {
        results.push({ ...run, skipped: true });
        continue;
      }
      if (!run.model && run.provider === "local" && real) run.model = await real.firstLocalModel();
      if (!run.model && run.provider !== "chatgpt") {
        results.push({ ...run, skipped: true, skip: `no model to check: name one, e.g. ${run.provider}:<model>` });
        continue;
      }
      err(`[smoke] ${run.provider} ${run.model || "(the account's default model)"} (${run.credential})\n`);
      const started = Date.now();
      let result;
      try {
        result = await verify(run.provider, run.model, {
          record: false,
          ...(args.engines ? { engines: args.engines } : {}),
          ...(args.efforts ? {} : { efforts: [] }),
          onProgress: (p) => err(`  ${p.engine} ${p.step}${p.effort ? ` ${p.effort}` : ""}: ${p.state}${p.detail ? ` (${p.detail})` : ""}\n`),
        });
      } catch (e) {
        result = { ok: false, error: `The check crashed: ${e?.message || e}`, checks: {}, efforts: [] };
      }
      results.push({ ...run, result, seconds: Math.round((Date.now() - started) / 100) / 10 });
    }
  } finally {
    await real?.close();
  }

  if (args.json) out(`${JSON.stringify(results.map((r) => jsonRow(r, clean)), null, 2)}\n`);
  else out(table(results, clean));
  return results.every((r) => !r.skipped && r.result?.ok) ? 0 : 1;
}

/** The real probe: a scratch settings database (keys from the environment only), Tarsee's turn layer, no recording. */
async function prepareReal({ env, err }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-smoke-"));
  // Before anything reads the config: the settings database lives here, empty, so no saved key can be used.
  process.env.TARSEE_DATA_DIR = scratch;
  let db = null;
  const close = async () => {
    try { db?.close(); } catch { /* closed */ }
    fs.rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const config = (await import("../src/config/env.js")).default;
    const { initDb } = await import("../src/db/sqlite.js");
    const { SettingsStore } = await import("../src/db/settings.js");
    db = initDb(config.DB_PATH);
    const store = new SettingsStore(db);
    let runTurn;
    try {
      ({ runTurn } = await import("../src/ai/turn.js"));
    } catch (e) {
      await close();
      return { ok: false, error: `Tarsee's turn layer (src/ai/turn.js) couldn't be loaded: ${e.message}` };
    }
    if (typeof runTurn !== "function") {
      await close();
      return { ok: false, error: "src/ai/turn.js has no runTurn." };
    }
    const { verifyModel } = await import("../src/ai/verify-model.js");
    const { refreshOpenRouterCatalog } = await import("../src/lib/openrouter-catalog.js");
    const { refreshProviderModels } = await import("../src/ai/provider-models.js");
    // OpenRouter's public list (no key): which engines each model's endpoints allow, and its effort levels.
    const catalog = await refreshOpenRouterCatalog(store);
    if (catalog.error) err(`[smoke] ${catalog.error}\n`);
    return {
      ok: true,
      verify: (provider, model, opts) => verifyModel(provider, model, {
        runner: runTurn,
        store,
        stateDir: config.STATE_DIR,
        limiter: null,
        toolCtx: { db, settingsStore: store },
        ...opts,
      }),
      firstLocalModel: async () => {
        const r = await refreshProviderModels("local", { store, env });
        if (!r.ok) err(`[smoke] local: ${r.error}\n`);
        return r.ok ? (r.ids[0] ?? null) : null;
      },
      close,
    };
  } catch (e) {
    await close();
    return { ok: false, error: `Tarsee couldn't be set up for the check: ${e.message}` };
  }
}

/** { reply, tool, shell, resume }: verify-model's checks map (true passed, false failed, null not run). */
function checksOf(result) {
  const checks = result?.checks && typeof result.checks === "object" && !Array.isArray(result.checks) ? result.checks : {};
  const map = {};
  for (const step of STEPS) map[step] = typeof checks[step] === "boolean" ? checks[step] : null;
  return map;
}

function jsonRow(r, clean) {
  const res = r.result || {};
  return {
    provider: r.provider,
    model: r.model,
    credential: r.credential,
    ok: !r.skipped && res.ok === true,
    skipped: !!r.skipped,
    engine: res.engine ?? null,
    engineVersion: res.engineVersion ?? res.entry?.engineVersion ?? null,
    at: res.entry?.at ?? null,
    checks: checksOf(res),
    efforts: Array.isArray(res.efforts) ? res.efforts : [],
    seconds: r.seconds ?? null,
    error: r.skipped ? r.skip : (res.ok ? null : clean(String(res.error || "failed"))),
  };
}

function table(results, clean) {
  const mark = (v) => (v === true ? "ok" : v === false ? "FAIL" : "-");
  const head = ["AI", "Model", "Engine", "Reply", "Tool", "Shell", "Resume", "Efforts", "Time", "Result"];
  const rows = results.map((r) => {
    const res = r.result || {};
    const checks = checksOf(res);
    const why = r.skipped ? `skipped: ${r.skip}` : res.ok ? "passed" : clean(String(res.error || "failed"));
    return [
      r.provider,
      r.model || "(default)",
      res.engine || "-",
      ...STEPS.map((s) => mark(checks[s])),
      res.efforts?.length ? res.efforts.join(",") : "-",
      r.seconds != null ? `${r.seconds}s` : "-",
      why.length > 120 ? `${why.slice(0, 117)}...` : why,
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join("  ");
  // The last column's rule is as wide as its heading: a long run of dashes reads as a secret to the redactor.
  const rule = widths.map((w, i) => "-".repeat(i === widths.length - 1 ? head[i].length : w));
  return `${[line(head), line(rule), ...rows.map(line)].join("\n")}\n`;
}

/** Every credential-looking value in the environment, longest first, so no output can carry one. */
function secretValues(env) {
  const names = new Set([...PROVIDER_IDS.flatMap((id) => (PROVIDERS[id].envKey ? [PROVIDERS[id].envKey] : [])), ...PLAN_ENV,
    "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID", "ENCRYPTION_KEY", "SETUP_PASSWORD", "TARSEE_API_TOKEN"]);
  const values = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value !== "string") continue;
    const v = value.trim();
    if (v.length < 6) continue;
    if (names.has(name) || /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) values.push(v);
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function scrub(text, secrets) {
  let s = String(text);
  for (const v of secrets) s = s.split(v).join("[hidden]");
  return redactSecrets(s);
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(redactSecrets(`smoke-backends failed: ${e?.stack || e}\n`));
    process.exitCode = 2;
  });
}
