#!/usr/bin/env node
// End-to-end: "Choose your AI" and Settings > AI when Railway variables already hold provider keys, on a REAL Tarsee
// server, in a browser. Companion of scripts/e2e/ai-ui.e2e.mjs (same rules).
//
//   node scripts/e2e/ai-ui-railway.e2e.mjs [--shots <dir>] [--out <results.json>]
//
// The server boots fresh (temp TARSEE_STATE_DIR and HOME, a SETUP_PASSWORD and ENCRYPTION_KEY made up now) with
// made-up OPENROUTER_API_KEY and DEEPSEEK_API_KEY in its environment, the way an owner sets them in Railway. The real
// openrouter.ai and api.deepseek.com refuse those keys. What the wizard and Settings say about them is checked:
//   - the wizard says Railway variables connect them, and shows where each key comes from, masked
//   - a key the provider refuses is not offered as Ready, can be tested from the wizard, and isn't taken by Next
//   - Settings > AI shows the Railway source (masked), Test refuses it, and no Remove is offered for a variable
// Since neither Railway key is Ready, the wizard is finished on a loopback "Local AI" (standing in for the owner's
// own server, answering only GET /v1/models) to reach Settings.
// Fails on any console error, and on a key in the server's output, any response, or the state folder.
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

const results = { passed: 0, failures: [], notes: [], shots: [] };
const t0 = Date.now();
const log = (...a) => console.log(`[e2e-railway ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
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

const rnd = (n) => crypto.randomBytes(n).toString("hex");
const SETUP_PASSWORD = `e2e-${rnd(12)}`;
const ENCRYPTION_KEY = rnd(32);
const CANARY = `testcanary${rnd(8)}`;
const ENV_KEYS = {
  openrouter: `sk-or-v1-0000${CANARY}E${rnd(8)}`,
  deepseek: `sk-${CANARY}F${rnd(8)}`,
};
const VAR = { openrouter: "OPENROUTER_API_KEY", deepseek: "DEEPSEEK_API_KEY" };
const scanSecrets = (text) => {
  const s = String(text ?? "");
  const hits = [];
  if (s.includes(CANARY)) hits.push("canary");
  if (s.includes(SETUP_PASSWORD)) hits.push("SETUP_PASSWORD");
  if (s.includes(ENCRYPTION_KEY)) hits.push("ENCRYPTION_KEY");
  return hits;
};

const started = [];
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch { /* gone */ }
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-e2e-state-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-e2e-home-"));
const port = await freePort();
const ORIGIN = `http://127.0.0.1:${port}`;
const CRED_NAME_RE = /^(ANTHROPIC_|OPENAI_|OPENROUTER_|DEEPSEEK_|CLAUDE|CODEX_|TARSEE_|AWS_BEARER|SETUP_PASSWORD$|ENCRYPTION_KEY$|NODE_ENV$|PORT$)/i;
const serverEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!CRED_NAME_RE.test(k)) serverEnv[k] = v;
Object.assign(serverEnv, {
  PORT: String(port), TARSEE_STATE_DIR: stateDir, SETUP_PASSWORD, ENCRYPTION_KEY, HOME: homeDir, USERPROFILE: homeDir,
  TARSEE_PHONON_AUTO_INSTALL: "0", OPENROUTER_API_KEY: ENV_KEYS.openrouter, DEEPSEEK_API_KEY: ENV_KEYS.deepseek,
});
let serverOut = "";
const server = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
started.push({ name: "server", child: server });
server.stdout.on("data", (d) => { serverOut += d.toString(); });
server.stderr.on("data", (d) => { serverOut += d.toString(); });
let browser = null;
const shutdown = async () => { try { await browser?.close(); } catch { /* gone */ } for (const { child } of started) killTree(child); localAi.close(); };
process.on("SIGINT", async () => { await shutdown(); process.exit(130); });

{
  const until = Date.now() + 60_000;
  let up = false;
  while (Date.now() < until && server.exitCode === null) {
    try { const r = await fetch(`${ORIGIN}/healthz`); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) { console.error(serverOut); await shutdown(); throw new Error("The server didn't come up within 60 s"); }
  log("server up at", ORIGIN);
}

browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA || "", "ms-playwright/chromium-1234/chrome-win64/chrome.exe") });
const consoleErrors = [];
const leakHits = [];
const apiCalls = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
ctx.on("response", async (res) => {
  const u = new URL(res.url());
  if (u.origin !== ORIGIN) return;
  const entry = { at: Date.now(), method: res.request().method(), path: u.pathname + u.search, status: res.status() };
  if (u.pathname.startsWith("/api/")) apiCalls.push(entry);
  try {
    const ct = res.headers()["content-type"] || "";
    if (!/json|text|javascript|html/.test(ct)) return;
    const body = await res.text();
    if (u.pathname.startsWith("/api/")) entry.body = body.slice(0, 4000);
    const hits = scanSecrets(body);
    if (hits.length) leakHits.push({ where: `HTTP ${entry.method} ${u.pathname}`, what: hits.join(", ") });
  } catch { /* no body */ }
});
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`${m.text()} ${m.location()?.url || ""}`); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
const shot = async (name) => { const f = path.join(SHOTS, `${name}.png`); await page.screenshot({ path: f, fullPage: true }).catch(() => {}); results.shots.push(f); };
const providersNow = async () => (await ctx.request.get(`${ORIGIN}/api/ai/providers`)).json();

await step("login, the wizard says Railway variables connect OpenRouter and DeepSeek", async () => {
  await page.goto(ORIGIN + "/");
  await page.locator("#loginPassword").fill(SETUP_PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.getByText("Choose your AI").waitFor({ timeout: 20_000 });
  await page.locator("#setupAiChoices .setup-ai-choice").first().waitFor();
  await page.waitForTimeout(500);
  await shot("40-railway-wizard-start-1280");
  const p = await providersNow();
  for (const id of ["openrouter", "deepseek"]) {
    const c = p.providers.find((x) => x.id === id);
    check(c.keySource === `env:${VAR[id]}`, `railway ${id}: the key's source is the Railway variable`, { file: "src/ai/provider-status.js", evidence: JSON.stringify({ keySource: c.keySource }) });
    check(c.keyHint === `…${ENV_KEYS[id].slice(-4)}`, `railway ${id}: only the last 4 characters are shown`, { file: "src/ai/provider-status.js", evidence: c.keyHint });
    check(!c.ready, `railway ${id}: a Railway key the provider refuses is not shown as Ready`, {
      file: "src/ai/provider-probes.js",
      detail: "GET /api/ai/providers reads the balance with this key on every load (refreshBalance), and the provider answers 401; that answer is dropped (null), so no failure flag is set and the card stays Ready.",
      evidence: JSON.stringify({ state: c.state, ready: c.ready, detail: c.detail }),
    });
  }
  const env = (await page.locator("#setupAiEnv").innerText()).trim();
  note(`wizard Railway line: ${env || "(none)"}`);
});

await step("wizard: the Railway key's panel, can it be tested, does Next take it", async () => {
  const use = page.locator('[data-setup="use-env"][data-provider="openrouter"]');
  if (await use.count()) await use.click();
  else {
    await page.locator('[data-setup="choice"][data-choice="key"]').click();
    await page.locator('#setupAiPanel [data-setup="provider"][data-provider="openrouter"]').click();
  }
  await page.locator('#setupAiPanel details.ai-guide[data-ai-guide="openrouter"]').waitFor();
  const status = (await page.locator("#setupAiPanel .setup-ai-status").innerText()).trim();
  const src = (await page.locator("#setupAiPanel .ai-keysource").innerText().catch(() => "")).trim();
  check(/Railway variable OPENROUTER_API_KEY/.test(src) && src.includes(`…${ENV_KEYS.openrouter.slice(-4)}`) && !src.includes(CANARY), "wizard railway: the key box says where the key comes from, masked", { file: "src/public/js/setup.js", evidence: src });
  const buttons = (await page.locator("#setupAiPanel button").allInnerTexts()).map((b) => b.trim());
  const canTest = await page.locator('#setupAiPanel [data-setup="test"]').count();
  check(canTest > 0, "wizard railway: the key from the Railway variable can be tested without pasting it again", {
    file: "src/public/js/setup.js", detail: "_aiControlsHtml gives key providers only 'Test and save', which needs a pasted key; a Railway key has no Test.", evidence: JSON.stringify(buttons),
  });
  const nextOn = await page.locator("#setupAiNext").isEnabled();
  check(!nextOn, "wizard railway: Next is not offered on a key the provider refuses", {
    file: "src/public/js/setup.js", evidence: `status "${status}"; Next ${nextOn ? "enabled" : "disabled"} "${(await page.locator("#setupAiNext").innerText()).trim()}"`,
  });
  await shot("41-railway-wizard-openrouter-1280");
  if (nextOn) {
    const mark = apiCalls.length;
    await page.locator("#setupAiNext").click();
    await page.getByText("Choose Your Skills").waitFor({ timeout: 20_000 });
    const put = apiCalls.slice(mark).find((c) => c.path === "/api/ai/active");
    note(`wizard railway: Next saved the refused Railway key's AI as the default (PUT /api/ai/active ${put?.status})`);
  } else {
    // The refused keys can't finish the wizard: finish it on the owner's own Local AI instead, to reach Settings.
    const keyChoice = page.locator('[data-setup="choice"][data-choice="key"]');
    if (await keyChoice.isVisible().catch(() => false)) await keyChoice.click();
    await page.locator('#setupAiPanel [data-setup="provider"][data-provider="local"]').click();
    await page.locator("#setupLocalUrl").fill(LOCAL_URL);
    await page.locator('#setupAiPanel [data-setup="save-local"]').click();
    await page.locator("#setupAiPanel .setup-ai-status", { hasText: "Ready" }).waitFor({ timeout: 20_000 });
    await page.locator("#setupAiNext:not([disabled])").waitFor();
    const mark = apiCalls.length;
    await page.locator("#setupAiNext").click();
    await page.getByText("Choose Your Skills").waitFor({ timeout: 20_000 });
    const p = await providersNow();
    check(p.active?.provider === "local" && p.active?.ready && apiCalls.slice(mark).some((c) => c.path === "/api/ai/active" && c.status === 200), "wizard railway: with the Railway keys refused, Next takes the Local AI that is Ready instead", {
      file: "src/public/js/setup.js", evidence: JSON.stringify(p.active),
    });
    note("wizard railway: Next stayed off for the refused key; the wizard was finished on Local AI to reach Settings");
  }
  await page.locator("#setupSkillsNone").click();
  await page.locator("#setupSkillsSave").click();
  await page.locator("#setupSkipInterview").click();
  await page.locator("#setupChannelSettings").click();
  await page.locator('.settings-tab[data-tab="ai"]').click();
});

await step("Settings > AI: the Railway key's card", async () => {
  const shown = await page.locator('.settings-tab-panel[data-tab="ai"]').isVisible().catch(() => false);
  check(shown, "Settings railway: Settings > AI opened after the wizard", { file: "src/public/js/setup.js" });
  if (!shown) return;
  await page.locator("#aiChips .ai-chip").first().waitFor({ timeout: 15_000 });
  const c = page.locator("#openrouterAiCard");
  await c.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const src = (await c.locator(".ai-keysource").innerText()).trim();
  check(/Railway variable OPENROUTER_API_KEY/.test(src) && src.includes(`…${ENV_KEYS.openrouter.slice(-4)}`), "Settings railway: the key box shows the Railway source, masked", { file: "src/public/js/settings.js", evidence: src });
  check(await c.locator('[data-ai-action="remove-key"]').count() === 0, "Settings railway: no Remove for a Railway variable", { file: "src/public/js/settings.js" });
  const statusBefore = (await page.locator("#openrouterAiStatus").innerText()).trim();
  const header = (await page.locator("#aiHeaderChipText").innerText()).trim();
  const dot = await page.locator("#aiHeaderChip .channel-dot").getAttribute("data-tone");
  note(`Settings railway before Test: status "${statusBefore}", header "${header}" (${dot})`);
  const mark = apiCalls.length;
  await c.locator('[data-ai-action="test"]').click();
  for (let i = 0; i < 300 && !apiCalls.slice(mark).some((x) => x.path === "/api/settings"); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  const line = (await c.locator("[data-ai-test]").innerText()).trim();
  check(/✗/.test(line) && /rejected/i.test(line), "Settings railway: Test shows OpenRouter's refusal", { file: "src/public/js/settings.js", evidence: line });
  const statusAfter = (await page.locator("#openrouterAiStatus").innerText()).trim();
  check(/rejected/i.test(statusAfter), "Settings railway: after Test the status line says the key was rejected", { file: "src/ai/provider-probes.js", evidence: statusAfter });
  await shot("42-railway-settings-openrouter-1280");
});

await ctx.close();
await browser.close();
browser = null;
for (const { child } of started) killTree(child);
await new Promise((r) => localAi.close(() => r()));
await new Promise((r) => setTimeout(r, 800));
const localProbe = (h) => /^GET \/v1\/models\b/.test(h) || /^POST \/v1\/responses\/?$/.test(h);
check(!localHits.some((h) => !localProbe(h)), "railway: the Local AI server only saw model-list reads and Test's Responses API check (no turn ran)", { evidence: localHits.join(", ") });

check(!consoleErrors.length, "railway: no console errors or page errors", { evidence: consoleErrors.join("\n") });
check(!leakHits.length, "railway: no Railway key in any HTTP response", { file: "src/routes/ai.js", evidence: JSON.stringify(leakHits) });
const outHits = scanSecrets(serverOut);
check(!outHits.length, "railway: no Railway key or secret in the server's stdout/stderr", { evidence: outHits.join(", ") });
const fileHits = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(f); continue; }
    try { const b = fs.readFileSync(f); if (b.includes(CANARY) || b.includes(Buffer.from(CANARY, "utf16le"))) fileHits.push(path.relative(stateDir, f)); } catch { /* locked */ }
  }
})(stateDir);
check(!fileHits.length, "railway: no Railway key written anywhere in the state folder", { file: "src/db/settings.js", evidence: fileHits.join(", ") });
fs.writeFileSync(path.join(SHOTS, "railway-server-output.log"), serverOut.split(SETUP_PASSWORD).join("<SETUP_PASSWORD>").split(ENCRYPTION_KEY).join("<ENCRYPTION_KEY>"));
fs.writeFileSync(path.join(SHOTS, "railway-api-calls.json"), JSON.stringify(apiCalls.map(({ body, ...c }) => ({ ...c, body: body?.slice(0, 600) })), null, 2));
try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { note(`couldn't remove ${stateDir}`); }
try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { note(`couldn't remove ${homeDir}`); }
log(`done: ${results.passed} passed, ${results.failures.length} failed`);
for (const f of results.failures) log(" -", f.title, "|", String(f.evidence).slice(0, 400));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
process.exitCode = results.failures.length ? 1 : 0;
