#!/usr/bin/env node
// End-to-end, browser-level check of "Choose your AI" (the setup wizard) and Settings > AI on a REAL Tarsee server.
//
//   node scripts/e2e/ai-ui.e2e.mjs [--shots <dir>] [--out <results.json>]
//
// What it does:
//   - boots `node src/server.js` on a free port with a fresh temp TARSEE_STATE_DIR and a temp HOME (so no Claude or
//     Codex sign-in of this machine is seen), a SETUP_PASSWORD and ENCRYPTION_KEY made up at run time (never written
//     to a file), and every AI credential variable of this shell removed
//   - runs a tiny loopback server that answers GET /v1/models like an Ollama/LM Studio box (the owner's "Local AI")
//   - drives Playwright's Chromium: logs in, walks the wizard's "Choose your AI" (who-question, the three choices,
//     each guide's links, live status, a fake key per key provider tested against the REAL provider site and
//     refused, the ChatGPT device sign-in started for real and cancelled), finishes the wizard on Local AI, then
//     Settings > AI (chips, cards, guides, masked key box, Save/Remove, Test, Use this AI, keys-only, backup, cap),
//     the header chip, the chat's model picker, and Settings > Security's tool list; at 1280px and 390px
//   - fails on any console error or page error, any canary key in the server's output, any HTTP response or
//     WebSocket frame, or anywhere in the state folder
// Every process it starts is stopped before it exits. Results go to --out (JSON) and the console.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { chromium } = require("playwright");

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const SHOTS = path.resolve(arg("--shots", path.join(os.tmpdir(), "tarsee-e2e-shots", "ai")));
const OUT = arg("--out", null);
fs.mkdirSync(SHOTS, { recursive: true });

// --- Results ---------------------------------------------------------------------------------------------------------

const results = { passed: 0, failures: [], notes: [], shots: [] };
const t0 = Date.now();
const log = (...a) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
function check(cond, title, { detail = "", file = "", evidence = "" } = {}) {
  if (cond) { results.passed++; return true; }
  results.failures.push({ title, file, detail, evidence: String(evidence).slice(0, 2000) });
  log("FAIL:", title, evidence ? `| ${String(evidence).slice(0, 300)}` : "");
  return false;
}
const note = (s) => { results.notes.push(s); log("note:", s); };
async function step(name, fn) {
  log("STEP", name);
  try { await fn(); } catch (err) {
    results.failures.push({ title: `${name}: threw`, file: "", detail: "The step stopped with an exception.", evidence: String(err?.stack || err).slice(0, 2000) });
    log("FAIL (threw):", name, err?.message);
  }
}

// --- Secrets made up now, never written anywhere ------------------------------------------------------------------

const rnd = (n) => crypto.randomBytes(n).toString("hex");
const SETUP_PASSWORD = `e2e-${rnd(12)}`;
const ENCRYPTION_KEY = rnd(32);
const CANARY = `testcanary${rnd(8)}`;            // in every fake key; nothing legitimate ever contains it
const FAKE_KEYS = {
  anthropic: `sk-ant-api03-${CANARY}A${rnd(8)}`,
  openai: `sk-proj-${CANARY}B${rnd(8)}`,
  openrouter: `sk-or-v1-0000${CANARY}C${rnd(8)}`,
  deepseek: `sk-${CANARY}D${rnd(8)}`,
};
const KEY_IDS = Object.keys(FAKE_KEYS);
const ALL_IDS = ["claude", "chatgpt", "anthropic", "openai", "openrouter", "deepseek", "local"];
const LABEL = { claude: "Claude plan", chatgpt: "ChatGPT plan", anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", deepseek: "DeepSeek", local: "Local AI" };
const CARD_NAME = { claude: "Claude plan", chatgpt: "ChatGPT plan", anthropic: "Anthropic API key", openai: "OpenAI API key", openrouter: "OpenRouter", deepseek: "DeepSeek", local: "Local AI" };
const scanSecrets = (text) => {
  const s = String(text ?? "");
  const hits = [];
  if (s.includes(CANARY)) hits.push("canary");
  for (const [id, k] of Object.entries(FAKE_KEYS)) if (s.includes(k)) hits.push(`${id} key`);
  if (s.includes(SETUP_PASSWORD)) hits.push("SETUP_PASSWORD");
  if (s.includes(ENCRYPTION_KEY)) hits.push("ENCRYPTION_KEY");
  return hits;
};

// --- Processes -----------------------------------------------------------------------------------------------------

const started = [];   // { name, child }
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch { /* already gone */ }
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}
/** Every process: [{ pid, ppid, name }] (Windows: Win32_Process; elsewhere ps). */
function procTable() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
      return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: String(p.Name || "") }));
    }
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" });
    return out.trim().split("\n").map((l) => { const [pid, ppid, ...n] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, name: n.join(" ") }; });
  } catch { return []; }
}
const serverTree = new Set();   // every pid seen under a server this run (kept after the server is gone)
/** The codex processes started by our servers: alive ones whose parent chain reaches a server pid. */
function ourCodex() {
  const table = procTable();
  const kids = new Map();
  for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const roots = started.filter((x) => x.name.startsWith("server")).map((x) => x.child.pid);
  const queue = [...roots, ...serverTree];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    serverTree.add(pid);
    for (const k of kids.get(pid) || []) queue.push(k.pid);
  }
  return table.filter((p) => /^codex(\.exe)?$/i.test(p.name) && seen.has(p.ppid)).map((p) => `${p.pid}(parent ${p.ppid})`);
}

// The owner's "Local AI": answers GET /v1/models, and Test's check that it has the Responses API (POST /v1/responses
// with no model in it) as a current Ollama does, 400 "model is required"; anything else is recorded (no turn should
// reach it here: a turn's POST /v1/responses names its model, and is recorded with it).
const localHits = [];
const localAi = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let model = null;
    try { model = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")?.model ?? null; } catch { model = "(not JSON)"; }
    localHits.push(`${req.method} ${req.url}${model ? ` (model ${model})` : ""}`);
    if (req.method === "GET" && /\/v1\/models\/?$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "e2e-local-model", object: "model", owned_by: "e2e" }] }));
      return;
    }
    if (req.method === "POST" && /\/v1\/responses\/?$/.test(req.url) && !model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model is required" } }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not here" } }));
  });
});
await new Promise((r) => localAi.listen(0, "127.0.0.1", r));
const LOCAL_URL = `http://127.0.0.1:${localAi.address().port}/v1`;

// The server, fresh.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-e2e-state-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-e2e-home-"));
const port = await freePort();
const ORIGIN = `http://127.0.0.1:${port}`;
const CRED_NAME_RE = /^(ANTHROPIC_|OPENAI_|OPENROUTER_|DEEPSEEK_|CLAUDE|CODEX_|TARSEE_|AWS_BEARER|SETUP_PASSWORD$|ENCRYPTION_KEY$|NODE_ENV$|PORT$)/i;
const serverEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!CRED_NAME_RE.test(k)) serverEnv[k] = v;
Object.assign(serverEnv, {
  PORT: String(port),
  TARSEE_STATE_DIR: stateDir,
  SETUP_PASSWORD,
  ENCRYPTION_KEY,
  HOME: homeDir,
  USERPROFILE: homeDir,
  TARSEE_PHONON_AUTO_INSTALL: "0",
});
let serverOut = "";
const server = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
started.push({ name: "server", child: server });
server.stdout.on("data", (d) => { serverOut += d.toString(); });
server.stderr.on("data", (d) => { serverOut += d.toString(); });

let browser = null;

async function shutdown() {
  try { await browser?.close(); } catch { /* gone */ }
  for (const { child } of started) killTree(child);
  await new Promise((r) => localAi.close(() => r()));
}
process.on("SIGINT", async () => { await shutdown(); process.exit(130); });

// --- Wait for the server ------------------------------------------------------------------------------------------

{
  const until = Date.now() + 60_000;
  let up = false;
  while (Date.now() < until && server.exitCode === null) {
    try { const r = await fetch(`${ORIGIN}/healthz`); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) {
    console.error(serverOut);
    await shutdown();
    throw new Error("The server didn't come up within 60 s");
  }
  log("server up at", ORIGIN, "state", stateDir);
}

// --- Browser plumbing -------------------------------------------------------------------------------------------

browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA || "", "ms-playwright/chromium-1234/chrome-win64/chrome.exe") });

const consoleErrors = [];   // { where, text, url }
const leakHits = [];        // { where, what }
const apiCalls = [];        // { at, method, path, status, body? }
const testCallTimes = [];   // POST /api/ai/test/* times, for the 6-a-minute limit

function watch(context, where) {
  context.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin === ORIGIN && req.method() === "POST" && u.pathname.startsWith("/api/ai/test/")) testCallTimes.push(Date.now());
  });
  context.on("response", async (res) => {
    const u = new URL(res.url());
    if (u.origin !== ORIGIN) return;
    const req = res.request();
    const entry = { at: Date.now(), where, method: req.method(), path: u.pathname + u.search, status: res.status() };
    if (u.pathname.startsWith("/api/")) apiCalls.push(entry);
    try {
      const ct = res.headers()["content-type"] || "";
      if (!/json|text|javascript|html/.test(ct)) return;
      const body = await res.text();
      if (u.pathname.startsWith("/api/")) entry.body = body.slice(0, 4000);
      const hits = scanSecrets(body);
      if (hits.length) leakHits.push({ where: `${where} HTTP ${req.method()} ${u.pathname}`, what: hits.join(", "), sample: body.slice(0, 300) });
    } catch { /* redirect or no body */ }
  });
}
function watchPage(page, where) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push({ where, text: msg.text(), url: msg.location()?.url || "" });
  });
  page.on("pageerror", (err) => consoleErrors.push({ where, text: `pageerror: ${err.message}`, url: "" }));
  page.on("websocket", (ws) => {
    const scan = (dir) => (f) => {
      const hits = scanSecrets(typeof f.payload === "string" ? f.payload : f.payload?.toString?.());
      if (hits.length) leakHits.push({ where: `${where} WS ${dir}`, what: hits.join(", ") });
    };
    ws.on("framereceived", scan("in"));
  });
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); results.shots.push(file); } catch (err) { note(`screenshot ${name} failed: ${err.message}`); }
}

/** Wait so no more than 5 Tests have gone out in the last 61 s (the route allows 6 a minute per address). */
async function paceTests() {
  for (;;) {
    const now = Date.now();
    const recent = testCallTimes.filter((t) => now - t < 61_000);
    if (recent.length < 5) return;
    const wait = 61_000 - (now - recent[0]) + 250;
    log(`waiting ${Math.ceil(wait / 1000)} s for the Test rate limit window`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Horizontal overflow: the page scrolls sideways, and the visible elements that stick out past the right edge. */
async function sideScroll(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const de = document.documentElement;
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[hidden]")) continue;
      // Inside something that scrolls sideways on its own (a code block, a table wrapper): fine.
      let p = el.parentElement; let clipped = false;
      while (p && p !== document.body) {
        const ps = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(ps.overflowX) && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; }
        p = p.parentElement;
      }
      if (clipped) continue;
      if (r.right > vw + 1) offenders.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""} right=${Math.round(r.right)}`);
    }
    return { scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth, innerWidth: vw, scrolls: de.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1, offenders: offenders.slice(0, 8) };
  });
}
async function noSideScroll(page, label, file) {
  const s = await sideScroll(page);
  check(!s.scrolls && !s.offenders.length, `${label}: no horizontal scroll at ${s.innerWidth}px`, {
    file, detail: "Something on the page is wider than the screen.", evidence: JSON.stringify(s),
  });
  return s;
}

/** Every link inside root: external ones https, opening in a new tab with rel="noopener noreferrer". */
async function linksIn(page, rootSelector) {
  return page.$$eval(`${rootSelector} a[href]`, (as) => as.map((a) => ({
    href: a.getAttribute("href"), abs: a.href, target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent.trim().slice(0, 60),
    visible: !!(a.offsetWidth || a.offsetHeight || a.getClientRects().length),
  })));
}
const externalLinks = new Map();   // href -> where
function checkLinks(links, where, file) {
  for (const l of links) {
    const external = /^https?:/i.test(l.href);
    if (external) {
      check(l.href.startsWith("https://"), `${where}: link ${l.href} is https`, { file, evidence: JSON.stringify(l) });
      if (!externalLinks.has(l.href)) externalLinks.set(l.href, where);
    }
    check(l.target === "_blank", `${where}: link "${l.text}" (${l.href}) opens in a new tab`, { file, evidence: JSON.stringify(l) });
    check(l.rel === "noopener noreferrer", `${where}: link "${l.text}" (${l.href}) has rel="noopener noreferrer"`, { file, evidence: JSON.stringify(l) });
  }
}

/** The open model menu: fully opaque, and on top at its rows (nothing else drawn over it). */
async function menuOnTop(pg, label, file) {
  await pg.waitForTimeout(1200);
  const r = await pg.evaluate(() => {
    const menu = document.querySelector(".mp-menu");
    if (!menu) return { menu: false };
    let opacity = 1;
    for (let el = menu; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity || 1);
    const covered = [];
    for (const row of [...menu.querySelectorAll(".mp-item")].slice(0, 8)) {
      const b = row.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const x = b.left + Math.min(40, b.width / 2); const y = b.top + b.height / 2;
      if (y < 0 || y > window.innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (top && !menu.contains(top)) covered.push(`${row.textContent.trim().slice(0, 30)} under ${top.tagName.toLowerCase()}${top.id ? "#" + top.id : ""}.${String(top.className || "").split(" ").join(".")}`);
    }
    const cs = getComputedStyle(menu);
    return { menu: true, opacity, covered, zIndex: cs.zIndex, position: cs.position, bg: cs.backgroundColor };
  });
  check(r.menu && r.opacity >= 0.99 && !r.covered.length, `${label}: the open model menu is opaque and on top`, { file, evidence: JSON.stringify(r) });
}

/** Answer the question on screen (js/dialogs.js) with the button called name, after its 400 ms settle time. */
async function answerDialog(page, name) {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(450);
  await dialog.getByRole("button", { name }).click();
}

const providersNow = async (ctx) => (await ctx.request.get(`${ORIGIN}/api/ai/providers`)).json();

// ======================================================================================================================
// 1. Log in (desktop, 1280px)
// ======================================================================================================================

const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
watch(desk, "desktop");
const page = await desk.newPage();
watchPage(page, "desktop");

await step("login at 1280px", async () => {
  await page.goto(ORIGIN + "/");
  await page.locator("#loginPassword").waitFor({ timeout: 20_000 });
  await shot(page, "01-login-1280");
  await page.locator("#loginPassword").fill(SETUP_PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.getByText("Choose your AI").waitFor({ timeout: 20_000 });
  check(true, "logged in and the wizard opened on a fresh install");
  await page.locator("#setupAiChoices .setup-ai-choice").first().waitFor();
  await shot(page, "02-wizard-start-1280");
});

// ======================================================================================================================
// 2. The wizard's "Choose your AI"
// ======================================================================================================================

const WIZ = "src/public/js/setup.js";

await step("wizard: who will talk to it, keys-only pre-ticked only for shared use", async () => {
  const box = page.locator("#setupKeysOnly");
  const me = page.locator('input[name="setupWho"][value="me"]');
  const others = page.locator('input[name="setupWho"][value="others"]');
  check(await me.isChecked(), "wizard: 'Just me' is the default answer", { file: WIZ });
  check(!(await box.isChecked()), "wizard: keys-only is not ticked for 'Just me'", { file: WIZ });
  await others.check();
  check(await box.isChecked(), "wizard: 'Other people too' pre-ticks 'Only use API keys'", { file: WIZ });
  const claudeBtn = page.locator('[data-setup="choice"][data-choice="claude"]');
  const chatgptBtn = page.locator('[data-setup="choice"][data-choice="chatgpt"]');
  check(await claudeBtn.isDisabled() && await chatgptBtn.isDisabled(), "wizard: plan choices are off while keys-only is ticked", { file: WIZ });
  check(/Off while "Only use API keys" is ticked/.test(await claudeBtn.innerText()), "wizard: the plan choice says why it is off", { file: WIZ, evidence: await claudeBtn.innerText() });
  await shot(page, "03-wizard-shared-keysonly-1280");
  await me.check();
  check(!(await box.isChecked()), "wizard: back to 'Just me' unticks the auto-ticked keys-only", { file: WIZ });
  check(!(await claudeBtn.isDisabled()), "wizard: plans are choosable again", { file: WIZ });
  // Keys-only ticked by hand stays ticked when the answer changes.
  await box.check();
  await others.check();
  await me.check();
  check(await box.isChecked(), "wizard: keys-only ticked by hand is not unticked by 'Just me'", { file: WIZ });
  await box.uncheck();
  const k = await providersNow(desk);
  check(k.keysOnly?.on === false, "wizard: nothing about keys-only is saved before Next", { file: WIZ, evidence: JSON.stringify(k.keysOnly) });
});

await step("wizard: the terms note's links", async () => {
  checkLinks(await linksIn(page, "#setupAiTerms"), "wizard terms note", "src/public/js/provider-guides-core.js");
});

/** The panel's status line, guide and links for the chosen AI. */
async function wizardPanel(id, { guideOpen = true } = {}) {
  const panel = page.locator("#setupAiPanel");
  const name = { claude: "Claude plan", chatgpt: "ChatGPT plan", anthropic: "Anthropic API key", openai: "OpenAI API key", openrouter: "OpenRouter", deepseek: "DeepSeek", local: "Local AI" }[id];
  await panel.getByText(`How to set up ${name}`).waitFor({ timeout: 10_000 });
  const status = (await panel.locator(".setup-ai-status").innerText()).trim();
  check(status && status !== "Checking…", `wizard ${id}: a live status line`, { file: WIZ, evidence: status });
  const open = await panel.locator(`details.ai-guide[data-ai-guide="${id}"]`).evaluate((d) => d.open);
  check(open === guideOpen, `wizard ${id}: the steps are ${guideOpen ? "unfolded" : "folded"}`, { file: WIZ, evidence: String(open) });
  const steps = await panel.locator(`details.ai-guide[data-ai-guide="${id}"] ol.channel-guide-steps > li`).count();
  check(steps >= 3, `wizard ${id}: the step-by-step guide has its steps`, { file: WIZ, evidence: `${steps} steps` });
  checkLinks(await linksIn(page, "#setupAiPanel"), `wizard ${id} panel`, "src/public/js/provider-guides-core.js");
  return status;
}

await step("wizard: My Claude plan", async () => {
  await page.locator('[data-setup="choice"][data-choice="claude"]').click();
  const status = await wizardPanel("claude");
  check(/signed in|sign-in/i.test(status), "wizard claude: status says nobody has signed in", { file: WIZ, evidence: status });
  await paceTests();
  await page.locator('#setupAiPanel [data-setup="test"]').click();
  const line = page.locator("#setupAiPanel .ai-test-result");
  await page.waitForFunction(() => { const t = document.querySelector("#setupAiPanel .ai-test-result")?.textContent || ""; return t && !/Checking/.test(t); }, null, { timeout: 15_000 });
  const text = await line.innerText();
  check(/claude auth login|sign/i.test(text), "wizard claude: Check says what to do", { file: WIZ, evidence: text });
  check(await page.locator("#setupAiNext").isDisabled(), "wizard claude: Next stays off until it is Ready", { file: WIZ });
  await shot(page, "04-wizard-claude-1280");
});

await step("wizard: My ChatGPT plan, Sign in shows a real link and code, then Cancel", async () => {
  await page.locator('[data-setup="choice"][data-choice="chatgpt"]').click();
  const status = await wizardPanel("chatgpt");
  check(/signed in|sign/i.test(status), "wizard chatgpt: status says nobody has signed in", { file: WIZ, evidence: status });
  await page.locator('#setupAiPanel [data-setup="chatgpt-login"]').click();
  const code = page.locator("#setupDevice .ai-device-code");
  try {
    await code.waitFor({ timeout: 45_000 });
  } catch {
    const shown = await page.locator("#setupDevice").innerText().catch(() => "");
    const last = apiCalls.filter((c) => c.path.startsWith("/api/ai/chatgpt/login")).slice(-2);
    check(false, "wizard chatgpt: Sign in with ChatGPT shows a link and a one-time code", { file: "src/ai/codex-device-login.js", detail: "No code appeared within 45 s.", evidence: `${shown} ${JSON.stringify(last)}` });
    await shot(page, "05-wizard-chatgpt-failed-1280");
    return;
  }
  const codeText = (await code.innerText()).replace(/Copy(ied)?$/i, "").trim();
  check(/^[A-Z0-9]{4,8}(-[A-Z0-9]{4,8})+/.test(codeText), "wizard chatgpt: a one-time code is shown", { file: WIZ, evidence: codeText });
  const links = await linksIn(page, "#setupDevice");
  check(links.some((l) => l.href.startsWith("https://auth.openai.com/codex/device")), "wizard chatgpt: OpenAI's device page link is shown", { file: WIZ, evidence: JSON.stringify(links) });
  checkLinks(links, "wizard chatgpt sign-in box", "src/public/js/settings.js");
  check(/\d+:\d\d/.test(await page.locator("#setupDevice [data-ai-countdown]").innerText()), "wizard chatgpt: the code's countdown is shown", { file: "src/public/js/settings.js" });
  const codexDuring = ourCodex();
  await page.locator("#setupDevice").scrollIntoViewIfNeeded();
  await shot(page, "05-wizard-chatgpt-code-1280");
  await page.locator('#setupDevice [data-ai-action="chatgpt-cancel"]').click();
  await page.locator("#setupDevice").waitFor({ state: "hidden", timeout: 10_000 });
  const st = await (await desk.request.get(`${ORIGIN}/api/ai/chatgpt/login`)).json();
  check(st.state === "idle", "wizard chatgpt: Cancel ends the sign-in on the server", { file: "src/routes/ai.js", evidence: JSON.stringify(st) });
  await page.waitForTimeout(3500);
  const leftover = ourCodex();
  check(!leftover.length, "wizard chatgpt: Cancel stops Codex (no codex.exe left)", { file: "src/ai/codex-device-login.js", evidence: `during: ${codexDuring.join(",")}; after: ${leftover.join(",")}` });
  // A poll that was in flight must not bring the box back.
  await page.waitForTimeout(3500);
  check(await page.locator("#setupDevice").isHidden(), "wizard chatgpt: the sign-in box stays closed after Cancel", { file: WIZ });
  await shot(page, "06-wizard-chatgpt-cancelled-1280");
});

await step("wizard: My own API key, each key provider refuses a fake key, nothing saved", async () => {
  await page.locator('[data-setup="choice"][data-choice="key"]').click();
  const provs = await page.locator('#setupAiPanel [data-setup="provider"]').evaluateAll((bs) => bs.map((b) => b.dataset.provider));
  check(JSON.stringify(provs) === JSON.stringify(["anthropic", "openai", "openrouter", "deepseek", "local"]), "wizard key: every key provider can be picked", { file: WIZ, evidence: JSON.stringify(provs) });
  for (const id of KEY_IDS) {
    await page.locator(`#setupAiPanel [data-setup="provider"][data-provider="${id}"]`).click();
    const status = await wizardPanel(id);
    check(new RegExp(`No ${LABEL[id]} key|needs.*key|key yet`, "i").test(status), `wizard ${id}: status says there is no key yet`, { file: WIZ, evidence: status });
    const input = page.locator("#setupKey");
    check((await input.getAttribute("type")) === "password", `wizard ${id}: the key box hides what is pasted`, { file: WIZ });
    const getKey = await linksIn(page, "#setupAiPanel .ai-actions");
    check(getKey.some((l) => /Get a key/.test(l.text)), `wizard ${id}: a Get a key link`, { file: WIZ, evidence: JSON.stringify(getKey) });
    const guideText = await page.locator(`#setupAiPanel details.ai-guide[data-ai-guide="${id}"]`).innerText();
    const buttons = await page.locator("#setupAiPanel button, #setupAiPanel a.btn, #setupAiNext").allInnerTexts();
    const named = [...guideText.matchAll(/click (Save key|Test|Use this AI)/g)].map((m) => m[1]);
    const missing = [...new Set(named)].filter((n) => !buttons.some((b) => b.trim() === n));
    check(!missing.length, `wizard ${id}: the steps only name buttons the wizard shows`, {
      file: "src/public/js/provider-guides-core.js", detail: "The guide is shared with Settings > AI, whose buttons differ from the wizard's (Test and save, Next).",
      evidence: `steps say: ${JSON.stringify([...new Set(named)])}; wizard buttons: ${JSON.stringify(buttons.map((b) => b.trim()))}`,
    });
    await input.fill(FAKE_KEYS[id]);
    await paceTests();
    const before = apiCalls.length;
    await page.locator('#setupAiPanel [data-setup="test-save"]').click();
    await page.waitForFunction(() => {
      const t = document.querySelector("#setupAiPanel .ai-test-result")?.textContent || "";
      return /[✓✗]/.test(t) || /Too many|couldn't/i.test(t);
    }, null, { timeout: 30_000 });
    const line = (await page.locator("#setupAiPanel .ai-test-result").innerText()).trim();
    const tone = await page.locator("#setupAiPanel .ai-test-result").getAttribute("data-tone");
    const calls = apiCalls.slice(before).filter((c) => c.method !== "GET");
    const testCall = calls.find((c) => c.path === `/api/ai/test/${id}`);
    check(!!testCall && testCall.status === 200, `wizard ${id}: Test went to the server and came back`, { file: "src/routes/ai.js", evidence: JSON.stringify(calls.map(({ body, ...c }) => c)) });
    let probe = {};
    try { probe = JSON.parse(testCall?.body || "{}"); } catch { /* not json */ }
    check(probe.ok === false && probe.httpStatus && [401, 403].includes(probe.httpStatus), `wizard ${id}: the real ${LABEL[id]} site refused the fake key (401/403)`, {
      file: "src/ai/provider-probes.js", detail: "Expected the provider's own host to answer 401 or 403 for a made-up key.", evidence: testCall?.body,
    });
    check(tone === "bad" && /✗/.test(line) && /rejected|turned this key down/i.test(line), `wizard ${id}: a clear refusal is shown`, { file: WIZ, evidence: `${tone}: ${line}` });
    check(!calls.some((c) => c.path === `/api/ai/keys/${id}`), `wizard ${id}: a refused key is not saved (no PUT /api/ai/keys)`, { file: WIZ, evidence: JSON.stringify(calls.map(({ body, ...c }) => c)) });
    check(await page.locator("#setupAiNext").isDisabled(), `wizard ${id}: Next stays off`, { file: WIZ });
    check(!(await page.content()).includes(CANARY) || (await input.inputValue()) === FAKE_KEYS[id], `wizard ${id}: the key is only in the box it was typed in`, { file: WIZ });
    await page.locator("#setupAiPanel .ai-test-result").scrollIntoViewIfNeeded();
    await shot(page, `07-wizard-${id}-refused-1280`);
    await input.fill("");
  }
  const p = await providersNow(desk);
  for (const id of KEY_IDS) {
    const c = p.providers.find((x) => x.id === id);
    check(!c.keySource && !c.keyHint, `wizard ${id}: no key saved after the refusal`, { file: "src/routes/ai.js", evidence: JSON.stringify({ keySource: c.keySource, keyHint: c.keyHint, state: c.state }) });
  }
});

await step("wizard: Local AI on the owner's own server becomes Ready", async () => {
  await page.locator('#setupAiPanel [data-setup="provider"][data-provider="local"]').click();
  await wizardPanel("local");
  await page.locator("#setupLocalUrl").fill(LOCAL_URL);
  await paceTests();
  await page.locator('#setupAiPanel [data-setup="save-local"]').click();
  await page.locator("#setupAiPanel .setup-ai-status", { hasText: "Ready" }).waitFor({ timeout: 20_000 });
  const line = await page.locator("#setupAiPanel .ai-test-result").innerText();
  check(/Reached your Local AI · 1 model/.test(line), "wizard local: Test lists the server's model", { file: WIZ, evidence: line });
  const open = await page.locator('#setupAiPanel details.ai-guide[data-ai-guide="local"]').evaluate((d) => d.open);
  check(open === false, "wizard local: the steps fold once it is Ready", { file: WIZ });
  await page.locator("#setupAiModel").waitFor();
  const opts = await page.locator("#setupAiModel option").evaluateAll((os) => os.map((o) => o.value));
  check(opts.includes("e2e-local-model"), "wizard local: the model list has the server's model", { file: WIZ, evidence: JSON.stringify(opts) });
  await page.locator("#setupAiNext:not([disabled])").waitFor();
  check(/Next: use Local AI/.test(await page.locator("#setupAiNext").innerText()), "wizard local: Next names the AI it will use", { file: WIZ });
  await shot(page, "08-wizard-local-ready-1280");
});

// ======================================================================================================================
// 3. The wizard at phone width (390px), before it is finished
// ======================================================================================================================

const desktopState = await desk.storageState();
await step("phone 390px: login screen and the wizard", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  watch(ctx, "phone");
  const p = await ctx.newPage();
  watchPage(p, "phone");
  try {
    await p.goto(ORIGIN + "/");
    await p.locator("#pinPad").waitFor({ timeout: 20_000 });
    await noSideScroll(p, "phone login screen", "src/public/css/style.css");
    await shot(p, "20-phone-login-390");
    await p.locator("#pinUsePassword").click();
    await p.locator("#loginPassword").fill(SETUP_PASSWORD);
    await p.locator('#loginForm button[type="submit"]').click();
    await p.getByText("Choose your AI").waitFor({ timeout: 20_000 });
    await p.locator("#setupAiChoices .setup-ai-choice").first().waitFor();
    await noSideScroll(p, "phone wizard start", "src/public/css/style.css");
    await shot(p, "21-phone-wizard-start-390");
    for (const choice of ["claude", "chatgpt", "key"]) {
      await p.locator(`[data-setup="choice"][data-choice="${choice}"]`).click();
      await p.locator("#setupAiPanel details.ai-guide").first().waitFor().catch(() => {});
      if (choice === "key") {
        await p.locator('#setupAiPanel [data-setup="provider"][data-provider="openrouter"]').click();
        await p.locator('#setupAiPanel details.ai-guide[data-ai-guide="openrouter"]').waitFor();
      }
      await noSideScroll(p, `phone wizard ${choice}`, "src/public/css/style.css");
      // The wizard scrolls inside itself (the page doesn't): Next must be reachable.
      const reach = await p.evaluate(() => {
        const w = document.getElementById("setupWizard");
        const next = document.getElementById("setupAiNext");
        next.scrollIntoView({ block: "center" });
        const r = next.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, ih: window.innerHeight, wizardOverflowY: getComputedStyle(w).overflowY };
      });
      check(reach.top >= 0 && reach.bottom <= reach.ih, `phone wizard ${choice}: Next can be scrolled to`, { file: "src/public/css/style.css", evidence: JSON.stringify(reach) });
      await shot(p, `22-phone-wizard-${choice}-390`);
    }
    // Local AI is Ready (saved from the desktop): its card at phone width too.
    await p.locator('#setupAiPanel [data-setup="provider"][data-provider="local"]').click();
    await p.locator("#setupAiPanel .setup-ai-status", { hasText: "Ready" }).waitFor({ timeout: 15_000 });
    await noSideScroll(p, "phone wizard local ready", "src/public/css/style.css");
    await shot(p, "23-phone-wizard-local-390");
  } finally {
    await ctx.close();
  }
});

// ======================================================================================================================
// 4. Finish the wizard on Local AI (desktop)
// ======================================================================================================================

await step("wizard: Next saves Local AI as the default, keys-only off; skills, personality skipped", async () => {
  const before = apiCalls.length;
  await page.locator("#setupAiNext").click();
  await page.getByText("Choose Your Skills").waitFor({ timeout: 20_000 });
  const writes = apiCalls.slice(before).filter((c) => c.method !== "GET" && c.path.startsWith("/api/ai/"));
  check(writes.some((c) => c.path === "/api/ai/active" && c.status === 200), "wizard Next: PUT /api/ai/active saved", { file: WIZ, evidence: JSON.stringify(writes.map(({ body, ...c }) => c)) });
  check(!writes.some((c) => c.path === "/api/ai/keys-only"), "wizard Next: keys-only left alone for 'Just me'", { file: WIZ, evidence: JSON.stringify(writes.map(({ body, ...c }) => c)) });
  const p = await providersNow(desk);
  check(p.active?.provider === "local" && p.active?.ready, "wizard Next: Local AI is the ready default", { file: "src/routes/ai.js", evidence: JSON.stringify(p.active) });
  check(p.active?.model === "e2e-local-model", "wizard Next: with the model chosen", { file: "src/routes/ai.js", evidence: JSON.stringify(p.active) });
  await page.locator("#setupSkillsNone").click();
  await page.locator("#setupSkillsSave").click();
  await page.locator("#setupSkipInterview").waitFor({ timeout: 20_000 });
  await page.locator("#setupSkipInterview").click();
  await page.locator("#setupChannelSettings").waitFor({ timeout: 20_000 });
  await shot(page, "09-wizard-channels-1280");
  await page.locator("#setupChannelSettings").click();
  await page.locator(".settings-tab[data-tab=\"ai\"]").waitFor({ timeout: 20_000 });
});

// ======================================================================================================================
// 5. Settings > AI (desktop)
// ======================================================================================================================

const SET = "src/public/js/settings.js";
const card = (id) => page.locator(`#${id}AiCard`);
/** Wait until, after index from, the calls in seq ([method, path]) have come back in that order. */
async function callsAfter(from, seq, timeout = 40_000) {
  const until = Date.now() + timeout;
  for (;;) {
    let i = from; let ok = true;
    for (const [m, p] of seq) {
      const j = apiCalls.findIndex((c, k) => k >= i && c.method === m && c.path.split("?")[0] === p);
      if (j < 0) { ok = false; break; }
      i = j + 1;
    }
    if (ok) { await new Promise((r) => setTimeout(r, 400)); return; }
    if (Date.now() > until) throw new Error(`timed out waiting for ${seq.map((x) => x.join(" ")).join(" -> ")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function cardTestLine(id) {
  await page.waitForFunction((cid) => {
    const t = document.querySelector(`#${cid}AiCard [data-ai-test]`)?.textContent || "";
    return t && !/Testing…|Checking…/.test(t);
  }, id, { timeout: 30_000 });
  return { text: (await card(id).locator("[data-ai-test]").innerText()).trim(), tone: await card(id).locator("[data-ai-test]").getAttribute("data-tone") };
}

await step("Settings > AI: chips, a card per provider, status lines, guides", async () => {
  await page.locator('.settings-tab[data-tab="ai"]').click();
  await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor();
  await page.locator("#aiChips .ai-chip").first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !/Checking/.test(document.getElementById("aiDefaultNow")?.textContent || "Checking"));
  const chips = (await page.locator("#aiChips .ai-chip").allInnerTexts()).map((s) => s.trim());
  check(chips.length === 7, "Settings > AI: one chip per provider", { file: SET, evidence: JSON.stringify(chips) });
  for (const id of ALL_IDS) {
    check(chips.some((c) => c.startsWith(`${LABEL[id]} ·`)), `Settings > AI: a chip for ${LABEL[id]}`, { file: SET, evidence: JSON.stringify(chips) });
  }
  check(chips.some((c) => /^Local AI · Ready · default$/.test(c)), "Settings > AI: the default's chip says Ready · default", { file: SET, evidence: JSON.stringify(chips) });
  const def = await page.locator("#aiDefaultNow").innerText();
  check(/✓ Local AI, using e2e-local-model/.test(def), "Settings > AI: the Default AI line", { file: SET, evidence: def });
  const p = await providersNow(desk);
  for (const id of ALL_IDS) {
    const c = card(id);
    check(await c.isVisible(), `Settings > AI: the ${CARD_NAME[id]} card is shown`, { file: SET });
    const status = (await page.locator(`#${id}AiStatus`).innerText()).trim();
    check(status && !/Checking/.test(status), `Settings > AI ${id}: a status line`, { file: SET, evidence: status });
    const ready = p.providers.find((x) => x.id === id)?.ready;
    const open = await c.locator("details.ai-guide").evaluate((d) => d.open).catch(() => null);
    check(open === !ready, `Settings > AI ${id}: guide ${ready ? "folded (ready)" : "unfolded until ready"}`, { file: SET, evidence: `open=${open} ready=${ready}` });
    checkLinks(await linksIn(page, `#${id}AiCard`), `Settings > AI ${id} card`, "src/public/js/provider-guides-core.js");
  }
  checkLinks(await linksIn(page, "#aiTermsNote"), "Settings > AI terms note", "src/public/js/provider-guides-core.js");
  // Jump chips go to their card.
  await page.locator('#aiChips .ai-chip[data-ai-jump="deepseek"]').click();
  // (A smooth scroll: the further the card, the longer it takes, so wait for it to arrive rather than a fixed time.)
  const inView = await page.waitForFunction(() => {
    const r = document.getElementById("deepseekAiCard")?.getBoundingClientRect();
    return !!r && r.top >= 0 && r.top < window.innerHeight / 2;   // its top in the upper half: scrolled to its start
  }, null, { timeout: 4000 }).then(() => true, () => false);
  check(inView, "Settings > AI: a chip jumps to its card", { file: SET });
  await shot(page, "10-settings-ai-top-1280");
});

await step("Settings > AI: key cards, masked key box with source, Save, Test refused, Remove", async () => {
  for (const id of KEY_IDS) {
    const c = card(id);
    await c.scrollIntoViewIfNeeded();
    const src0 = (await c.locator(".ai-keysource").innerText()).trim();
    check(/No key yet/.test(src0), `Settings ${id}: says no key yet`, { file: SET, evidence: src0 });
    const input = page.locator(`#aiKey-${id}`);
    check((await input.getAttribute("type")) === "password", `Settings ${id}: the key box is masked`, { file: SET });
    check(await c.locator('[data-ai-action="test"]').isVisible(), `Settings ${id}: a Test button`, { file: SET });
    check(!(await c.locator('[data-ai-action="use"]').isEnabled()), `Settings ${id}: Use this AI is off until Ready`, { file: SET });
    await input.fill(FAKE_KEYS[id]);
    await paceTests();
    let mark = apiCalls.length;
    await c.locator('[data-ai-action="save-key"]').click();
    await callsAfter(mark, [["PUT", `/api/ai/keys/${id}`], ["POST", `/api/ai/test/${id}`], ["GET", "/api/ai/providers"], ["GET", "/api/settings"]]);
    const line = await cardTestLine(id);
    const src1 = (await c.locator(".ai-keysource").innerText()).trim();
    const last4 = FAKE_KEYS[id].slice(-4);
    check(/Saved in Tarsee \(encrypted\)/.test(src1) && src1.includes(`…${last4}`), `Settings ${id}: the key box shows its source and only the last 4`, { file: SET, evidence: src1 });
    check(!src1.includes(CANARY), `Settings ${id}: the key itself is not shown`, { file: SET, evidence: src1 });
    check(line.tone === "bad" && /rejected|turned this key down/i.test(line.text), `Settings ${id}: Test shows the real site's refusal`, { file: SET, evidence: `${line.tone}: ${line.text}` });
    const status = (await page.locator(`#${id}AiStatus`).innerText()).trim();
    check(/✗/.test(status) && /rejected|turned/i.test(status), `Settings ${id}: the status line says the key was rejected`, { file: "src/ai/provider-status.js", evidence: status });
    check(!(await c.locator('[data-ai-action="use"]').isEnabled()), `Settings ${id}: a refused key can't be made the default`, { file: SET });
    const chip = (await page.locator(`#aiChips .ai-chip[data-ai-jump="${id}"]`).innerText()).trim();
    check(/Needs attention/.test(chip), `Settings ${id}: its chip turns to Needs attention`, { file: SET, evidence: chip });
    check(!(await page.content()).includes(CANARY), `Settings ${id}: the key is nowhere on the page after saving`, { file: SET });
    await shot(page, `11-settings-${id}-saved-refused-1280`);
    // Test again with the saved key (no typed one): the same refusal, read from the store.
    await paceTests();
    mark = apiCalls.length;
    await c.locator('[data-ai-action="test"]').click();
    await callsAfter(mark, [["POST", `/api/ai/test/${id}`], ["GET", "/api/ai/providers"], ["GET", "/api/settings"]]);
    const again = await cardTestLine(id);
    check(again.tone === "bad" && /rejected|turned this key down/i.test(again.text), `Settings ${id}: Test of the saved key is refused`, { file: SET, evidence: `${again.tone}: ${again.text}` });
    mark = apiCalls.length;
    await c.locator('[data-ai-action="remove-key"]').click();
    await answerDialog(page, "Remove");
    await callsAfter(mark, [["DELETE", `/api/ai/keys/${id}`], ["GET", "/api/ai/providers"], ["GET", "/api/settings"]]);
    await page.waitForFunction((cid) => /No key yet/.test(document.querySelector(`#${cid}AiCard .ai-keysource`)?.textContent || ""), id, { timeout: 15_000 });
    const after = (await providersNow(desk)).providers.find((x) => x.id === id);
    check(!after.keySource && after.state === "needs-key", `Settings ${id}: Remove deletes the key and clears the flag`, { file: "src/routes/ai.js", evidence: JSON.stringify({ keySource: after.keySource, state: after.state, detail: after.detail }) });
    const status2 = (await page.locator(`#${id}AiStatus`).innerText()).trim();
    check(!/rejected/i.test(status2), `Settings ${id}: the status line no longer says rejected after Remove`, { file: SET, evidence: status2 });
    const guideOpen = await c.locator("details.ai-guide").evaluate((d) => d.open);
    check(guideOpen, `Settings ${id}: the guide is unfolded again (not ready)`, { file: SET });
  }
});

await step("Settings > AI: Claude plan signs in (placeholder sign-in file), Use this AI + model select, header chip", async () => {
  // Stand-in for `claude auth login` having run: provider-status.js only looks for the file.
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude", ".credentials.json"), "{}");
  note("The Claude plan was made Ready by an empty placeholder .credentials.json in the temp HOME (no real sign-in, no turn sent).");
  const c = card("claude");
  await c.scrollIntoViewIfNeeded();
  await paceTests();
  await c.locator('[data-ai-action="test"]').click();
  await page.locator("#claudeAiStatus", { hasText: "Ready" }).waitFor({ timeout: 15_000 });
  await page.locator("#aiModel-claude option").first().waitFor({ state: "attached" });
  const opts = await page.locator("#aiModel-claude option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  check(opts.length >= 2, "Settings claude: the model select lists Claude's models", { file: SET, evidence: JSON.stringify(opts) });
  const pick = opts.find((o) => /sonnet/i.test(o.v)) || opts[0];
  await page.locator("#aiModel-claude").selectOption(pick.v);
  const useBtn = c.locator('[data-ai-action="use"]');
  check(await useBtn.isEnabled(), "Settings claude: Use this AI is on once Ready", { file: SET });
  await useBtn.click();
  await page.locator("#aiDefaultNow", { hasText: "Claude plan" }).waitFor({ timeout: 15_000 });
  const def = await page.locator("#aiDefaultNow").innerText();
  check(/✓ Claude plan, using/.test(def), "Settings: the Default AI line follows Use this AI", { file: SET, evidence: def });
  const p = await providersNow(desk);
  check(p.active.provider === "claude" && String(p.active.model || "").toLowerCase().includes(String(pick.v).toLowerCase().replace(/\[1m\]$/, "")), "Settings: the chosen model is saved with the default", { file: "src/routes/ai.js", evidence: JSON.stringify({ chosen: pick.v, active: p.active }) });
  await page.locator("#aiHeaderChip:not([hidden])").waitFor();
  const chipText = await page.locator("#aiHeaderChipText").innerText();
  check(/^Claude plan/.test(chipText.trim()), "header chip: names the new default", { file: SET, evidence: chipText });
  check((await page.locator("#aiHeaderChip .channel-dot").getAttribute("data-tone")) === "ok", "header chip: green dot when ready", { file: SET });
  await shot(page, "12-settings-claude-default-1280");
  // The composer, right after the default changed: its button and its list.
  await page.evaluate(() => Settings.close());
  await page.waitForTimeout(500);
  const btnText = (await page.locator("#modelPickerBtn").innerText()).trim();
  check(!/e2e-local-model/.test(btnText), "composer: after Use this AI (Claude plan) the model button no longer shows the old default's model", {
    file: "src/public/js/chat.js", detail: "Settings > AI dispatches tarsee:ai-changed, but nothing listens for it, so the composer keeps the old default until its 5-minute cache runs out.", evidence: btnText,
  });
  await page.locator("#modelPickerBtn").click();
  await page.locator(".mp-menu .mp-group[aria-label]").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  const groups = await page.locator(".mp-menu .mp-group[aria-label]").evaluateAll((gs) => gs.map((g) => g.getAttribute("aria-label")));
  const listCalls = apiCalls.filter((c) => c.where === "desktop" && c.path === "/api/chat/models").map((c) => new Date(c.at).toISOString());
  check(groups.includes("Claude plan"), "model picker: opened right after the Claude plan turned Ready and became the default, it lists the Claude plan", {
    file: "src/public/js/chat.js", detail: "refreshPicker() only asks GET /api/chat/models again when its copy is over 5 minutes old; the tarsee:ai-changed event Settings sends has no listener.", evidence: `groups ${JSON.stringify(groups)}; GET /api/chat/models at ${listCalls.join(", ")}`,
  });
  await shot(page, "12b-composer-after-default-change-1280");
  await page.keyboard.press("Escape");
  // With a forced refresh the list is right: the stale copy, not the server, was the problem.
  await page.evaluate(() => Chat.refreshPicker(true));
  await page.locator("#modelPickerBtn").click();
  await page.waitForTimeout(800);
  const fresh = await page.locator(".mp-menu .mp-group[aria-label]").evaluateAll((gs) => gs.map((g) => g.getAttribute("aria-label")));
  check(fresh.includes("Claude plan"), "model picker: after a forced refresh the server's list has the Claude plan", { file: "src/lib/model-catalog.js", evidence: JSON.stringify(fresh) });
  await page.keyboard.press("Escape");
  await page.locator("#aiHeaderChip").click();
  await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor({ timeout: 10_000 });
});

await step("Settings > AI: Only use API keys (asks first while a plan is the default), then off", async () => {
  await page.locator("#aiKeysOnly").scrollIntoViewIfNeeded();
  await page.locator("#aiKeysOnly").check();
  await answerDialog(page, "Switch it on");
  await page.locator("#claudeAiStatus", { hasText: "Only use API keys" }).waitFor({ timeout: 15_000 });
  const p = await providersNow(desk);
  check(p.keysOnly.on === true, "keys-only: saved on", { file: "src/routes/ai.js", evidence: JSON.stringify(p.keysOnly) });
  check(!p.active.ready, "keys-only: the plan default is no longer ready", { file: "src/ai/provider-status.js", evidence: JSON.stringify(p.active) });
  const chip = await page.locator("#aiHeaderChip .channel-dot").getAttribute("data-tone");
  check(chip === "bad", "keys-only: the header chip turns red", { file: SET, evidence: chip });
  check(await page.locator("#aiAttention").isVisible(), "keys-only: a banner says the default can't answer", { file: SET });
  await shot(page, "13-settings-keysonly-on-1280");
  await page.locator("#aiKeysOnly").uncheck();
  await page.locator("#claudeAiStatus", { hasText: "Ready" }).waitFor({ timeout: 15_000 });
  check((await providersNow(desk)).keysOnly.on === false, "keys-only: saved off", { file: "src/routes/ai.js" });
  // Back to Local AI as the default.
  await card("local").scrollIntoViewIfNeeded();
  await card("local").locator('[data-ai-action="use"]').click();
  await page.locator("#aiDefaultNow", { hasText: "Local AI" }).waitFor({ timeout: 15_000 });
  check((await providersNow(desk)).active.provider === "local", "Use this AI: Local AI is the default again", { file: "src/routes/ai.js" });
});

await step("Settings > AI: backup model and monthly cap", async () => {
  const sel = page.locator("#aiBackupModel");
  await sel.scrollIntoViewIfNeeded();
  const opts = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  check(opts[0]?.v === "" && opts.some((o) => o.v.startsWith("claude:")) && opts.some((o) => o.v.startsWith("local:")), "backup: lists Off and every ready AI", { file: SET, evidence: JSON.stringify(opts) });
  const backup = opts.find((o) => o.v.startsWith("claude:")).v;
  await sel.selectOption(backup);
  await page.locator("#aiMonthlyCap").fill("20");
  await page.locator("#aiSaveExtrasBtn").click();
  await page.getByText("Saved: backup on, cap $20 a month").waitFor({ timeout: 10_000 });
  const settings = (await (await desk.request.get(`${ORIGIN}/api/settings`)).json()).settings || [];
  const get = (k) => settings.find((s) => s.key === k)?.value;
  check(get("ai.backupModel") === backup, "backup: saved", { file: SET, evidence: JSON.stringify(get("ai.backupModel")) });
  check(String(get("ai.spendCap.monthlyUsd")) === "20", "cap: saved", { file: SET, evidence: JSON.stringify(get("ai.spendCap.monthlyUsd")) });
  // (The toast shows once both are saved; the cards are read again just after, and the spend line then names the cap.)
  await page.locator("#aiMonthSpend", { hasText: "of your $20 cap" }).waitFor({ timeout: 10_000 }).catch(() => {});
  const spend = await page.locator("#aiMonthSpend").innerText();
  // Nothing spent yet, so nothing is estimated: no "(est.)" (GET /api/ai/providers spend.costNote is "exact").
  check(/Spent so far this month: \$0\.00 of your \$20 cap\./.test(spend), "cap: this month's spend beside it", { file: SET, evidence: spend });
  const costNote = (await providersNow(desk)).spend?.costNote;
  check(costNote === "exact", "cap: with nothing spent, the month's figure isn't called an estimate", { file: "src/routes/ai.js", evidence: JSON.stringify(costNote) });
  check((await sel.inputValue()) === backup && (await page.locator("#aiMonthlyCap").inputValue()) === "20", "backup and cap show what was saved after the redraw", { file: SET });
  await shot(page, "14-settings-backup-cap-1280");
  // Cap off again.
  await page.locator("#aiMonthlyCap").fill("");
  await sel.selectOption("");
  await page.locator("#aiSaveExtrasBtn").click();
  await page.getByText("Saved: backup off, no monthly cap").waitFor({ timeout: 10_000 });
});

await step("Settings > AI: ChatGPT card, Sign in shows link and code, Cancel", async () => {
  const c = card("chatgpt");
  await c.scrollIntoViewIfNeeded();
  await c.locator('[data-ai-action="chatgpt-login"]').click();
  const code = c.locator(".ai-device-code");
  try { await code.waitFor({ timeout: 45_000 }); } catch {
    check(false, "Settings chatgpt: Sign in shows a code", { file: "src/ai/codex-device-login.js", evidence: await c.locator("[data-ai-device]").innerText().catch(() => "") });
    return;
  }
  checkLinks(await linksIn(page, "#chatgptAiCard [data-ai-device]"), "Settings chatgpt sign-in box", SET);
  await shot(page, "15-settings-chatgpt-code-1280");
  await c.locator('[data-ai-action="chatgpt-cancel"]').click();
  await c.locator("[data-ai-device]").waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForTimeout(3500);
  check(await c.locator("[data-ai-device]").isHidden(), "Settings chatgpt: the box stays closed after Cancel", { file: SET });
  const leftover = ourCodex();
  check(!leftover.length, "Settings chatgpt: Cancel stops Codex", { file: "src/ai/codex-device-login.js", evidence: leftover.join(",") });
});

await step("header chip opens Settings > AI; Security tab lists the server's tools", async () => {
  await page.evaluate(() => Settings.close());
  await page.locator("#aiHeaderChip:not([hidden])").click();
  await page.locator('.settings-tab-panel[data-tab="ai"].active').waitFor({ timeout: 10_000 });
  check(true, "header chip: opens Settings > AI");
  const chipText = (await page.locator("#aiHeaderChipText").innerText()).trim();
  check(/^Local AI · e2e-local-model$/.test(chipText), "header chip: the default AI and its model", { file: SET, evidence: chipText });
  await page.locator('.settings-tab[data-tab="security"]').click();
  await page.locator(".tool-perm-row").first().waitFor({ timeout: 20_000 });
  const server = await (await desk.request.get(`${ORIGIN}/api/admin/tool-registry`)).json();
  const rows = await page.locator(".tool-perm-row .tool-perm-name > span").allInnerTexts();
  check(Array.isArray(server) && rows.length === server.length, "Security: one row per tool the server lists", { file: SET, evidence: `server ${server.length}, page ${rows.length}` });
  const labels = new Set(server.map((t) => t.label || t.name));
  check(rows.every((r) => labels.has(r.trim())), "Security: every row is a tool from the server", { file: SET, evidence: rows.filter((r) => !labels.has(r.trim())).join(", ") });
  check(apiCalls.some((c) => c.path.startsWith("/api/admin/tool-registry") && c.status === 200), "Security: the list came from GET /api/admin/tool-registry", { file: SET });
  const builtIn = server.filter((t) => !t.policyCovered).length;
  const fixed = await page.locator(".tool-perm-fixed").count();
  check(builtIn === fixed, "Security: the engines' built-in tools say Always on", { file: SET, evidence: `${builtIn} vs ${fixed}` });
  await shot(page, "16-settings-security-1280");
});

await step("chat: the model picker groups models by provider", async () => {
  await page.evaluate(() => Settings.close());
  const btn = page.locator("#modelPickerBtn");
  await btn.waitFor({ timeout: 10_000 });
  await btn.click();
  const menu = page.locator(".mp-menu, [role=menu]").first();
  await menu.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const groups = await page.locator(".mp-group[aria-label]").evaluateAll((gs) => gs.map((g) => g.getAttribute("aria-label")));
  check(groups.includes("Local AI") && groups.includes("Claude plan"), "model picker: a group per ready AI (Local AI, Claude plan)", { file: "src/public/js/model-picker.js", evidence: JSON.stringify(groups) });
  check(groups[0] === "Local AI", "model picker: the default AI first", { file: "src/lib/model-catalog.js", evidence: JSON.stringify(groups) });
  const notReady = ["DeepSeek", "OpenRouter", "Anthropic API key", "OpenAI API key", "ChatGPT plan"].filter((g) => groups.includes(g));
  check(!notReady.length, "model picker: AIs that aren't ready have no group", { file: "src/lib/model-catalog.js", evidence: JSON.stringify(groups) });
  await menuOnTop(page, "desktop model picker", "src/public/css/chat-ui.css");
  const btnNow = (await page.locator("#modelPickerBtn").innerText()).trim();
  const chipNow = (await page.locator("#aiHeaderChipText").innerText()).trim();
  check(/e2e-local-model/.test(btnNow), "composer: the model button names the default AI's model (Local AI) once the default is back on Local AI", {
    file: "src/public/js/chat.js", detail: "The header chip and the composer disagree about which AI a new message goes to.", evidence: `button "${btnNow}", header chip "${chipNow}"`,
  });
  await shot(page, "17-chat-model-picker-1280");
  await page.keyboard.press("Escape");
});

// ======================================================================================================================
// 6. Phone width (390px), after setup
// ======================================================================================================================

await step("phone 390px: chat, model picker, Settings > AI, Security", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await desk.storageState() });
  watch(ctx, "phone2");
  const p = await ctx.newPage();
  watchPage(p, "phone2");
  try {
    await p.goto(ORIGIN + "/");
    await p.locator("#appScreen").waitFor({ state: "visible", timeout: 20_000 });
    await p.locator("#aiHeaderChip:not([hidden])").waitFor({ timeout: 15_000 });
    await noSideScroll(p, "phone chat", "src/public/css/style.css");
    await shot(p, "30-phone-chat-390");
    await p.locator("#modelPickerBtn").click();
    await p.locator(".mp-group[aria-label]").first().waitFor({ timeout: 10_000 });
    await noSideScroll(p, "phone model picker", "src/public/css/chat-ui.css");
    const groups = await p.locator(".mp-group[aria-label]").evaluateAll((gs) => gs.map((g) => g.getAttribute("aria-label")));
    check(groups.includes("Local AI") && groups.includes("Claude plan"), "phone model picker: grouped by AI", { file: "src/public/js/model-picker.js", evidence: JSON.stringify(groups) });
    await menuOnTop(p, "phone model picker", "src/public/css/chat-ui.css");
    await shot(p, "31-phone-model-picker-390");
    await p.keyboard.press("Escape");
    await p.locator("#aiHeaderChip").click();
    await p.locator('.settings-tab-panel[data-tab="ai"].active').waitFor({ timeout: 10_000 });
    await p.locator("#aiChips .ai-chip").first().waitFor({ timeout: 15_000 });
    await p.waitForTimeout(800);
    await noSideScroll(p, "phone Settings > AI", "src/public/css/style.css");
    await shot(p, "32-phone-settings-ai-390");
    // A refused key at phone width: the long refusal line must wrap.
    await p.locator("#aiKey-openrouter").fill(FAKE_KEYS.openrouter);
    await paceTests();
    const pmark = apiCalls.length;
    await p.locator('#openrouterAiCard [data-ai-action="test"]').click();
    await callsAfter(pmark, [["POST", "/api/ai/test/openrouter"], ["GET", "/api/ai/providers"]]);
    await p.waitForFunction(() => { const t = document.querySelector("#openrouterAiCard [data-ai-test]")?.textContent || ""; return t && !/Testing/.test(t); }, null, { timeout: 30_000 });
    const line = await p.locator("#openrouterAiCard [data-ai-test]").innerText();
    check(/✗/.test(line), "phone Settings: Test of a typed key (not saved) is refused", { file: SET, evidence: line });
    const after = (await providersNow(ctx)).providers.find((x) => x.id === "openrouter");
    check(!after.keySource, "phone Settings: Test of a typed key does not save it", { file: "src/routes/ai.js", evidence: JSON.stringify({ keySource: after.keySource }) });
    await p.locator("#aiKey-openrouter").fill("");
    await p.locator("#openrouterAiCard").scrollIntoViewIfNeeded();
    await noSideScroll(p, "phone Settings > AI after a refusal", "src/public/css/style.css");
    await shot(p, "33-phone-settings-openrouter-390");
    await p.locator('.settings-tab[data-tab="security"]').click();
    await p.locator(".tool-perm-row").first().waitFor({ timeout: 20_000 });
    await noSideScroll(p, "phone Security", "src/public/css/style.css");
    await shot(p, "34-phone-security-390");
  } finally {
    await ctx.close();
  }
});

// ======================================================================================================================
// 7. The guides' links answer
// ======================================================================================================================

await step("every external link in the guides answers", async () => {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  for (const [href, where] of externalLinks) {
    let status = null; let err = null; let final = null;
    try {
      const r = await fetch(href, { redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
      status = r.status; final = r.url;
      try { await r.body?.cancel(); } catch { /* fine */ }
    } catch (e) { err = e.cause?.code || e.name || e.message; }
    if (status && [401, 403, 429, 503].includes(status)) note(`link ${href} answered HTTP ${status} to a script (bot protection); not counted as broken`);
    check(!err && status && (status < 400 || [401, 403, 429, 503].includes(status)), `link works: ${href}`, {
      file: "src/public/js/provider-guides-core.js", detail: `Shown in ${where}.`, evidence: err ? `error ${err}` : `HTTP ${status} -> ${final}`,
    });
  }
});

// ======================================================================================================================
// 8. Close down and sweep for leaks
// ======================================================================================================================

await desk.close();
await browser.close();
browser = null;
for (const { child } of started) killTree(child);
await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => localAi.close(() => r()));

check(!consoleErrors.length, "no console errors or page errors", {
  file: "", detail: "Every console.error and uncaught page error, on every page.", evidence: consoleErrors.map((e) => `[${e.where}] ${e.text} ${e.url}`).join("\n"),
});
check(!leakHits.length, "no canary key or secret in any HTTP response or WebSocket frame", { file: "src/routes/ai.js", evidence: JSON.stringify(leakHits) });
const outHits = scanSecrets(serverOut);
check(!outHits.length, "no canary key or secret in the server's stdout/stderr", { file: "", evidence: outHits.join(", ") });

// The state folder: no fake key written anywhere in plain text.
const fileHits = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== "node_modules") walk(f); continue; }
    try {
      const st = fs.statSync(f);
      if (st.size > 50 * 1024 * 1024) continue;
      const buf = fs.readFileSync(f);
      if (buf.includes(CANARY) || buf.includes(Buffer.from(CANARY, "utf16le"))) fileHits.push(path.relative(stateDir, f));
    } catch { /* locked */ }
  }
})(stateDir);
check(!fileHits.length, "no fake key in plain text anywhere in the state folder", { file: "src/db/settings.js", evidence: fileHits.join(", ") });
const localProbe = (h) => /^GET \/v1\/models\b/.test(h) || /^POST \/v1\/responses\/?$/.test(h);
check(!localHits.some((h) => !localProbe(h)), "the Local AI server only saw model-list reads and Test's Responses API check (no turn ran)", { file: "", evidence: localHits.join(", ") });

const codexAfter = ourCodex();
check(!codexAfter.length, "no codex.exe left running", { file: "src/ai/codex-device-login.js", evidence: codexAfter.join(",") });

const serverLog = path.join(SHOTS, "server-output.log");
fs.writeFileSync(serverLog, serverOut.replaceAll(SETUP_PASSWORD, "<SETUP_PASSWORD>").replaceAll(ENCRYPTION_KEY, "<ENCRYPTION_KEY>"));
fs.writeFileSync(path.join(SHOTS, "api-calls.json"), JSON.stringify(apiCalls.map(({ body, ...c }) => ({ ...c, body: body && body.length > 600 ? `${body.slice(0, 600)}…` : body })), null, 2));
results.serverLog = serverLog;
results.consoleErrors = consoleErrors;

try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { note(`couldn't remove ${stateDir}`); }
try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { note(`couldn't remove ${homeDir}`); }

log(`done: ${results.passed} passed, ${results.failures.length} failed`);
for (const f of results.failures) log(" -", f.title, "|", String(f.evidence).slice(0, 400));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
process.exitCode = results.failures.length ? 1 : 0;
