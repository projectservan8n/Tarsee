// The security checklist for more AI providers (design 4.15): the files API never serves a sign-in or a key home
// (safe-path.js), the redaction patterns cover every provider's key shape and OAuth token fields (redact.js), git
// ignores the new homes (.gitignore), and the security audit checks the default AI's credential, the sign-in file's
// mode, the key homes' isolation and an encryption key kept only on the volume (security-audit.js).
// Every key and token here is an obvious fake.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-ai-security-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.ENCRYPTION_KEY = "test-only-encryption-key-" + "0".repeat(40);
for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_AI_PROVIDER", "TARSEE_KEYS_ONLY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_HOME"]) delete process.env[name];

const { safePath, isSensitivePath } = await import("../src/lib/safe-path.js");
const { redactSecrets } = await import("../src/lib/redact.js");
const { runAudit, encryptionKeyOnVolume } = await import("../src/lib/security-audit.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opened = [];
after(() => { for (const db of opened) db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("safe-path: the files API never serves a sign-in or a key home", () => {
  const denied = [
    "/data/tarsee/.codex-home/auth.json",
    "/data/tarsee/.codex-home-keys/config.toml",
    "/data/tarsee/.codex/sessions/x.jsonl",
    "/data/tarsee/.claude-home-deepseek/settings.json",
    "/data/tarsee/.claude-home-openrouter/.claude.json",
    "/data/tarsee/.claude-home-anthropic/projects/a.jsonl",
    "/data/tarsee/tool-output/turn1/call1.txt",
    "/data/tarsee/workspace/project/auth.json",
    "/data/tarsee/workspace/AUTH.JSON",
    "C:\\Users\\me\\.Codex-Home\\auth.json",
    "C:\\Users\\me\\.CLAUDE-HOME-DEEPSEEK\\x",
    "C:\\Users\\me\\work\\auth.json.",
    "C:\\Users\\me\\work\\auth.json::$DATA",
  ];
  for (const p of denied) it(`denies ${p}`, () => assert.equal(isSensitivePath(p), true));

  const allowed = [
    "/data/tarsee/workspace/oauth.json",
    "/data/tarsee/workspace/authors.json",
    "/data/tarsee/workspace/my-auth.json",
    "/data/tarsee/workspace/.codexrc",
    "/data/tarsee/workspace/.claude-homework/notes.md",
    "/data/tarsee/workspace/tool-outputs.md",
  ];
  for (const p of allowed) it(`still serves ${p}`, () => assert.equal(isSensitivePath(p), false));

  it("safePath refuses them inside an allowed root", () => {
    const root = path.join(tmp, "root");
    assert.throws(() => safePath(".codex-home/auth.json", [root]), /not accessible/);
    assert.throws(() => safePath("sub/auth.json", [root]), /not accessible/);
    assert.throws(() => safePath(".claude-home-openrouter/settings.json", [root]), /not accessible/);
    assert.equal(safePath("sub/oauth.json", [root]), path.join(root, "sub", "oauth.json"));
  });
});

describe("redaction covers every provider's key shape and OAuth token fields", () => {
  const keys = [
    // Built at run time: written out whole, these fakes have the exact shape GitHub's push protection blocks as
    // real OpenRouter and DeepSeek keys.
    ["OpenRouter", "sk-or-v1-" + "0123456789abcdef".repeat(4)],
    ["DeepSeek", "sk-" + "0123456789abcdef".repeat(2)],
    ["OpenAI project", "sk-proj-Ab_cD-0123456789abcdefTESTcanary"],
    ["Anthropic", "sk-ant-api03-test-canary-0123456789abcdef-AA"],
    ["Claude sign-in token", "sk-ant-oat01-test-canary-0123456789abcdef"],
  ];
  for (const [name, key] of keys) {
    it(`redacts a ${name} key`, () => {
      const out = redactSecrets(`using ${key} now`);
      assert.equal(out, "using [REDACTED] now");
    });
  }

  it("redacts the values of OAuth token fields in JSON, keeping the field names", () => {
    const text = JSON.stringify({ access_token: "at.short-canary", refresh_token: "rt_test_canary_1", id_token: "idtok", token_type: "Bearer" });
    const out = redactSecrets(text);
    assert.ok(!/at\.short-canary|rt_test_canary_1|idtok/.test(out), out);
    assert.match(out, /"access_token":"\[REDACTED\]"/);
    assert.match(out, /"refresh_token":"\[REDACTED\]"/);
    assert.match(out, /"token_type":"Bearer"/, "a field that isn't a secret stays");
  });

  it("redacts token values in a query string or form body", () => {
    const out = redactSecrets("POST /oauth/token grant_type=refresh_token&refresh_token=rt_test_canary_2&client_id=app_x");
    assert.ok(!out.includes("rt_test_canary_2"), out);
    assert.match(out, /refresh_token=\[REDACTED\]/);
    assert.match(out, /grant_type=refresh_token/);
  });

  it("redacts an x-api-key header and an apiKey field whatever the key looks like", () => {
    assert.equal(redactSecrets("x-api-key: test-canary-Local8Mn"), "x-api-key: [REDACTED]");
    assert.ok(!redactSecrets("{\"apiKey\": \"test-canary-Local8Mn\"}").includes("test-canary-Local8Mn"));
  });
});

describe(".gitignore keeps sign-ins and key homes out of git", () => {
  let git = true;
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { git = false; }
  const ignored = [
    ".codex/auth.json",
    ".codex-home/auth.json",
    ".codex-home-keys/config.toml",
    ".claude-home-deepseek/.claude.json",
    ".claude-home-openrouter/settings.json",
    ".claude-home-anthropic/.credentials.json",
    "some/folder/auth.json",
    "tool-output/turn/call.txt",
  ];
  for (const p of ignored) {
    it(`ignores ${p}`, { skip: !git && "git is not installed" }, () => {
      execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: repoRoot, stdio: "ignore" });
    });
  }
});

describe("security audit: the AI providers", () => {
  let dbn = 0;
  function fresh() {
    const state = fs.mkdtempSync(path.join(tmp, `state-${++dbn}-`));
    const db = initDb(path.join(state, "tarsee.db"));
    opened.push(db);
    return { state, store: new SettingsStore(db) };
  }
  const emptyClaude = fs.mkdtempSync(path.join(tmp, "claude-empty-"));
  const audit = (store, state, extra = {}) => runAudit(store, {
    env: { SETUP_PASSWORD: "1234", NODE_ENV: "production", ENCRYPTION_KEY: process.env.ENCRYPTION_KEY },
    stateDir: state,
    claudeHomes: () => [emptyClaude],
    isShipped: () => true,
    ...extra,
  });
  const ids = (r) => r.issues.map((i) => i.id);

  it("the default AI not connected is a warning with what to do", () => {
    const { store, state } = fresh();
    const r = audit(store, state);
    const issue = r.issues.find((i) => i.id === "ai-credential");
    assert.ok(issue, JSON.stringify(r.issues));
    assert.equal(issue.severity, "warning");
    assert.match(issue.message, /Claude plan/);
    assert.match(issue.fix, /claude auth login/);
  });

  it("a connected default AI raises nothing, and a clean install passes", () => {
    const { store, state } = fresh();
    store.set("ai.activeProvider", "deepseek");
    store.set("ai.deepseek.apiKey", "sk-testcanaryDeepseek3Kp");
    const r = audit(store, state);
    assert.ok(!ids(r).includes("ai-credential"), JSON.stringify(r.issues));
    assert.equal(r.passed, true, JSON.stringify(r.issues));
  });

  it("a sign-in or a /login key in a key home is critical, naming the file", () => {
    const { store, state } = fresh();
    const deepseekHome = path.join(state, ".claude-home-deepseek");
    fs.mkdirSync(deepseekHome);
    fs.writeFileSync(path.join(deepseekHome, ".credentials.json"), "{}");
    const routerHome = path.join(state, ".claude-home-openrouter");
    fs.mkdirSync(routerHome);
    fs.writeFileSync(path.join(routerHome, ".claude.json"), JSON.stringify({ primaryApiKey: "sk-ant-api03-test-canary-Login1" }));
    const keysHome = path.join(state, ".codex-home-keys");
    fs.mkdirSync(keysHome);
    fs.writeFileSync(path.join(keysHome, "auth.json"), "{}");
    const r = audit(store, state);
    const isolation = r.issues.filter((i) => i.id === "key-home-isolation");
    assert.equal(isolation.length, 3, JSON.stringify(r.issues));
    for (const i of isolation) assert.equal(i.severity, "critical");
    assert.ok(isolation.some((i) => i.message.includes(path.join(deepseekHome, ".credentials.json"))));
    assert.ok(isolation.some((i) => i.message.includes(path.join(keysHome, "auth.json"))));
    assert.ok(!JSON.stringify(r).includes("sk-ant-api03-test-canary-Login1"));
    assert.equal(r.passed, false);
  });

  it("a .env in a Codex home is critical, naming the file, and its contents are never read or shown", () => {
    // Codex loads <CODEX_HOME>/.env into its own environment, so an HTTP_PROXY or a certificate file there could see
    // an AI's key and traffic; every Codex turn refuses to start while one is there (engine-env codexConfigGuard).
    const { store, state } = fresh();
    const planHome = path.join(state, ".codex-home");
    const keysHome = path.join(state, ".codex-home-keys");
    for (const home of [planHome, keysHome]) {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, ".env"), "HTTP_PROXY=http://127.0.0.1:9\nSECRET_CANARY=sk-test-canary-dotenv-value\n");
    }
    const r = audit(store, state);
    const found = r.issues.filter((i) => i.id === "codex-dotenv");
    assert.equal(found.length, 2, JSON.stringify(r.issues));
    for (const i of found) assert.equal(i.severity, "critical");
    assert.ok(found.some((i) => i.message.includes(path.join(planHome, ".env"))));
    assert.ok(found.some((i) => i.message.includes(path.join(keysHome, ".env"))));
    assert.ok(found.every((i) => /Settings > AI/.test(i.fix)));
    assert.ok(!JSON.stringify(r).includes("sk-test-canary-dotenv-value"));
    assert.equal(r.passed, false);
    fs.rmSync(path.join(planHome, ".env"));
    fs.rmSync(path.join(keysHome, ".env"));
    assert.ok(!ids(audit(store, state)).includes("codex-dotenv"), "gone once the files are set aside");
  });

  it("the ChatGPT sign-in file must be readable by its owner only (0600), on Linux", () => {
    const { store, state } = fresh();
    const home = path.join(state, ".codex-home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    const loose = audit(store, state, { platform: "linux", stat: (p) => ({ mode: p.endsWith("auth.json") ? 0o100644 : 0o040700 }) });
    const issue = loose.issues.find((i) => i.id === "codex-auth-mode");
    assert.ok(issue, JSON.stringify(loose.issues));
    assert.match(issue.fix, /chmod 600/);
    const tight = audit(store, state, { platform: "linux", stat: (p) => ({ mode: p.endsWith("auth.json") ? 0o100600 : 0o040700 }) });
    assert.ok(!ids(tight).includes("codex-auth-mode"));
    const windows = audit(store, state, { platform: "win32", stat: () => ({ mode: 0o100666 }) });
    assert.ok(!ids(windows).includes("codex-auth-mode"), "file modes mean nothing on Windows");
  });

  it("saved keys encrypted with a key that lives only in the volume file is a warning", () => {
    const { store, state } = fresh();
    const key = process.env.ENCRYPTION_KEY;
    fs.writeFileSync(path.join(state, ".encryption-key"), `${key}\n`);
    assert.equal(encryptionKeyOnVolume({ stateDir: state, env: { ENCRYPTION_KEY: key } }), true);
    assert.equal(encryptionKeyOnVolume({ stateDir: state, env: { ENCRYPTION_KEY: "another-key" } }), false);
    let r = audit(store, state);
    assert.ok(!ids(r).includes("encryption-key-on-volume"), "no saved keys, nothing to warn about");
    store.set("ai.openrouter.apiKey", "sk-or-v1-testcanaryRouter9Q");
    r = audit(store, state);
    const issue = r.issues.find((i) => i.id === "encryption-key-on-volume");
    assert.ok(issue, JSON.stringify(r.issues));
    assert.equal(issue.severity, "warning");
    assert.match(issue.fix, /ENCRYPTION_KEY/);
  });
});
