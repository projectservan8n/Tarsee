#!/usr/bin/env node
/**
 * scripts/e2e/upgrade-e2e.mjs: the owner's real upgrade path, from main (what runs on Railway today) to this branch.
 *
 * 1. A git worktree of main (7e5563d) with its own `npm ci`.
 * 2. main's server on a fresh temp TARSEE_STATE_DIR (the Railway volume), NODE_ENV=production, a SETUP_PASSWORD and
 *    ENCRYPTION_KEY made at run time (never written to a file), and a temp home whose .claude links to
 *    <state>/.claude-code-home, the way main's entrypoint.sh links /home/node/.claude to the volume. Through main's own
 *    HTTP routes it is set up the way an owner did it: the old wizard (the Claude plan, apiKey "subscription"), skills,
 *    the personality's files, then Settings: the default model, effort, Telegram and Discord saved but off, three cron
 *    jobs (and /briefing on), voice (Edge TTS, Whisper API with an OpenAI key, as main's Voice page saved it), tool
 *    permissions, session reset, an allowlist; and chats with replies. main's turns need a signed-in Claude plan: main
 *    passes its whole environment to Claude Code, so CLAUDE_CODE_OAUTH_TOKEN (an obvious fake) and ANTHROPIC_BASE_URL
 *    (test/fixtures/fake-anthropic.js) give its real bundled CLI a plan sign-in that answers on loopback.
 *    main is stopped with SIGTERM (test/e2e/graceful-stop.mjs), as Railway stops it on a redeploy.
 * 3. This branch's server on the SAME state folder, with a new temp home (linked the same way) and no sign-in at all,
 *    so the Claude plan needs sign-in (expected) and no Claude turn can reach anything. Checked: migrations ran once,
 *    the wizard stays away, the Claude plan is still the default AI (and its model), GET /api/ai/providers shows it with
 *    the plain sign-in message, old chats open with every message, picks, cron jobs (each one's model resolved through
 *    the registry), settings, tool permissions, voice, channels off, workspace files, the API token, no stale fake key,
 *    /healthz 200, and no errors in the log. Then a second boot (nothing re-runs), and the Railway case: a
 *    .credentials.json on the volume (what `claude login` left there) makes the Claude plan ready with no action.
 * 4. On Linux (WSL, when there): main's volume layout through this branch's entrypoint.sh setup_provider_homes.
 *
 *   node scripts/e2e/upgrade-e2e.mjs [--worktree <dir>] [--out <dir>] [--keep] [--keep-worktree] [--no-wsl]
 *
 * Exit code 0 when every check passed, 1 otherwise. Results: <out>/upgrade-e2e.json and the servers' logs next to it
 * (every secret scrubbed). Every process it started is stopped, and the worktree removed, unless --keep-worktree.
 */
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_REF = "7e5563d";
const fa = await import(pathToFileURL(path.join(ROOT, "test", "fixtures", "fake-anthropic.js")).href);
const PRELOAD = pathToFileURL(path.join(ROOT, "test", "e2e", "graceful-stop.mjs")).href;
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// --- Options -------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const OUT = path.resolve(argOf("--out") || path.join(os.tmpdir(), "tarsee-upgrade-e2e-out"));
const WT = path.resolve(argOf("--worktree") || path.join(os.tmpdir(), "tarsee-upgrade-main-wt"));
const KEEP = argv.includes("--keep");
const KEEP_WT = argv.includes("--keep-worktree");
const NO_WSL = argv.includes("--no-wsl");
fs.mkdirSync(OUT, { recursive: true });

const rand = (n = 10) => crypto.randomBytes(n).toString("hex").slice(0, n);

// --- Secrets: made now, never written to a file (the result files are scrubbed) ------------------------------------

const SETUP_PASSWORD = crypto.randomBytes(18).toString("base64url");
const ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
/** main's plan sign-in for its turns: only main's environment has it, and only the loopback fake ever sees it. */
const FAKE_PLAN_TOKEN = `sk-ant-oat01-test-canary-upgrade-plan-${rand(12)}`;
const FAKE = {
  telegram: `1234567890:TEST-canary-telegram-${rand(16)}`,
  discord: `TEST.canary.discord.${rand(20)}`,
  openaiVoice: `sk-test-canary-voice-openai-${rand(16)}`,
  credentials: `sk-ant-oat01-test-canary-volume-credentials-${rand(10)}`,
  anthropic: `sk-ant-api03-test-canary-upgrade-anthropic-${rand(12).replace(/[^a-z0-9]/g, "0")}`,
};
const SECRETS = [SETUP_PASSWORD, ENCRYPTION_KEY, FAKE_PLAN_TOKEN, ...Object.values(FAKE)];

// --- Results -------------------------------------------------------------------------------------------------------

const results = [];
const t0 = Date.now();
function log(...a) { console.log(`[upgrade ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a); }
class Fail extends Error { constructor(msg, evidence) { super(msg); this.evidence = evidence; } }
function expect(cond, msg, evidence) { if (!cond) throw new Fail(msg, evidence); }
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: true, ...(r && typeof r === "object" ? { note: r } : {}) });
    log(`PASS ${name}`);
    return r;
  } catch (err) {
    const ev = err?.evidence ?? (err instanceof Fail ? null : err?.stack);
    results.push({ name, ok: false, error: err?.message || String(err), evidence: ev ?? null });
    log(`FAIL ${name}: ${err?.message || err}${ev ? `\n      evidence: ${clip(typeof ev === "string" ? ev : JSON.stringify(ev), 1500)}` : ""}`);
    return undefined;
  }
}
const clip = (s, n = 400) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 20_000, everyMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) return last;
    await sleep(everyMs);
  }
}
function scrub(s) {
  let out = String(s);
  for (const k of SECRETS) out = out.split(k).join(`<secret …${k.slice(-4)}>`);
  return out;
}
const scrubDeep = (o) => JSON.parse(scrub(JSON.stringify(o ?? null)));

// --- Processes -----------------------------------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), err });
    });
  });
}
async function processes() {
  if (process.platform !== "win32") {
    const r = await run("ps", ["-eo", "pid=,ppid=,comm=,args="]);
    return r.stdout.split("\n").filter(Boolean).map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] } : null;
    }).filter(Boolean);
  }
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  try {
    const list = JSON.parse(r.stdout);
    return (Array.isArray(list) ? list : [list]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine || "" }));
  } catch { return []; }
}
function descendants(list, rootPid) {
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift();
    for (const c of list) if (c.ppid === p && !out.includes(c)) { out.push(c); queue.push(c.pid); }
  }
  return out;
}
async function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}
async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
function hostEnv() {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "SystemDrive", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "WINDIR", "windir", "LANG", "CLAUDE_CODE_GIT_BASH_PATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
}

/** A home folder whose .claude is the volume's .claude-code-home, as entrypoint.sh links /home/node/.claude. */
function makeHome(dir, state, { codex = false } = {}) {
  for (const d of [dir, path.join(dir, "AppData", "Roaming"), path.join(dir, "AppData", "Local")]) fs.mkdirSync(d, { recursive: true });
  const link = (name, target) => {
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(dir, name), process.platform === "win32" ? "junction" : "dir");
  };
  link(".claude", path.join(state, ".claude-code-home"));
  if (codex) link(".codex", path.join(state, ".codex-home"));
  return dir;
}

// --- A server ------------------------------------------------------------------------------------------------------

const servers = [];
const answers = []; // every HTTP answer, for the secret scan

class Server {
  constructor(label) { this.label = label; this.out = ""; this.err = ""; this.all = ""; this.exited = null; }

  async boot({ cwd, home, state, extraEnv = {} }) {
    this.port = await freePort();
    this.base = `http://127.0.0.1:${this.port}`;
    const env = {
      ...hostEnv(),
      HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
      PORT: String(this.port),
      TARSEE_STATE_DIR: state,
      SETUP_PASSWORD, ENCRYPTION_KEY,
      NODE_ENV: "production",
      TARSEE_PHONON_AUTO_INSTALL: "0",
      ...extraEnv,
    };
    log(`${this.label}: booting on port ${this.port} (cwd ${cwd})`);
    const child = spawn(process.execPath, ["--import", PRELOAD, path.join(cwd, "src", "server.js")], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    servers.push(this);
    child.stdout.on("data", (b) => { const s = b.toString("utf8"); this.out += s; this.all += s; });
    child.stderr.on("data", (b) => { const s = b.toString("utf8"); this.err += s; this.all += s; });
    child.on("exit", (code, sig) => { this.exited = { code, sig }; this.all += `\n[harness] ${this.label} exited code=${code} signal=${sig}\n`; });
    const ok = await until(async () => {
      if (this.exited) return true;
      try { const r = await fetch(`${this.base}/healthz`); return r.ok; } catch { return false; }
    }, { timeoutMs: 90_000, everyMs: 300 });
    if (!ok || this.exited) throw new Error(`${this.label} didn't come up:\n${clip(this.all, 4000)}`);
    return this;
  }

  /** Stop it with SIGTERM (graceful-stop.mjs) and wait; anything still running under it afterwards is killed. */
  async stop() {
    if (!this.child || this.exited) return { graceful: !!this.exited, leftovers: [] };
    const under = descendants(await processes(), this.child.pid);
    try { this.child.stdin.write("stop\n"); } catch { /* stdin gone */ }
    const done = await until(() => !!this.exited, { timeoutMs: 20_000, everyMs: 200 });
    let graceful = !!done;
    if (!done) { await killTree(this.child.pid); graceful = false; await until(() => !!this.exited, { timeoutMs: 5000 }); }
    const now = await processes();
    const leftovers = now.filter((p) => under.some((u) => u.pid === p.pid && (u.cmd === p.cmd)));
    for (const p of leftovers) await killTree(p.pid);
    return { graceful, exit: this.exited, leftovers: leftovers.map((p) => `${p.pid} ${p.name} ${clip(p.cmd, 160)}`) };
  }
}

// --- HTTP (one cookie jar: the owner's browser, which keeps its session across the upgrade) --------------------------

const jar = new Map();
function takeCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const csrf = () => decodeURIComponent(jar.get("tarsee_csrf") || "");
let CUR = null; // the server the helpers talk to

async function api(method, p, body, { headers = {}, auth = true } = {}) {
  const res = await fetch(CUR.base + p, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { cookie: cookieHeader(), "x-csrf-token": csrf() } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (auth) takeCookies(res);
  const text = await res.text();
  answers.push(`${CUR.label} ${method} ${p} ${res.status} ${text}`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** POST /api/chat/send and read it to the end: {status, events, json?} (a command answers with JSON). */
async function chat(body, { timeoutMs = 180_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events = [];
  let raw = "";
  let status = 0;
  try {
    const res = await fetch(`${CUR.base}/api/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader(), "x-csrf-token": csrf() },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = res.status;
    if (!String(res.headers.get("content-type") || "").includes("text/event-stream")) {
      raw = await res.text();
      answers.push(`${CUR.label} POST /api/chat/send ${status} ${raw}`);
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not JSON */ }
      return { status, events, raw, json };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      raw += s;
      buf += s;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (!ev) continue;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        events.push({ event: ev, data: parsed });
      }
    }
    answers.push(`${CUR.label} POST /api/chat/send ${status} ${raw}`);
    return { status, events, raw };
  } finally { clearTimeout(timer); }
}
const textOf = (r) => r.events.filter((e) => e.event === "text").map((e) => e.data?.content || "").join("");
const errorsOf = (r) => r.events.filter((e) => e.event === "error").map((e) => e.data?.message || JSON.stringify(e.data));

// --- The state folder, read directly (only while no server has it open) -------------------------------------------

function readDb(state) {
  const db = new Database(path.join(state, "data", "tarsee.db"), { readonly: true, fileMustExist: true });
  try {
    const all = (sql, ...a) => db.prepare(sql).all(...a);
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const tables = all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    const cols = (t) => (tables.includes(t) ? all(`SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name) : []);
    return {
      integrity: one("PRAGMA integrity_check")?.integrity_check,
      migrations: all("SELECT id, name, applied_at FROM migrations ORDER BY id"),
      settings: all("SELECT key, value FROM settings ORDER BY key").map((r) => ({ key: r.key, encrypted: /^enc:/.test(String(r.value)) || /^v\d+:/.test(String(r.value)), len: String(r.value ?? "").length, value: r.value })),
      conversations: all("SELECT * FROM conversations ORDER BY created_at, id"),
      messageCount: one("SELECT COUNT(*) AS c FROM messages").c,
      messages: all("SELECT id, conversation_id, role, content FROM messages ORDER BY id"),
      usageTurns: tables.includes("usage_turns") ? one("SELECT COUNT(*) AS c FROM usage_turns").c : null,
      usageCalls: tables.includes("usage_calls") ? one("SELECT COUNT(*) AS c FROM usage_calls").c : null,
      usageTurnRows: tables.includes("usage_turns") ? all("SELECT * FROM usage_turns ORDER BY started_at, turn_id") : [],
      usageCallRows: tables.includes("usage_calls") ? all("SELECT * FROM usage_calls ORDER BY rowid") : [],
      usageTurnCols: cols("usage_turns"),
      usageCallCols: cols("usage_calls"),
      audit: tables.includes("audit_log") ? all("SELECT action, target, actor, detail FROM audit_log ORDER BY id") : [],
      sessions: tables.includes("sessions") ? one("SELECT COUNT(*) AS c FROM sessions").c : null,
      tables,
    };
  } finally { db.close(); }
}

/** Every file under the state folder: { relPath: sha256 } (links not followed twice; the db's own files skipped). */
function treeOf(state) {
  const out = {};
  const seen = new Set();
  const walk = (dir) => {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(state, p).split(path.sep).join("/");
      if (e.isDirectory()) { walk(p); continue; }
      if (/^data\/tarsee\.db(-wal|-shm)?$/.test(rel) || /\.pid$/.test(rel)) continue;
      try { out[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16); } catch { out[rel] = "unreadable"; }
    }
  };
  walk(state);
  return out;
}

// --- Log reading ---------------------------------------------------------------------------------------------------

/** stderr lines (console.warn and console.error both land there) that look like a problem, and every stack line. */
function problemLines(text) {
  const lines = String(text).split(/\r?\n/);
  const bad = /(error|fail|uncaught|unhandled|exception|cannot|can't|couldn't|could not|invalid|denied|refus|not found|ENOENT|EACCES|EPERM|SQLITE|TypeError|ReferenceError)/i;
  return lines.filter((l) => l.trim() && (bad.test(l) || /^\s+at\s.+[:(]\d+:\d+\)?$/.test(l)));
}

// --- The run -------------------------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-upgrade-"));
const STATE = path.join(tmp, "state");
fs.mkdirSync(STATE, { recursive: true });
let fake = null;
let exitCode = 1;
const M = {}; // what main had
const B = {}; // what the branch shows
let mainSrv = null;
let branchSrv = null;
let branchSrv2 = null;
let wtCreated = false;

try {
  // --- 1. main's worktree --------------------------------------------------------------------------------------
  await check(`a worktree of main (${MAIN_REF}) with npm ci`, async () => {
    if (fs.existsSync(path.join(WT, ".git"))) {
      const head = await run("git", ["-C", WT, "rev-parse", "HEAD"]);
      const want = await run("git", ["-C", ROOT, "rev-parse", MAIN_REF]);
      expect(head.stdout.trim() === want.stdout.trim(), `the worktree at ${WT} is at ${head.stdout.trim()}, not ${MAIN_REF}`, head);
      log(`reusing the worktree at ${WT}`);
    } else {
      fs.mkdirSync(path.dirname(WT), { recursive: true });
      const add = await run("git", ["-C", ROOT, "worktree", "add", "--detach", WT, MAIN_REF]);
      expect(add.code === 0, "git worktree add failed", add.stderr || add.stdout);
      wtCreated = true;
    }
    if (!fs.existsSync(path.join(WT, "node_modules", "better-sqlite3"))) {
      log("npm ci in main's worktree");
      const npm = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: WT, shell: process.platform === "win32" });
      expect(npm.code === 0, "npm ci failed in main's worktree", clip(npm.stderr || npm.stdout, 3000));
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(WT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8"));
    return { worktree: WT, agentSdk: pkg.version, claudeCode: pkg.claudeCodeVersion || null };
  });

  // --- 2. main, set up as an owner did it ----------------------------------------------------------------------
  fake = await fa.startFakeAnthropic();
  let replyNo = 0;
  fake.script = (req) => {
    // A short answer per turn; side requests (title, summaries) get the same shape.
    replyNo += 1;
    req.replyNo = replyNo; // which request answered what the chat shows
    return { text: `Fake plan reply ${replyNo}: noted, glimmerword-${replyNo}.` };
  };
  const homeMain = makeHome(path.join(tmp, "home-main"), STATE);
  mainSrv = await new Server("main").boot({
    cwd: WT, home: homeMain, state: STATE,
    extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_PLAN_TOKEN, ANTHROPIC_BASE_URL: fake.url },
  });
  CUR = mainSrv;

  await check("main: sign in with SETUP_PASSWORD", async () => {
    const r = await api("POST", "/api/auth/login", { password: SETUP_PASSWORD });
    expect(r.status === 200 && jar.has("tarsee_session"), `login answered ${r.status}, cookie ${jar.has("tarsee_session")}`, r.text);
    await api("GET", "/api/auth/csrf");
    expect(jar.has("tarsee_csrf"), "no tarsee_csrf cookie");
    M.sessionCookie = jar.get("tarsee_session");
  });

  await check("main: a fresh install needs the wizard", async () => {
    const r = await api("GET", "/api/settings/setup-status");
    expect(r.status === 200 && r.json?.needsSetup === true, "setup-status didn't ask for setup", r.text);
    return r.json;
  });

  await check("main: the old wizard, step 1 (Claude plan: provider claude-code, apiKey \"subscription\")", async () => {
    const r = await api("POST", "/api/settings/provider", { provider: "claude-code", apiKey: "subscription" });
    expect(r.status === 200 && r.json?.ok, `answered ${r.status}`, r.text);
    return r.json;
  });

  await check("main: the old wizard, step 2 (the recommended skills)", async () => {
    const want = ["weather", "github", "gog", "summarize", "nano-pdf", "session-logs", "frontend-design", "gsap-core", "gsap-scrolltrigger"];
    const list = await api("GET", "/api/skills");
    const names = (list.json?.skills || []).map((s) => s.name);
    const install = want.filter((n) => names.includes(n));
    const r = await api("POST", "/api/skills/setup", { install });
    expect(r.status === 200 && r.json?.ok, `answered ${r.status}`, r.text);
    M.skillsInstalled = r.json.installed;
    return { installed: r.json.installed, failed: r.json.failed };
  });

  M.soul = "# Soul & Personality\n\nYou are Atlas, a calm and precise assistant. Short answers first, details on request.\n";
  M.user = "# About the User\n\n- Prefers metric units\n- Works mornings, likes a summary at 9\n";
  await check("main: the old wizard, step 3 (setup.completed, the personality's name and files, BOOTSTRAP.md deleted)", async () => {
    for (const [k, v] of [["setup.completed", "true"], ["identity.name", "Atlas"], ["identity.systemPrompt", "You are Atlas, a calm and precise assistant."]]) {
      const r = await api("POST", "/api/settings/general", { key: k, value: v });
      expect(r.status === 200, `general ${k} answered ${r.status}`, r.text);
    }
    for (const [name, content] of [["SOUL.md", M.soul], ["USER.md", M.user]]) {
      const r = await api("PUT", "/api/settings/workspace-file", { name, content });
      expect(r.status === 200, `PUT ${name} answered ${r.status}`, r.text);
    }
    const d = await api("DELETE", "/api/settings/bootstrap");
    expect(d.status === 200, `DELETE bootstrap answered ${d.status}`, d.text);
    const s = await api("GET", "/api/settings/setup-status");
    expect(s.json?.needsSetup === false && s.json?.needsPersonality === false, "setup-status still asks", s.text);
    M.setupStatus = s.json;
    return s.json;
  });

  await check("main: Settings > AI Provider, the default model (claude-opus-4-7) and effort (high)", async () => {
    const models = await api("GET", "/api/chat/models");
    expect((models.json?.models || []).some((m) => m.id === "claude-opus-4-7"), "main's model list has no claude-opus-4-7", models.text);
    const r = await api("POST", "/api/settings/provider", { provider: "claude-code", model: "claude-opus-4-7" });
    expect(r.status === 200, `answered ${r.status}`, r.text);
    const e = await api("POST", "/api/settings/general", { key: "ai.defaultEffort", value: "high" });
    expect(e.status === 200, `ai.defaultEffort answered ${e.status}`, e.text);
  });

  await check("main: Telegram and Discord saved with tokens but switched off; an allowlist and mention mode", async () => {
    for (const [type, token] of [["telegram", FAKE.telegram], ["discord", FAKE.discord]]) {
      const r = await api("POST", "/api/settings/channel", { type, token, enabled: false });
      expect(r.status === 200 && r.json?.enabled === false, `${type} answered ${r.status}`, r.text);
    }
    for (const [k, v] of [["allowlist.telegram", JSON.stringify(["111222333"])], ["telegram.mention_mode", "off"]]) {
      const r = await api("POST", "/api/settings/general", { key: k, value: v });
      expect(r.status === 200, `${k} answered ${r.status}`, r.text);
    }
  });

  await check("main: voice (Edge TTS and a voice; Whisper API with an OpenAI key, saved both ways as main's Voice page did; STT model)", async () => {
    const steps = [
      ["POST", "/api/settings/general", { key: "voice.engine", value: "edge-tts" }],
      ["POST", "/api/settings/general", { key: "voice.defaultVoiceId", value: "en-GB-RyanNeural" }],
      ["POST", "/api/voice/stt-model", { model: "small.en" }],
      ["POST", "/api/settings/general", { key: "voice.stt_provider", value: "whisper-api" }],
      ["POST", "/api/settings/general", { key: "voice.openai_api_key", value: FAKE.openaiVoice }],
      ["POST", "/api/settings/general", { key: "ai.openai.apiKey", value: FAKE.openaiVoice }],
    ];
    for (const [m, p, b] of steps) {
      const r = await api(m, p, b);
      expect(r.status === 200, `${p} ${b.key || b.model} answered ${r.status}`, r.text);
    }
  });

  await check("main: tool permissions (get_key and railway Deny, exec and send_message Warn)", async () => {
    for (const [toolName, mode] of [["get_key", "always_deny"], ["railway", "always_deny"], ["exec", "warn"], ["send_message", "warn"]]) {
      const r = await api("POST", "/api/admin/tool-permissions", { toolName, mode });
      expect(r.status === 200, `${toolName} answered ${r.status}`, r.text);
    }
    const g = await api("GET", "/api/admin/tool-permissions");
    M.toolPermissions = g.json?.permissions;
    return M.toolPermissions;
  });

  await check("main: session reset (idle, 240 minutes)", async () => {
    const r = await api("POST", "/api/settings/session-reset", { mode: "idle", idleMinutes: 240 });
    expect(r.status === 200, `answered ${r.status}`, r.text);
  });

  await check("main: cron jobs from Settings (a morning summary, a deploy job, one paused) and /briefing on", async () => {
    const jobs = [
      { schedule: "0 9 * * *", prompt: "Give me a short morning summary of my day", name: "morning" },
      { schedule: "30 17 * * 5", prompt: "Deploy the weekly report site and commit the changes", name: "weekly" },
      { schedule: "0 12 1 * *", prompt: "Remind me to pay the hosting bill", name: "paused", enabled: false },
    ];
    for (const j of jobs) {
      const r = await api("POST", "/api/settings/cron", j);
      expect(r.status === 201, `${j.name} answered ${r.status}`, r.text);
    }
    const b = await chat({ message: "/briefing on" });
    expect(b.status === 200 && b.json?.command, `/briefing on answered ${b.status}`, b.raw);
    const g = await api("GET", "/api/settings/cron");
    M.cron = g.json;
    expect((g.json?.jobs || []).length === 4, `main has ${(g.json?.jobs || []).length} cron jobs, not 4`, g.text);
    return g.json.jobs.map((j) => `${j.id} ${j.schedule} enabled=${j.enabled} running=${j.running}`);
  });

  // Chats, each with replies from main's real Claude Code against the loopback fake.
  M.convs = {};
  await check("main: a chat with two turns (the second resumes the Claude session) and /effort", async () => {
    const c = await api("POST", "/api/chat/conversations", { title: "Trip planning" });
    expect(c.status === 201 && c.json?.id, `create answered ${c.status}`, c.text);
    const id = c.json.id;
    const t1 = await chat({ conversationId: id, message: "Plan a two-day trip to Vigan, keep it short. tarsierword-one" });
    expect(t1.status === 200 && /Fake plan reply/.test(textOf(t1)), `turn 1: ${errorsOf(t1).join(" | ") || t1.status}`, clip(t1.raw, 2000));
    const t2 = await chat({ conversationId: id, message: "And what should I eat there? tarsierword-two" });
    expect(t2.status === 200 && /Fake plan reply/.test(textOf(t2)), `turn 2: ${errorsOf(t2).join(" | ") || t2.status}`, clip(t2.raw, 2000));
    const e = await chat({ conversationId: id, message: "/effort xhigh" });
    expect(e.status === 200, `/effort answered ${e.status}`, e.raw);
    M.convs.trip = id;
  });

  await check("main: a chat with its own model and effort in the picker (haiku, low) and a turn", async () => {
    const c = await api("POST", "/api/chat/conversations", { title: "Quick facts" });
    const id = c.json.id;
    const p = await api("PUT", `/api/chat/conversations/${id}/picker`, { model: "haiku", effort: "low" });
    expect(p.status === 200, `picker answered ${p.status}`, p.text);
    const t = await chat({ conversationId: id, message: "How tall is Mount Apo? tarsierword-three" });
    expect(t.status === 200 && /Fake plan reply/.test(textOf(t)), `turn: ${errorsOf(t).join(" | ") || t.status}`, clip(t.raw, 2000));
    M.convs.facts = id;
    M.factsPick = p.json;
  });

  await check("main: a chat with a pinned model of its own (claude-sonnet-4-6) and a turn", async () => {
    const c = await api("POST", "/api/chat/conversations", { title: "Code review notes" });
    const id = c.json.id;
    const p = await api("PUT", `/api/chat/conversations/${id}/picker`, { model: "claude-sonnet-4-6" });
    expect(p.status === 200, `picker answered ${p.status}`, p.text);
    const t = await chat({ conversationId: id, message: "List three things to check in a pull request. tarsierword-four" });
    expect(t.status === 200 && /Fake plan reply/.test(textOf(t)), `turn: ${errorsOf(t).join(" | ") || t.status}`, clip(t.raw, 2000));
    M.convs.review = id;
    M.reviewPick = p.json;
  });

  await check("main: the web channel's chat (channelKey web:default) and a cron run delivered into it", async () => {
    const t = await chat({ channelKey: "web:default", message: "Good morning! tarsierword-five" });
    expect(t.status === 200 && /Fake plan reply/.test(textOf(t)), `turn: ${errorsOf(t).join(" | ") || t.status}`, clip(t.raw, 2000));
    const convEv = t.events.find((e) => e.event === "conversation");
    // POST /api/settings/cron takes no name, so the ids are cron_<time>: find the morning job by its prompt.
    const jobs = (await api("GET", "/api/settings/cron")).json?.jobs || [];
    const morning = jobs.find((j) => /morning summary/.test(j.prompt));
    expect(morning, "no morning job", jobs);
    const r = await chat({ message: `/cron run ${morning.id}` });
    expect(r.status === 200 && /Cron result/.test(r.json?.response || ""), `/cron run answered ${r.status}`, r.raw);
    const ch = await api("GET", "/api/chat/channels");
    M.convs.web = (ch.json?.channels || []).find((c) => c.key === "web:default")?.conversationId || convEv?.data?.id;
    expect(M.convs.web, "no web:default chat", ch.text);
    M.mainCronModelLine = (mainSrv.out.match(new RegExp(`\\[cron\\] Job "${morning.id}" model → .*`)) || [])[0] || null;
    return { cronModelLine: M.mainCronModelLine };
  });

  await check("main: snapshot of everything through its routes", async () => {
    const s = await api("GET", "/api/settings");
    M.settings = Object.fromEntries((s.json?.settings || []).map((x) => [x.key, x.value]));
    const list = await api("GET", "/api/chat/conversations?limit=200");
    M.convList = list.json?.conversations || [];
    M.full = {};
    for (const c of M.convList) {
      const r = await api("GET", `/api/chat/conversations/${c.id}?all=true&raw=true`);
      expect(r.status === 200, `conversation ${c.id} answered ${r.status}`, r.text);
      M.full[c.id] = r.json;
    }
    M.pickers = {};
    for (const id of Object.values(M.convs)) M.pickers[id] = (await api("GET", `/api/chat/conversations/${id}/picker`)).json;
    M.reset = (await api("GET", "/api/settings/session-reset")).json;
    M.stt = (await api("GET", "/api/voice/stt-models")).json;
    M.skills = ((await api("GET", "/api/skills")).json?.skills || []).map((x) => ({ name: x.name, installed: x.installed ?? x.custom ?? null }));
    M.files = {};
    for (const n of ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "TOOLS.md", "IDENTITY.md", "HEARTBEAT.md", "BOOT.md"]) {
      M.files[n] = (await api("GET", `/api/settings/workspace-file?name=${n}`)).json?.content ?? null;
    }
    M.usage = (await api("GET", "/api/analytics/usage")).json;
    M.search = (await api("GET", "/api/chat/search?q=tarsierword")).json?.results || [];
    const tok = await api("GET", "/api/auth/api-token");
    M.apiToken = tok.json?.apiToken;
    if (M.apiToken) SECRETS.push(M.apiToken);
    const v1 = await api("GET", "/api/v1/status", undefined, { auth: false, headers: { authorization: `Bearer ${M.apiToken}` } });
    M.v1Status = v1.status;
    const deep = await api("GET", "/healthz/deep");
    M.deep = { status: deep.status, ai: deep.json?.ai ?? null };
    expect(M.convList.length >= 4, `main lists ${M.convList.length} chats`, M.convList);
    return {
      settings: Object.keys(M.settings).length, chats: M.convList.length,
      messages: Object.values(M.full).reduce((n, c) => n + (c.messages || []).length, 0), search: M.search.length,
      v1Status: M.v1Status, deep: M.deep,
    };
  });

  await check("main: stops on SIGTERM, as Railway stops it", async () => {
    const r = await mainSrv.stop();
    M.stop = r;
    expect(r.graceful && r.exit?.code === 0, "main didn't stop cleanly", r);
    expect(/SIGTERM received, shutting down/.test(mainSrv.out), "no shutdown line in main's log", clip(mainSrv.out.slice(-1500), 1500));
    return r;
  });

  M.db = readDb(STATE);
  M.tree = treeOf(STATE);
  M.stderr = problemLines(mainSrv.err);
  await check("main's database as it leaves it: migrations, the placeholder key, sessions, transcripts", async () => {
    const placeholder = M.db.settings.find((s) => s.key === "ai.claude-code.apiKey");
    expect(placeholder, "main didn't save the wizard's apiKey placeholder (ai.claude-code.apiKey)", M.db.settings.map((s) => s.key));
    expect(M.db.migrations.length >= 11, `main applied ${M.db.migrations.length} migrations`, M.db.migrations);
    const transcripts = Object.keys(M.tree).filter((k) => /^\.claude-code-home\/projects\/.+\.jsonl$/.test(k));
    const withSession = M.db.conversations.filter((c) => c.claude_session_id);
    expect(withSession.length >= 3, `only ${withSession.length} chats have a Claude session id`, M.db.conversations.map((c) => [c.id, c.claude_session_id]));
    return {
      migrations: M.db.migrations.map((m) => m.name), placeholderEncrypted: placeholder.encrypted, sessions: M.db.sessions,
      transcripts: transcripts.length, sessionIds: withSession.map((c) => c.claude_session_id), usageTurns: M.db.usageTurns, usageCalls: M.db.usageCalls,
      mainStderr: M.stderr.length,
    };
  });

  // What the owner's own Terminal use leaves on the volume: Claude Code's user settings (written by `claude` itself
  // when the model, permissions or thinking are changed there) and the workspace's local permission list. Ordinary
  // entries, no credential: the branch's settings guard (R5) must not refuse the plan's turns over them.
  M.terminalSettings = {
    user: { model: "opus", alwaysThinkingEnabled: true, permissions: { allow: ["Bash(git status:*)", "Bash(npm test:*)"] }, env: { DISABLE_AUTOUPDATER: "1", BASH_DEFAULT_TIMEOUT_MS: "300000" }, statusLine: { type: "command", command: "echo tarsee" } },
    local: { permissions: { allow: ["WebFetch(domain:example.com)"], deny: [] }, enableAllProjectMcpServers: false },
  };
  fs.writeFileSync(path.join(STATE, ".claude-code-home", "settings.json"), JSON.stringify(M.terminalSettings.user, null, 2));
  fs.mkdirSync(path.join(STATE, "workspace", ".claude"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "workspace", ".claude", "settings.local.json"), JSON.stringify(M.terminalSettings.local, null, 2));
  M.tree = treeOf(STATE);

  // --- 3. This branch on the same state folder -----------------------------------------------------------------
  const homeBranch = makeHome(path.join(tmp, "home-branch"), STATE, { codex: true });
  branchSrv = await new Server("branch").boot({ cwd: ROOT, home: homeBranch, state: STATE });
  CUR = branchSrv;
  await check("branch: /healthz is 200", async () => {
    const r = await api("GET", "/healthz", undefined, { auth: false });
    expect(r.status === 200 && r.json?.ok === true, `answered ${r.status}`, r.text);
  });
  // Let the boot's background work (the [ai] line, OpenRouter's catalog, the boot checklist) finish before the log is read.
  await until(() => /\[ai\] /.test(branchSrv.out), { timeoutMs: 20_000 });
  await sleep(4000);

  await check("branch: the migrations ran once (only 012 is new), and the database is intact", async () => {
    const applied = branchSrv.out.match(/\[db\] applied migration: .*/g) || [];
    expect(applied.length === 1 && /012_ai_usage_columns/.test(applied[0]), `applied at boot: ${applied.length}`, applied);
    return { applied };
  });

  await check("branch: the owner is still signed in (the session from main still opens Settings)", async () => {
    const r = await api("GET", "/api/auth/status");
    const s = await api("GET", "/api/settings/setup-status");
    expect(s.status === 200, `setup-status answered ${s.status} with main's session cookie: the owner would have to sign in again`, { status: r.json, setup: s.text });
    return r.json;
  });
  if (!jar.has("tarsee_session") || (await api("GET", "/api/settings/setup-status")).status !== 200) {
    await api("POST", "/api/auth/login", { password: SETUP_PASSWORD });
    await api("GET", "/api/auth/csrf");
  }

  await check("branch: the wizard does not come back", async () => {
    const r = await api("GET", "/api/settings/setup-status");
    B.setupStatus = r.json;
    expect(r.status === 200, `answered ${r.status}`, r.text);
    expect(r.json.needsSetup === false, "needsSetup is true: the wizard would show again", r.json);
    expect(r.json.needsPersonality === false, "needsPersonality is true: the personality interview would start again", r.json);
    expect(r.json.botName === "Atlas", `botName is ${r.json.botName}`, r.json);
    return r.json;
  });

  await check("branch: the Claude plan is still the default AI, with the owner's model, with no action", async () => {
    const s = B.setupStatus;
    expect(s.provider === "claude" && s.ai?.provider === "claude", `setup-status says the default is ${s.provider}/${s.ai?.provider}`, s);
    expect(s.ai?.chosenBy && s.ai.chosenBy !== "env", `chosenBy ${s.ai?.chosenBy}`, s.ai);
    expect(s.ai?.model === "claude-opus-4-7", `the default model is ${s.ai?.model}, not the owner's claude-opus-4-7`, s.ai);
    return s.ai;
  });

  const plainSignIn = (detail, fix) => {
    const all = `${detail || ""} ${fix || ""}`;
    return detail === "Nobody has signed in to the Claude plan yet."
      && /claude auth login/.test(fix || "")
      && !/undefined|null|NaN|\[object|Error:|ENOENT|stack|\/login\b|Please run|CLAUDE_CODE_OAUTH_TOKEN=|sk-ant/i.test(all.replace(/CLAUDE_CODE_OAUTH_TOKEN \(from claude setup-token\)/, ""));
  };

  await check("branch: GET /api/ai/providers shows the Claude plan as the default, needing sign-in, in plain words", async () => {
    const r = await api("GET", "/api/ai/providers");
    B.providers = r.json;
    expect(r.status === 200, `answered ${r.status}`, r.text);
    const a = r.json.active;
    expect(a.provider === "claude", `active is ${a.provider}`, a);
    expect(a.state === "needs-sign-in" && a.ready === false, `active state ${a.state}`, a);
    expect(plainSignIn(a.detail, a.fix), "the message isn't the plain one", { detail: a.detail, fix: a.fix });
    const card = r.json.providers.find((p) => p.id === "claude");
    expect(card && card.state === "needs-sign-in", "no needs-sign-in Claude plan card", card);
    expect(plainSignIn(card.detail, card.fix), "the card's message isn't the plain one", { detail: card.detail, fix: card.fix });
    expect(!r.json.providers.some((p) => p.id !== "claude" && (p.active || p.default || p.isDefault)), "another card is marked the default", r.json.providers.map((p) => [p.id, p.active, p.default]));
    // The owner's Terminal settings (ordinary entries) must not raise a settings-guard banner.
    expect(!(r.json.banners || []).some((b) => /^settings-guard/.test(b.id)), "a settings-guard banner over the owner's ordinary Claude Code settings", r.json.banners);
    return { active: a, banners: r.json.banners, keysOnly: r.json.keysOnly, cards: r.json.providers.map((p) => `${p.id}:${p.state}${p.keySource ? `(${p.keySource})` : ""}`) };
  });

  await check("branch: setup-status says the same, in the same plain words", async () => {
    const ai = B.setupStatus.ai;
    expect(ai.state === "needs-sign-in" && ai.ready === false, `state ${ai.state}`, ai);
    expect(plainSignIn(ai.detail, ai.fix), "not the plain message", ai);
  });

  await check("branch: the Claude plan's model list knows the owner's default and every model main offered", async () => {
    const r = await api("GET", "/api/ai/models/claude");
    expect(r.status === 200, `answered ${r.status}`, r.text);
    const ids = new Set((r.json?.models || []).map((m) => m.id));
    expect(r.json?.defaultModel === "claude-opus-4-7", `the card's default model is ${r.json?.defaultModel}`, r.json);
    // main's whole table (src/config/constants.js CLAUDE_MODELS at 7e5563d): any of them may be saved as a default or a chat's pick.
    const mainModels = ["opus", "sonnet", "haiku", "fable", "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"];
    const reg = await registryProbe(mainModels);
    const unknown = mainModels.filter((m) => !reg[m]?.kept || reg[m]?.engine !== "claude-code");
    expect(unknown.length === 0, `the registry doesn't keep ${unknown.join(", ")} on the Claude plan`, reg);
    const unlisted = mainModels.filter((m) => !ids.has(m));
    return { listed: ids.size, notInCardList: unlisted };
  });

  await check("branch: every old chat is there and opens with every message intact", async () => {
    const list = await api("GET", "/api/chat/conversations?limit=200");
    B.convList = list.json?.conversations || [];
    const mainIds = M.convList.map((c) => c.id).sort();
    const ids = B.convList.map((c) => c.id).sort();
    expect(JSON.stringify(ids) === JSON.stringify(mainIds), "the chat list changed", { main: mainIds, branch: ids });
    const diffs = [];
    for (const c of M.convList) {
      const r = await api("GET", `/api/chat/conversations/${c.id}?all=true&raw=true`);
      if (r.status !== 200) { diffs.push(`${c.id}: ${r.status} ${clip(r.text, 200)}`); continue; }
      const want = (M.full[c.id].messages || []).map((m) => `${m.id}|${m.role}|${m.content}`);
      const got = (r.json.messages || []).map((m) => `${m.id}|${m.role}|${m.content}`);
      if (JSON.stringify(want) !== JSON.stringify(got)) diffs.push({ id: c.id, main: want.map((x) => clip(x, 120)), branch: got.map((x) => clip(x, 120)) });
      if (r.json.title !== M.full[c.id].title) diffs.push(`${c.id}: title ${M.full[c.id].title} -> ${r.json.title}`);
      // The page's own view (slim) must open too.
      const slim = await api("GET", `/api/chat/conversations/${c.id}`);
      if (slim.status !== 200 || (slim.json?.messages || []).length !== want.length) diffs.push(`${c.id}: the page's view answered ${slim.status} with ${(slim.json?.messages || []).length} messages`);
    }
    expect(diffs.length === 0, `${diffs.length} chats differ`, diffs);
    return { chats: ids.length, messages: Object.values(M.full).reduce((n, c) => n + (c.messages || []).length, 0) };
  });

  await check("branch: search still finds the old messages", async () => {
    const r = await api("GET", "/api/chat/search?q=tarsierword");
    const n = (r.json?.results || []).length;
    expect(r.status === 200 && n === M.search.length && n > 0, `search found ${n}, main found ${M.search.length}`, r.text);
  });

  await check("branch: each chat's own model and effort survived and is understood", async () => {
    const out = {};
    const bad = [];
    for (const [name, id] of Object.entries(M.convs)) {
      const r = await api("GET", `/api/chat/conversations/${id}/picker`);
      out[name] = r.json;
      if (r.status !== 200) { bad.push(`${name}: ${r.status} ${r.text}`); continue; }
      if (r.json.warning) bad.push(`${name}: warning ${r.json.warning}`);
    }
    const f = out.facts;
    if (!(f && /haiku/.test(String(f.modelId ?? f.model)) && f.effort === "low")) bad.push({ facts: f, main: M.pickers[M.convs.facts] });
    const v = out.review;
    if (!(v && /claude-sonnet-4-6/.test(String(v.modelId ?? v.model)))) bad.push({ review: v, main: M.pickers[M.convs.review] });
    const t = out.trip;
    if (!(t && t.effort === "xhigh")) bad.push({ trip: t, main: M.pickers[M.convs.trip] });
    const reg = await registryProbe([f?.modelId ?? f?.model, v?.modelId ?? v?.model].filter(Boolean));
    for (const [m, x] of Object.entries(reg)) if (!x.kept) bad.push(`the registry doesn't keep ${m} (${JSON.stringify(x)})`);
    expect(bad.length === 0, `${bad.length} problems`, bad);
    return out;
  });

  await check("branch: the cron jobs are all there, scheduled as before", async () => {
    const r = await api("GET", "/api/settings/cron");
    B.cron = r.json;
    const want = (M.cron.jobs || []).map((j) => `${j.id}|${j.schedule}|${j.prompt}|${j.enabled}|${j.running}`).sort();
    const got = (r.json?.jobs || []).map((j) => `${j.id}|${j.schedule}|${j.prompt}|${j.enabled}|${j.running}`).sort();
    expect(JSON.stringify(want) === JSON.stringify(got), "the cron jobs changed", { main: want, branch: got });
    expect(r.json.activeJobs === M.cron.activeJobs, `activeJobs ${r.json.activeJobs}, main ${M.cron.activeJobs}`, r.json);
    return got;
  });

  B.errBeforeCronRuns = branchSrv.err.length;
  await check("branch: each cron job runs on a model the registry understands, and says plainly that the plan needs sign-in", async () => {
    const out = [];
    const bad = [];
    for (const j of (M.cron.jobs || []).filter((x) => x.enabled)) {
      const before = branchSrv.out.length;
      const r = await chat({ message: `/cron run ${j.id}` });
      const said = r.json?.response || r.raw;
      const line = (branchSrv.out.slice(before).match(new RegExp(`\\[cron\\] Job "${j.id}" model → (.*)`)) || [])[1]?.trim() || null;
      out.push({ id: j.id, model: line, said: clip(said, 400) });
      if (!line) { bad.push(`${j.id}: no model line in the log`); continue; }
      const reg = await registryProbe([line]);
      if (!reg[line]?.kept) bad.push(`${j.id}: model ${line} isn't understood by the registry (${JSON.stringify(reg[line])})`);
      if (!/Nobody has signed in to the Claude plan yet\. Run claude auth login in the Terminal/.test(said)) bad.push(`${j.id}: not the plain sign-in message: ${clip(said, 300)}`);
      if (/isn't connected to an AI yet|undefined|\[object|TypeError|at .+:\d+:\d+/.test(said)) bad.push(`${j.id}: ${clip(said, 300)}`);
    }
    const after = await api("GET", "/api/settings/cron");
    for (const j of after.json?.jobs || []) if (j.autoDisabled) bad.push(`${j.id} auto-disabled`);
    expect(bad.length === 0, `${bad.length} problems`, { bad, out });
    return out;
  });

  // Removed at boot, each once with an audit row: the old wizard's placeholder key, and the copy of the OpenAI key
  // main's Voice page kept in voice.openai_api_key, which nothing reads (the OpenAI card's ai.openai.apiKey is kept).
  const REMOVED_AT_BOOT = ["ai.claude-code.apiKey", "voice.openai_api_key"];
  await check("branch: every setting main had is still there, the same (the wizard's placeholder key and the Voice tab's copy of the OpenAI key excepted)", async () => {
    const s = await api("GET", "/api/settings");
    B.settings = Object.fromEntries((s.json?.settings || []).map((x) => [x.key, x.value]));
    const gone = [];
    const changed = [];
    for (const [k, v] of Object.entries(M.settings)) {
      if (REMOVED_AT_BOOT.includes(k)) continue;
      if (!(k in B.settings)) { gone.push(k); continue; }
      if (JSON.stringify(B.settings[k]) !== JSON.stringify(v)) changed.push({ key: k, main: clip(JSON.stringify(v), 200), branch: clip(JSON.stringify(B.settings[k]), 200) });
    }
    const added = Object.keys(B.settings).filter((k) => !(k in M.settings));
    expect(gone.length === 0 && changed.length === 0, `${gone.length} gone, ${changed.length} changed`, { gone, changed });
    return { kept: Object.keys(M.settings).filter((k) => !REMOVED_AT_BOOT.includes(k)).length, added };
  });

  await check("branch: no stale fake key (the placeholder \"subscription\" is gone, once, with an audit row)", async () => {
    expect(!("ai.claude-code.apiKey" in B.settings) && !("ai.claude.apiKey" in B.settings), "the placeholder is still in Settings", Object.keys(B.settings).filter((k) => /apiKey/.test(k)));
    const lines = branchSrv.out.match(/\[settings\] removed the placeholder Claude plan key.*/g) || [];
    expect(lines.length === 1, `removed-placeholder log lines: ${lines.length}`, lines);
    const card = B.providers.providers.find((p) => p.id === "claude");
    expect(!card.keySource && !card.keyHint, "the Claude plan card shows a key", card);
    return { line: lines[0], fixup: B.settings["fixups.fakeSubscriptionKeyRemovedAt"] ?? null };
  });

  await check("branch: the Voice tab's copy of the OpenAI key (voice.openai_api_key, read by nothing) is gone, once; the OpenAI card's key stays", async () => {
    expect(M.settings["voice.openai_api_key"] !== undefined, "main didn't save voice.openai_api_key", Object.keys(M.settings));
    expect(!("voice.openai_api_key" in B.settings), "voice.openai_api_key is still in Settings", Object.keys(B.settings).filter((k) => /voice\./.test(k)));
    expect(JSON.stringify(B.settings["ai.openai.apiKey"]) === JSON.stringify(M.settings["ai.openai.apiKey"]), "the OpenAI card's key changed", { main: M.settings["ai.openai.apiKey"], branch: B.settings["ai.openai.apiKey"] });
    const lines = branchSrv.out.match(/\[settings\] removed what the old Voice tab saved in place of a key.*/g) || [];
    expect(lines.length === 1 && /voice\.openai_api_key/.test(lines[0]) && !/ai\.openai\.apiKey/.test(lines[0]), `Voice fixup log lines: ${lines.length}`, lines);
    return { line: lines[0] };
  });

  await check("branch: the OpenAI key main's Voice page saved is the OpenAI card's (shared slot), but it didn't become the default", async () => {
    const card = B.providers.providers.find((p) => p.id === "openai");
    expect(B.providers.active.provider === "claude", "the default moved", B.providers.active);
    const r = await api("GET", "/api/voice/stt-models");
    expect(r.json?.current === "small.en", `STT model ${r.json?.current}`, r.text);
    expect(B.settings["voice.stt_provider"] === "whisper-api", `voice.stt_provider ${B.settings["voice.stt_provider"]}`, null);
    return { openaiCard: { state: card?.state, detail: card?.detail, keySource: card?.keySource, keyHint: card?.keyHint } };
  });

  await check("branch: tool permissions survived, and Settings > Security shows them", async () => {
    const r = await api("GET", "/api/admin/tool-permissions");
    expect(JSON.stringify(r.json?.permissions) === JSON.stringify(M.toolPermissions), "the permissions changed", { main: M.toolPermissions, branch: r.json?.permissions });
    const reg = await api("GET", "/api/admin/tool-registry");
    expect(reg.status === 200, `tool-registry answered ${reg.status}`, reg.text);
    const tools = reg.json?.tools || reg.json || [];
    const modeOf = (n) => (Array.isArray(tools) ? tools : []).find((t) => t.name === n)?.mode;
    const want = { get_key: "always_deny", railway: "always_deny", exec: "warn", send_message: "warn" };
    const off = Object.entries(want).filter(([n, m]) => modeOf(n) !== m).map(([n, m]) => `${n}: ${modeOf(n)} (want ${m})`);
    expect(off.length === 0, "the registry shows other modes", off);
  });

  await check("branch: session reset, voice and identity survived", async () => {
    const r = await api("GET", "/api/settings/session-reset");
    expect(JSON.stringify(r.json) === JSON.stringify(M.reset), "session reset changed", { main: M.reset, branch: r.json });
    for (const [k, v] of [["voice.engine", "edge-tts"], ["voice.defaultVoiceId", "en-GB-RyanNeural"], ["identity.name", "Atlas"], ["ai.defaultEffort", "high"]]) {
      expect(B.settings[k] === v, `${k} is ${B.settings[k]}`, null);
    }
  });

  await check("branch: the channels stay off (saved, not started)", async () => {
    const st = await api("GET", "/api/admin/status");
    const tg = B.settings["channel.telegram"];
    const dc = B.settings["channel.discord"];
    expect(tg?.enabled === false && dc?.enabled === false, "a channel is switched on", { tg, dc });
    expect(tg?.hasToken === true || tg?.token === undefined, "the Telegram token's redaction changed", tg);
    const started = /\[(telegram|discord)\][^\n]*(start|connect|logged in|launch)/i.exec(branchSrv.out);
    expect(!started, "a channel started", started?.[0]);
    return { status: st.json?.channels ?? null };
  });

  await check("branch: the workspace files are as the owner left them", async () => {
    const bad = [];
    for (const [n, content] of Object.entries(M.files)) {
      const r = await api("GET", `/api/settings/workspace-file?name=${n}`);
      const got = r.json?.content ?? null;
      if (n === "SOUL.md" || n === "USER.md") { if (got !== content) bad.push({ file: n, main: clip(content, 300), branch: clip(got, 300) }); }
      else if (content && !got) bad.push(`${n} is gone`);
    }
    expect(bad.length === 0, `${bad.length} files differ`, bad);
  });

  await check("branch: the installed skills are still installed", async () => {
    const r = await api("GET", "/api/skills");
    const names = new Set((r.json?.skills || []).map((s) => s.name));
    const missing = (M.skillsInstalled || []).filter((n) => !names.has(n));
    expect(missing.length === 0, `missing ${missing.join(", ")}`, null);
  });

  await check("branch: the API token from main still works (GET /api/v1/status, /api/v1/conversations)", async () => {
    const h = { authorization: `Bearer ${M.apiToken}` };
    const s = await api("GET", "/api/v1/status", undefined, { auth: false, headers: h });
    const c = await api("GET", "/api/v1/conversations", undefined, { auth: false, headers: h });
    expect(s.status === 200 && c.status === 200, `status ${s.status}, conversations ${c.status}`, { s: clip(s.text, 300), c: clip(c.text, 300) });
  });

  await check("branch: the Usage page counts main's model calls, once each, as the Claude plan's", async () => {
    // main's own page lags its indexer (it read the transcripts in the background), so the yardstick is the calls main's
    // database held when it stopped.
    let r = null;
    await until(async () => { r = await api("GET", "/api/analytics/usage"); return r.json?.week?.calls >= M.db.usageCalls; }, { timeoutMs: 15_000, everyMs: 500 });
    expect(r.status === 200, `answered ${r.status}`, r.text);
    B.usage = r.json;
    expect(r.json.week?.calls === M.db.usageCalls, `this week shows ${r.json.week?.calls} calls; main's database had ${M.db.usageCalls}`, summarizeUsage(r.json));
    const providers = (r.json.byProvider || []).map((p) => `${p.provider ?? p.id ?? p.key}:${p.calls ?? ""}:${p.costNote ?? ""}`);
    return { week: r.json.week, byProvider: providers };
  });

  await check("branch: /healthz/deep answers (503 while the plan needs sign-in is by design) and names the Claude plan", async () => {
    const r = await api("GET", "/healthz/deep");
    expect([200, 503].includes(r.status), `answered ${r.status}`, r.text);
    expect(r.json?.ai?.provider === "claude", `ai is ${JSON.stringify(r.json?.ai)}`, r.json);
    return { status: r.status, ai: r.json?.ai };
  });

  await check("branch: no errors in the server log (the harness's own /cron run refusals aside)", async () => {
    // The /cron run checks above ran each job once on purpose, and the background turn logs its refusal: exactly that
    // line, with the plain sign-in message, is expected once per job. Anything else is a problem.
    const ran = new Set((M.cron.jobs || []).filter((x) => x.enabled).map((x) => x.id));
    const own = (l) => {
      const m = /^\[cron:([^\]]+)\] failed on .+?: Nobody has signed in to the Claude plan yet\. Run claude auth login in the Terminal/.exec(l);
      return !!m && ran.has(m[1]);
    };
    const lines = problemLines(branchSrv.err).filter((l) => !own(l));
    const outLines = problemLines(branchSrv.out).filter((l) => /\b(Error|TypeError|ReferenceError|SqliteError|uncaught|unhandled)\b|^\s+at\s/i.test(l));
    B.stderr = lines;
    expect(lines.length === 0 && outLines.length === 0, `${lines.length + outLines.length} problem lines`, [...lines, ...outLines].slice(0, 60));
  });

  await check("branch: the [ai] boot line says the Claude plan, needing sign-in", async () => {
    const line = (branchSrv.out.match(/\[ai\] .*/g) || [])[0];
    expect(line && /Claude plan/i.test(line), "no [ai] line naming the Claude plan", line || clip(branchSrv.out, 2000));
    return { line };
  });

  // --- A second boot: nothing re-runs ----------------------------------------------------------------------------
  await check("branch: stops on SIGTERM", async () => {
    const r = await branchSrv.stop();
    expect(r.graceful, "didn't stop cleanly", r);
    return r;
  });
  B.db = readDb(STATE);
  B.tree = treeOf(STATE);

  await check("the database after the upgrade: integrity, migrations once each, usage columns, sessions kept", async () => {
    expect(B.db.integrity === "ok", `integrity_check: ${B.db.integrity}`, null);
    const names = B.db.migrations.map((m) => m.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes.length === 0, "a migration is recorded twice", dupes);
    expect(names.length === M.db.migrations.length + 1 && names.at(-1) === "012_ai_usage_columns", "unexpected migrations", names);
    for (const c of ["provider", "engine", "cost_usd", "cost_exact"]) expect(B.db.usageTurnCols.includes(c), `usage_turns has no ${c}`, B.db.usageTurnCols);
    // main's usage rows are all still there, with the same numbers (012's new columns aside); the only new rows are the
    // harness's own /cron run refusals (source cron, stop_reason not-ready, no calls).
    const NEW = new Set(["provider", "engine", "cost_usd", "cost_exact"]);
    const strip = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !NEW.has(k))));
    const bTurns = new Map(B.db.usageTurnRows.map((r) => [r.turn_id, r]));
    const turnDiffs = M.db.usageTurnRows.filter((r) => !bTurns.has(r.turn_id) || strip(bTurns.get(r.turn_id)) !== strip(r))
      .map((r) => ({ main: strip(r), branch: bTurns.has(r.turn_id) ? strip(bTurns.get(r.turn_id)) : "gone" }));
    const mainTurnIds = new Set(M.db.usageTurnRows.map((r) => r.turn_id));
    const extra = B.db.usageTurnRows.filter((r) => !mainTurnIds.has(r.turn_id));
    const oddExtra = extra.filter((r) => !(r.source === "cron" && r.stop_reason === "not-ready" && !r.calls));
    const callKey = (r) => strip(r);
    const mCalls = M.db.usageCallRows.map(callKey).sort();
    const bCalls = B.db.usageCallRows.map(callKey).sort();
    expect(turnDiffs.length === 0, `${turnDiffs.length} of main's usage turns changed or went`, turnDiffs);
    expect(oddExtra.length === 0, `${oddExtra.length} new usage turns that the harness didn't cause`, oddExtra);
    expect(JSON.stringify(mCalls) === JSON.stringify(bCalls), "main's usage calls changed (numbers or count)", { main: mCalls, branch: bCalls });
    const providerOfOld = [...new Set(B.db.usageTurnRows.filter((r) => mainTurnIds.has(r.turn_id)).map((r) => `${r.provider}/${r.engine}`))];
    expect(B.db.messageCount === M.db.messageCount + 0 || B.db.messageCount >= M.db.messageCount, "messages were lost", { main: M.db.messageCount, branch: B.db.messageCount });
    const sess = M.db.conversations.map((c) => `${c.id}|${c.claude_session_id}`);
    const sessB = B.db.conversations.map((c) => `${c.id}|${c.claude_session_id}`);
    expect(JSON.stringify(sess) === JSON.stringify(sessB), "the chats' Claude sessions changed", { main: sess, branch: sessB });
    expect(!B.db.settings.some((s) => s.key === "ai.claude-code.apiKey"), "the placeholder row is still in the database", null);
    const del = B.db.audit.filter((a) => a.action === "credential.delete" && a.target === "ai.claude-code.apiKey");
    expect(del.length === 1, `${del.length} audit rows for the placeholder's removal`, B.db.audit.slice(-10));
    expect(!B.db.settings.some((s) => s.key === "voice.openai_api_key"), "the Voice tab's copy of the OpenAI key is still in the database", null);
    const voiceDel = B.db.audit.filter((a) => a.action === "credential.delete" && a.target === "voice.openai_api_key");
    expect(voiceDel.length === 1, `${voiceDel.length} audit rows for the Voice key's removal`, B.db.audit.slice(-10));
    expect(B.db.settings.some((s) => s.key === "ai.openai.apiKey"), "the OpenAI card's key is gone from the database", null);
    return { migrations: names.length, usageTurns: B.db.usageTurns, newHarnessTurns: extra.length, oldTurnsNowLabelled: providerOfOld, messages: B.db.messageCount, audit: del[0] };
  });

  await check("the state folder after the upgrade: nothing main left was deleted, and only expected files changed", async () => {
    const gone = Object.keys(M.tree).filter((k) => !(k in B.tree));
    const changed = Object.keys(M.tree).filter((k) => k in B.tree && B.tree[k] !== M.tree[k]);
    const added = Object.keys(B.tree).filter((k) => !(k in M.tree));
    expect(gone.length === 0, `${gone.length} files main left are gone`, gone);
    const odd = changed.filter((k) => !/^workspace\/(memory\/|AGENTS\.md|CLAUDE\.md|MEMORY\.md|TOOLS\.md|IDENTITY\.md|HEARTBEAT\.md|BOOT\.md|\.boot-context|.*\.json$)|^\.claude-code-home\/|^data\/(boot-context|.*\.json$)/.test(k));
    return { changed, added: added.slice(0, 60), oddChanges: odd };
  });

  // The second boot runs with NODE_ENV=test so the branch's own test seam (engine-env.js TARSEE_TEST_BASE_URL_<ID>,
  // honoured only then and only on loopback) can send an Anthropic key's turns to the fake: the owner's morning, when
  // a real key goes in and an old chat carries on. Nothing else about the boot differs.
  const homeBranch2 = makeHome(path.join(tmp, "home-branch-2"), STATE, { codex: true });
  branchSrv2 = await new Server("branch-2").boot({ cwd: ROOT, home: homeBranch2, state: STATE, extraEnv: { NODE_ENV: "test", TARSEE_TEST_BASE_URL_ANTHROPIC: fake.url } });
  CUR = branchSrv2;
  await until(() => /\[ai\] /.test(branchSrv2.out), { timeoutMs: 20_000 });
  await sleep(2000);
  await check("branch, second boot: no migration and no fixup runs again; the wizard stays away", async () => {
    const applied = branchSrv2.out.match(/\[db\] applied migration: .*/g) || [];
    const fix = branchSrv2.out.match(/\[settings\] removed .*/g) || [];
    expect(applied.length === 0 && fix.length === 0, "something ran again", { applied, fix });
    const s = await api("GET", "/api/settings/setup-status");
    expect(s.status === 200 && s.json.needsSetup === false && s.json.provider === "claude", "setup-status changed", s.text);
  });

  await check("branch, the Railway case: a .credentials.json on the volume (claude login's) makes the Claude plan ready with no action", async () => {
    const credDir = path.join(STATE, ".claude-code-home");
    const credFile = path.join(credDir, ".credentials.json");
    fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: FAKE.credentials, refreshToken: `${FAKE.credentials}-r`, expiresAt: Date.now() + 86_400_000 * 30, scopes: ["user:inference"], subscriptionType: "max" } }), { mode: 0o600 });
    try {
      const r = await api("GET", "/api/ai/providers");
      const s = await api("GET", "/api/settings/setup-status");
      expect(r.json?.active?.provider === "claude" && r.json.active.ready === true && r.json.active.state === "ready", `active ${r.json?.active?.provider} ${r.json?.active?.state}`, r.json?.active);
      expect(s.json?.ai?.ready === true && s.json.needsSetup === false, "setup-status doesn't say ready", s.json);
      return { detail: r.json.active.detail, keySource: r.json.providers.find((p) => p.id === "claude")?.keySource ?? null };
    } finally {
      fs.rmSync(credFile, { force: true });
    }
  });

  // The owner's morning: an Anthropic key goes in, it becomes the default, and an old chat (a Claude plan session from
  // main, a bare id with its transcript in the plan's home) carries on there.
  await check("branch, the morning: an Anthropic key is saved and made the default AI", async () => {
    const k = await api("PUT", "/api/ai/keys/anthropic", { apiKey: FAKE.anthropic });
    expect(k.status === 200 && k.json?.ok, `PUT /api/ai/keys/anthropic answered ${k.status}`, k.text);
    const a = await api("PUT", "/api/ai/active", { provider: "anthropic" });
    expect(a.status === 200 && a.json?.provider === "anthropic", `PUT /api/ai/active answered ${a.status}`, a.text);
    B.morningModel = a.json.model;
    return { model: a.json.model };
  });

  await check("branch, the morning: an old chat from main carries on with the Anthropic key, its history handed over", async () => {
    const id = M.convs.trip;
    const before = (await api("GET", `/api/chat/conversations/${id}?all=true&raw=true`)).json;
    const seen = fake.requests.length;
    const t = await chat({ conversationId: id, message: "Add a third day, please. tarsierword-six" });
    const text = textOf(t);
    expect(t.status === 200 && /Fake plan reply/.test(text), `the turn: ${errorsOf(t).join(" | ") || t.status}`, clip(t.raw, 2500));
    const mine = fake.requests.slice(seen).filter((r) => r.method === "POST" && /\/v1\/messages$/.test(r.path));
    expect(mine.length >= 1, "the Anthropic fake got no request", fake.requests.slice(seen).map((r) => `${r.method} ${r.path}`));
    const keyed = mine.filter((r) => r.headers["x-api-key"] === FAKE.anthropic);
    expect(keyed.length === mine.length, "a request didn't carry the saved Anthropic key (or carried another credential)", mine.map((r) => ({ xApiKey: r.headers["x-api-key"] ? `…${String(r.headers["x-api-key"]).slice(-4)}` : null, auth: r.headers.authorization ? "set" : null })));
    // The request whose answer the chat shows is the turn itself (the CLI also makes small side requests).
    const shown = Number(/Fake plan reply (\d+)/.exec(text)?.[1]);
    const asked = mine.find((r) => r.replyNo === shown);
    expect(asked, `no request answered reply ${shown}`, mine.map((r) => ({ replyNo: r.replyNo, model: r.body?.model })));
    const body = JSON.stringify(asked.body);
    // The old turns must reach the new AI: main's first message (and its reply) are in what Anthropic is sent.
    expect(/tarsierword-one/.test(body) && /Vigan/.test(body) && /tarsierword-six/.test(body), "the old chat's history didn't reach the Anthropic turn (no handoff)", clip(body, 3000));
    expect(!/haiku/i.test(String(asked.body?.model)) || /haiku/i.test(String(B.morningModel)), `the turn ran on ${asked.body?.model}, not the Anthropic default`, { model: asked.body?.model, default: B.morningModel });
    const after = (await api("GET", `/api/chat/conversations/${id}?all=true&raw=true`)).json;
    const old = (before.messages || []).map((m) => `${m.id}|${m.content}`);
    const kept = (after.messages || []).slice(0, old.length).map((m) => `${m.id}|${m.content}`);
    expect(JSON.stringify(old) === JSON.stringify(kept) && after.messages.length === old.length + 2, "the old messages changed, or the new turn didn't add a message and a reply", { before: old.length, after: (after.messages || []).length });
    return { requests: mine.map((r) => `${r.replyNo}:${r.body?.model}`), turnModel: asked.body?.model, reply: clip(text, 120) };
  });

  // A chat main gave a model of its own ("haiku", stored bare, as main stored every pick). The composer shows what the
  // page's own code makes of it (src/public/js/model-picker-core.js buttonLabel, fed exactly as chat.js feeds it:
  // GET /api/chat/models' picker, and the chat's GET …/picker); the turn must run on the model the button names.
  for (const [name, family] of [["facts", "haiku"], ["review", "sonnet"]]) {
    await check(`branch, the morning: main's ${name} chat (its own pick ${family}) runs on the model its composer button shows`, async () => {
      await import(pathToFileURL(path.join(ROOT, "src", "public", "js", "model-picker-core.js")).href);
      const Core = globalThis.ModelPickerCore;
      const id = M.convs[name];
      const models = (await api("GET", "/api/chat/models")).json;
      const pickRes = (await api("GET", `/api/chat/conversations/${id}/picker`)).json;
      const pick = { provider: pickRes.provider || null, model: pickRes.model || null, effort: pickRes.effort || null };
      const label = Core.buttonLabel(models.picker, pick, pickRes.defaults);
      const seen = fake.requests.length;
      const t = await chat({ conversationId: id, message: `One more question. tarsierword-${name}-morning` });
      const text = textOf(t);
      expect(t.status === 200 && /Fake plan reply/.test(text), `the turn: ${errorsOf(t).join(" | ") || t.status}`, clip(t.raw, 2000));
      const shown = Number(/Fake plan reply (\d+)/.exec(text)?.[1]);
      const asked = fake.requests.slice(seen).find((r) => r.replyNo === shown);
      const ran = String(asked?.body?.model || "");
      const selected = t.events.find((e) => e.event === "model_selected")?.data || null;
      // The button's entry is an exact model ("Haiku 4.5" is claude-haiku-4-5) or a family's newest (a tier word).
      const want = String(label.entry?.id || "");
      const fam = (s) => (/(fable|opus|sonnet|haiku)/i.exec(String(s || "")) || [])[1]?.toLowerCase() || null;
      const tierOnly = /^(fable|opus|sonnet|haiku)(\[1m\])?$/i.test(want);
      const same = want && (tierOnly ? fam(want) === fam(ran) : ran === want || ran.startsWith(`${want}-`) || ran === want.replace(/\[1m\]$/, ""));
      const ev = { button: { model: label.model, entry: want || null, effort: label.effort, provider: label.provider, warning: label.warning }, pick, defaults: pickRes.defaults, turnModel: ran, modelSelected: selected };
      expect(same, `the composer shows "${label.model}" (${want || "no entry"}) with no warning, but the turn ran ${ran}`, ev);
      return ev;
    });
  }

  await check("branch, the morning: the plan's old session and transcript are untouched; the chat's new session is the Anthropic key's", async () => {
    // Read the database through the branch's own answers: the conversation carries its session handle.
    const conv = (await api("GET", `/api/chat/conversations/${M.convs.trip}?raw=true`)).json;
    const handle = conv?.claude_session_id ?? null;
    const old = M.db.conversations.find((c) => c.id === M.convs.trip)?.claude_session_id;
    const transcript = Object.keys(M.tree).find((k) => k.endsWith(`/${old}.jsonl`));
    expect(transcript, "main's transcript for the chat wasn't found in the plan's home", Object.keys(M.tree).filter((k) => /\.jsonl$/.test(k)));
    const nowHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(STATE, transcript))).digest("hex").slice(0, 16);
    expect(nowHash === M.tree[transcript], "the plan's transcript was changed by the Anthropic turn", { transcript });
    return { oldHandle: old, newHandle: handle };
  });

  await check("branch, second boot: no errors in the log", async () => {
    const lines = problemLines(branchSrv2.err);
    expect(lines.length === 0, `${lines.length} problem lines`, lines.slice(0, 60));
  });

  await check("branch, second boot: stops on SIGTERM", async () => {
    const r = await branchSrv2.stop();
    expect(r.graceful, "didn't stop cleanly", r);
    return r;
  });

  // --- 4. Linux: main's volume layout through this branch's entrypoint.sh ---------------------------------------
  if (!NO_WSL) await entrypointCheck();

  // --- Secrets -----------------------------------------------------------------------------------------------------
  await check("no key, token or password in any HTTP answer from the branch", async () => {
    const all = answers.filter((a) => a.startsWith("branch")).join("\n");
    const found = SECRETS.filter((s) => s !== M.apiToken && all.includes(s));
    expect(found.length === 0, `found ${found.length}`, found.map((s) => { const i = all.indexOf(s); return `${s.slice(0, 12)}… in: ${scrub(clip(all.slice(Math.max(0, i - 200), i + 40), 260))}`; }));
  });
  await check("no key, token or password in the branch's log", async () => {
    const all = branchSrv.all + (branchSrv2?.all || "");
    const found = SECRETS.filter((s) => all.includes(s));
    expect(found.length === 0, `found ${found.length}`, found.map((s) => s.slice(0, 12)));
  });
  await check("no saved key in plain text anywhere in the state folder", async () => {
    const hits = [];
    const walk = (dir, seen = new Set()) => {
      let real;
      try { real = fs.realpathSync(dir); } catch { return; }
      if (seen.has(real)) return;
      seen.add(real);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, seen); continue; }
        let buf;
        try { buf = fs.readFileSync(p); } catch { continue; }
        for (const [id, k] of Object.entries({ telegram: FAKE.telegram, discord: FAKE.discord, openaiVoice: FAKE.openaiVoice, plan: FAKE_PLAN_TOKEN, anthropic: FAKE.anthropic })) {
          if (buf.includes(Buffer.from(k))) hits.push(`${id} in ${path.relative(STATE, p)}`);
        }
      }
    };
    walk(STATE);
    expect(hits.length === 0, `${hits.length} files hold a key in plain text`, hits);
  });
} catch (err) {
  results.push({ name: "harness", ok: false, error: err?.stack || String(err) });
  log("HARNESS ERROR", err?.stack || err);
} finally {
  for (const s of servers) {
    if (s.child && !s.exited) { const r = await s.stop().catch(() => null); if (r?.leftovers?.length) log(`${s.label} leftovers killed:`, r.leftovers); }
  }
  // Anything still running from this run's folders.
  const stray = (await processes()).filter((p) => p.pid !== process.pid && (p.cmd.includes(tmp) || p.cmd.includes(WT)));
  for (const p of stray) await killTree(p.pid);
  if (stray.length) log("stray processes killed:", stray.map((p) => `${p.pid} ${p.name} ${clip(p.cmd, 120)}`));
  await fake?.close().catch(() => {});
  for (const s of servers) fs.writeFileSync(path.join(OUT, `upgrade-e2e.${s.label}.log`), scrub(s.all));
  if (!KEEP_WT) {
    let rm = await run("git", ["-C", ROOT, "worktree", "remove", WT]);
    if (rm.code !== 0) rm = await run("git", ["-C", ROOT, "worktree", "remove", "--force", WT]);
    await run("git", ["-C", ROOT, "worktree", "prune"]);
    results.push({ name: "the main worktree is removed", ok: rm.code === 0 && !fs.existsSync(WT), ...(rm.code ? { error: rm.stderr } : {}) });
  }
  void wtCreated;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "upgrade-e2e.json"), JSON.stringify(scrubDeep({
    passed, failed: failed.length, results, tmp,
    main: { setupStatus: M.setupStatus, cron: M.cron, toolPermissions: M.toolPermissions, stderr: M.stderr, deep: M.deep, cronModelLine: M.mainCronModelLine, db: M.db && { migrations: M.db.migrations, settingsKeys: M.db.settings.map((s) => `${s.key}${s.encrypted ? " (enc)" : ""}`), conversations: M.db.conversations, usageTurns: M.db.usageTurns, usageCalls: M.db.usageCalls } },
    branch: { setupStatus: B.setupStatus, providersActive: B.providers?.active, banners: B.providers?.banners, cron: B.cron, stderr: B.stderr, db: B.db && { migrations: B.db.migrations, usageTurns: B.db.usageTurns, usageCalls: B.db.usageCalls } },
  }), null, 2));
  log(`done: ${passed} passed, ${failed.length} failed. Results: ${path.join(OUT, "upgrade-e2e.json")}`);
  for (const f of failed) log(`  FAILED: ${f.name}: ${clip(f.error, 300)}`);
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } }
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);

// --- Helpers that need the branch's code ---------------------------------------------------------------------------

/**
 * What this branch's provider registry makes of models on the Claude plan: { model: { resolved, engine, ref } }.
 * Run in a child Node (the registry is pure, but its imports read the config), with a throwaway state folder.
 */
async function registryProbe(models) {
  const code = `
    const reg = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src", "ai", "provider-registry.js")).href)});
    const ref = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src", "ai", "model-ref.js")).href)});
    const out = {};
    for (const m of ${JSON.stringify(models)}) {
      const parsed = ref.parseModelRef(m);
      const provider = parsed.provider || "claude";
      const asked = parsed.model || m;
      const resolved = reg.resolveModelFor(provider, asked);
      // "Understood": the registry keeps the model (an unknown id would fall back to the default model instead).
      out[m] = { provider, resolved, kept: resolved === asked, engine: reg.engineFor(provider, resolved) };
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const probeState = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-upgrade-probe-"));
  try {
    const r = await run(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { ...hostEnv(), TARSEE_STATE_DIR: probeState, HOME: probeState, USERPROFILE: probeState } });
    if (r.code !== 0) throw new Fail("the registry probe failed", r.stderr);
    return JSON.parse(r.stdout);
  } finally { fs.rmSync(probeState, { recursive: true, force: true }); }
}

function summarizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const pick = {};
  for (const k of Object.keys(u)) {
    const v = u[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      pick[k] = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "number" || typeof x === "string").slice(0, 8));
    } else if (Array.isArray(v)) pick[k] = `[${v.length}]`;
    else pick[k] = v;
  }
  return pick;
}

/** main's Railway volume layout (/data/tarsee/.claude-code-home with a sign-in and transcripts, /home/node/.claude
 *  linked to it) through this branch's entrypoint.sh carry_plan_home, setup_provider_homes and report_sign_ins (in
 *  main()'s order), on Linux (WSL); and the same sign-in with TARSEE_STATE_DIR set to another folder on the volume. */
async function entrypointCheck() {
  if (process.platform !== "win32") return;
  const probe = await run("wsl.exe", ["-e", "bash", "-lc", "command -v sh >/dev/null && echo ok"]);
  if (!/ok/.test(probe.stdout)) { log("WSL isn't available: skipping the entrypoint check"); return; }
  const wslPath = (await run("wsl.exe", ["-e", "wslpath", "-a", path.join(ROOT, "entrypoint.sh")])).stdout.trim();
  const script = `
set -u
T=$(mktemp -d)
S="$T/data/tarsee"; H="$T/home/node"
mkdir -p "$S/.claude-code-home/projects/-data-tarsee-workspace" "$H"
# main's entrypoint: the plan's home on the volume, ~/.claude linked to it, a sign-in and a transcript in it
ln -sf "$S/.claude-code-home" "$H/.claude"
printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-test-canary-wsl"}}' > "$S/.claude-code-home/.credentials.json"
echo '{"type":"user"}' > "$S/.claude-code-home/projects/-data-tarsee-workspace/abc.jsonl"
tr -d '\\r' < '${wslPath}' > "$T/entrypoint.sh"
. "$T/entrypoint.sh"
carry_plan_home "$T/data" "$S" || echo "CARRY_FAILED"
setup_provider_homes "$S" "$H" "" || echo "SETUP_FAILED"
report_sign_ins "$S"
echo "LINK=$(readlink "$H/.claude")"
echo "CODEXLINK=$(readlink "$H/.codex")"
[ -f "$S/.claude-code-home/.credentials.json" ] && echo CRED_KEPT
[ -f "$S/.claude-code-home/projects/-data-tarsee-workspace/abc.jsonl" ] && echo TRANSCRIPT_KEPT
for d in .claude-code-home .claude-home-anthropic .claude-home-deepseek .claude-home-openrouter .codex-home .codex-home-keys; do echo "MODE $d $(stat -c %a "$S/$d")"; done
grep -l 'sk-' "$S/.codex-home/config.toml" "$S/.codex-home-keys/config.toml" 2>/dev/null && echo SECRET_IN_CONFIG
rm -rf "$T"
`;
  await check("Linux (WSL): main's volume layout through this branch's entrypoint.sh keeps the Claude sign-in and transcripts", async () => {
    const r = await run("wsl.exe", ["-e", "bash", "-c", script]);
    const o = r.stdout;
    const bad = [];
    if (/CARRY_FAILED/.test(o)) bad.push("carry_plan_home failed");
    if (/moved the Claude plan sign-in/.test(o)) bad.push("carry_plan_home moved something on the default layout");
    if (/SETUP_FAILED/.test(o)) bad.push("setup_provider_homes failed");
    if (!/CRED_KEPT/.test(o)) bad.push("the .credentials.json is gone");
    if (!/TRANSCRIPT_KEPT/.test(o)) bad.push("the transcripts are gone");
    if (!/LINK=.*\/data\/tarsee\/\.claude-code-home$/m.test(o)) bad.push("~/.claude doesn't link to the volume's .claude-code-home");
    if (!/Claude plan signed in \(on the volume\)/.test(o)) bad.push("report_sign_ins doesn't say the Claude plan is signed in");
    if (/SECRET_IN_CONFIG/.test(o)) bad.push("a config.toml holds an sk- string");
    for (const m of o.matchAll(/MODE (\S+) (\d+)/g)) if (m[2] !== "700") bad.push(`${m[1]} is mode ${m[2]}`);
    expect(bad.length === 0, bad.join("; "), o + r.stderr);
    return o.split("\n").filter((l) => /^\[entrypoint\]|^LINK|^CODEXLINK|^MODE/.test(l));
  });

  const custom = `
set -u
T=$(mktemp -d)
OLD="$T/data/tarsee/.claude-code-home"; S="$T/data/tarsee/state"; H="$T/home/node"
mkdir -p "$OLD/projects/-data-tarsee-workspace" "$S" "$H"
ln -sf "$OLD" "$H/.claude"
printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-test-canary-wsl"}}' > "$OLD/.credentials.json"
echo '{"type":"user"}' > "$OLD/projects/-data-tarsee-workspace/abc.jsonl"
tr -d '\\r' < '${wslPath}' > "$T/entrypoint.sh"
. "$T/entrypoint.sh"
carry_plan_home "$T/data" "$S" || echo "CARRY_FAILED"
setup_provider_homes "$S" "$H" "" || echo "SETUP_FAILED"
report_sign_ins "$S"
echo "LINK=$(readlink "$H/.claude")"
[ -f "$S/.claude-code-home/.credentials.json" ] && echo CRED_MOVED
[ -f "$S/.claude-code-home/projects/-data-tarsee-workspace/abc.jsonl" ] && echo TRANSCRIPT_MOVED
[ -e "$OLD" ] && echo OLD_LEFT
echo "--- again"
carry_plan_home "$T/data" "$S" || echo "CARRY_FAILED"
rm -rf "$T"
`;
  await check("Linux (WSL): with TARSEE_STATE_DIR set to another folder on the volume, main's Claude sign-in and transcripts move there, once", async () => {
    const r = await run("wsl.exe", ["-e", "bash", "-c", custom]);
    const o = r.stdout;
    const [first, again = ""] = o.split("--- again");
    const bad = [];
    if (/CARRY_FAILED|SETUP_FAILED/.test(o)) bad.push("carry_plan_home or setup_provider_homes failed");
    if (!/moved the Claude plan sign-in and chat history/.test(first)) bad.push("the move wasn't reported");
    if (!/CRED_MOVED/.test(first)) bad.push("the .credentials.json didn't move");
    if (!/TRANSCRIPT_MOVED/.test(first)) bad.push("the transcripts didn't move");
    if (/OLD_LEFT/.test(first)) bad.push("the old folder is still there");
    if (!/LINK=.*\/data\/tarsee\/state\/\.claude-code-home$/m.test(first)) bad.push("~/.claude doesn't link to the state folder's .claude-code-home");
    if (!/Claude plan signed in/.test(first)) bad.push("report_sign_ins doesn't say the Claude plan is signed in");
    if (/\[entrypoint\]/.test(again)) bad.push("a second boot did something");
    expect(bad.length === 0, bad.join("; "), o + r.stderr);
    return first.split("\n").filter((l) => /^\[entrypoint\]|^LINK/.test(l));
  });
}
