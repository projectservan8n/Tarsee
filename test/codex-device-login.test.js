// ChatGPT sign-in through Codex's own device-code login (src/ai/codex-device-login.js; design amendment A1, 4.14).
// Tarsee runs `codex login --device-auth` with CODEX_HOME set, reads the link and one-time code off its output, and
// waits for auth.json plus `codex login status`. The parser runs on the real binary's stdout (captured from codex-cli
// 0.167.0 with network and no account; only the one-time code was swapped for a same-shape fake). The flow runs a
// fake codex through the same platform shim any codex binary would get (test/fixtures/fake-codex-login), so the
// spawning, the ANSI, the files in CODEX_HOME and killing the whole process tree are real. The last block runs the
// real pinned binary's `login status`, which reads auth.json and never goes online. Every token is an obvious fake.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVICE_LOGIN_URL, DEVICE_CODE_DISABLED_MESSAGE, DeviceLoginError, parseDeviceAuthOutput, classifyLoginError,
  startDeviceLogin, getDeviceLogin, cancelDeviceLogin, loginStatus, logout,
} from "../src/ai/codex-device-login.js";
import { resolveCodexBin } from "../src/ai/codex-cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "fake-codex-login");
const REAL_STDOUT = fs.readFileSync(path.join(FIXTURES, "device-auth.stdout.txt"), "latin1");

let root;
let fakeBin;
let n = 0;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-codex-login-"));
  // A copy, so the POSIX shim can be made executable whatever git recorded for its mode.
  const bin = path.join(root, "bin");
  fs.cpSync(FIXTURES, bin, { recursive: true });
  fakeBin = path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform !== "win32") fs.chmodSync(fakeBin, 0o755);
});
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Credentials a host might have set; none may reach the codex child.
const CANARIES = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "ENCRYPTION_KEY", "ANTHROPIC_API_KEY", "TARSEE_PROVIDER_KEY"];

/** A fresh case: its own CODEX_HOME (not yet created), log and pid files, and the env the fake reads its scenario from. */
function scenario(vars = {}) {
  const dir = path.join(root, `case-${++n}`);
  fs.mkdirSync(dir);
  const log = path.join(dir, "codex-calls.jsonl");
  const pidFile = path.join(dir, "codex.pid");
  const env = {
    ...process.env,
    ...Object.fromEntries(CANARIES.map((k) => [k, `sk-test-canary-${k}`])),
    CODEX_HOME: path.join(dir, "wrong-home"),
    FAKE_CODEX_NODE: process.execPath,
    FAKE_CODEX_LOG: log,
    FAKE_CODEX_PID_FILE: pidFile,
    ...vars,
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const pid = () => Number(fs.readFileSync(pidFile, "utf8"));
  return { dir, home: path.join(dir, ".codex-home"), env, calls, pid, codexBin: fakeBin };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

async function goneSoon(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none" })}.${b64(claims)}.sig-test-canary`;

function writeChatgptAuth(home, { email = "person@example.test", plan = "plus", lastRefresh = "2026-11-01T10:00:00Z", profileOnly = false } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const claims = profileOnly
    ? { "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_plan_type: plan } }
    : { email, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "acct-test" } };
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { id_token: jwt(claims), access_token: "at-test-canary-0001", refresh_token: "rt-test-canary-0001", account_id: "acct-test" },
    last_refresh: lastRefresh,
  }));
}

function writeApiKeyAuth(home) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-canary-0000000000000000abcd" }));
}

describe("parseDeviceAuthOutput: the real binary's stdout", () => {
  it("reads the link, the one-time code and the expiry through the ANSI colours", () => {
    assert.ok(REAL_STDOUT.includes(`${String.fromCharCode(27)}[94m`), "the fixture still has the CLI's colour codes");
    assert.deepEqual(parseDeviceAuthOutput(REAL_STDOUT), { url: DEVICE_LOGIN_URL, code: "TEST-12345", expiresInMs: 15 * 60_000 });
    assert.equal(DEVICE_LOGIN_URL, "https://auth.openai.com/codex/device");
  });

  it("reads the same with Windows line endings", () => {
    assert.deepEqual(parseDeviceAuthOutput(REAL_STDOUT.replace(/\n/g, "\r\n")), { url: DEVICE_LOGIN_URL, code: "TEST-12345", expiresInMs: 15 * 60_000 });
  });

  it("waits for the code: output cut before it gives null", () => {
    assert.equal(parseDeviceAuthOutput(REAL_STDOUT.slice(0, REAL_STDOUT.indexOf("2. Enter"))), null);
    assert.equal(parseDeviceAuthOutput(REAL_STDOUT.slice(0, REAL_STDOUT.indexOf("TEST-12345") + 4)), null);
    assert.equal(parseDeviceAuthOutput(""), null);
  });

  it("only ever accepts OpenAI's own device page", () => {
    for (const other of [
      "https://auth.example.test/codex/device",
      "https://auth.openai.com.example.test/codex/device",
      "http://auth.openai.com/codex/device",
      "https://auth.openai.com/codex/device-elsewhere",
      "https://auth.openai.com/codex/devices",
    ]) {
      assert.equal(parseDeviceAuthOutput(REAL_STDOUT.replace(DEVICE_LOGIN_URL, other)), null, other);
    }
  });

  it("uses the minutes the CLI states, and 15 when it states none", () => {
    assert.equal(parseDeviceAuthOutput(REAL_STDOUT.replace("expires in 15 minutes", "expires in 10 minutes")).expiresInMs, 10 * 60_000);
    assert.equal(parseDeviceAuthOutput(REAL_STDOUT.replace(" (expires in 15 minutes)", "")).expiresInMs, 15 * 60_000);
  });
});

describe("classifyLoginError: what the person is told", () => {
  it("device-code sign-in switched off: the ChatGPT setting to turn on", () => {
    const real = "Error logging in: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.";
    assert.deepEqual(classifyLoginError(real), { code: "device-code-disabled", error: DEVICE_CODE_DISABLED_MESSAGE });
    assert.equal(DEVICE_CODE_DISABLED_MESSAGE, "In ChatGPT, open Settings → Security and, under App security, turn on \"Enable device code sign-in for Codex\"");
    assert.equal(classifyLoginError("\x1b[31merror\x1b[0m: device_code_auth_disabled for this workspace").code, "device-code-disabled");
  });

  it("no connection, the CLI's own 15-minute limit, and anything else (with secrets taken out)", () => {
    assert.equal(classifyLoginError("Error logging in: failed to request device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)").code, "network");
    assert.equal(classifyLoginError("Error logging in: device auth timed out after 15 minutes").code, "timeout");
    const other = classifyLoginError(`WARNING: proceeding\nError logging in: device code exchange failed: bad token ${jwt({ a: "aaaaaaaaaaaa" })}x and sk-test-canary-0000000000000000abcd`);
    assert.equal(other.code, "failed");
    assert.match(other.error, /device code exchange failed/);
    assert.doesNotMatch(other.error, /sk-test-canary|eyJ|WARNING/);
  });
});

describe("startDeviceLogin with a fake codex", () => {
  it("shows the link and code, then signs in once auth.json is there and `codex login status` agrees", async () => {
    const s = scenario({ FAKE_CODEX_EMAIL: "someone@example.test", FAKE_CODEX_PLAN: "free" });
    const t0 = Date.now();
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    assert.equal(login.url, DEVICE_LOGIN_URL);
    assert.equal(login.code, "TEST-12345");
    assert.ok(login.expiresAt >= t0 + 15 * 60_000 - 1000 && login.expiresAt <= Date.now() + 15 * 60_000, "expires 15 minutes out");
    assert.equal(typeof login.cancel, "function");
    assert.equal(getDeviceLogin({ codexHome: s.home }).status, "waiting");

    const result = await login.done;
    assert.deepEqual(result, { ok: true, method: "chatgpt", email: "someone@example.test", plan: "free" });
    assert.ok(fs.existsSync(path.join(s.home, "auth.json")));
    const snap = getDeviceLogin({ codexHome: s.home });
    assert.equal(snap.status, "signed-in");
    assert.equal(snap.code, "TEST-12345");
    assert.ok(!JSON.stringify(snap).includes("canary"), "no token in the snapshot");

    if (process.platform !== "win32") assert.equal(fs.statSync(s.home).mode & 0o777, 0o700, "home is owner-only");
    const calls = s.calls();
    const loginCall = calls.find((c) => c.argv.includes("--device-auth"));
    const statusCall = calls.find((c) => c.argv.includes("status"));
    assert.ok(loginCall && statusCall, "ran the login, then `codex login status`");
    for (const c of [loginCall, statusCall]) {
      assert.equal(path.resolve(c.CODEX_HOME), path.resolve(s.home), "CODEX_HOME is the sign-in home, not the server's");
      assert.ok(c.argv.includes('cli_auth_credentials_store="file"'), "credentials go to auth.json, never a keyring");
      const upper = new Set(c.env.map((k) => k.toUpperCase()));
      for (const k of CANARIES) assert.ok(!upper.has(k), `${k} must not reach codex`);
    }
  });

  it("one login at a time: starting again while one waits gives the same code", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "hang" });
    const a = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    const b = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    assert.equal(b.code, a.code);
    assert.equal(b.done, a.done);
    assert.equal(s.calls().filter((c) => c.argv.includes("--device-auth")).length, 1, "codex started once");
    await a.cancel();
  });

  it("cancel kills the codex process tree and says so", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "hang" });
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    const pid = s.pid();
    assert.ok(isAlive(pid), "codex is waiting for the person");
    await login.cancel();
    const result = await login.done;
    assert.equal(result.ok, false);
    assert.equal(result.code, "cancelled");
    assert.ok(await goneSoon(pid), "the codex process is gone (not just the shim)");
    assert.equal(getDeviceLogin({ codexHome: s.home }).status, "cancelled");
    await login.cancel(); // twice is harmless
  });

  it("cancelDeviceLogin by home does the same", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "hang" });
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    assert.equal(await cancelDeviceLogin({ codexHome: s.home }), true);
    assert.equal((await login.done).code, "cancelled");
    assert.ok(await goneSoon(s.pid()));
    assert.equal(await cancelDeviceLogin({ codexHome: s.home }), false, "nothing left to cancel");
  });

  it("timeout kills the codex process tree", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "hang" });
    const t0 = Date.now();
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env, timeoutMs: 1500 });
    assert.ok(login.expiresAt <= t0 + 1500 + 1000, "expiresAt follows the shorter limit");
    const result = await login.done;
    assert.equal(result.ok, false);
    assert.equal(result.code, "timeout");
    assert.match(result.error, /expired/i);
    assert.ok(await goneSoon(s.pid()));
    assert.equal(getDeviceLogin({ codexHome: s.home }).status, "expired");
  });

  it("an old sign-in already in the home doesn't count as the new one", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "hang" });
    writeChatgptAuth(s.home);
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env, pollMs: 50 });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(getDeviceLogin({ codexHome: s.home }).status, "waiting");
    await login.cancel();
  });

  it("auth.json appearing is enough even if codex hasn't exited; codex is then stopped", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "auth-no-exit", FAKE_CODEX_DELAY_MS: "100" });
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env, pollMs: 50 });
    const result = await login.done;
    assert.equal(result.ok, true);
    assert.ok(await goneSoon(s.pid()), "codex stopped after the sign-in landed");
  });

  it("device-code sign-in switched off: start fails with the setting to turn on", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "disabled" });
    await assert.rejects(startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), (err) => {
      assert.ok(err instanceof DeviceLoginError);
      assert.equal(err.code, "device-code-disabled");
      assert.equal(err.message, DEVICE_CODE_DISABLED_MESSAGE);
      return true;
    });
    assert.equal(getDeviceLogin({ codexHome: s.home }).status, "failed");
  });

  it("no connection to OpenAI: start fails with that", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "network" });
    await assert.rejects(startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), { code: "network" });
  });

  it("codex failing after showing the code ends the wait with its reason", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "fail-after-code", FAKE_CODEX_DELAY_MS: "50" });
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    const result = await login.done;
    assert.equal(result.ok, false);
    assert.equal(result.code, "failed");
    assert.match(result.error, /device auth failed with status 400/);
  });

  it("codex exiting cleanly without a sign-in isn't taken as one", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "exit-no-auth", FAKE_CODEX_DELAY_MS: "50" });
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    const result = await login.done;
    assert.equal(result.ok, false);
    assert.equal(result.code, "not-confirmed");
  });

  it("a sign-in link to any other site is refused and codex is stopped", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "other-host" });
    await assert.rejects(startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env, startTimeoutMs: 1500 }), { code: "unexpected-output" });
    assert.ok(await goneSoon(s.pid()));
  });

  it("a config.toml that could redirect the sign-in refuses before codex starts", async () => {
    const s = scenario();
    fs.mkdirSync(s.home, { recursive: true });
    fs.writeFileSync(path.join(s.home, "config.toml"), 'chatgpt_base_url = "https://example.test/"\n');
    await assert.rejects(startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), (err) => {
      assert.equal(err.code, "unsafe-config");
      assert.match(err.message, /chatgpt_base_url/);
      return true;
    });
    assert.equal(s.calls().length, 0, "codex never ran");
  });

  it("a .env in the home (Codex would load a proxy or a certificate from it) refuses before codex starts", async () => {
    const s = scenario();
    fs.mkdirSync(s.home, { recursive: true });
    fs.writeFileSync(path.join(s.home, ".env"), "HTTPS_PROXY=http://127.0.0.1:9\n");
    await assert.rejects(startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), (err) => {
      assert.equal(err.code, "unsafe-config");
      assert.match(err.message, /\.env/);
      assert.ok(!err.message.includes("127.0.0.1"));
      return true;
    });
    assert.equal(s.calls().length, 0, "codex never ran");
  });

  it("a home folder that can't be created: says so plainly, and codex never runs", async () => {
    const s = scenario();
    const blocker = path.join(s.dir, "a-file");
    fs.writeFileSync(blocker, "not a folder");
    await assert.rejects(startDeviceLogin({ codexHome: path.join(blocker, ".codex-home"), codexBin: s.codexBin, env: s.env }), (err) => {
      assert.ok(err instanceof DeviceLoginError);
      assert.equal(err.code, "home-failed");
      assert.match(err.message, /folder/);
      return true;
    });
    assert.equal(s.calls().length, 0);
  });

  it("no codex binary: says so plainly", async () => {
    const s = scenario();
    await assert.rejects(startDeviceLogin({ codexHome: s.home, codexBin: path.join(s.dir, "no-such-codex"), env: s.env }), { code: "codex-missing" });
  });

  it("needs a home", async () => {
    await assert.rejects(startDeviceLogin({}), TypeError);
    await assert.rejects(loginStatus({}), TypeError);
  });
});

describe("loginStatus: shapes, never a token", () => {
  it("not signed in", async () => {
    const s = scenario();
    assert.deepEqual(await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), { signedIn: false, method: null });
  });

  it("ChatGPT: email and plan from the ID token, the last refresh, and no token", async () => {
    const s = scenario();
    writeChatgptAuth(s.home, { email: "someone@example.test", plan: "free", lastRefresh: "2026-11-02T03:04:05Z" });
    const st = await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    assert.deepEqual(st, { signedIn: true, method: "chatgpt", email: "someone@example.test", plan: "free", lastRefresh: "2026-11-02T03:04:05.000Z" });
    assert.ok(!JSON.stringify(st).includes("canary"));
  });

  it("ChatGPT: the email can come from the profile claim", async () => {
    const s = scenario();
    writeChatgptAuth(s.home, { email: "profile@example.test", profileOnly: true });
    const st = await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env, cli: false });
    assert.equal(st.email, "profile@example.test");
  });

  it("API key: method api, and not even the masked key the CLI prints", async () => {
    const s = scenario();
    writeApiKeyAuth(s.home);
    const st = await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    assert.deepEqual(st, { signedIn: true, method: "api" });
  });

  it("cli:false reads auth.json only (nothing spawned)", async () => {
    const s = scenario();
    writeChatgptAuth(s.home, { plan: "pro" });
    const st = await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env, cli: false });
    assert.equal(st.signedIn, true);
    assert.equal(st.method, "chatgpt");
    assert.equal(st.plan, "pro");
    assert.equal(s.calls().length, 0);
  });

  it("an auth.json the CLI doesn't accept isn't signed in", async () => {
    const s = scenario();
    fs.mkdirSync(s.home, { recursive: true });
    fs.writeFileSync(path.join(s.home, "auth.json"), "{ torn");
    assert.deepEqual(await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), { signedIn: false, method: null });
  });

  it("codex missing: falls back to the file and says it couldn't check", async () => {
    const s = scenario();
    writeChatgptAuth(s.home, { plan: "free" });
    const st = await loginStatus({ codexHome: s.home, codexBin: path.join(s.dir, "no-such-codex"), env: s.env });
    assert.equal(st.signedIn, true);
    assert.equal(st.method, "chatgpt");
    assert.equal(st.checked, false);
  });

  it("a home whose config Codex mustn't load (a .env, a refused config.toml): the file answers, codex is never asked", async () => {
    for (const [name, text] of [[".env", "HTTPS_PROXY=http://127.0.0.1:9\n"], ["config.toml", "chatgpt_base_url = \"https://example.test/\"\n"]]) {
      const s = scenario();
      writeChatgptAuth(s.home, { plan: "free" });
      fs.writeFileSync(path.join(s.home, name), text);
      const st = await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
      assert.equal(st.signedIn, true, name);
      assert.equal(st.method, "chatgpt", name);
      assert.equal(st.checked, false, `${name}: says it couldn't check`);
      assert.equal(s.calls().length, 0, `${name}: codex never ran`);
      // Sign-out still removes the sign-in, without running codex in that home.
      assert.deepEqual(await logout({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), { ok: true }, name);
      assert.equal(fs.existsSync(path.join(s.home, "auth.json")), false, name);
      assert.equal(s.calls().length, 0, `${name}: codex logout never ran`);
    }
  });

  it("logout signs out and stops a login in progress", async () => {
    const s = scenario({ FAKE_CODEX_LOGIN: "hang" });
    writeChatgptAuth(s.home);
    const login = await startDeviceLogin({ codexHome: s.home, codexBin: s.codexBin, env: s.env });
    assert.deepEqual(await logout({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), { ok: true });
    assert.equal((await login.done).code, "cancelled");
    assert.equal(fs.existsSync(path.join(s.home, "auth.json")), false);
    assert.deepEqual(await loginStatus({ codexHome: s.home, codexBin: s.codexBin, env: s.env }), { signedIn: false, method: null });
    assert.ok(s.calls().some((c) => c.argv.includes("logout")), "used `codex logout`");
  });
});

describe("loginStatus on the real pinned codex (offline: `codex login status` only reads auth.json)", () => {
  let realBin = null;
  try { realBin = resolveCodexBin({ env: {} }); } catch {}
  const opts = { skip: realBin ? false : "the pinned codex binary isn't installed for this platform" };

  it("ChatGPT sign-in", opts, async () => {
    const s = scenario();
    writeChatgptAuth(s.home, { email: "someone@example.test", plan: "free" });
    const st = await loginStatus({ codexHome: s.home, codexBin: realBin, env: s.env });
    assert.equal(st.signedIn, true);
    assert.equal(st.method, "chatgpt");
    assert.equal(st.email, "someone@example.test");
    assert.equal(st.plan, "free");
    assert.ok(!("checked" in st), "the CLI answered");
  });

  it("API key sign-in, with nothing of the key in the answer", opts, async () => {
    const s = scenario();
    writeApiKeyAuth(s.home);
    const st = await loginStatus({ codexHome: s.home, codexBin: realBin, env: s.env });
    assert.deepEqual(st, { signedIn: true, method: "api" });
  });

  it("nothing signed in", opts, async () => {
    const s = scenario();
    assert.deepEqual(await loginStatus({ codexHome: s.home, codexBin: realBin, env: s.env }), { signedIn: false, method: null });
  });
});
