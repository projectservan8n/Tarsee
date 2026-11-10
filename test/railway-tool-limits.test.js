// tarsee_railway's limits (src/lib/railway-admin.js): what the tool never does, whoever the AI says gave the go. What
// the AI asks for can come from a web page or a message it read, so:
//   - a value that is a Railway reference (${{ ... }}) is refused on every service: Railway fills it in from another
//     variable when the service deploys, so it could pull a shared secret or another service's secret into a service;
//   - Tarsee's own keys (its Railway token, its sign-in and encryption secrets) are never copied into a service;
//   - on Tarsee's own service only an allowlist is set, with a deploy or without one: a key or address for the owner's
//     own scripts (a name in capitals ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL that no part of
//     Tarsee reads), TZ, and a few tuning settings. Every name Tarsee's code, its start-up script, its Dockerfile and
//     its AI engines read is refused there (scanned below), and so is every other name;
//   - nor is a variable one of Tarsee's own settings is filled in from, and while such a setting is sealed (its value
//     can't be read) nothing is set in that environment of Tarsee's project;
//   - from_key onto Tarsee's own service is refused while the owner has denied get_key in Tool Permissions.
// Other services, and the allowed names on Tarsee's own, keep working. Railway is never reached: fetch is a stand-in
// that answers like Railway's GraphQL API.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Keep every module that reads config away from the real state dir, vault and DB, and from a real Railway service.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-railway-limits-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.ENCRYPTION_KEY = "railway-limits-test-encryption-key-0123456789";
for (const k of ["RAILWAY_API_TOKEN", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"]) delete process.env[k];
// The whole module, so a test that needs a new export fails on its own rather than stopping the file.
const RA = await import("../src/lib/railway-admin.js");
const { railwayAdmin } = RA;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TOKEN = "owner-tok-SECRET-11111111-2222-3333";
const OPENAI = "sk-proj-SECRET-openai-0123456789abcdef";
const HOOK = "https://discord.com/api/webhooks/1564447804183547987/wh-SECRET-abcdefghij_KLMNOP-0123456789xyz";
const GO = "the owner in chat: go ahead";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P_ACME = id(1), P_TARSEE = id(5);
const E_PROD = id(11), E_TARSEE = id(43), E_TSTAGE = id(46);
const S_WEB = id(22), S_WORK = id(23), S_TARSEE = id(44), S_PG = id(47), S_TWORK = id(48);
const D_WEB = id(31), D_NEW = id(32), D_TARSEE = id(45);
/** Where Tarsee runs, as Railway tells a service. */
const ON_RAILWAY = { RAILWAY_PROJECT_ID: P_TARSEE, RAILWAY_ENVIRONMENT_ID: E_TARSEE, RAILWAY_SERVICE_ID: S_TARSEE };

/**
 * A stand-in for Railway's GraphQL endpoint, answering by operation name and recording every call. `more` adds
 * variables per environment ({ name, serviceId, value }; serviceId null for a shared one). `refsFail` makes the
 * unrendered-variables query fail as Railway would.
 */
function railway({ more = {}, refsFail = false } = {}) {
  const acct = {
    projects: [
      { id: P_ACME, name: "Acme", deletedAt: null, environments: [{ id: E_PROD, name: "production" }], services: [{ id: S_WEB, name: "web" }, { id: S_WORK, name: "worker" }] },
      { id: P_TARSEE, name: "Tarsee", deletedAt: null, environments: [{ id: E_TARSEE, name: "production" }, { id: E_TSTAGE, name: "staging" }], services: [{ id: S_TARSEE, name: "tarsee" }, { id: S_PG, name: "Postgres" }, { id: S_TWORK, name: "worker" }] },
    ],
    variables: { [E_PROD]: [], [E_TARSEE]: [{ name: "SETUP_PASSWORD", serviceId: S_TARSEE, isSealed: false, value: "1234" }], [E_TSTAGE]: [] },
    deployments: { [`${E_PROD}/${S_WEB}`]: [{ id: D_WEB, status: "SUCCESS" }], [`${E_TARSEE}/${S_TARSEE}`]: [{ id: D_TARSEE, status: "SUCCESS" }] },
  };
  for (const [envId, list] of Object.entries(more)) {
    (acct.variables[envId] ||= []).push(...list.map((x) => ({ isSealed: false, serviceId: null, ...x })));
  }
  const calls = [];
  const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const op = /(?:query|mutation) (\w+)/.exec(body.query)?.[1];
    calls.push({ body, op });
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) return reply(401, { errors: [{ message: "Not Authorized" }] });
    const v = body.variables || {};
    const edges = (list) => ({ edges: list.map((node) => ({ node })) });
    switch (op) {
      case "TarseeProjects":
        return reply(200, { data: { projects: edges(acct.projects.map(({ id: pid, name, deletedAt }) => ({ id: pid, name, deletedAt }))) } });
      case "TarseeProject": {
        const p = acct.projects.find((x) => x.id === v.id);
        if (!p) return reply(200, { errors: [{ message: "Project not found" }], data: null });
        return reply(200, { data: { project: { id: p.id, name: p.name, deletedAt: null, environments: edges(p.environments.map((e) => ({ deletedAt: null, ...e }))), services: edges(p.services) } } });
      }
      case "TarseeVariableNames":
        return reply(200, { data: { environment: { variables: edges((acct.variables[v.environmentId] || []).map(({ name, serviceId, isSealed }) => ({ name, serviceId, isSealed }))) } } });
      case "TarseeUnrenderedVariables": {
        // Railway's `variables(..., unrendered: true)`: a service's variables (serviceId left out: the shared ones, as
        // Railway's Manage Variables guide shows) as { NAME: value }, references left as typed. A sealed one's value
        // never comes back. A serviceId sent as null is not how the guide asks for shared ones, so it is refused here.
        if (refsFail) return reply(200, { errors: [{ message: "Problem processing request" }], data: null });
        assert.match(body.query, /unrendered: true/, "asks for the values with the references left in");
        if (Object.hasOwn(v, "serviceId") && v.serviceId == null) return reply(200, { errors: [{ message: "serviceId must be a service id" }], data: null });
        const list = (acct.variables[v.environmentId] || []).filter((x) => x.serviceId === (v.serviceId ?? null) && !x.isSealed);
        return reply(200, { data: { variables: Object.fromEntries(list.map((x) => [x.name, x.value])) } });
      }
      case "TarseeVariableUpsert": {
        const list = (acct.variables[v.environmentId] ||= []);
        for (const [name, value] of Object.entries(v.variables)) {
          const had = list.find((x) => x.name === name && x.serviceId === v.serviceId);
          if (had) had.value = value; else list.push({ name, serviceId: v.serviceId, isSealed: false, value });
        }
        return reply(200, { data: { variableCollectionUpsert: true } });
      }
      case "TarseeLatestDeployment":
        return reply(200, { data: { deployments: edges(acct.deployments[`${v.input.environmentId}/${v.input.serviceId}`] || []) } });
      case "TarseeRedeploy":
        return reply(200, { data: { deploymentRedeploy: { id: D_NEW } } });
      default:
        return reply(400, { errors: [{ message: `unknown operation ${op}` }] });
    }
  };
  const writes = () => calls.filter((c) => /^mutation/.test(c.body.query));
  const valueOf = (envId, svcId, name) => acct.variables[envId]?.find((x) => x.serviceId === svcId && x.name === name)?.value;
  return { fetch, calls, writes, valueOf };
}

const VAULT = {
  RAILWAY_API_TOKEN: TOKEN,
  OPENAI_KEY: OPENAI,
  ALERTS_WEBHOOK: HOOK,
  WORKER_PASSWORD: "worker-pw-SECRET-0001",
  REF_KEY: "${{shared.SETUP_PASSWORD}}",
  TOKEN_COPY: TOKEN,
  SETUP_PASSWORD: "vault-pw-SECRET-0002",
  ENCRYPTION_KEY: "vault-enc-SECRET-0003-0123456789",
  TARSEE_API_TOKEN: "vault-api-SECRET-0004-0123456789",
};
function fakeVault(entries = VAULT) {
  const keys = new Map(Object.entries(entries));
  return { getKey: (k) => (keys.has(k) ? keys.get(k) : null), getAllKeysDecrypted: () => Object.fromEntries(keys) };
}

/** getKeyDenied: whether the owner has denied get_key in Tool Permissions (a stand-in; here no, unless a test says). */
async function run(args, { rw = railway(), vault = fakeVault(), env = {}, getKeyDenied = () => false } = {}) {
  const lines = [];
  const out = await railwayAdmin({ approved_by: GO, ...args }, { vault, env, fetch: rw.fetch, log: (l) => lines.push(l), getKeyDenied });
  return { out, rw, text: out + "\n" + lines.join("\n") };
}

/** Nothing was asked of Railway that changes anything, and no secret is in the result or the log. */
function assertNothingChanged({ out, rw, text }, label = "") {
  assert.equal(rw.writes().length, 0, `no write was sent ${label}: ${out}`);
  assert.match(out, /^railway \w+ error: /, `${label} ${out}`);
  assert.match(out, /Nothing was changed\.$/, `${label} ${out}`);
  for (const secret of [TOKEN, OPENAI, HOOK, ...Object.values(VAULT).filter((x) => /SECRET/.test(x))]) {
    assert.ok(!text.includes(secret), `${label}: no ${secret.slice(0, 14)} in the result or the log`);
  }
}

// ---------------------------------------------------------------------------------------------------------------

describe("a Railway reference (${{ ... }}) is never set, on any service", () => {
  const refs = ["${{SETUP_PASSWORD}}", "${{shared.OPENAI_API_KEY}}", "${{ Postgres.DATABASE_URL }}", "https://x.example/?k=${{tarsee.TARSEE_API_TOKEN}}"];

  it("as a plain value on another service: refused before anything is sent, saying where references are made", async () => {
    for (const value of refs) {
      const r = await run({ action: "set_variable", project: "Acme", service: "web", name: "SOME_SETTING", value });
      assertNothingChanged(r, value);
      assert.equal(r.rw.calls.length, 0, "nothing at all is sent");
      assert.match(r.out, /a Railway reference \(\$\{\{ \.\.\. \}\}\)/, value);
      assert.match(r.out, /in Railway's dashboard/, "says where to make it instead");
    }
  });

  it("on Tarsee's own service, even for a harmless name, with or without a deploy", async () => {
    for (const deploy of [true, false]) {
      const r = await run({ action: "set_variable", name: "SOME_SERVICE_API_KEY", value: "${{shared.SOME_SERVICE_API_KEY}}", deploy }, { env: ON_RAILWAY });
      assertNothingChanged(r);
      assert.match(r.out, /a Railway reference/);
    }
  });

  it("from a vault key whose value is a reference: refused too", async () => {
    const r = await run({ action: "set_variable", project: "Acme", service: "web", name: "SOME_SETTING", from_key: "REF_KEY" });
    assertNothingChanged(r);
    assert.equal(r.rw.calls.length, 0);
    assert.match(r.out, /The vault key REF_KEY holds a Railway reference/);
  });

  it("braces that are not a reference are an ordinary value", async () => {
    const r = await run({ action: "set_variable", project: "Acme", service: "web", name: "GREETING", value: "Hi {{name}}, ${HOME} stays as typed" });
    assert.match(r.out, /^Set GREETING on web/, r.out);
    assert.equal(r.rw.writes().length, 1);
  });
});

describe("Tarsee's own keys are never copied into a service", () => {
  it("SERVER_ONLY_KEYS: the Railway token and Tarsee's sign-in and encryption secrets", () => {
    assert.ok(Array.isArray(RA.SERVER_ONLY_KEYS), "railway-admin.js exports SERVER_ONLY_KEYS");
    for (const k of ["RAILWAY_API_TOKEN", "SETUP_PASSWORD", "ENCRYPTION_KEY", "TARSEE_API_TOKEN"]) assert.ok(RA.SERVER_ONLY_KEYS.includes(k), k);
  });

  it("from_key with any of them, in any case, is refused before anything is sent", async () => {
    for (const key of ["RAILWAY_API_TOKEN", "railway_api_token", "SETUP_PASSWORD", "ENCRYPTION_KEY", "TARSEE_API_TOKEN"]) {
      const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "SOME_TOKEN", from_key: key });
      assertNothingChanged(r, key);
      assert.equal(r.rw.calls.length, 0, key);
      assert.match(r.out, /never copies it into a service/, key);
    }
    const tok = await run({ action: "set_variable", project: "Acme", service: "worker", name: "RAILWAY_TOKEN", from_key: "RAILWAY_API_TOKEN" });
    assert.match(tok.out, /RAILWAY_API_TOKEN is the token Tarsee itself uses to reach Railway/);
    assert.match(tok.out, /the owner makes one in Railway \(Account Settings > Tokens\)/, "says how to give a service its own token instead");
  });

  it("a copy of the token under another vault name, or a value with the token in it, is refused", async () => {
    const copy = await run({ action: "set_variable", project: "Acme", service: "worker", name: "RAILWAY_TOKEN", from_key: "TOKEN_COPY" });
    assertNothingChanged(copy);
    assert.match(copy.out, /The vault key TOKEN_COPY holds Tarsee's own Railway token/);
    const plain = await run({ action: "set_variable", project: "Acme", service: "worker", name: "AUTH_HEADER", value: `Bearer ${TOKEN}` });
    assertNothingChanged(plain);
    assert.match(plain.out, /That value holds Tarsee's own Railway token/);
    const same = await run({ action: "set_variable", project: "Acme", service: "worker", name: "RAILWAY_TOKEN", value: TOKEN });
    assertNothingChanged(same);
    assert.match(same.out, /Tarsee's own Railway token/);
  });

  it("the token from the environment counts too", async () => {
    const vault = fakeVault({ STASH: TOKEN });
    const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "RAILWAY_TOKEN", from_key: "STASH" }, { vault, env: { RAILWAY_API_TOKEN: TOKEN } });
    assertNothingChanged(r);
    assert.match(r.out, /The vault key STASH holds Tarsee's own Railway token/);
  });

  it("a plain value that is one of them is refused as Tarsee's own, not pointed at from_key", async () => {
    const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "ADMIN_PASSWORD", value: VAULT.SETUP_PASSWORD });
    assertNothingChanged(r);
    assert.match(r.out, /SETUP_PASSWORD is one of Tarsee's own secrets/);
    assert.ok(!/Pass from_key/.test(r.out));
  });
});

describe("on Tarsee's own service only the allowlist is set: sign-in, AI keys, how it is built and runs are left to the owner", () => {
  // [name, how it is passed, where the refusal says to make the change]
  const AI = /Settings > AI/;
  const DASH = /Railway's dashboard/;
  const cases = [
    ["SETUP_PASSWORD", { value: "hunter2hunter2" }, DASH],
    ["ENCRYPTION_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    ["TARSEE_API_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["TARSEE_KEYS_ONLY", { value: "0" }, AI],
    ["TARSEE_AI_PROVIDER", { value: "openai" }, AI],
    ["TARSEE_AI_MODEL", { value: "openai:gpt-5" }, AI],
    ["TARSEE_LOCAL_AI_URL", { value: "http://127.0.0.1:9999/v1" }, AI],
    ["OPENAI_API_KEY", { from_key: "OPENAI_KEY" }, AI],
    ["OPENROUTER_API_KEY", { from_key: "OPENAI_KEY" }, AI],
    ["DEEPSEEK_API_KEY", { from_key: "OPENAI_KEY" }, AI],
    ["TARSEE_LOCAL_AI_KEY", { from_key: "OPENAI_KEY" }, AI],
    ["ANTHROPIC_API_KEY", { from_key: "OPENAI_KEY" }, AI],
    ["ANTHROPIC_BASE_URL", { value: "http://127.0.0.1:9999" }, AI],
    ["CLAUDE_CODE_OAUTH_TOKEN", { from_key: "OPENAI_KEY" }, AI],
    ["OPENAI_BASE_URL", { value: "http://127.0.0.1:9999" }, AI],
    ["TARSEE_AGENT_ENV_KEYS", { value: "RAILWAY_API_TOKEN" }, DASH],
    ["TARSEE_AGENT_ISOLATION", { value: "off" }, DASH],
    ["TARSEE_TEST_BASE_URL_OPENAI", { value: "http://127.0.0.1:9999" }, DASH],
    ["TARSEE_SESSION_MAX_AGE_DAYS", { value: "36500" }, DASH],
    ["TARSEE_CSRF_MAX_AGE_HOURS", { value: "87600" }, DASH],
    ["TARSEE_STATE_DIR", { value: "/tmp/x" }, DASH],
    ["TARSEE_CODEX_BIN", { value: "/data/tarsee/workspace/codex" }, DASH],
    ["TARSEE_AUTO_UPDATE_CLI", { value: "1" }, DASH],
    ["TARSEE_SOMETHING_NEW", { value: "1" }, DASH],
    ["CLAUDE_BIN", { value: "/data/tarsee/workspace/claude" }, DASH],
    ["CLAUDE_CODE_VERSION", { value: "1.0.0" }, DASH],
    ["NODE_OPTIONS", { value: "--require /data/tarsee/workspace/x.js" }, DASH],
    ["NODE_ENV", { value: "test" }, DASH],
    ["NODE_TLS_REJECT_UNAUTHORIZED", { value: "0" }, DASH],
    ["npm_config_prefix", { value: "/data/tarsee/workspace" }, DASH],
    ["PATH", { value: "/data/tarsee/workspace/bin:/usr/bin" }, DASH],
    ["HOME", { value: "/data/tarsee/workspace" }, DASH],
    ["LD_PRELOAD", { value: "/data/tarsee/workspace/x.so" }, DASH],
    ["PYTHONPATH", { value: "/data/tarsee/workspace" }, DASH],
    ["OPENSSL_CONF", { value: "/data/tarsee/workspace/x.cnf" }, DASH],
    ["SSL_CERT_FILE", { value: "/data/tarsee/workspace/ca.pem" }, DASH],
    ["HTTPS_PROXY", { value: "http://proxy.example:8080" }, DASH],
    ["PLAYWRIGHT_BROWSERS_PATH", { value: "/data/tarsee/workspace/pw" }, DASH],
    ["RAILWAY_RUN_UID", { value: "0" }, DASH],
    ["RAILWAY_DOCKERFILE_PATH", { value: "workspace/Dockerfile" }, DASH],
    ["RAILWAY_API_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["PORT", { value: "1" }, DASH],
    ["ELEVENLABS_API_KEY", { from_key: "OPENAI_KEY" }, /Settings/],
    ["CAPTCHA_API_KEY", { from_key: "OPENAI_KEY" }, /Settings/],
    ["setup_password", { value: "hunter2hunter2" }, DASH],
    ["SETUP_PASSWORD", { value: "" }, DASH],
    ["PIP_INDEX_URL", { value: "https://pypi.example/simple" }, DASH],
    ["UV_INDEX_URL", { value: "https://pypi.example/simple" }, DASH],
    ["HF_ENDPOINT", { value: "https://hf.example" }, DASH],
    ["HUGGINGFACE_HUB_CACHE", { value: "/data/tarsee/workspace/hf" }, DASH],
    ["COREPACK_NPM_REGISTRY", { value: "https://npm.example" }, DASH],
    // Round 2. The build: BUILDKIT_SYNTAX names the image that runs the whole build (a BuildKit built-in build
    // argument, no ARG line needed), and every service variable reaches Railway's build.
    ["BUILDKIT_SYNTAX", { value: "attacker.example/frontend:latest" }, DASH],
    ["BUILDKIT_INLINE_CACHE", { value: "1" }, DASH],
    ["BUILDX_BUILDER", { value: "remote" }, DASH],
    ["DOCKER_HOST", { value: "tcp://attacker.example:2375" }, DASH],
    ["SOURCE_DATE_EPOCH", { value: "0" }, DASH],
    // How bash starts in the owner's Terminal: options, prompts that run $(...), readline's keys, history, locale and
    // resolver files, the terminal database, the pager.
    ["SHELLOPTS", { value: "xtrace" }, DASH],
    ["BASHOPTS", { value: "extdebug" }, DASH],
    ["PS0", { value: "$(id)" }, DASH],
    ["PS1", { value: "$(id)" }, DASH],
    ["PS2", { value: "$(id)" }, DASH],
    ["PS3", { value: "$(id)" }, DASH],
    ["PS4", { value: "$(id)" }, DASH],
    ["INPUTRC", { value: "/data/tarsee/workspace/inputrc" }, DASH],
    ["HISTFILE", { value: "/data/tarsee/workspace/history" }, DASH],
    ["HISTFILESIZE", { value: "0" }, DASH],
    ["LOCPATH", { value: "/data/tarsee/workspace/locale" }, DASH],
    ["NLSPATH", { value: "/data/tarsee/workspace/%N" }, DASH],
    ["HOSTALIASES", { value: "/data/tarsee/workspace/hosts" }, DASH],
    ["LOCALDOMAIN", { value: "attacker.example" }, DASH],
    ["RES_OPTIONS", { value: "ndots:15" }, DASH],
    ["TERMINFO", { value: "/data/tarsee/workspace/terminfo" }, DASH],
    ["MANPAGER", { value: "sh -c id" }, DASH],
    ["LESSOPEN", { value: "|/data/tarsee/workspace/x %s" }, DASH],
    // ssh, which git falls back on for a password.
    ["SSH_ASKPASS", { value: "/data/tarsee/workspace/askpass" }, DASH],
    ["SSH_ASKPASS_REQUIRE", { value: "force" }, DASH],
    ["SSH_AUTH_SOCK", { value: "/data/tarsee/workspace/agent.sock" }, DASH],
    // The browser: its fonts, its display and Playwright's remote browser.
    ["FONTCONFIG_FILE", { value: "/data/tarsee/workspace/fonts.conf" }, DASH],
    ["FONTCONFIG_PATH", { value: "/data/tarsee/workspace" }, DASH],
    ["FONTCONFIG_SYSROOT", { value: "/data/tarsee/workspace" }, DASH],
    ["DISPLAY", { value: ":99" }, DASH],
    ["WAYLAND_DISPLAY", { value: "wayland-1" }, DASH],
    ["XAUTHORITY", { value: "/data/tarsee/workspace/.Xauthority" }, DASH],
    ["DBUS_SESSION_BUS_ADDRESS", { value: "unix:path=/data/tarsee/workspace/bus" }, DASH],
    ["SELENIUM_REMOTE_URL", { value: "http://attacker.example:4444" }, DASH],
    // Names the AI engines (Claude Code, Codex) and the libraries Tarsee runs read, though they look like a key for
    // the owner's scripts: the GitHub sign-in, the cloud logins, telemetry, MCP, the chat bots' tokens, web push.
    ["GH_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["GITHUB_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["GH_ENTERPRISE_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["AWS_SECRET_ACCESS_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    ["AZURE_CLIENT_SECRET", { from_key: "WORKER_PASSWORD" }, DASH],
    ["ACTIONS_ID_TOKEN_REQUEST_URL", { value: "https://attacker.example/oidc" }, DASH],
    ["MCP_CLIENT_SECRET", { from_key: "WORKER_PASSWORD" }, DASH],
    ["OTEL_EXPORTER_OTLP_ENDPOINT", { value: "https://attacker.example" }, DASH],
    ["APP_URL", { value: "https://x.example" }, DASH],
    ["SESSION_INGRESS_URL", { value: "https://attacker.example" }, DASH],
    ["DISCORD_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["SLACK_BOT_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["TELEGRAM_BOT_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["VAPID_SUBJECT", { value: "mailto:someone@example.com" }, DASH],
    ["VAPID_PRIVATE_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    ["DOTENV_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    ["CODEX_HOME", { value: "/data/tarsee/workspace" }, AI],
    ["RUST_LOG", { value: "trace" }, DASH],
    ["MAX_THINKING_TOKENS", { value: "1" }, DASH],
    ["DEBUG", { value: "*" }, DASH],
    // Not on the allowlist: a name that isn't clearly a key for the owner's scripts, or isn't in capitals.
    ["LOG_LEVEL", { value: "debug" }, DASH],
    ["FEATURE_FLAGS", { value: "beta" }, DASH],
    ["CI", { value: "1" }, DASH],
    ["some_service_api_key", { from_key: "WORKER_PASSWORD" }, DASH],
    ["tz", { value: "UTC" }, DASH],
  ];

  for (const [name, how, where] of cases) {
    it(`${name} is refused, with a deploy or without, and the refusal says where to change it`, async () => {
      for (const deploy of [true, false]) {
        const r = await run({ action: "set_variable", name, ...how, deploy }, { env: ON_RAILWAY });
        assertNothingChanged(r, `${name} deploy=${deploy}`);
        assert.match(r.out, /on Tarsee's own service/, r.out);
        assert.match(r.out, where, r.out);
      }
    });
  }

  it("Tarsee's service named by name or id, and in another environment of its project, is still Tarsee's own", async () => {
    for (const args of [
      { project: "Tarsee", service: "tarsee" },
      { project: P_TARSEE, service: S_TARSEE },
      { project: "Tarsee", environment: "staging", service: "TARSEE" },
    ]) {
      const r = await run({ action: "set_variable", name: "SETUP_PASSWORD", value: "hunter2hunter2", ...args }, { env: ON_RAILWAY });
      assertNothingChanged(r, JSON.stringify(args));
    }
  });

  // The allowlist: a key or address for the owner's own scripts, TZ, and Tarsee's tuning settings.
  const ALLOWED = ["SOME_SERVICE_API_KEY", "ALERTS_WEBHOOK", "TZ", "ALERTS_WEBHOOK_URL", "STATUS_PAGE_URL", "DATABASE_URL",
    "MY_SERVICE_API_KEY", "STRIPE_SECRET", "SMTP_PASSWORD", "NOTION_TOKEN", "API_KEY", "GOOGLE_PLACES_KEY"];
  const TUNING = ["TARSEE_TIMEZONE", "TARSEE_DEFAULT_EFFORT", "TARSEE_COMPACT_WINDOW", "TARSEE_MODEL_CONTEXT_TOKENS",
    "TARSEE_TOOL_RESULT_MAX_CHARS", "TARSEE_BASH_OUTPUT_MAX_CHARS", "TARSEE_SESSION_JSONL_MAX_MB", "TARSEE_PHONON_THREADS"];

  it("selfServiceRefusal: a reason for every name above, none for the allowlist", () => {
    assert.equal(typeof RA.selfServiceRefusal, "function", "railway-admin.js exports selfServiceRefusal");
    for (const [name] of cases) assert.ok(RA.selfServiceRefusal(name), name);
    for (const name of [...ALLOWED, ...TUNING]) assert.equal(RA.selfServiceRefusal(name), null, name);
    assert.deepEqual([...RA.SELF_SERVICE_SETTINGS].sort(), [...TUNING, "TZ"].sort(), "the settings besides the owner's keys: TZ and the tuning ones, no more");
  });

  it("a name off the list is refused with the rule in plain words and where the owner sets it instead", async () => {
    const r = await run({ action: "set_variable", name: "LOG_LEVEL", value: "debug" }, { env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /LOG_LEVEL is not one of the names this tool sets on Tarsee's own service/, r.out);
    assert.match(r.out, /ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL/, "says which names it sets");
    assert.match(r.out, /TZ/);
    assert.match(r.out, /TARSEE_PHONON_THREADS/, "and the tuning settings");
    assert.match(r.out, /by hand in Railway's dashboard/, "and where the owner makes the change");
    const shell = await run({ action: "set_variable", name: "PS0", value: "$(id)" }, { env: ON_RAILWAY });
    assert.match(shell.out, /how programs and shells start/, shell.out);
    const build = await run({ action: "set_variable", name: "BUILDKIT_SYNTAX", value: "attacker.example/frontend:latest", deploy: false }, { env: ON_RAILWAY });
    assert.match(build.out, /how Railway builds and runs Tarsee/, build.out);
    const read = await run({ action: "set_variable", name: "GITHUB_TOKEN", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY });
    assert.match(read.out, /read by Tarsee itself, its AI engines or a program it runs/, read.out);
  });

  it("TZ takes a time zone name only, never a path to a file", async () => {
    for (const value of [":/data/tarsee/workspace/zone", "/data/tarsee/workspace/zone", "../../data/tarsee/workspace/zone", "Asia/../../x", "UTC; id", ""]) {
      const r = await run({ action: "set_variable", name: "TZ", value, deploy: false }, { env: ON_RAILWAY });
      assertNothingChanged(r, JSON.stringify(value));
      assert.match(r.out, /TZ on Tarsee's own service takes a time zone name/, r.out);
      assert.match(r.out, /Railway's dashboard/);
    }
    for (const value of ["Asia/Manila", "UTC", "Etc/GMT-8", "America/Argentina/Buenos_Aires", "EST5EDT"]) {
      const rw = railway();
      const r = await run({ action: "set_variable", name: "TZ", value, deploy: false }, { rw, env: ON_RAILWAY });
      assert.match(r.out, /^Set TZ on tarsee/, `${value}: ${r.out}`);
      assert.equal(rw.valueOf(E_TARSEE, S_TARSEE, "TZ"), value);
    }
    const other = await run({ action: "set_variable", project: "Acme", service: "web", name: "TZ", value: ":/etc/localtime" });
    assert.match(other.out, /^Set TZ on web/, "another service is the owner's business");
  });

  it("the owner's keys, TZ and the tuning settings still go on Tarsee's own service, from_key included", async () => {
    for (const [name, how] of [
      ["SOME_SERVICE_API_KEY", { from_key: "WORKER_PASSWORD" }],
      ["ALERTS_WEBHOOK", { from_key: "ALERTS_WEBHOOK" }],
      ["ALERTS_WEBHOOK_URL", { from_key: "ALERTS_WEBHOOK" }],
      ["STATUS_PAGE_URL", { value: "https://status.example.com" }],
      ["TZ", { value: "Asia/Manila" }],
      ["TARSEE_TIMEZONE", { value: "Asia/Manila" }],
      ["TARSEE_PHONON_THREADS", { value: "2" }],
    ]) {
      for (const deploy of [true, false]) {
        const rw = railway();
        const r = await run({ action: "set_variable", name, ...how, deploy }, { rw, env: ON_RAILWAY });
        assert.match(r.out, new RegExp(`^Set ${name} on tarsee \\(service id ${S_TARSEE}\\)`), r.out);
        assert.equal(rw.writes().length, 1);
        assert.equal(rw.valueOf(E_TARSEE, S_TARSEE, name), how.value ?? (how.from_key === "ALERTS_WEBHOOK" ? HOOK : VAULT.WORKER_PASSWORD));
        assert.ok(!r.text.includes(VAULT.WORKER_PASSWORD) && !r.text.includes(HOOK), "the vault value is not shown");
      }
    }
  });

  it("a redeploy the owner asks for still works on Tarsee's own service", async () => {
    const r = await run({ action: "redeploy" }, { env: ON_RAILWAY });
    assert.match(r.out, /^Asked Railway to redeploy tarsee/, r.out);
    assert.deepEqual(r.rw.writes().map((c) => c.op), ["TarseeRedeploy"]);
  });

  it("nothing deletes one of them either: a delete is no action of this tool, and nothing is sent", async () => {
    for (const action of ["delete_variable", "variable_delete", "unset_variable", "remove_variable"]) {
      const r = await run({ action, name: "SETUP_PASSWORD" }, { env: ON_RAILWAY });
      assert.match(r.out, /never deletes anything: deleting a variable, a service or a project is something the owner does by hand in Railway/, action);
      assert.equal(r.rw.calls.length, 0, action);
    }
  });
});

describe("from_key onto Tarsee's own service while the owner has denied get_key", () => {
  // Denying get_key in Tool Permissions keeps the vault's keys out of the AI's reach (agent-env.js puts none in its
  // commands' environment then). A vault key set on Tarsee's own service would reach those commands at the next deploy.
  it("is refused, with a deploy or without, in any environment of it, saying why and where the owner sets it", async () => {
    for (const [args, deploy] of [[{}, true], [{}, false], [{ project: "Tarsee", environment: "staging", service: "tarsee" }, false]]) {
      const r = await run({ action: "set_variable", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD", deploy, ...args }, { env: ON_RAILWAY, getKeyDenied: () => true });
      assertNothingChanged(r, JSON.stringify(args));
      assert.match(r.out, /get_key is denied in Settings > Tool Permissions/, r.out);
      assert.match(r.out, /by hand in Railway's dashboard/, r.out);
    }
  });

  it("a plain value there, from_key onto another service, and from_key once get_key is allowed all still work", async () => {
    const plain = await run({ action: "set_variable", name: "STATUS_PAGE_URL", value: "https://status.example.com" }, { env: ON_RAILWAY, getKeyDenied: () => true });
    assert.match(plain.out, /^Set STATUS_PAGE_URL on tarsee/, plain.out);
    const other = await run({ action: "set_variable", service: "Postgres", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY, getKeyDenied: () => true });
    assert.match(other.out, /^Set SOME_SERVICE_API_KEY on Postgres/, other.out);
    const away = await run({ action: "set_variable", project: "Acme", service: "web", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY, getKeyDenied: () => true });
    assert.match(away.out, /^Set SOME_SERVICE_API_KEY on web/, away.out);
    const allowed = await run({ action: "set_variable", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY, getKeyDenied: () => false });
    assert.match(allowed.out, /^Set SOME_SERVICE_API_KEY on tarsee/, allowed.out);
  });

  it("when Tarsee can't tell whether get_key is denied, from_key onto its own service is refused", async () => {
    const r = await run({ action: "set_variable", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY, getKeyDenied: () => { throw new Error("settings unavailable"); } });
    assertNothingChanged(r);
    assert.match(r.out, /could not tell whether get_key is denied/, r.out);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Every name Tarsee's server, its start-up script, its Dockerfile, its AI engines and the libraries it runs read: none
// is set on Tarsee's own service (TZ and the tuning settings aside, which the tool may set on purpose). Scanned where it
// can be, so a name a change or an engine update adds is caught here, named.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };

/** The environment names a JavaScript, Python or shell file reads (comment lines left out). */
function namesReadIn(text, kind) {
  const names = new Set();
  const lines = text.split(/\r?\n/).filter((l) => !(kind === "sh" ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/).test(l)).join("\n");
  const patterns = kind === "sh"
    ? [/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g]
    : kind === "py"
      ? [/os\.environ(?:\.get)?[[(]\s*["']([A-Za-z_][A-Za-z0-9_]*)/g, /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)/g]
      : [/\b(?:process\.env|env|environ)\??\.([A-Za-z_][A-Za-z0-9_]*)/g, /\b(?:process\.env|env)\??\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g];
  for (const re of patterns) for (const m of lines.matchAll(re)) names.add(m[1]);
  return names;
}

/** Every file under `dir` (relative to the checkout) with one of `exts`, src/public left out (the browser's code). */
function filesUnder(dir, exts) {
  const out = [];
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) { if (path.relative(ROOT, p) !== path.join("src", "public")) walk(p); } else if (exts.includes(path.extname(e.name))) out.push(p);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

/** Every process.env name in a (large) file, read in chunks so the whole file is never one string. */
function envNamesInBinary(file, re = /process\.env(?:\?\.|\.|\[\s*["'`])([A-Za-z_][A-Za-z0-9_]*)/g) {
  const CHUNK = 16 * 1024 * 1024, OVERLAP = 512;
  const names = new Set();
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK + OVERLAP);
    for (let pos = 0; pos < size; pos += CHUNK) {
      const n = fs.readSync(fd, buf, 0, CHUNK + OVERLAP, pos);
      for (const m of buf.toString("latin1", 0, n).matchAll(re)) names.add(m[1]);
    }
  } finally {
    fs.closeSync(fd);
  }
  return names;
}

/** The Claude Code CLI the Agent SDK ships for this platform, or null (as test/claude-cli-env-names.test.js finds it). */
function claudeCli() {
  const sdk = path.join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(sdk, "package.json"), "utf8")); } catch { return null; }
  for (const dep of Object.keys(pkg.optionalDependencies || {})) {
    for (const dir of [path.join(ROOT, "node_modules", dep), path.join(sdk, "node_modules", dep)]) {
      for (const name of ["claude", "claude.exe"]) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  return null;
}

/** The Codex binary of whichever @openai/codex-<platform> package is installed, or null. */
function codexBinary() {
  const base = path.join(ROOT, "node_modules", "@openai");
  let pkgs = [];
  try { pkgs = fs.readdirSync(base).filter((d) => /^codex-(linux|darwin|win32)/.test(d)); } catch { return null; }
  for (const p of pkgs) {
    const vendor = path.join(base, p, "vendor");
    let triples = [];
    try { triples = fs.readdirSync(vendor); } catch { continue; }
    for (const t of triples) for (const name of ["codex", "codex.exe"]) if (fs.existsSync(path.join(vendor, t, "bin", name))) return path.join(vendor, t, "bin", name);
  }
  return null;
}

/**
 * Codex is a compiled program, so its names can't be scanned like the CLI's: these are the ones in codex 0.167 that
 * look like a key for the owner's scripts (its sign-in, its host, the GitHub and cloud logins it uses).
 */
const CODEX_READS = ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GH_TOKEN",
  "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "AWS_CONTAINER_AUTHORIZATION_TOKEN"];
/**
 * What the libraries Tarsee runs read that looks like a key for the owner's scripts (found with a scan of node_modules
 * for process.env.<NAME ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL>; that scan takes too long to
 * run on every test run).
 */
const LIBRARY_READS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "APP_URL", "SESSION_INGRESS_URL",
  "DISCORD_TOKEN", "SLACK_BOT_TOKEN", "SELENIUM_REMOTE_URL", "DOTENV_KEY", "BUILD_URL", "JENKINS_URL", "CI_JOB_URL",
  "CI_PROJECT_URL", "GITHUB_SERVER_URL", "ETHEREAL_API_KEY", "GCM_API_KEY", "MCP_CLIENT_SECRET", "MCP_SERVER_URL",
  "MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL", "PLAYWRIGHT_MCP_EXTENSION_TOKEN", "PLAYWRIGHT_TEST_BASE_URL",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_SESSION_ACCESS_TOKEN"];

function refusedOnSelf(names, where) {
  const allowed = new Set(RA.SELF_SERVICE_SETTINGS || []);
  const through = [...names].filter((n) => !allowed.has(n) && !RA.selfServiceRefusal(n)).sort();
  assert.deepEqual(through, [], `${where} reads these, and tarsee_railway would set them on Tarsee's own service. Refuse them in src/lib/railway-admin.js (READ_BY_TARSEE or a family before it).`);
}

describe("every name Tarsee and its AI engines read is refused on Tarsee's own service", () => {
  it("Tarsee's own code (the server, its voice workers and skills' scripts)", () => {
    const names = new Set();
    for (const f of filesUnder("src", [".js", ".mjs", ".cjs"])) for (const n of namesReadIn(fs.readFileSync(f, "utf8"), "js")) names.add(n);
    for (const f of filesUnder("src", [".py"])) for (const n of namesReadIn(fs.readFileSync(f, "utf8"), "py")) names.add(n);
    for (const f of filesUnder("src", [".sh"])) for (const n of namesReadIn(fs.readFileSync(f, "utf8"), "sh")) names.add(n);
    assert.ok(names.size > 40, `found only ${names.size} names in src: is the scan working?`);
    for (const n of ["SETUP_PASSWORD", "TARSEE_STATE_DIR", "VAPID_SUBJECT", "CLAUDE_BIN", "PHONON_THREADS"]) assert.ok(names.has(n), `the scan finds ${n}`);
    refusedOnSelf(names, "Tarsee's code");
  });

  it("its start-up script, its Dockerfile, railway.toml, docker-compose.yml and .env.example", () => {
    const names = namesReadIn(read("entrypoint.sh"), "sh");
    const docker = read("Dockerfile");
    for (const m of docker.matchAll(/^\s*(?:ENV|ARG)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) names.add(m[1]);
    for (const n of namesReadIn(docker, "sh")) names.add(n);
    for (const m of read("railway.toml").matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) names.add(m[1]);
    for (const m of read("docker-compose.yml").matchAll(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)(?:=|\s*$)/gm)) names.add(m[1]);
    for (const m of read(".env.example").matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)) names.add(m[1]);
    for (const n of ["ENCRYPTION_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "TARSEE_AUTO_UPDATE_CLI", "PLAYWRIGHT_BROWSERS_PATH", "RAILWAY_GIT_COMMIT_SHA"]) assert.ok(names.has(n), `the scan finds ${n}`);
    refusedOnSelf(names, "The start-up script, the Dockerfile or the deploy files");
  });

  it("Claude Code: the Agent SDK's code and the CLI it ships", () => {
    const sdk = path.join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const names = new Set();
    for (const f of fs.existsSync(sdk) ? fs.readdirSync(sdk).filter((x) => /\.m?js$/.test(x)) : []) for (const n of envNamesInBinary(path.join(sdk, f))) names.add(n);
    const cli = claudeCli();
    if (cli) for (const n of envNamesInBinary(cli)) names.add(n);
    if (cli) assert.ok(names.size > 200, `found only ${names.size} names in ${cli}: is this the CLI?`);
    for (const n of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) names.add(n);
    refusedOnSelf(names, "Claude Code");
  });

  it("Codex, and the libraries Tarsee runs", () => {
    const codex = codexBinary();
    if (codex) {
      // A compiled program keeps its names one after another, so a name is looked for anywhere, not between words.
      const found = envNamesInBinary(codex, new RegExp(`(${CODEX_READS.join("|")})`, "g"));
      assert.deepEqual(CODEX_READS.filter((n) => !found.has(n)), [], `gone from ${codex}: check what replaced them`);
    }
    refusedOnSelf(CODEX_READS, "Codex");
    refusedOnSelf(LIBRARY_READS, "A library Tarsee runs");
  });
});

describe("a variable Tarsee's own settings are filled in from is never set either", () => {
  // One of Tarsee's protected variables can be a Railway reference to another variable, on another service, on
  // Tarsee's own or a shared one. Changing that one changes Tarsee's setting at its next deploy, whoever starts it.
  const TOK_VALUE = "tok-SECRET-start-";
  // The names on Tarsee's own service that a reference fills in are names the allowlist would let through (a key of the
  // owner's), so the reference check is what stops them.
  const protectedRefs = {
    [E_TARSEE]: [
      { name: "TARSEE_API_TOKEN", serviceId: S_TARSEE, value: `${TOK_VALUE}\${{ Worker.API_TOKEN }}` },
      { name: "OPENAI_API_KEY", serviceId: S_TARSEE, value: "${{MY_OPENAI_KEY}}" },
      { name: "TARSEE_AI_MODEL", serviceId: S_TARSEE, value: "${{tarsee.MODEL_SOURCE_URL}}" },
      { name: "TARSEE_KEYS_ONLY", serviceId: S_TARSEE, value: "${{KO_TOKEN}}" },
      { name: "KO_TOKEN", serviceId: S_TARSEE, value: "${{worker.KO_SRC}}" },
      { name: "ANTHROPIC_API_KEY", serviceId: S_TARSEE, value: "${{shared.ANT}}" },
      { name: "ANT", serviceId: null, value: "${{Postgres.ANT_SRC}}" },
      { name: "STATUS_PAGE_URL", serviceId: S_TARSEE, value: "${{worker.LVL}}" },
      { name: "LOG_LEVEL", serviceId: S_TARSEE, value: "${{worker.LOG_SRC}}" },
      { name: "TZ", serviceId: S_TARSEE, value: "${{worker.ZONE}}" },
    ],
  };
  // [service, name, the protected variable the refusal names]
  const fed = [
    ["worker", "API_TOKEN", "TARSEE_API_TOKEN"],
    ["tarsee", "MY_OPENAI_KEY", "OPENAI_API_KEY"],
    ["tarsee", "MODEL_SOURCE_URL", "TARSEE_AI_MODEL"],
    ["tarsee", "KO_TOKEN", "TARSEE_KEYS_ONLY"],
    ["worker", "KO_SRC", "TARSEE_KEYS_ONLY"],
    ["Postgres", "ANT_SRC", "ANTHROPIC_API_KEY"],
    // A name off the allowlist is guarded the same way, and so is TZ: a reference would skip the check on its value.
    ["worker", "LOG_SRC", "LOG_LEVEL"],
    ["worker", "ZONE", "TZ"],
  ];

  for (const [service, name, feeds] of fed) {
    it(`${name} on ${service} feeds Tarsee's ${feeds}: refused, with a deploy or without, and nothing is sent`, async () => {
      for (const deploy of [true, false]) {
        const r = await run({ action: "set_variable", service, name, value: "plain-value", deploy }, { rw: railway({ more: protectedRefs }), env: ON_RAILWAY });
        assertNothingChanged(r, `${service}.${name} deploy=${deploy}`);
        assert.match(r.out, new RegExp(`Tarsee's own ${feeds} is filled in from ${name} on ${service} by a Railway reference`, "i"), r.out);
        assert.match(r.out, /Railway's dashboard/, "says where the owner changes it");
        assert.ok(!r.text.includes(TOK_VALUE), "no value of Tarsee's own variables in the result or the log");
      }
    });
  }

  it("from_key into such a variable is refused too", async () => {
    const r = await run({ action: "set_variable", service: "worker", name: "API_TOKEN", from_key: "WORKER_PASSWORD" }, { rw: railway({ more: protectedRefs }), env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /Tarsee's own TARSEE_API_TOKEN is filled in from API_TOKEN on worker/);
  });

  it("what feeds nothing of Tarsee's keeps working: other names, a reference into an everyday variable, another environment", async () => {
    for (const [args, envId, svcId] of [
      [{ service: "worker", name: "OTHER_SETTING" }, E_TARSEE, S_TWORK],
      // It fills STATUS_PAGE_URL, which the tool may set on Tarsee's own service itself.
      [{ service: "worker", name: "LVL" }, E_TARSEE, S_TWORK],
      [{ name: "MY_OPENAI_SECRET" }, E_TARSEE, S_TARSEE],
      [{ environment: "staging", service: "worker", name: "API_TOKEN" }, E_TSTAGE, S_TWORK],
    ]) {
      const rw = railway({ more: protectedRefs });
      const r = await run({ action: "set_variable", value: "plain-value", deploy: false, ...args }, { rw, env: ON_RAILWAY });
      assert.match(r.out, new RegExp(`^Set ${args.name} on `), `${JSON.stringify(args)}: ${r.out}`);
      assert.equal(rw.valueOf(envId, svcId, args.name), "plain-value");
      assert.ok(!r.text.includes(TOK_VALUE));
    }
  });

  it("the shared variables are asked for with serviceId left out, as Railway's guide shows, never sent as null", async () => {
    const rw = railway({ more: protectedRefs });
    const r = await run({ action: "set_variable", service: "Postgres", name: "ANT_SRC", value: "plain-value" }, { rw, env: ON_RAILWAY });
    assert.match(r.out, /Tarsee's own ANTHROPIC_API_KEY is filled in from ANT_SRC on Postgres/, r.out);
    const lookups = rw.calls.filter((c) => c.op === "TarseeUnrenderedVariables").map((c) => c.body.variables);
    assert.equal(lookups.filter((v) => !Object.hasOwn(v, "serviceId")).length, 1, "one lookup of the shared variables, without serviceId");
    assert.ok(lookups.every((v) => !Object.hasOwn(v, "serviceId") || typeof v.serviceId === "string"), "no serviceId: null");
  });

  // A sealed variable's value never comes back from Railway, so a reference in one can't be followed. One of Tarsee's
  // protected settings that is sealed could be filled in from any variable in its environment: fail closed there.
  const sealedSetting = { [E_TARSEE]: [{ name: "TARSEE_API_TOKEN", serviceId: S_TARSEE, isSealed: true, value: "${{worker.API_TOKEN}}" }] };

  it("while a protected setting of Tarsee's is sealed, nothing is set in that environment of its project", async () => {
    for (const args of [
      { service: "worker", name: "API_TOKEN" },       // the reference hidden in the sealed value
      { service: "worker", name: "OTHER_SETTING" },
      { service: "Postgres", name: "SOME_SERVICE_API_KEY" },
      { name: "SOME_SERVICE_API_KEY" },               // Tarsee's own service, a name the allowlist lets through
    ]) {
      for (const deploy of [true, false]) {
        const r = await run({ action: "set_variable", value: "plain-value", deploy, ...args }, { rw: railway({ more: sealedSetting }), env: ON_RAILWAY });
        assertNothingChanged(r, `${JSON.stringify(args)} deploy=${deploy}`);
        assert.match(r.out, /Tarsee's own TARSEE_API_TOKEN is sealed/, r.out);
        assert.match(r.out, /can't see whether it is filled in from another variable/, r.out);
        assert.match(r.out, /by hand in Railway's dashboard/, r.out);
      }
    }
  });

  it("a sealed link in the middle of a chain is refused the same way", async () => {
    const chain = {
      [E_TARSEE]: [
        { name: "TARSEE_KEYS_ONLY", serviceId: S_TARSEE, value: "${{worker.KO_MID}}" },
        { name: "KO_MID", serviceId: S_TWORK, isSealed: true, value: "${{Postgres.KO_END}}" },
      ],
    };
    const end = await run({ action: "set_variable", service: "Postgres", name: "KO_END", value: "0" }, { rw: railway({ more: chain }), env: ON_RAILWAY });
    assertNothingChanged(end);
    assert.match(end.out, /Tarsee's own TARSEE_KEYS_ONLY is filled in from KO_MID on worker, which is sealed/, end.out);
    const mid = await run({ action: "set_variable", service: "worker", name: "KO_MID", value: "0" }, { rw: railway({ more: chain }), env: ON_RAILWAY });
    assertNothingChanged(mid);
    assert.match(mid.out, /Tarsee's own TARSEE_KEYS_ONLY is filled in from KO_MID on worker by a Railway reference/, mid.out);
  });

  it("what a sealed setting can't reach still works: another environment, another project; a sealed key of the owner's is no setting", async () => {
    const stage = await run({ action: "set_variable", environment: "staging", service: "worker", name: "API_TOKEN", value: "plain-value" }, { rw: railway({ more: sealedSetting }), env: ON_RAILWAY });
    assert.match(stage.out, /^Set API_TOKEN on worker .* in staging/, stage.out);
    const acme = await run({ action: "set_variable", project: "Acme", service: "worker", name: "API_TOKEN", value: "plain-value" }, { rw: railway({ more: sealedSetting }), env: ON_RAILWAY });
    assert.match(acme.out, /^Set API_TOKEN on worker/, acme.out);
    const ownKeys = {
      [E_TARSEE]: [
        { name: "SOME_SERVICE_API_KEY", serviceId: S_TARSEE, isSealed: true, value: "${{worker.X}}" },
        { name: "UNRELATED", serviceId: S_TWORK, isSealed: true, value: "${{Postgres.Y}}" },
      ],
    };
    const r = await run({ action: "set_variable", service: "worker", name: "X", value: "plain-value", deploy: false }, { rw: railway({ more: ownKeys }), env: ON_RAILWAY });
    assert.match(r.out, /^Set X on worker/, r.out);
  });

  it("when Railway can't say what Tarsee's settings are filled in from, nothing is set in Tarsee's project", async () => {
    const r = await run({ action: "set_variable", service: "worker", name: "OTHER_SETTING", value: "1" }, { rw: railway({ refsFail: true }), env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /Railway said: "Problem processing request"/);
  });

  it("a write in another project never reads any variable's value", async () => {
    const rw = railway({ more: protectedRefs });
    const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "API_TOKEN", value: "plain-value" }, { rw, env: ON_RAILWAY });
    assert.match(r.out, /^Set API_TOKEN on worker/, r.out);
    assert.ok(!rw.calls.some((c) => c.op === "TarseeUnrenderedVariables"), "no unrendered values asked for outside Tarsee's project");
  });

  it("off Railway (Tarsee's own service unknown) nothing extra is asked for", async () => {
    const rw = railway({ more: protectedRefs });
    const r = await run({ action: "set_variable", project: "Tarsee", service: "worker", name: "API_TOKEN", value: "plain-value" }, { rw });
    assert.match(r.out, /^Set API_TOKEN on worker/, r.out);
    assert.ok(!rw.calls.some((c) => c.op === "TarseeUnrenderedVariables"));
  });
});

describe("other services keep working", () => {
  it("a provider key from the vault onto another project's service: set, the value reaching Railway only", async () => {
    const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "OPENAI_API_KEY", from_key: "OPENAI_KEY" });
    assert.match(r.out, /^Set OPENAI_API_KEY on worker \(service id /, r.out);
    assert.equal(r.rw.valueOf(E_PROD, S_WORK, "OPENAI_API_KEY"), OPENAI);
    assert.ok(!r.text.includes(OPENAI));
  });

  it("names that are Tarsee's own settings are ordinary on another service", async () => {
    for (const [name, how] of [["SETUP_PASSWORD", { from_key: "WORKER_PASSWORD" }], ["NODE_OPTIONS", { value: "--max-old-space-size=512" }], ["TARSEE_AI_PROVIDER", { value: "openai" }], ["PORT", { value: "8080" }]]) {
      const rw = railway();
      const r = await run({ action: "set_variable", project: "Acme", service: "web", name, ...how }, { rw });
      assert.match(r.out, new RegExp(`^Set ${name} on web`), r.out);
      assert.equal(rw.writes().length, 1, name);
    }
  });

  it("another service in Tarsee's own project (on Railway) is not Tarsee", async () => {
    const r = await run({ action: "set_variable", service: "Postgres", name: "SETUP_PASSWORD", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY });
    assert.match(r.out, /^Set SETUP_PASSWORD on Postgres/, r.out);
    assert.equal(r.rw.valueOf(E_TARSEE, S_PG, "SETUP_PASSWORD"), VAULT.WORKER_PASSWORD);
  });

  it("redeploying another service works as before", async () => {
    const r = await run({ action: "redeploy", project: "Acme", service: "web" });
    assert.match(r.out, /^Asked Railway to redeploy web/, r.out);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real vault (a temporary one), the tool switch in tools.js, and what the AI reads about the tool.

describe("through tools.js, the real vault and the MCP server", () => {
  let realFetch;
  before(async () => {
    const { setKey } = await import("../src/lib/key-vault.js");
    setKey("RAILWAY_API_TOKEN", TOKEN, "test token");
    setKey("ALERTS_WEBHOOK", HOOK, "test webhook");
    realFetch = globalThis.fetch;
  });
  after(() => { globalThis.fetch = realFetch; });

  it("executeTool('railway') refuses the token and a reference, and still sets an ordinary variable", async () => {
    const rw = railway();
    globalThis.fetch = rw.fetch;
    try {
      const { executeTool } = await import("../src/lib/tools.js");
      const tok = await executeTool("railway", { action: "set_variable", project: "Acme", service: "web", name: "T", from_key: "RAILWAY_API_TOKEN", approved_by: GO }, {});
      assert.match(tok, /never copies it into a service/, tok);
      assert.ok(!tok.includes(TOKEN));
      const ref = await executeTool("railway", { action: "set_variable", project: "Acme", service: "web", name: "T", value: "${{shared.X}}", approved_by: GO }, {});
      assert.match(ref, /a Railway reference/, ref);
      assert.equal(rw.writes().length, 0);
      const ok = await executeTool("railway", { action: "set_variable", project: "Acme", service: "web", name: "ALERTS_WEBHOOK_URL", from_key: "ALERTS_WEBHOOK", approved_by: GO }, {});
      assert.match(ok, /^Set ALERTS_WEBHOOK_URL on web/, ok);
      assert.equal(rw.valueOf(E_PROD, S_WEB, "ALERTS_WEBHOOK_URL"), HOOK);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("executeTool('railway') reads Tool Permissions: from_key onto Tarsee's own service is refused while get_key is denied", async () => {
    const rw = railway();
    globalThis.fetch = rw.fetch;
    const saved = Object.fromEntries(Object.keys(ON_RAILWAY).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ON_RAILWAY);
    const { getSecurityManager } = await import("../src/lib/security-manager.js");
    const sm = getSecurityManager();
    const was = sm.getToolPermission("get_key");
    try {
      const { executeTool } = await import("../src/lib/tools.js");
      const args = { action: "set_variable", name: "ALERTS_WEBHOOK_URL", from_key: "ALERTS_WEBHOOK", deploy: false, approved_by: GO };
      sm.setToolPermission("get_key", "always_deny");
      const denied = await executeTool("railway", args, {});
      assert.match(denied, /get_key is denied in Settings > Tool Permissions/, denied);
      assert.equal(rw.writes().length, 0);
      sm.setToolPermission("get_key", "always_allow");
      const allowed = await executeTool("railway", args, {});
      assert.match(allowed, /^Set ALERTS_WEBHOOK_URL on tarsee/, allowed);
      assert.equal(rw.valueOf(E_TARSEE, S_TARSEE, "ALERTS_WEBHOOK_URL"), HOOK);
    } finally {
      sm.setToolPermission("get_key", was);
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      globalThis.fetch = realFetch;
    }
  });

  it("the tool's description tells the AI what it never does and where those changes are made", async () => {
    const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
    const server = createTarseeMcp({});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "railway-limits-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.instance.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      const { tools } = await mcp.listTools();
      const tool = tools.find((t) => t.name === "tarsee_railway");
      assert.match(tool.description, /NEVER, WHOEVER GAVE THE GO:/);
      assert.match(tool.description, /a Railway reference \(\$\{\{ \.\.\. \}\}\)/);
      assert.match(tool.description, /RAILWAY_API_TOKEN/);
      assert.match(tool.description, /SETUP_PASSWORD/);
      assert.match(tool.description, /Settings > AI/);
      assert.match(tool.description, /Nor is a variable that one of those settings is filled in from by a Railway reference/);
      assert.match(tool.description, /ON TARSEE'S OWN SERVICE IT SETS ONLY/);
      assert.match(tool.description, /ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL/);
      assert.match(tool.description, /TZ/);
      assert.match(tool.description, /TARSEE_PHONON_THREADS/);
      assert.match(tool.description, /sealed/);
      assert.match(tool.description, /get_key is denied/);
      assert.match(tool.description, /Railway's dashboard/);
      assert.ok(!tool.description.includes(String.fromCharCode(0x2014)), "no long dash");
      assert.match(tool.inputSchema.properties.from_key.description, /Tarsee's own keys .* are refused/);
      assert.match(tool.inputSchema.properties.from_key.description, /onto Tarsee's own service while get_key is denied/);
      assert.match(tool.inputSchema.properties.name.description, /On Tarsee's own service only/);
      assert.match(tool.inputSchema.properties.value.description, /A Railway reference \(\$\{\{ \.\.\. \}\}\) is refused/);
    } finally {
      await mcp.close();
    }
  });
});
