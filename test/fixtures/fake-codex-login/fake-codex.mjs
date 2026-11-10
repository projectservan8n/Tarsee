// A stand-in for the pinned `codex` binary, for test/codex-device-login.test.js and test/codex-models.test.js. It is
// started through a platform shim next to it (codex.cmd on Windows, codex on POSIX), the way Tarsee starts any
// codex binary, so the tests exercise real child processes: spawning, ANSI on stdout, files in CODEX_HOME, killing
// the whole process tree. What it prints copies the real binary's formats (codex-cli 0.167.0, captured into this
// folder: device-auth.stdout.txt, model-list.bundled.json, refresh-failed.stderr.txt).
//
// Commands (global `-c key=value` pairs before the command are skipped, as the real CLI accepts them):
//   login --device-auth   FAKE_CODEX_LOGIN picks the scenario:
//                           success (default)  print the captured stdout, then write auth.json, say so, exit 0
//                           hang               print the captured stdout and wait forever
//                           disabled           the CLI's "device code login is not enabled" error, exit 1, no code
//                           network            the CLI's "failed to request device code" error, exit 1, no code
//                           fail-after-code    print the stdout, then "device auth failed with status 400", exit 1
//                           auth-no-exit       print the stdout, write auth.json, keep running
//                           exit-no-auth       print the stdout, exit 0 without writing auth.json
//                           other-host         print the stdout with a different sign-in link
//                         FAKE_CODEX_DELAY_MS (default 300) is how long "the person" takes to sign in.
//   login status          from $CODEX_HOME/auth.json, on stderr as the real CLI does
//   logout                deletes auth.json
//   app-server            JSON-RPC over stdio (initialize, account/read, model/list); FAKE_CODEX_ACCOUNT
//                         (chatgpt | none | apikey | expired) and FAKE_CODEX_MODELS pick it:
//                           live            the account's own list, in two pages, cached in models_cache.json
//                           fallback        the real binary on a failed fetch: its error line, the bundled catalog
//                           quiet-fallback  the bundled catalog with no error line and no cache
//                           mismatch        the bundled catalog next to a cache of some other list
//                           hang            never answers model/list
// Every run appends {argv, cwd, env names it can see} to FAKE_CODEX_LOG when set, and the login writes its pid to
// FAKE_CODEX_PID_FILE when set, so a test can check the process is gone after cancel or timeout. Every token here
// is an obvious fake.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const home = env.CODEX_HOME || "";
const authFile = path.join(home, "auth.json");

const argv = process.argv.slice(2);
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-c" || argv[i] === "--config") { i++; continue; }
  rest.push(argv[i]);
}

if (env.FAKE_CODEX_LOG) {
  fs.appendFileSync(env.FAKE_CODEX_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: Object.keys(env), CODEX_HOME: home, RUST_LOG: env.RUST_LOG ?? null }) + "\n");
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig-test-canary`;

function writeChatgptAuth() {
  const now = Math.floor(Date.now() / 1000);
  const auth = { chatgpt_plan_type: env.FAKE_CODEX_PLAN || "free", chatgpt_account_id: "acct-test" };
  const id = jwt({ email: env.FAKE_CODEX_EMAIL || "person@example.test", exp: now + 3600, "https://api.openai.com/auth": auth });
  const body = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: id, access_token: jwt({ exp: now + 3600 }), refresh_token: "rt-test-canary-0000", account_id: "acct-test" },
    last_refresh: new Date().toISOString(),
  };
  fs.writeFileSync(authFile, JSON.stringify(body, null, 2));
}

function readAuth() {
  try { return JSON.parse(fs.readFileSync(authFile, "utf8")); } catch { return null; }
}

const delay = Number(env.FAKE_CODEX_DELAY_MS || 300);
const forever = () => setInterval(() => {}, 1 << 30);

function deviceLogin() {
  if (env.FAKE_CODEX_PID_FILE) fs.writeFileSync(env.FAKE_CODEX_PID_FILE, String(process.pid));
  const mode = env.FAKE_CODEX_LOGIN || "success";
  if (mode === "disabled") {
    process.stderr.write("Error logging in: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.\n");
    process.exit(1);
  }
  if (mode === "network") {
    process.stderr.write("Error logging in: failed to request device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)\n");
    process.exit(1);
  }
  let out = fs.readFileSync(path.join(here, "device-auth.stdout.txt"), "latin1");
  if (mode === "other-host") out = out.replace("https://auth.openai.com/codex/device", "https://auth.example.test/codex/device");
  // Real output arrives in pieces; split it so the parser has to wait for the code.
  const cut = out.indexOf("2. Enter");
  process.stdout.write(out.slice(0, cut));
  setTimeout(() => {
    process.stdout.write(out.slice(cut));
    if (mode === "hang" || mode === "other-host") return forever();
    setTimeout(() => {
      if (mode === "fail-after-code") {
        process.stderr.write("Error logging in: device auth failed with status 400 Bad Request\n");
        process.exit(1);
      }
      if (mode === "exit-no-auth") process.exit(0);
      writeChatgptAuth();
      if (mode === "auth-no-exit") return forever();
      process.stderr.write("Successfully logged in\n");
      process.exit(0);
    }, delay);
  }, 50);
}

function loginStatus() {
  const auth = readAuth();
  if (auth?.tokens) {
    process.stderr.write("Logged in using ChatGPT\n");
    process.exit(0);
  }
  if (auth?.OPENAI_API_KEY) {
    const k = String(auth.OPENAI_API_KEY);
    process.stderr.write(`API key configured - ${k.slice(0, 8)}***${k.slice(-5)}\nAuthentication is checked when you send a request.\n`);
    process.exit(0);
  }
  process.stderr.write("Not logged in\n");
  process.exit(1);
}

function logout() {
  if (!fs.existsSync(authFile)) { process.stderr.write("Not logged in\n"); process.exit(0); }
  fs.rmSync(authFile);
  process.stderr.write("Successfully logged out\n");
  process.exit(0);
}

// --- app-server --------------------------------------------------------------------------------------------------

function liveModels() {
  // An account's own list: ids the bundled catalog doesn't have, so a test can tell the two apart.
  const model = (id, name, efforts, def, extra = {}) => ({
    id, model: id, upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: name,
    description: `${name} for tests.`, modelSpecialty: null, hidden: false,
    supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: e })),
    defaultReasoningEffort: efforts[0], inputModalities: ["text", "image"], supportsPersonality: false,
    additionalSpeedTiers: [], serviceTiers: [], isDefault: def, ...extra,
  });
  return [
    model("test-free-small", "Test Free Small", ["medium", "low", "high"], true),
    model("test-free-mini", "Test Free Mini", ["low"], false, { inputModalities: ["text"] }),
    model("test-free-hidden", "Test Hidden", ["low"], false, { hidden: true }),
  ];
}

function appServer() {
  if (env.FAKE_CODEX_PID_FILE) fs.writeFileSync(env.FAKE_CODEX_PID_FILE, String(process.pid));
  const accountMode = env.FAKE_CODEX_ACCOUNT || "chatgpt";
  const modelsMode = env.FAKE_CODEX_MODELS || "live";
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === "initialize") {
      return send({ id: m.id, result: { userAgent: `${m.params?.clientInfo?.name}/0.167.0 (fake)`, codexHome: home, platformFamily: "unix", platformOs: "linux" } });
    }
    if (m.method === "initialized") return;
    if (m.method === "account/read") {
      if (accountMode === "expired") return send({ id: m.id, error: { code: -32603, message: "Your access token could not be refreshed. Please log out and sign in again." } });
      const account = accountMode === "chatgpt" ? { type: "chatgpt", email: env.FAKE_CODEX_EMAIL || "person@example.test", planType: "free" }
        : accountMode === "apikey" ? { type: "apiKey" } : null;
      return send({ id: m.id, result: { account, requiresOpenaiAuth: true, workspaceRouting: null } });
    }
    if (m.method === "model/list") {
      if (modelsMode === "hang") return;
      const bundled = () => JSON.parse(fs.readFileSync(path.join(here, "model-list.bundled.json"), "utf8"));
      if (modelsMode === "fallback") {
        // What the real binary does when the account's fetch fails: log it, answer with its bundled catalog.
        process.stderr.write(fs.readFileSync(path.join(here, "refresh-failed.stderr.txt"), "utf8"));
        return send({ id: m.id, result: bundled() });
      }
      if (modelsMode === "quiet-fallback") return send({ id: m.id, result: bundled() }); // no log line, no cache
      if (modelsMode === "mismatch") {
        // A cache from some other answer (another account's, say) next to the bundled catalog.
        fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ fetched_at: new Date().toISOString(), client_version: "0.167.0", models: [{ slug: "test-other-account" }] }));
        return send({ id: m.id, result: bundled() });
      }
      const all = liveModels();
      if (!m.params?.cursor) {
        // The account's fetch succeeded: the real binary caches it in CODEX_HOME, keyed to the account.
        fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
          fetched_at: new Date().toISOString(), etag: "W/\"test\"", client_version: "0.167.0", identity: { account: "acct-test" },
          models: all.map((x) => ({ slug: x.id, display_name: x.displayName, visibility: x.hidden ? "hide" : "list" })),
        }));
      }
      // Two pages, so the caller has to follow nextCursor.
      const visible = all.filter((x) => m.params?.includeHidden || !x.hidden);
      if (!m.params?.cursor) return send({ id: m.id, result: { data: visible.slice(0, 1), nextCursor: "page-2" } });
      return send({ id: m.id, result: { data: visible.slice(1), nextCursor: null } });
    }
    if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  });
  rl.on("close", () => process.exit(0));
}

const [cmd, sub] = rest;
if (cmd === "login" && rest.includes("--device-auth")) deviceLogin();
else if (cmd === "login" && sub === "status") loginStatus();
else if (cmd === "logout") logout();
else if (cmd === "app-server") appServer();
else {
  process.stderr.write(`fake codex: unknown command ${rest.join(" ")}\n`);
  process.exit(2);
}
