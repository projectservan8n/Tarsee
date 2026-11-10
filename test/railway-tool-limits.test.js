// tarsee_railway's limits (src/lib/railway-admin.js): what the tool never does, whoever the AI says gave the go. What
// the AI asks for can come from a web page or a message it read, so:
//   - a value that is a Railway reference (${{ ... }}) is refused on every service: Railway fills it in from another
//     variable when the service deploys, so it could pull a shared secret or another service's secret into a service;
//   - Tarsee's own keys (its Railway token, its sign-in and encryption secrets) are never copied into a service;
//   - on Tarsee's own service only an allowlist is set, with a deploy or without one: a key or address for the owner's
//     own scripts (a name in capitals ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL that no part of
//     Tarsee reads), TZ, and a few tuning settings. Every name Tarsee's code, its start-up script and its Dockerfile
//     read is refused there (scanned below), every name that appears anywhere in its AI engines' and browser library's
//     shipped code (src/lib/engine-env-names.json, re-extracted below), and every other name;
//   - a variable that any variable on Tarsee's own service is filled in from (by a Railway reference, through shared
//     variables and chains) counts as that variable: the same rules, under the name on Tarsee's own service. While a
//     guarded one is sealed (its value can't be read) nothing is set in that environment of Tarsee's project;
//   - while the owner has denied get_key in Tool Permissions, no vault key (from_key) goes onto Tarsee's own service,
//     nor into a variable it is filled in from;
//   - every one of these holds on any Tarsee service: Tarsee's own in any environment, a service whose variable names
//     give it away (SETUP_PASSWORD, ENCRYPTION_KEY, a TARSEE_ name), one Railway says is deployed from Tarsee's repo or
//     image. Where Tarsee can't read the programs a variable reaches (another Tarsee, its own service in another
//     environment, or its own while TARSEE_AUTO_UPDATE_CLI is set), only TZ and the tuning settings go.
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
// The Terminal's own Claude Code, which Tarsee reads when it starts (startTerminalCliScan): none here unless a test
// gives one, so no test reads the claude installed on the machine it runs on.
await RA.startTerminalCliScan?.({ find: async () => [], log: () => {} });

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
 * unrendered-variables query fail as Railway would. `services` adds services to Tarsee's project ({ id, name }).
 * `sources` is what Railway says a service is deployed from ({ [serviceId]: { repo, image } }), or "fail" when its API
 * doesn't say. `namesFail` lists the environments whose variable names Railway doesn't give.
 */
function railway({ more = {}, refsFail = false, services = [], sources = {}, namesFail = [] } = {}) {
  const acct = {
    projects: [
      { id: P_ACME, name: "Acme", deletedAt: null, environments: [{ id: E_PROD, name: "production" }], services: [{ id: S_WEB, name: "web" }, { id: S_WORK, name: "worker" }] },
      { id: P_TARSEE, name: "Tarsee", deletedAt: null, environments: [{ id: E_TARSEE, name: "production" }, { id: E_TSTAGE, name: "staging" }], services: [{ id: S_TARSEE, name: "tarsee" }, { id: S_PG, name: "Postgres" }, { id: S_TWORK, name: "worker" }, ...services] },
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
        if (namesFail.includes(v.environmentId)) return reply(200, { errors: [{ message: "Problem processing request" }], data: null });
        return reply(200, { data: { environment: { variables: edges((acct.variables[v.environmentId] || []).map(({ name, serviceId, isSealed }) => ({ name, serviceId, isSealed }))) } } });
      case "TarseeServiceSources": {
        // Each service's deployments, one per environment, with the repo or image Railway builds it from.
        if (sources === "fail") return reply(400, { errors: [{ message: "Cannot query field \"source\" on type \"ServiceInstance\"." }] });
        const p = acct.projects.find((x) => x.id === v.id);
        if (!p) return reply(200, { errors: [{ message: "Project not found" }], data: null });
        const instances = (s) => p.environments.map((e) => ({ environmentId: e.id, source: { repo: null, image: null, ...sources[s.id] } }));
        return reply(200, { data: { project: { services: edges(p.services.map((s) => ({ id: s.id, serviceInstances: edges(instances(s)) }))) } } });
      }
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
    // Round 3. Chromium's keys for Google's services (and their per-service and per-client forms).
    ["GOOGLE_API_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    ["GOOGLE_DEFAULT_CLIENT_ID", { value: "1234.apps.googleusercontent.com" }, DASH],
    ["GOOGLE_DEFAULT_CLIENT_SECRET", { from_key: "WORKER_PASSWORD" }, DASH],
    ["GOOGLE_API_KEY_SODA", { from_key: "WORKER_PASSWORD" }, DASH],
    ["GOOGLE_CLIENT_ID_MAIN", { value: "1234.apps.googleusercontent.com" }, DASH],
    ["GOOGLE_CLIENT_SECRET_MAIN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["GOOGLE_METRICS_SIGNING_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    // Round 3. Names Claude Code reads through its typed lists of settings (process.env[e]), never as process.env.NAME:
    // where voice mode sends the claude.ai sign-in, a proxy for all its traffic and that proxy's token, a Google Cloud
    // sign-in, a cloud environment's key. Refused because they appear in the engines' code.
    ["VOICE_STREAM_BASE_URL", { value: "https://attacker.example/x" }, DASH],
    ["AGENT_PROXY_URL", { value: "https://attacker.example/proxy" }, DASH],
    ["AGENT_PROXY_AUTH_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["CLOUDSDK_AUTH_ACCESS_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["ENVIRONMENT_SERVICE_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    // Everyday-looking names an engine's code holds: Bun's built-in database client (inside the Claude Code CLI) reads
    // DATABASE_URL and REDIS_URL; Claude Code lists SLACK_WEBHOOK_URL and NPM_TOKEN among the names it treats as
    // secrets; Codex reads CODEX_CONNECTORS_TOKEN.
    ["DATABASE_URL", { from_key: "WORKER_PASSWORD" }, DASH],
    ["REDIS_URL", { from_key: "WORKER_PASSWORD" }, DASH],
    ["SLACK_WEBHOOK_URL", { from_key: "ALERTS_WEBHOOK" }, DASH],
    ["NPM_TOKEN", { from_key: "WORKER_PASSWORD" }, DASH],
    ["API_KEY", { from_key: "WORKER_PASSWORD" }, DASH],
    ["CODEX_CONNECTORS_TOKEN", { from_key: "WORKER_PASSWORD" }, AI],
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
  // (DATABASE_URL and API_KEY were on this list until round 3: both appear in the engines' code, so they are refused.)
  const ALLOWED = ["SOME_SERVICE_API_KEY", "ALERTS_WEBHOOK", "TZ", "ALERTS_WEBHOOK_URL", "STATUS_PAGE_URL", "DB_URL",
    "MY_SERVICE_API_KEY", "STRIPE_SECRET", "SMTP_PASSWORD", "NOTION_TOKEN", "WORKER_API_KEY", "GOOGLE_PLACES_KEY"];
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
    const browser = await run({ action: "set_variable", name: "GOOGLE_API_KEY", from_key: "WORKER_PASSWORD", deploy: false }, { env: ON_RAILWAY });
    assert.match(browser.out, /read by the browser Tarsee drives \(Chromium, through Playwright\)/, browser.out);
    const engine = await run({ action: "set_variable", name: "VOICE_STREAM_BASE_URL", value: "https://attacker.example/x", deploy: false }, { env: ON_RAILWAY });
    assert.match(engine.out, /VOICE_STREAM_BASE_URL appears in the code of Tarsee's AI engines or its browser library/, engine.out);
    assert.match(engine.out, /by hand in Railway's dashboard/, engine.out);
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
    // In another environment only TZ and the tuning settings go at all (see below), and from_key not even those.
    for (const [args, deploy, name] of [[{}, true, "SOME_SERVICE_API_KEY"], [{}, false, "SOME_SERVICE_API_KEY"], [{ project: "Tarsee", environment: "staging", service: "tarsee" }, false, "TARSEE_TIMEZONE"]]) {
      const r = await run({ action: "set_variable", name, from_key: "WORKER_PASSWORD", deploy, ...args }, { env: ON_RAILWAY, getKeyDenied: () => true });
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

/**
 * What the libraries Tarsee runs (besides its AI engines and Playwright, scanned below) read that looks like a key for
 * the owner's scripts (found with a scan of node_modules for process.env.<NAME ending in _KEY, _TOKEN, _SECRET,
 * _PASSWORD, _WEBHOOK or _URL>; that scan takes too long to run on every test run).
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

  it("the other libraries Tarsee runs", () => {
    refusedOnSelf(LIBRARY_READS, "A library Tarsee runs");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The names in the shipped code of Tarsee's AI engines and its browser library (src/lib/engine-env-names.json).
//
// Claude Code reads most of its settings through typed lists of names ({NAME:()=>u.str()}, each read as process.env[e]),
// much of its CLI is bytecode, and Codex is a compiled program, so no search for process.env.NAME finds what they read.
// So the rule is blunter: a name in capitals with underscores that appears as a string anywhere in that code is never
// set on Tarsee's own service. The allowlist already refuses every name that isn't key-shaped, so the list keeps the
// ones it would otherwise let through. This test re-extracts them from node_modules on every run (streaming the native
// programs, about a second), and a name an engine update brings that the list lacks fails here, named.
//
// To bring the list up to date (after an engine update, or to add another platform's programs):
//   TARSEE_UPDATE_ENGINE_NAMES=1 node --test test/railway-tool-limits.test.js
// adds what the installed engines hold, and keeps what the list already has. Each platform ships its own CLI and Codex
// programs, and the list holds them all (CI runs on Linux, Railway too). To add another platform's: npm pack its
// packages (@anthropic-ai/claude-agent-sdk-linux-x64@<version>, @openai/codex@<version>-linux-x64, and the rest), unpack
// each with tar -xzf into a folder of its own, and list the unpacked package folders in TARSEE_ENGINE_PACKAGES (joined
// with the path delimiter, ; on Windows and : elsewhere).

const ENGINE_NAMES_FILE = path.join(ROOT, "src", "lib", "engine-env-names.json");
const UPDATE_ENGINE_NAMES = process.env.TARSEE_UPDATE_ENGINE_NAMES === "1";
const MORE_ENGINE_PACKAGES = String(process.env.TARSEE_ENGINE_PACKAGES || "").split(path.delimiter).filter(Boolean);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const isJs = (file) => /\.(?:m?js|cjs)$/.test(file);
/** "name@version" of the package in `dir`. */
const packageOf = (dir) => { const p = readJson(path.join(dir, "package.json")); return `${p.name}@${p.version}`; };
/** Every file under `dir` that `keep` keeps. */
function allFiles(dir, keep = () => true) {
  const out = [];
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile() && keep(p)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/**
 * The engines' shipped files: `text` (JavaScript) and `native` (programs, read as bytes), and the packages they come
 * from. The Claude Agent SDK's JavaScript (sdk.mjs and the rest) and the Claude Code CLI each installed platform package
 * ships; the Codex SDK, the codex launcher, and every file of each installed Codex platform package (codex itself, its
 * helpers and their libraries); Playwright's library (playwright-core), which starts Chromium and drives it. Then the
 * unpacked packages TARSEE_ENGINE_PACKAGES lists.
 */
function engineFiles() {
  const nm = path.join(ROOT, "node_modules");
  const text = [], native = [], packages = new Set();
  const cliIn = (dir) => ["claude", "claude.exe"].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
  const optional = (dir) => Object.keys(readJson(path.join(dir, "package.json")).optionalDependencies || {});

  const sdk = path.join(nm, "@anthropic-ai", "claude-agent-sdk");
  if (fs.existsSync(path.join(sdk, "package.json"))) {
    packages.add(packageOf(sdk));
    text.push(...fs.readdirSync(sdk).filter(isJs).map((f) => path.join(sdk, f)));
    for (const dep of optional(sdk)) {
      const dir = [path.join(sdk, "node_modules", dep), path.join(nm, dep)].find((d) => cliIn(d));
      if (dir) { native.push(cliIn(dir)); packages.add(packageOf(dir)); }
    }
  }
  const codexSdk = path.join(nm, "@openai", "codex-sdk");
  if (fs.existsSync(path.join(codexSdk, "package.json"))) {
    packages.add(packageOf(codexSdk));
    text.push(...allFiles(path.join(codexSdk, "dist"), isJs));
  }
  const codex = [path.join(codexSdk, "node_modules", "@openai", "codex"), path.join(nm, "@openai", "codex")].find((d) => fs.existsSync(path.join(d, "package.json")));
  if (codex) {
    packages.add(packageOf(codex));
    text.push(...allFiles(path.join(codex, "bin"), isJs));
    for (const dep of optional(codex)) {
      const dir = [path.join(codex, "node_modules", dep), path.join(nm, dep)].find((d) => fs.existsSync(path.join(d, "vendor")));
      if (dir) { native.push(...allFiles(path.join(dir, "vendor"))); packages.add(packageOf(dir)); }
    }
  }
  const pw = path.join(nm, "playwright-core");
  if (fs.existsSync(path.join(pw, "package.json"))) {
    packages.add(packageOf(pw));
    text.push(...allFiles(path.join(pw, "lib"), isJs));
  }
  for (const dir of MORE_ENGINE_PACKAGES) {
    const cli = cliIn(dir);
    if (cli) native.push(cli);
    else if (fs.existsSync(path.join(dir, "vendor"))) native.push(...allFiles(path.join(dir, "vendor")));
    else throw new Error(`TARSEE_ENGINE_PACKAGES: ${dir} holds neither a claude program nor a vendor folder (pass the unpacked package folder)`);
    packages.add(packageOf(dir));
  }
  return { text, native, packages: [...packages].sort() };
}

// A run: capitals, digits and underscores, one after another. Only runs holding an underscore are kept.
const RUN_BYTE = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) RUN_BYTE[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) RUN_BYTE[c] = 1;
RUN_BYTE[0x5f] = 1;
const QUOTE_BYTE = new Set([0x22, 0x27, 0x60]);
const CHUNK = 16 * 1024 * 1024, EDGE = 1024 * 1024;

/**
 * The runs in `file`, read in pieces so a program of hundreds of megabytes is never one string. `whole` gets the runs
 * that are one string each: every run of a JavaScript file, and a run between two of the same quote inside a program
 * (a JavaScript or JSON string there). `inside` gets the rest: a native program can keep its strings one after another
 * with nothing between them (GH_TOKENGITHUB_TOKEN), so a name can sit inside such a run.
 */
function runsIn(file, isText, whole, inside) {
  const size = fs.statSync(file).size;
  const scan = (buf, n, from, lo, hi) => {
    for (let i = buf.indexOf(0x5f, lo); i !== -1 && i < n; i = buf.indexOf(0x5f, i)) {
      let a = i, b = i + 1;
      while (a > 0 && RUN_BYTE[buf[a - 1]]) a--;
      while (b < n && RUN_BYTE[buf[b]]) b++;
      if (a >= hi) break;   // the next piece's
      if ((a === 0 && from > 0) || (b === n && from + n < size)) throw new Error(`${file}: a run of capitals over ${EDGE} bytes long at byte ${from + a}; raise EDGE`);
      if (a >= lo) {
        const run = buf.toString("latin1", a, b);
        if (isText || (a > 0 && b < n && QUOTE_BYTE.has(buf[a - 1]) && buf[b] === buf[a - 1])) whole.add(run); else inside.add(run);
      }
      i = b;
    }
  };
  if (size <= CHUNK) {
    const buf = fs.readFileSync(file);
    scan(buf, buf.length, 0, 0, buf.length);
    return;
  }
  // Each piece is read with EDGE bytes on either side, so a run that starts in it is read whole.
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(EDGE + CHUNK + EDGE);
  try {
    for (let pos = 0; pos < size; pos += CHUNK) {
      const from = Math.max(0, pos - EDGE);
      const n = fs.readSync(fd, buf, 0, Math.min(size - from, pos - from + CHUNK + EDGE), from);
      scan(buf, n, from, pos - from, pos - from + CHUNK);
    }
  } finally {
    fs.closeSync(fd);
  }
}

let extracted = null;
/** Every run in the installed engines' code, extracted once for the tests below. */
function engineRuns() {
  if (!extracted) {
    const started = Date.now();
    const { text, native, packages } = engineFiles();
    const whole = new Set(), inside = new Set();
    for (const f of text) runsIn(f, true, whole, inside);
    for (const f of native) runsIn(f, false, whole, inside);
    for (const r of whole) inside.delete(r);
    extracted = { whole, inside, packages, text, native, ms: Date.now() - started };
  }
  return extracted;
}

/** The allowlist's key shape (railway-admin.js SCRIPT_KEY): what it would set on Tarsee's own service if nothing refused it. */
const KEY_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|WEBHOOK|URL)$/;
const KEY_ENDINGS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "WEBHOOK", "URL"];
/** A Claude Code CLI program: `claude` (Linux, macOS) or `claude.exe` (Windows). */
const isCliProgram = (file) => /(?:^|[\\/])claude(?:\.exe)?$/.test(file);

/**
 * Throws unless a Claude Code CLI program was scanned whenever the Claude Agent SDK is installed. Without its platform
 * package (npm's --omit=optional, or a platform it has none for), the scan would pass on sdk.mjs alone and miss every
 * name the CLI holds.
 */
function assertCliScanned({ packages, native }) {
  if (!packages.some((p) => p.startsWith("@anthropic-ai/claude-agent-sdk@"))) return;
  assert.ok(native.some(isCliProgram),
    `The Claude Agent SDK is installed (${packages.join(", ")}), but no Claude Code CLI program (claude or claude.exe, from ` +
    `its platform package) was scanned: only ${native.length ? native.join(", ") : "no programs"}. Install the SDK with its ` +
    "optional platform package (npm ci without --omit=optional), or list one in TARSEE_ENGINE_PACKAGES.");
}

/**
 * Every key-shaped name inside a run that may hold several strings one after another: one may start at the run's start
 * or after any character but an underscore, and end at the run's end or before any character but an underscore. Up to
 * `limit` of them (1 is enough to tell whether the run holds any).
 */
function keyNamesInRun(run, { limit = Infinity } = {}) {
  const out = new Set();
  for (const word of KEY_ENDINGS) {
    for (let p = run.indexOf(`_${word}`); p !== -1; p = run.indexOf(`_${word}`, p + 1)) {
      const end = p + 1 + word.length;
      if (end < run.length && run[end] === "_") continue;
      for (let i = p - 1; i >= 0; i--) {
        if (run[i] === "_") {
          if (i === p - 1 || i === 0 || run[i - 1] === "_" || run[i + 1] === "_") break;
          continue;
        }
        if (run[i] >= "A" && run[i] <= "Z" && (i === 0 || run[i - 1] !== "_")) {
          out.add(run.slice(i, end));
          if (out.size >= limit) return [...out];
        }
      }
    }
  }
  return [...out];
}

/** Writes the list: what it had and what the installed engines (and TARSEE_ENGINE_PACKAGES) hold. CRLF, like the checkout. */
function updateEngineNames(names, runs, strings, packages) {
  let had = { names: [], runs: [], strings: [], scanned: [] };
  try { had = readJson(ENGINE_NAMES_FILE); } catch { /* a first list */ }
  const allNames = [...new Set([...had.names, ...names])].sort();
  const isName = new Set(allNames);
  const allStrings = [...new Set([...(had.strings || []), ...strings])].filter((s) => !isName.has(s)).sort();
  const isString = new Set(allStrings);
  const data = {
    about: [
      "Every name in capitals with underscores that appears as a string in the shipped code of Tarsee's AI engines and its browser library, and that tarsee_railway's allowlist would otherwise set on Tarsee's own service (a name ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL). Every other name is refused by the allowlist itself.",
      "The code: the Claude Agent SDK's JavaScript and the Claude Code CLI it ships, the Codex SDK and every file of Codex's platform packages, and Playwright's library (playwright-core), which starts Chromium. The CLI and Codex are native programs, read as bytes, for every platform in scanned.",
      "names: strings found whole (in JavaScript, or between quotes inside a program). runs: capitals, digits and underscores found inside a native program, which can keep its strings one after another with nothing between them (GH_TOKENGITHUB_TOKEN); a name counts as found in a run when it starts at the run's start or after any character but _, and ends at its end or before any character but _. A run found whole anywhere is that string, not a run.",
      "strings: the runs found whole that hold such a name without being one (CLAUDE_CODE_TOTAL_TOKENS_REMINDER holds CLAUDE_CODE_TOTAL_TOKEN). They refuse nothing themselves: when Tarsee reads the Terminal's own Claude Code at start, a run of it that is in names or strings counts whole, as it does here.",
      "Made and checked by test/railway-tool-limits.test.js. TARSEE_UPDATE_ENGINE_NAMES=1 node --test test/railway-tool-limits.test.js adds what the installed engines hold; that test says how to add another platform's programs. A name stays when an update drops it: refusing a name nothing reads costs nothing.",
    ],
    scanned: [...new Set([...had.scanned, ...packages])].sort(),
    names: allNames,
    runs: [...new Set([...had.runs, ...runs])].filter((r) => !isName.has(r) && !isString.has(r)).sort(),
    strings: allStrings,
  };
  fs.writeFileSync(ENGINE_NAMES_FILE, `${JSON.stringify(data, null, 2)}\n`.replace(/\n/g, "\r\n"));
}

describe("every name in the AI engines' and the browser library's code is refused on Tarsee's own service", () => {
  // The names that got through before this rule: Claude Code reads each one through its typed lists of settings.
  const REVIEWED = ["VOICE_STREAM_BASE_URL", "AGENT_PROXY_URL", "AGENT_PROXY_AUTH_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN", "ENVIRONMENT_SERVICE_KEY"];

  it("src/lib/engine-env-names.json has every name the installed engines hold that the allowlist would let through", () => {
    const { whole, inside, packages, text, native, ms } = engineRuns();
    assert.ok(text.length > 100 && whole.size > 1000, `found only ${whole.size} names in ${text.length} JavaScript files: is the scan working?`);
    for (const n of REVIEWED) assert.ok(whole.has(n), `the scan finds ${n} in Claude Code's code`);
    // The check itself: an SDK without its CLI program fails it, naming what was scanned.
    assert.throws(() => assertCliScanned({ packages: ["@anthropic-ai/claude-agent-sdk@0.3.319"], native: ["vendor/codex"] }), /no Claude Code CLI program \(claude or claude\.exe/);
    assert.doesNotThrow(() => assertCliScanned({ packages: ["@openai/codex@0.167.0"], native: [] }), "no SDK, no CLI to scan");
    assertCliScanned({ packages, native });
    if (native.some((f) => /codex(\.exe)?$/.test(f))) {
      assert.ok([...inside, ...whole].some((r) => r.includes("CODEX_API_KEY")), "the scan finds CODEX_API_KEY in Codex");
    }
    const names = [...whole].filter((r) => KEY_NAME.test(r));
    const runs = [...inside].filter((r) => keyNamesInRun(r, { limit: 1 }).length);
    const strings = [...whole].filter((r) => !KEY_NAME.test(r) && keyNamesInRun(r, { limit: 1 }).length);
    if (UPDATE_ENGINE_NAMES) updateEngineNames(names, runs, strings, packages);
    // The file as it is now (the module read it when it loaded, which in update mode was before this wrote it).
    const list = readJson(ENGINE_NAMES_FILE);
    const current = RA.parseEngineNames(fs.readFileSync(ENGINE_NAMES_FILE, "utf8"));
    const listed = new Set([...list.names, ...list.runs]);
    // Named: the whole names, and the runs inside a program as found (each can hold several names one after another).
    // And the strings: without them the Terminal's read at start would count more runs than this check does.
    const missing = {
      names: names.filter((n) => !RA.inEngineCode(n, current)).sort(),
      runs: runs.filter((r) => !listed.has(r) && keyNamesInRun(r).some((n) => !RA.inEngineCode(n, current))).sort()
        .map((r) => (r.length > 200 ? `${r.slice(0, 200)}... (${r.length} characters)` : r)),
      strings: strings.filter((s) => !current.strings.has(s)).sort(),
    };
    assert.deepEqual(missing, { names: [], runs: [], strings: [] },
      `The engines installed here (${packages.join(", ")}) hold these names, and src/lib/engine-env-names.json (made from ` +
      `${list.scanned.join(", ")}) lacks them, so tarsee_railway would set them on Tarsee's own service. Add them with ` +
      "TARSEE_UPDATE_ENGINE_NAMES=1 node --test test/railway-tool-limits.test.js (this file's comment says how to add another platform's programs).");
    assert.ok(ms < 30_000, `the scan took ${ms} ms`);
  });

  it("every name in the list is refused there, saying so and where the owner sets it instead", () => {
    const list = readJson(ENGINE_NAMES_FILE);
    assert.ok(list.names.length > 100 && list.runs.length > 100, "the list has names and runs");
    for (const n of list.names) {
      assert.ok(KEY_NAME.test(n), `${n}: only key-shaped names are listed`);
      const why = RA.selfServiceRefusal(n);
      assert.ok(why, `${n} is refused on Tarsee's own service`);
      assert.match(why, /Railway's dashboard/, n);
    }
    for (const r of list.runs) {
      // Every name the test finds in a run, the module finds there too (the first 2000, for the few runs that hold more).
      const held = keyNamesInRun(r, { limit: 2000 });
      assert.ok(held.length, `${r}: only runs that hold a key-shaped name are listed`);
      for (const n of held) assert.ok(RA.heldInRun(r, n), `${n} in ${r}`);
      for (const n of [held[0], held.at(-1)]) assert.ok(RA.selfServiceRefusal(n), `${n} (in ${r}) is refused on Tarsee's own service`);
    }
    // The strings: each holds a key-shaped name without being one, and none is also a run or a name.
    assert.ok(Array.isArray(list.strings), "the list has its strings");
    for (const s of list.strings) {
      assert.ok(!KEY_NAME.test(s) && keyNamesInRun(s, { limit: 1 }).length, `${s}: only strings that hold a key-shaped name without being one`);
      assert.ok(!list.runs.includes(s) && !list.names.includes(s), `${s} is a string only`);
    }
    // Not a name inside a longer one in a JavaScript string, nor one that goes on with an underscore.
    assert.equal(RA.heldInRun("GH_TOKENGITHUB_TOKEN", "GITHUB_TOKEN"), true);
    assert.equal(RA.heldInRun("OPENAI_API_KEYCODEX_API_KEY", "API_KEY"), false, "starts just after an underscore");
    assert.equal(RA.heldInRun("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_CONTAINER_AUTHORIZATION_TOKEN"), false, "goes on with _FILE");
  });

  it("the names Claude Code reads through its typed lists are refused, saying they appear in the engines' code", async () => {
    for (const name of REVIEWED) {
      assert.equal(RA.inEngineCode(name), true, name);
      const r = await run({ action: "set_variable", name, value: "https://attacker.example/x", deploy: false }, { env: ON_RAILWAY });
      assertNothingChanged(r, name);
      assert.match(r.out, new RegExp(`${name} appears in the code of Tarsee's AI engines or its browser library`), r.out);
      assert.match(r.out, /by hand in Railway's dashboard/, r.out);
    }
  });

  it("the owner's everyday names are in none of that code and still go on, and so do TZ and the tuning settings", () => {
    for (const n of ["SOME_SERVICE_API_KEY", "ALERTS_WEBHOOK", "ALERTS_WEBHOOK_URL", "STATUS_PAGE_URL"]) {
      assert.equal(RA.inEngineCode(n), false, n);
      assert.equal(RA.selfServiceRefusal(n), null, n);
    }
    // No run of the engines' code holds a tuning setting's name: all the runs, not only the key-shaped ones.
    const { whole, inside } = engineRuns();
    const tuning = RA.SELF_SERVICE_SETTINGS.filter((n) => n !== "TZ");
    for (const set of [whole, inside]) for (const r of set) for (const n of tuning) assert.ok(!r.includes(n), `${n} is in the engines' code (${r})`);
    // TZ is read by every program (the C library reads it), the engines included. It stays on the allowlist on purpose:
    // there it takes a time zone name only, never a path to a file, so all it changes is the clock's zone.
    assert.equal(RA.selfServiceRefusal("TZ", "Asia/Manila"), null);
    assert.ok(RA.selfServiceRefusal("TZ", "/data/tarsee/workspace/zone"));
  });

  it("a list that can't be read refuses every key-shaped name on Tarsee's own service", () => {
    assert.throws(() => RA.parseEngineNames("{}"), /names/);
    assert.throws(() => RA.parseEngineNames("not json"));
    const why = RA.selfServiceRefusal("SOME_SERVICE_API_KEY", undefined, { engineNames: new Error("no such file") });
    assert.match(why, /could not read the list of names in its AI engines' code/, why);
    assert.match(why, /Railway's dashboard/, why);
    assert.equal(RA.selfServiceRefusal("TZ", "UTC", { engineNames: new Error("no such file") }), null, "TZ and the tuning settings don't need it");
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

  it("a write in a project with no Tarsee in it never reads any variable's value", async () => {
    const rw = railway({ more: protectedRefs });
    const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "API_TOKEN", value: "plain-value" }, { rw, env: ON_RAILWAY });
    assert.match(r.out, /^Set API_TOKEN on worker/, r.out);
    assert.ok(!rw.calls.some((c) => c.op === "TarseeUnrenderedVariables"), "no unrendered values asked for where no service is a Tarsee");
  });

  it("off Railway (Tarsee's own service unknown) the Tarsee in that project is still found by its variable names", async () => {
    // Its SETUP_PASSWORD gives it away, so its references are followed as Tarsee's own are.
    const rw = railway({ more: protectedRefs });
    const r = await run({ action: "set_variable", project: "Tarsee", service: "worker", name: "API_TOKEN", value: "plain-value" }, { rw });
    assertNothingChanged(r);
    assert.match(r.out, /The Tarsee tarsee's TARSEE_API_TOKEN \(tarsee counts as a Tarsee: its variables include SETUP_PASSWORD\) is filled in from API_TOKEN on worker by a Railway reference/, r.out);
    assert.ok(!r.text.includes(TOK_VALUE), "no value of its variables in the result or the log");
    const free = await run({ action: "set_variable", project: "Tarsee", service: "worker", name: "OTHER_SETTING", value: "1" }, { rw: railway({ more: protectedRefs }) });
    assert.match(free.out, /^Set OTHER_SETTING on worker/, free.out);
  });
});

describe("a variable any of Tarsee's own variables is filled in from counts as that variable", () => {
  // Railway's usual set-up puts references on the app's service: a variable there made from another service's
  // (WORKER_API_KEY=${{worker.API_KEY}}, REPORTS_DB_URL=${{Postgres.DATABASE_PUBLIC_URL}}), directly or through a shared
  // variable. A write to the variable it is made from is, at Tarsee's next deploy, a write to Tarsee's own service under
  // the referencing name. So references are followed from every variable on Tarsee's own service, not only the guarded
  // ones, and every rule for Tarsee's own service applies to the referencing name: the allowlist, the names in the
  // engines' code, and the get_key rule for from_key.
  const refs = {
    [E_TARSEE]: [
      { name: "WORKER_API_KEY", serviceId: S_TARSEE, value: "${{worker.API_KEY}}" },
      { name: "REPORTS_DB_URL", serviceId: S_TARSEE, value: "${{Postgres.DATABASE_PUBLIC_URL}}" },
      { name: "ALERTS_API_KEY", serviceId: S_TARSEE, value: "${{shared.ALERTS}}" },
      { name: "ALERTS", serviceId: null, value: "${{worker.ALERTS_SRC}}" },
      { name: "CHAIN_API_KEY", serviceId: S_TARSEE, value: "${{shared.C1}}" },
      { name: "C1", serviceId: null, value: "chain-SECRET-prefix-${{worker.C2}}" },
      { name: "C2", serviceId: S_TWORK, value: "${{ postgres.C3 }}" },
      // Names that appear in the engines' code, which the owner filled in by hand from another variable.
      { name: "VOICE_STREAM_BASE_URL", serviceId: S_TARSEE, value: "https://${{worker.VOICE_HOST}}/v1" },
      { name: "DATABASE_URL", serviceId: S_TARSEE, value: "${{ Postgres.DATABASE_URL }}" },
      { name: "AGENT_PROXY_URL", serviceId: S_TARSEE, value: "${{MY_PROXY_URL}}" },
    ],
  };
  const DENIED = { env: ON_RAILWAY, getKeyDenied: () => true };
  // [service, name, the variable on Tarsee's own service it fills]
  const feeders = [
    ["worker", "API_KEY", "WORKER_API_KEY"],
    ["Postgres", "DATABASE_PUBLIC_URL", "REPORTS_DB_URL"],
    ["worker", "ALERTS_SRC", "ALERTS_API_KEY"],          // through a shared variable
    ["Postgres", "C3", "CHAIN_API_KEY"],                 // shared, then worker, then Postgres
  ];

  for (const [service, name, fills] of feeders) {
    it(`while get_key is denied, from_key into ${name} on ${service} (it fills Tarsee's ${fills}) is refused, with a deploy or without`, async () => {
      for (const deploy of [true, false]) {
        const rw = railway({ more: refs });
        const r = await run({ action: "set_variable", service, name, from_key: "OPENAI_KEY", deploy }, { rw, ...DENIED });
        assertNothingChanged(r, `${service}.${name} deploy=${deploy}`);
        assert.match(r.out, /get_key is denied in Settings > Tool Permissions/, r.out);
        assert.match(r.out, new RegExp(`Tarsee's own ${fills} is filled in from ${name} on ${service} by a Railway reference`), r.out);
        assert.match(r.out, /by hand in Railway's dashboard/, r.out);
        assert.ok(!r.text.includes("chain-SECRET-prefix"), "no value of Tarsee's own variables in the result or the log");
      }
    });
  }

  it("the reviewer's case end to end: the key never reaches worker, so a redeploy of Tarsee can't bring it in", async () => {
    const rw = railway({ more: refs });
    const r = await run({ action: "set_variable", service: "worker", name: "API_KEY", from_key: "OPENAI_KEY", deploy: false }, { rw, ...DENIED });
    assertNothingChanged(r);
    assert.equal(rw.valueOf(E_TARSEE, S_TWORK, "API_KEY"), undefined, "worker.API_KEY was not set");
    const re = await run({ action: "redeploy" }, { rw, ...DENIED });
    assert.match(re.out, /^Asked Railway to redeploy tarsee/, re.out);
  });

  it("a plain value into those still goes, and from_key too once get_key is allowed", async () => {
    for (const [service, name] of feeders) {
      const rw = railway({ more: refs });
      const plain = await run({ action: "set_variable", service, name, value: "plain-value", deploy: false }, { rw, ...DENIED });
      assert.match(plain.out, new RegExp(`^Set ${name} on ${service}`), plain.out);
      const allowed = await run({ action: "set_variable", service, name, from_key: "WORKER_PASSWORD", deploy: false }, { rw, env: ON_RAILWAY, getKeyDenied: () => false });
      assert.match(allowed.out, new RegExp(`^Set ${name} on ${service}`), allowed.out);
    }
    // And from_key, get_key denied, onto a variable nothing of Tarsee's is filled in from.
    const free = await run({ action: "set_variable", service: "worker", name: "UNREFERENCED_KEY", from_key: "WORKER_PASSWORD" }, { rw: railway({ more: refs }), ...DENIED });
    assert.match(free.out, /^Set UNREFERENCED_KEY on worker/, free.out);
  });

  it("a variable that fills a name in the engines' code is refused, plain or from_key, get_key allowed or not", async () => {
    for (const [service, name, fills] of [["worker", "VOICE_HOST", "VOICE_STREAM_BASE_URL"], ["Postgres", "DATABASE_URL", "DATABASE_URL"], ["tarsee", "MY_PROXY_URL", "AGENT_PROXY_URL"]]) {
      for (const how of [{ value: "plain-value" }, { from_key: "WORKER_PASSWORD" }]) {
        const r = await run({ action: "set_variable", service, name, ...how, deploy: false }, { rw: railway({ more: refs }), env: ON_RAILWAY, getKeyDenied: () => false });
        assertNothingChanged(r, `${service}.${name}`);
        assert.match(r.out, new RegExp(`Tarsee's own ${fills} is filled in from ${name} on ${service} by a Railway reference`), r.out);
        assert.match(r.out, new RegExp(`${fills} appears in the code of Tarsee's AI engines`), r.out);
        assert.match(r.out, /Railway's dashboard/, r.out);
      }
    }
  });

  it("on Tarsee's own service too: MY_PROXY_URL is allowed by name, but it fills AGENT_PROXY_URL, so it is refused", async () => {
    assert.equal(RA.selfServiceRefusal("MY_PROXY_URL"), null, "an allowed name by itself");
    const r = await run({ action: "set_variable", name: "MY_PROXY_URL", value: "https://attacker.example", deploy: false }, { rw: railway({ more: refs }), env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /Tarsee's own AGENT_PROXY_URL is filled in from MY_PROXY_URL on tarsee by a Railway reference/, r.out);
  });

  it("a sealed variable on Tarsee's own service hides what it is filled in from: while get_key is denied, no from_key in that environment", async () => {
    const sealedKey = { [E_TARSEE]: [{ name: "SOME_SERVICE_API_KEY", serviceId: S_TARSEE, isSealed: true, value: "${{worker.X}}" }] };
    for (const args of [{ service: "worker", name: "X" }, { service: "Postgres", name: "OTHER_KEY" }]) {
      const r = await run({ action: "set_variable", from_key: "WORKER_PASSWORD", deploy: false, ...args }, { rw: railway({ more: sealedKey }), ...DENIED });
      assertNothingChanged(r, JSON.stringify(args));
      assert.match(r.out, /get_key is denied in Settings > Tool Permissions/, r.out);
      assert.match(r.out, /Tarsee's own SOME_SERVICE_API_KEY is sealed/, r.out);
      assert.match(r.out, /by hand in Railway's dashboard/, r.out);
    }
    // A plain value, another environment, and from_key once get_key is allowed all still go.
    for (const [args, opts] of [
      [{ service: "worker", name: "X", value: "plain-value" }, DENIED],
      [{ environment: "staging", service: "worker", name: "X", from_key: "WORKER_PASSWORD" }, DENIED],
      [{ service: "worker", name: "X", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY, getKeyDenied: () => false }],
    ]) {
      const r = await run({ action: "set_variable", deploy: false, ...args }, { rw: railway({ more: sealedKey }), ...opts });
      assert.match(r.out, /^Set X on worker/, `${JSON.stringify(args)}: ${r.out}`);
    }
  });

  it("when Tarsee can't tell whether get_key is denied, from_key into such a variable is refused", async () => {
    const r = await run({ action: "set_variable", service: "worker", name: "API_KEY", from_key: "WORKER_PASSWORD" }, { rw: railway({ more: refs }), env: ON_RAILWAY, getKeyDenied: () => { throw new Error("settings unavailable"); } });
    assertNothingChanged(r);
    assert.match(r.out, /could not tell whether get_key is denied/, r.out);
  });
});

describe("names that differ only in case are each kept and followed", () => {
  // Environment variables are case-sensitive, so one service can hold DATABASE_URL and database_url side by side. Each
  // one's references are followed, whichever comes first in Railway's answer: a twin never hides the other's.
  const DENIED = { env: ON_RAILWAY, getKeyDenied: () => true };
  // Railway's own Postgres template: DATABASE_URL is made from other variables of the service.
  const PG_URL = "postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}";
  const pgVars = (twin = null) => ({
    [E_TARSEE]: [
      { name: "REPORTS_DB_URL", serviceId: S_TARSEE, value: "${{Postgres.DATABASE_URL}}" },
      ...(twin === "first" ? [{ name: "database_url", serviceId: S_PG, value: "x" }] : []),
      { name: "DATABASE_URL", serviceId: S_PG, value: PG_URL },
      { name: "POSTGRES_PASSWORD", serviceId: S_PG, value: "pg-pw-0001" },
      { name: "PGUSER", serviceId: S_PG, value: "postgres" },
      ...(twin === "last" ? [{ name: "database_url", serviceId: S_PG, value: "x" }] : []),
    ],
  });
  const intoPassword = { action: "set_variable", service: "Postgres", name: "POSTGRES_PASSWORD", from_key: "OPENAI_KEY", deploy: false };

  it("the reviewer's Postgres case: after a planted database_url, from_key into POSTGRES_PASSWORD is still refused", async () => {
    const rw = railway({ more: pgVars() });
    const first = await run(intoPassword, { rw, ...DENIED });
    assertNothingChanged(first);
    assert.match(first.out, /Tarsee's own REPORTS_DB_URL is filled in from POSTGRES_PASSWORD on Postgres by a Railway reference/, first.out);
    // A plain value into the twin goes: it fills REPORTS_DB_URL, a name the tool may set on Tarsee's service itself.
    const plant = await run({ action: "set_variable", service: "Postgres", name: "database_url", value: "x", deploy: false }, { rw, ...DENIED });
    assert.match(plant.out, /^Set database_url on Postgres/, plant.out);
    assert.equal(rw.valueOf(E_TARSEE, S_PG, "DATABASE_URL"), PG_URL, "DATABASE_URL keeps its references");
    const sent = rw.writes().length;
    const again = await run(intoPassword, { rw, ...DENIED });
    assert.equal(rw.writes().length, sent, `no write was sent: ${again.out}`);
    assert.match(again.out, /get_key is denied in Settings > Tool Permissions/, again.out);
    assert.match(again.out, /Tarsee's own REPORTS_DB_URL is filled in from POSTGRES_PASSWORD on Postgres by a Railway reference/, again.out);
    assert.match(again.out, /Nothing was changed\.$/, again.out);
    assert.ok(!again.text.includes(OPENAI) && !again.text.includes("pg-pw-0001"), "no value in the result or the log");
    assert.equal(rw.valueOf(E_TARSEE, S_PG, "POSTGRES_PASSWORD"), "pg-pw-0001");
  });

  it("whichever twin comes first in Railway's answer, both are followed", async () => {
    for (const twin of ["first", "last"]) {
      for (const name of ["POSTGRES_PASSWORD", "PGUSER"]) {
        const r = await run({ ...intoPassword, name }, { rw: railway({ more: pgVars(twin) }), ...DENIED });
        assertNothingChanged(r, `${name}, twin ${twin}`);
        assert.match(r.out, new RegExp(`Tarsee's own REPORTS_DB_URL is filled in from ${name} on Postgres by a Railway reference`), r.out);
      }
    }
  });

  it("the worker chain: a planted worker.api_key doesn't hide worker.API_KEY's reference", async () => {
    for (const plantedFirst of [true, false]) {
      const chain = [{ name: "API_KEY", serviceId: S_TWORK, value: "${{Postgres.SECRET_TOKEN}}" }, { name: "api_key", serviceId: S_TWORK, value: "x" }];
      const more = { [E_TARSEE]: [{ name: "WORKER_API_KEY", serviceId: S_TARSEE, value: "${{worker.API_KEY}}" }, ...(plantedFirst ? chain.reverse() : chain)] };
      const r = await run({ action: "set_variable", service: "Postgres", name: "SECRET_TOKEN", from_key: "OPENAI_KEY", deploy: false }, { rw: railway({ more }), ...DENIED });
      assertNothingChanged(r, `planted first: ${plantedFirst}`);
      assert.match(r.out, /Tarsee's own WORKER_API_KEY is filled in from SECRET_TOKEN on Postgres by a Railway reference/, r.out);
    }
  });

  it("twins on Tarsee's own service: each one's references are followed, and each counts under its own name", async () => {
    for (const lowerFirst of [true, false]) {
      const twins = [{ name: "ALERTS_API_KEY", serviceId: S_TARSEE, value: "${{worker.A_SRC}}" }, { name: "alerts_api_key", serviceId: S_TARSEE, value: "${{worker.B_SRC}}" }];
      const more = { [E_TARSEE]: lowerFirst ? twins.reverse() : twins };
      const label = `lower first: ${lowerFirst}`;
      // A_SRC fills ALERTS_API_KEY, a name the tool may set: a plain value goes, a vault key waits for get_key.
      const key = await run({ action: "set_variable", service: "worker", name: "A_SRC", from_key: "OPENAI_KEY", deploy: false }, { rw: railway({ more }), ...DENIED });
      assertNothingChanged(key, label);
      assert.match(key.out, /Tarsee's own ALERTS_API_KEY is filled in from A_SRC on worker by a Railway reference/, key.out);
      const plain = await run({ action: "set_variable", service: "worker", name: "A_SRC", value: "plain-value", deploy: false }, { rw: railway({ more }), ...DENIED });
      assert.match(plain.out, /^Set A_SRC on worker/, `${label}: ${plain.out}`);
      // B_SRC fills alerts_api_key, a name the tool never sets on Tarsee's service (not in capitals): refused either way.
      for (const how of [{ value: "plain-value" }, { from_key: "OPENAI_KEY" }]) {
        const r = await run({ action: "set_variable", service: "worker", name: "B_SRC", ...how, deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
        assertNothingChanged(r, label);
        assert.match(r.out, /Tarsee's own alerts_api_key is filled in from B_SRC on worker by a Railway reference/, r.out);
        assert.match(r.out, /alerts_api_key is not one of the names this tool sets on Tarsee's own service/, r.out);
      }
    }
  });

  it("were Railway's two answers to spell a name of Tarsee's differently, its references are still followed", async () => {
    const rw = railway({ more: { [E_TARSEE]: [{ name: "Reports_Db_Url", serviceId: S_TARSEE, value: "${{Postgres.DATABASE_URL}}" }, { name: "DATABASE_URL", serviceId: S_PG, value: PG_URL }] } });
    // The values come back under names in capitals; the list of names keeps them as typed.
    const fetch = async (url, init) => {
      const res = await rw.fetch(url, init);
      if (!JSON.parse(init.body).query.includes("TarseeUnrenderedVariables")) return res;
      const body = JSON.parse(await res.text());
      body.data.variables = Object.fromEntries(Object.entries(body.data.variables).map(([k, v]) => [k.toUpperCase(), v]));
      return { status: res.status, text: async () => JSON.stringify(body) };
    };
    const r = await run({ ...intoPassword, value: "plain-value", from_key: undefined }, { rw: { ...rw, fetch }, env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /Tarsee's own Reports_Db_Url is filled in from POSTGRES_PASSWORD on Postgres by a Railway reference/, r.out);
  });

  it("on Tarsee's own service, setting a name refuses what its twin would get from it", async () => {
    const more = { [E_TARSEE]: [{ name: "status_page_url", serviceId: S_TARSEE, value: "${{STATUS_PAGE_URL}}" }] };
    const r = await run({ action: "set_variable", name: "STATUS_PAGE_URL", value: "https://status.example.com", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /Tarsee's own status_page_url is filled in from STATUS_PAGE_URL on tarsee by a Railway reference/, r.out);
  });
});

describe("a reference to a service the project doesn't have can't be followed", () => {
  // Railway would look for a service of that name, so what the variable is filled in from is as unknown as a sealed
  // value: it fails closed the same way.
  const DENIED = { env: ON_RAILWAY, getKeyDenied: () => true };
  const guardedGhost = {
    [E_TARSEE]: [
      { name: "TARSEE_KEYS_ONLY", serviceId: S_TARSEE, value: "${{worker.KO_MID}}" },
      { name: "KO_MID", serviceId: S_TWORK, value: "${{ Ghost Service.KO }}" },
    ],
  };
  const keyGhost = { [E_TARSEE]: [{ name: "ALERTS_API_KEY", serviceId: S_TARSEE, value: "${{Ghost.ALERTS}}" }] };

  it("one of Tarsee's guarded variables filled in from one: nothing is set in that environment of Tarsee's project", async () => {
    for (const args of [{ service: "worker", name: "OTHER_SETTING" }, { service: "Postgres", name: "KO" }, { name: "SOME_SERVICE_API_KEY" }]) {
      for (const deploy of [true, false]) {
        const r = await run({ action: "set_variable", value: "plain-value", deploy, ...args }, { rw: railway({ more: guardedGhost }), env: ON_RAILWAY });
        assertNothingChanged(r, `${JSON.stringify(args)} deploy=${deploy}`);
        assert.match(r.out, /Tarsee's own TARSEE_KEYS_ONLY is filled in from KO on "Ghost Service", a service the project "Tarsee" doesn't have/, r.out);
        assert.match(r.out, /by hand in Railway's dashboard/, r.out);
      }
    }
    const stage = await run({ action: "set_variable", environment: "staging", service: "worker", name: "OTHER_SETTING", value: "plain-value" }, { rw: railway({ more: guardedGhost }), env: ON_RAILWAY });
    assert.match(stage.out, /^Set OTHER_SETTING on worker .* in staging/, stage.out);
    const acme = await run({ action: "set_variable", project: "Acme", service: "worker", name: "OTHER_SETTING", value: "plain-value" }, { rw: railway({ more: guardedGhost }), env: ON_RAILWAY });
    assert.match(acme.out, /^Set OTHER_SETTING on worker/, acme.out);
  });

  it("an everyday key of Tarsee's filled in from one: while get_key is denied, no from_key in that environment", async () => {
    for (const args of [{ service: "worker", name: "ALERTS" }, { service: "Postgres", name: "OTHER_KEY" }]) {
      const r = await run({ action: "set_variable", from_key: "WORKER_PASSWORD", deploy: false, ...args }, { rw: railway({ more: keyGhost }), ...DENIED });
      assertNothingChanged(r, JSON.stringify(args));
      assert.match(r.out, /get_key is denied in Settings > Tool Permissions/, r.out);
      assert.match(r.out, /Tarsee's own ALERTS_API_KEY is filled in from ALERTS on "Ghost", a service the project "Tarsee" doesn't have/, r.out);
    }
    for (const [args, opts] of [
      [{ service: "worker", name: "ALERTS", value: "plain-value" }, DENIED],
      [{ service: "worker", name: "ALERTS", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY, getKeyDenied: () => false }],
    ]) {
      const r = await run({ action: "set_variable", deploy: false, ...args }, { rw: railway({ more: keyGhost }), ...opts });
      assert.match(r.out, /^Set ALERTS on worker/, `${JSON.stringify(args)}: ${r.out}`);
    }
  });

  it("a service named shared: ${{shared.X}} is followed to the shared variables and to that service", async () => {
    const S_SHAREDSVC = id(49);
    const more = { [E_TARSEE]: [{ name: "ALERTS_API_KEY", serviceId: S_TARSEE, value: "${{shared.ALERTS}}" }] };
    const r = await run({ action: "set_variable", service: "shared", name: "ALERTS", from_key: "WORKER_PASSWORD", deploy: false }, { rw: railway({ more, services: [{ id: S_SHAREDSVC, name: "shared" }] }), ...DENIED });
    assertNothingChanged(r);
    assert.match(r.out, /Tarsee's own ALERTS_API_KEY is filled in from ALERTS on shared by a Railway reference/, r.out);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The Terminal's own Claude Code. engine-env-names.json comes from the Claude Code pinned in node_modules, but with
// TARSEE_AUTO_UPDATE_CLI=1 the start-up script installs the latest one as the Terminal's claude, and a variable on
// Tarsee's own service reaches it there. So Tarsee reads that program once when it starts, streamed in the background
// (startTerminalCliScan), and refuses the names in it too. While it can't be read, only TZ and the tuning settings go
// on Tarsee's own service.

const CLI_DIR = path.join(tmp, "terminal-cli");
/** A stand-in for a Claude Code build: a native program's header, then its strings. */
function fakeCli(rel, text) {
  const file = path.join(CLI_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.from(text, "latin1")]));
  return file;
}
/** One program read the way the freshness check reads the engines: its whole key-shaped names and its runs that hold one. */
function freshnessRead(file) {
  const whole = new Set(), inside = new Set();
  runsIn(file, false, whole, inside);
  for (const r of whole) inside.delete(r);
  return {
    names: [...whole].filter((r) => KEY_NAME.test(r)).sort(),
    runs: [...inside].filter((r) => keyNamesInRun(r, { limit: 1 }).length).sort(),
  };
}
/** Tarsee as it started with `programs` as the Terminal's claude ([]: what every other test in this file runs with). */
const terminalRuns = (programs, opts = {}) => RA.startTerminalCliScan({ find: async () => programs, log: () => {}, ...opts });
// Names a newer Claude Code might read that the pinned one doesn't hold: one as a JavaScript string, two inside a run
// of strings kept one after another, as a native program keeps them.
const NEWER = ["NEWER_CLI_PROXY_URL", "NEWER_CLI_SESSION_TOKEN", "NEWER_CLI_SIGNING_KEY"];
const NEWER_TEXT = "\0x=\"NEWER_CLI_PROXY_URL\";\0ZNEWER_CLI_SESSION_TOKENNEWER_CLI_SIGNING_KEY\0'STATUS'\0";

describe("the Terminal's own Claude Code (TARSEE_AUTO_UPDATE_CLI=1 can make it newer) is read when Tarsee starts", () => {
  after(() => terminalRuns([]));

  it("a name only it holds is refused on Tarsee's own service, saying so; the owner's names and other services still go", async () => {
    for (const n of NEWER) assert.equal(RA.selfServiceRefusal(n, undefined, { terminal: null }), null, `${n} goes without it`);
    const got = await terminalRuns([fakeCli("newer/claude", NEWER_TEXT)]);
    assert.ok(!(got instanceof Error), String(got));
    for (const name of NEWER) {
      for (const how of [{ value: "https://attacker.example" }, { from_key: "WORKER_PASSWORD" }]) {
        const r = await run({ action: "set_variable", name, ...how, deploy: false }, { env: ON_RAILWAY });
        assertNothingChanged(r, name);
        assert.match(r.out, new RegExp(`${name} appears in the code of the Terminal's Claude Code`), r.out);
        assert.match(r.out, /TARSEE_AUTO_UPDATE_CLI=1/, r.out);
        assert.match(r.out, /by hand in Railway's dashboard/, r.out);
      }
    }
    const ok = await run({ action: "set_variable", name: "STATUS_PAGE_URL", value: "https://status.example.com", deploy: false }, { env: ON_RAILWAY });
    assert.match(ok.out, /^Set STATUS_PAGE_URL on tarsee/, ok.out);
    const away = await run({ action: "set_variable", project: "Acme", service: "web", name: "NEWER_CLI_PROXY_URL", value: "https://x.example" }, { env: ON_RAILWAY });
    assert.match(away.out, /^Set NEWER_CLI_PROXY_URL on web/, away.out);
  });

  it("a variable that one of those names on Tarsee's service is filled in from is refused too", async () => {
    await terminalRuns([fakeCli("newer/claude", NEWER_TEXT)]);
    const more = { [E_TARSEE]: [{ name: "NEWER_CLI_PROXY_URL", serviceId: S_TARSEE, value: "${{worker.PROXY_SRC}}" }] };
    const r = await run({ action: "set_variable", service: "worker", name: "PROXY_SRC", value: "https://attacker.example", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /Tarsee's own NEWER_CLI_PROXY_URL is filled in from PROXY_SRC on worker by a Railway reference/, r.out);
    assert.match(r.out, /appears in the code of the Terminal's Claude Code/, r.out);
  });

  it("a program that changed since it was read (an update, a reinstall) is read again before the next write", async () => {
    const cli = fakeCli("changing/claude", "\0'NOTHING_NEW'\0");
    await terminalRuns([cli]);
    const args = { action: "set_variable", name: "NEWER_CLI_PROXY_URL", value: "https://x.example", deploy: false };
    const before_ = await run(args, { env: ON_RAILWAY });
    assert.match(before_.out, /^Set NEWER_CLI_PROXY_URL on tarsee/, before_.out);
    fakeCli("changing/claude", NEWER_TEXT);
    const after_ = await run(args, { env: ON_RAILWAY });
    assertNothingChanged(after_);
    assert.match(after_.out, /NEWER_CLI_PROXY_URL appears in the code of the Terminal's Claude Code/, after_.out);
  });

  it("while it can't be read, only TZ and the tuning settings go on Tarsee's own service", async () => {
    fs.mkdirSync(CLI_DIR, { recursive: true });
    for (const [label, opts] of [
      ["a folder, not a program", { find: async () => [CLI_DIR] }],
      ["the search for it failed", { find: async () => { throw new Error("EACCES: permission denied"); } }],
      ["the read never finished", { find: () => new Promise(() => {}), waitMs: 50 }],
    ]) {
      const started = terminalRuns([], opts);
      if (!opts.waitMs) await started;
      for (const [name, how] of [["SOME_SERVICE_API_KEY", { from_key: "WORKER_PASSWORD" }], ["STATUS_PAGE_URL", { value: "https://status.example.com" }]]) {
        const r = await run({ action: "set_variable", name, ...how, deploy: false }, { env: ON_RAILWAY });
        assertNothingChanged(r, `${label}: ${name}`);
        assert.match(r.out, /could not read the Terminal's Claude Code/, r.out);
        assert.match(r.out, /only TZ and the tuning settings/, r.out);
        assert.match(r.out, /by hand in Railway's dashboard/, r.out);
      }
      for (const [name, value] of [["TZ", "Asia/Manila"], ["TARSEE_TIMEZONE", "Asia/Manila"], ["TARSEE_PHONON_THREADS", "2"]]) {
        const r = await run({ action: "set_variable", name, value, deploy: false }, { env: ON_RAILWAY });
        assert.match(r.out, new RegExp(`^Set ${name} on tarsee`), `${label}: ${r.out}`);
      }
      // Through a reference too. A write that fills nothing of Tarsee's, and other projects, go as before.
      const more = { [E_TARSEE]: [{ name: "ALERTS_API_KEY", serviceId: S_TARSEE, value: "${{worker.ALERTS_SRC}}" }] };
      const fed = await run({ action: "set_variable", service: "worker", name: "ALERTS_SRC", value: "plain-value", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
      assertNothingChanged(fed, label);
      assert.match(fed.out, /Tarsee's own ALERTS_API_KEY is filled in from ALERTS_SRC on worker by a Railway reference/, fed.out);
      assert.match(fed.out, /could not read the Terminal's Claude Code/, fed.out);
      const free = await run({ action: "set_variable", service: "worker", name: "OTHER_SETTING", value: "1", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
      assert.match(free.out, /^Set OTHER_SETTING on worker/, `${label}: ${free.out}`);
      const away = await run({ action: "set_variable", project: "Acme", service: "web", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY });
      assert.match(away.out, /^Set SOME_SERVICE_API_KEY on web/, `${label}: ${away.out}`);
    }
    // Once it can be read again, the owner's keys go again.
    await terminalRuns([]);
    const back = await run({ action: "set_variable", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD", deploy: false }, { env: ON_RAILWAY });
    assert.match(back.out, /^Set SOME_SERVICE_API_KEY on tarsee/, back.out);
  });

  it("it reads a program in pieces and finds what the freshness check finds, wherever a piece ends", async () => {
    const file = fakeCli("pieces/claude", `${NEWER_TEXT}"ANOTHER_NEW_URL"\0\`TICK_KEY\`${"A".repeat(40)}_TOKEN\0X_URL`);
    const { names, runs } = freshnessRead(file);
    assert.ok(names.includes("NEWER_CLI_PROXY_URL") && runs.length >= 3, `${names} ${runs}`);
    for (const chunkBytes of [1, 2, 3, 5, 7, 11, 64, 1 << 20]) {
      const got = await RA.scanProgramNames(file, { chunkBytes });
      assert.deepEqual([...got.names].sort(), names, `chunkBytes ${chunkBytes}`);
      assert.deepEqual([...got.runs].sort(), runs, `chunkBytes ${chunkBytes}`);
    }
    // A run seen as one string somewhere is that string everywhere, as in the freshness check.
    const twice = fakeCli("pieces/twice", "\0'XBLACK_TAG_TOKEN'\0XBLACK_TAG_TOKEN\0");
    const got = await RA.scanProgramNames(twice, { chunkBytes: 4 });
    assert.deepEqual([[...got.names], got.runs], [["XBLACK_TAG_TOKEN"], []]);
  });

  it("on the Claude Code CLI installed here, the start-up read finds what the freshness check finds, without holding up the server", async () => {
    const { native, packages } = engineRuns();
    assertCliScanned({ packages, native });
    const cli = native.find(isCliProgram);
    if (!cli) return;   // no Claude Agent SDK installed here (assertCliScanned would have failed otherwise)
    const want = freshnessRead(cli);
    let last = Date.now(), worst = 0;
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    const started = Date.now();
    let raw;
    try { raw = await RA.scanProgramNames(cli); } finally { clearInterval(tick); }
    const ms = Date.now() - started;
    assert.deepEqual([...raw.names].sort(), want.names, "the same names, found whole");
    assert.deepEqual([...raw.runs].sort(), want.runs, "the same runs that hold a key-shaped name");
    assert.ok(ms < 30_000, `the read took ${ms} ms`);
    assert.ok(worst < 1000, `the server waited ${worst} ms at most between two of its turns while the CLI was read (${ms} ms in all)`);
    // As the Terminal's claude: it is the CLI the list was made from, so the read adds nothing to refuse. A run the
    // engines' code holds as one string (the list's names and strings) counts whole, as in the freshness check.
    const lines = [];
    const got = await RA.startTerminalCliScan({ find: async () => [cli], log: (l) => lines.push(l) });
    assert.ok(!(got instanceof Error), String(got));
    const list = readJson(ENGINE_NAMES_FILE);
    assert.deepEqual([...got.runs].sort(), want.runs.filter((r) => !list.names.includes(r) && !list.strings.includes(r)));
    assert.match(lines.join("\n"), /It holds no key-shaped name engine-env-names\.json lacks\./, lines.join("\n"));
    await terminalRuns([]);
  });

  it("the module and this test find the same names in a run", () => {
    for (const r of readJson(ENGINE_NAMES_FILE).runs) assert.deepEqual(RA.keyNamesInRun(r, 2000), keyNamesInRun(r, { limit: 2000 }), r);
    assert.deepEqual(RA.keyNamesInRun("ZNEWER_CLI_SESSION_TOKENNEWER_CLI_SIGNING_KEY").sort(), keyNamesInRun("ZNEWER_CLI_SESSION_TOKENNEWER_CLI_SIGNING_KEY").sort());
  });

  it("the Terminal's claude is found where the Terminal looks, never the Agent SDK's own copy (engine-env-names.json has its names)", async () => {
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    const onPath = fakeCli(path.join("path-bin", exe), NEWER_TEXT);
    const inHome = fakeCli(path.join("home", ".local", "bin", exe), "\0'X'\0");
    const sdkCli = engineRuns().native.find(isCliProgram);
    const PATH = [path.dirname(onPath), ...(sdkCli ? [path.dirname(sdkCli)] : []), path.join(CLI_DIR, "missing"), "relative-dir"].join(path.delimiter);
    const found = await RA.terminalClaudePrograms({ env: { PATH }, home: path.join(CLI_DIR, "home"), fixedDirs: [] });
    assert.deepEqual(found, [fs.realpathSync(onPath), fs.realpathSync(inHome)]);
    assert.deepEqual(await RA.terminalClaudePrograms({ env: { PATH: "" }, home: path.join(CLI_DIR, "nobody"), fixedDirs: [] }), [], "none");
  });

  it("a launcher in a Claude Code package brings the package's own programs with it", async () => {
    const pkg = path.join(CLI_DIR, "global", "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "9.9.9" }));
    fs.writeFileSync(path.join(pkg, "bin", "claude.exe"), "#!/bin/sh\necho stub\n");
    const nested = fakeCli(path.join("global", "node_modules", "@anthropic-ai", "claude-code", "node_modules", "@anthropic-ai", "claude-code-linux-x64", "claude"), NEWER_TEXT);
    const hoisted = fakeCli(path.join("global", "node_modules", "@anthropic-ai", "claude-code-win32-x64", "claude.exe"), "\0'Y'\0");
    // npm links bin/claude.exe in as claude (a symlink off Windows; on Windows the folder itself is on the PATH).
    let dir = path.join(pkg, "bin");
    if (process.platform !== "win32") {
      dir = path.join(CLI_DIR, "global-bin");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(pkg, "bin", "claude.exe"), path.join(dir, "claude"));
    }
    const found = await RA.terminalClaudePrograms({ env: { PATH: dir }, home: path.join(CLI_DIR, "nobody"), fixedDirs: [] });
    assert.deepEqual([...found].sort(), [path.join(pkg, "bin", "claude.exe"), nested, hoisted].map((f) => fs.realpathSync(f)).sort());
  });

  it("the read is logged: what it found that the list lacks, or that it couldn't read and what that means", async () => {
    const lines = [];
    await RA.startTerminalCliScan({ find: async () => [fakeCli("logged/claude", NEWER_TEXT)], log: (l) => lines.push(l) });
    assert.match(lines.join("\n"), /^\[railway\] the Terminal's Claude Code/m, lines.join("\n"));
    assert.match(lines.join("\n"), /NEWER_CLI_PROXY_URL/, lines.join("\n"));
    lines.length = 0;
    await RA.startTerminalCliScan({ find: async () => { throw new Error("nope"); }, log: (l) => lines.push(l) });
    assert.match(lines.join("\n"), /could not read the Terminal's Claude Code \(nope\)/, lines.join("\n"));
    assert.match(lines.join("\n"), /only TZ and the tuning settings/, lines.join("\n"));
    await terminalRuns([]);
  });

  it("server.js starts the read when Tarsee starts on Railway, after it listens", () => {
    const server = read("src/server.js");
    assert.match(server, /startTerminalCliScan\(\)/);
    assert.ok(server.indexOf("startTerminalCliScan()") > server.indexOf("server.listen("), "after listen: it never holds up the start");
  });
});

describe("other services keep working", () => {
  it("a provider key from the vault onto another project's service: set, the value reaching Railway only", async () => {
    const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "OPENAI_API_KEY", from_key: "OPENAI_KEY" });
    assert.match(r.out, /^Set OPENAI_API_KEY on worker \(service id /, r.out);
    assert.equal(r.rw.valueOf(E_PROD, S_WORK, "OPENAI_API_KEY"), OPENAI);
    assert.ok(!r.text.includes(OPENAI));
  });

  it("names refused on Tarsee's own service are ordinary on a service that is no Tarsee", async () => {
    // SETUP_PASSWORD, ENCRYPTION_KEY and TARSEE_ names would make a service look like a Tarsee (see below).
    for (const [name, how] of [["NODE_OPTIONS", { value: "--max-old-space-size=512" }], ["PORT", { value: "8080" }], ["ANTHROPIC_API_KEY", { from_key: "WORKER_PASSWORD" }], ["BUILDKIT_SYNTAX", { value: "docker/dockerfile:1" }]]) {
      const rw = railway();
      const r = await run({ action: "set_variable", project: "Acme", service: "web", name, ...how }, { rw });
      assert.match(r.out, new RegExp(`^Set ${name} on web`), r.out);
      assert.equal(rw.writes().length, 1, name);
    }
  });

  it("another service in Tarsee's own project (on Railway) is not Tarsee", async () => {
    const r = await run({ action: "set_variable", service: "Postgres", name: "POSTGRES_PASSWORD", from_key: "WORKER_PASSWORD" }, { env: ON_RAILWAY });
    assert.match(r.out, /^Set POSTGRES_PASSWORD on Postgres/, r.out);
    assert.equal(r.rw.valueOf(E_TARSEE, S_PG, "POSTGRES_PASSWORD"), VAULT.WORKER_PASSWORD);
  });

  it("redeploying another service works as before", async () => {
    const r = await run({ action: "redeploy", project: "Acme", service: "web" });
    assert.match(r.out, /^Asked Railway to redeploy web/, r.out);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Any Tarsee, not only this one. A second Tarsee of the owner's, in another project or in this one, has sign-ins, a
// vault and a Terminal of its own, and a variable set on it reaches its start-up script (run as root), its server and
// its engines. Its variable names give it away (SETUP_PASSWORD, ENCRYPTION_KEY or any TARSEE_ name, in any environment
// of its project, the name being set included), and so does Railway when it says the service is deployed from a repo
// or image named like Tarsee's. This Tarsee can't read the programs another one runs, nor those of its own service in
// another environment, so there only TZ and the tuning settings go.

describe("any Tarsee service gets the limits of Tarsee's own", () => {
  const DENIED = { env: ON_RAILWAY, getKeyDenied: () => true };
  // The reviewer's case: a second Tarsee as Acme's worker.
  const acmeTarsee = {
    [E_PROD]: [
      { name: "SETUP_PASSWORD", serviceId: S_WORK, value: "other-pw-SECRET-0005" },
      { name: "TARSEE_STATE_DIR", serviceId: S_WORK, value: "/data/tarsee" },
      { name: "ENCRYPTION_KEY", serviceId: S_WORK, value: "other-enc-SECRET-0006" },
    ],
  };
  const SAYS_WHAT_GOES = (r) => {
    assert.match(r.out, /only TZ and the tuning settings/, r.out);
    assert.match(r.out, /TARSEE_TIMEZONE, .*TARSEE_PHONON_THREADS/, "names the tuning settings");
    assert.match(r.out, /not even a key for the owner's own scripts/, r.out);
    assert.match(r.out, /by hand in Railway's dashboard/, r.out);
  };

  it("another project's Tarsee: its sign-in, its start-up, its AI, its build and every other name are refused, and nothing is sent", async () => {
    for (const [name, how, deploy] of [
      ["SETUP_PASSWORD", { value: "chosen-by-the-ai" }, true],
      ["NODE_OPTIONS", { value: "--import=data:text/javascript,0" }, false],
      ["TARSEE_AI_PROVIDER", { value: "openrouter" }, false],
      ["ANTHROPIC_BASE_URL", { value: "https://relay.example" }, false],
      ["BUILDKIT_SYNTAX", { value: "example/frontend:1" }, false],
      // A key for the owner's scripts too: which names that Tarsee's engines and Claude Code read is unknown here.
      ["SOME_SERVICE_API_KEY", { value: "plain-value" }, false],
      ["STATUS_PAGE_URL", { value: "https://status.example.com" }, true],
    ]) {
      for (const [label, opts] of [["get_key denied", DENIED], ["get_key allowed", { env: ON_RAILWAY }], ["off Railway", {}]]) {
        const rw = railway({ more: acmeTarsee });
        const r = await run({ action: "set_variable", project: "Acme", service: "worker", name, ...how, deploy }, { rw, ...opts });
        assertNothingChanged(r, `${name}, ${label}`);
        assert.match(r.out, /worker counts as a Tarsee \(its variables include SETUP_PASSWORD\)/, r.out);
        assert.match(r.out, /can't see which versions of the AI engines, the browser and Claude Code worker runs/, r.out);
        SAYS_WHAT_GOES(r);
        assert.ok(!r.text.includes("other-pw-SECRET") && !r.text.includes("other-enc-SECRET"), "none of its values is shown");
      }
    }
  });

  it("there TZ, with a time zone name, and the tuning settings still go, and list_variables shows names only", async () => {
    for (const [name, value] of [["TZ", "Asia/Manila"], ["TARSEE_TIMEZONE", "Asia/Manila"], ["TARSEE_PHONON_THREADS", "2"]]) {
      for (const deploy of [true, false]) {
        const rw = railway({ more: acmeTarsee });
        const r = await run({ action: "set_variable", project: "Acme", service: "worker", name, value, deploy }, { rw, ...DENIED });
        assert.match(r.out, new RegExp(`^Set ${name} on worker`), r.out);
        assert.equal(rw.valueOf(E_PROD, S_WORK, name), value);
      }
    }
    const path_ = await run({ action: "set_variable", project: "Acme", service: "worker", name: "TZ", value: ":/data/zone" }, { rw: railway({ more: acmeTarsee }), ...DENIED });
    assertNothingChanged(path_);
    assert.match(path_.out, /takes a time zone name/, path_.out);
    const list = await run({ action: "list_variables", project: "Acme", service: "worker" }, { rw: railway({ more: acmeTarsee }), ...DENIED });
    assert.match(list.out, /- SETUP_PASSWORD\n- TARSEE_STATE_DIR/, list.out);
    assert.ok(!list.text.includes("other-pw-SECRET"));
  });

  it("from_key onto it is refused while get_key is denied, as on Tarsee's own service", async () => {
    const r = await run({ action: "set_variable", project: "Acme", service: "worker", name: "TARSEE_TIMEZONE", from_key: "WORKER_PASSWORD", deploy: false }, { rw: railway({ more: acmeTarsee }), ...DENIED });
    assertNothingChanged(r);
    assert.match(r.out, /worker counts as a Tarsee \(its variables include SETUP_PASSWORD\)/, r.out);
    assert.match(r.out, /get_key is denied in Settings > Tool Permissions/, r.out);
    const allowed = await run({ action: "set_variable", project: "Acme", service: "worker", name: "TARSEE_TIMEZONE", from_key: "WORKER_PASSWORD", deploy: false }, { rw: railway({ more: acmeTarsee }), env: ON_RAILWAY });
    assert.match(allowed.out, /^Set TARSEE_TIMEZONE on worker/, allowed.out);
  });

  it("each of its marks, in any case and in any environment of its project, makes a service a Tarsee", async () => {
    for (const mark of ["SETUP_PASSWORD", "TARSEE_STATE_DIR", "ENCRYPTION_KEY", "TARSEE_API_TOKEN", "TARSEE_SOMETHING_ELSE", "setup_password", "Tarsee_Workspace_Dir"]) {
      // Tarsee's project's worker, written in production, with the mark in production or only in staging.
      for (const [envName, envId] of [["production", E_TARSEE], ["staging", E_TSTAGE]]) {
        const rw = railway({ more: { [envId]: [{ name: mark, serviceId: S_TWORK, value: "x" }] } });
        const r = await run({ action: "set_variable", service: "worker", name: "SOME_SERVICE_API_KEY", value: "plain-value", deploy: false }, { rw, env: ON_RAILWAY });
        assertNothingChanged(r, `${mark} in ${envName}`);
        assert.match(r.out, new RegExp(`worker counts as a Tarsee \\(its variables${envName === "staging" ? " in staging" : ""} include ${mark}\\)`), r.out);
      }
    }
    // Without one it is an ordinary service, and so is one whose marks are only shared variables.
    for (const more of [{}, { [E_TARSEE]: [{ name: "SETUP_PASSWORD", serviceId: null, value: "x" }] }]) {
      const r = await run({ action: "set_variable", service: "worker", name: "SOME_SERVICE_API_KEY", value: "plain-value", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
      assert.match(r.out, /^Set SOME_SERVICE_API_KEY on worker/, r.out);
    }
  });

  it("a name that would make a service look like a Tarsee is refused there, on a service that is none yet", async () => {
    for (const [name, how] of [["SETUP_PASSWORD", { from_key: "WORKER_PASSWORD" }], ["ENCRYPTION_KEY", { value: "plain-value" }], ["TARSEE_AI_PROVIDER", { value: "openai" }], ["TARSEE_STATE_DIR", { value: "/tmp/x" }], ["tarsee_api_token", { value: "plain-value" }]]) {
      for (const args of [{ project: "Acme", service: "web" }, { service: "Postgres" }]) {
        const r = await run({ action: "set_variable", name, ...how, ...args }, { env: ON_RAILWAY });
        assertNothingChanged(r, `${name} ${JSON.stringify(args)}`);
        assert.match(r.out, new RegExp(`${args.service} counts as a Tarsee \\(${name}, the name being set, is one of Tarsee's own`), r.out);
        SAYS_WHAT_GOES(r);
      }
    }
    // A tuning setting is one of those names, and goes.
    const tuning = await run({ action: "set_variable", project: "Acme", service: "web", name: "TARSEE_TIMEZONE", value: "Asia/Manila" }, { env: ON_RAILWAY });
    assert.match(tuning.out, /^Set TARSEE_TIMEZONE on web/, tuning.out);
  });

  it("a service Railway says is deployed from Tarsee's repo or image is a Tarsee, whatever its variables", async () => {
    for (const source of [{ repo: "someone/Tarsee" }, { repo: "someone/tarsee-fork" }, { image: "ghcr.io/someone/tarsee:latest" }, { image: "someone/Tarsee@sha256:0123abcd" }]) {
      const rw = railway({ sources: { [S_WEB]: source } });
      const r = await run({ action: "set_variable", project: "Acme", service: "web", name: "SOME_SERVICE_API_KEY", value: "plain-value", deploy: false }, { rw });
      assertNothingChanged(r, JSON.stringify(source));
      assert.match(r.out, new RegExp(`web counts as a Tarsee \\(Railway says it is deployed from the ${source.repo ? "repo" : "image"} `), r.out);
      SAYS_WHAT_GOES(r);
    }
    // Another repo or image, a Tarsee-like owner with another repo, or no answer about sources: an ordinary service.
    for (const sources of [{ [S_WEB]: { repo: "someone/shop" } }, { [S_WEB]: { image: "ghcr.io/tarsee-labs/shop:1" } }, { [S_WEB]: { repo: "tarsee-labs/shop" } }, "fail"]) {
      const r = await run({ action: "set_variable", project: "Acme", service: "web", name: "SOME_SERVICE_API_KEY", value: "plain-value", deploy: false }, { rw: railway({ sources }) });
      assert.match(r.out, /^Set SOME_SERVICE_API_KEY on web/, `${JSON.stringify(sources)}: ${r.out}`);
    }
  });

  it("a variable another Tarsee is filled in from counts as that Tarsee's: the same rules, and its sealed ones close that environment", async () => {
    const more = {
      [E_PROD]: [
        ...acmeTarsee[E_PROD],
        { name: "ANTHROPIC_API_KEY", serviceId: S_WORK, value: "${{web.AK}}" },
        { name: "WORKER_API_KEY", serviceId: S_WORK, value: "${{ web.WK }}" },
        { name: "TARSEE_TIMEZONE", serviceId: S_WORK, value: "${{web.ZONE}}" },
      ],
    };
    for (const name of ["AK", "WK"]) {
      for (const how of [{ value: "plain-value" }, { from_key: "WORKER_PASSWORD" }]) {
        const r = await run({ action: "set_variable", project: "Acme", service: "web", name, ...how, deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
        assertNothingChanged(r, name);
        assert.match(r.out, new RegExp(`The Tarsee worker's (ANTHROPIC|WORKER)_API_KEY \\(worker counts as a Tarsee: its variables include SETUP_PASSWORD\\) is filled in from ${name} on web by a Railway reference`), r.out);
        SAYS_WHAT_GOES(r);
      }
    }
    // A tuning setting filled in from web.ZONE: a plain value goes, from_key not while get_key is denied.
    const zone = await run({ action: "set_variable", project: "Acme", service: "web", name: "ZONE", value: "Asia/Manila", deploy: false }, { rw: railway({ more }), ...DENIED });
    assert.match(zone.out, /^Set ZONE on web/, zone.out);
    const zoneKey = await run({ action: "set_variable", project: "Acme", service: "web", name: "ZONE", from_key: "WORKER_PASSWORD", deploy: false }, { rw: railway({ more }), ...DENIED });
    assertNothingChanged(zoneKey);
    assert.match(zoneKey.out, /get_key is denied in Settings > Tool Permissions/, zoneKey.out);
    assert.match(zoneKey.out, /The Tarsee worker's TARSEE_TIMEZONE \(worker counts as a Tarsee: .*\) is filled in from ZONE on web/, zoneKey.out);
    // One of its variables sealed: nothing is set in that environment of its project.
    const sealed = { [E_PROD]: [...acmeTarsee[E_PROD], { name: "MY_KEY", serviceId: S_WORK, isSealed: true, value: "${{web.X}}" }] };
    for (const name of ["X", "OTHER_SETTING"]) {
      const r = await run({ action: "set_variable", project: "Acme", service: "web", name, value: "1", deploy: false }, { rw: railway({ more: sealed }), env: ON_RAILWAY });
      assertNothingChanged(r, name);
      assert.match(r.out, /The Tarsee worker's MY_KEY \(worker counts as a Tarsee: .*\) is sealed/, r.out);
    }
  });

  it("when Railway doesn't give a project's variable names, in any of its environments, nothing is set there, saying why", async () => {
    for (const [args, envId] of [
      [{ project: "Acme", service: "web" }, E_PROD],            // another project
      [{ service: "worker" }, E_TARSEE],                        // Tarsee's own project, the environment written to
      [{ service: "worker" }, E_TSTAGE],                        // and another environment of it
      [{ name: "TZ", value: "UTC" }, E_TSTAGE],                 // Tarsee's own service, even TZ
    ]) {
      const rw = railway({ namesFail: [envId] });
      const r = await run({ action: "set_variable", name: "OTHER_SETTING", value: "1", deploy: false, ...args }, { rw, env: ON_RAILWAY });
      assertNothingChanged(r, JSON.stringify(args));
      assert.match(r.out, /Railway did not give the variable names in (production|staging) of the project/, r.out);
      assert.match(r.out, /Problem processing request/, r.out);
      assert.match(r.out, /can't tell whether a service there is a Tarsee/, r.out);
    }
  });

  it("Tarsee's own service in another environment: only TZ and the tuning settings, since it can run other programs there", async () => {
    for (const [name, how] of [["SOME_SERVICE_API_KEY", { from_key: "WORKER_PASSWORD" }], ["STATUS_PAGE_URL", { value: "https://status.example.com" }]]) {
      const r = await run({ action: "set_variable", environment: "staging", name, ...how, deploy: false }, { env: ON_RAILWAY });
      assertNothingChanged(r, name);
      assert.match(r.out, /this is Tarsee's own service in staging, not in production, the environment this Tarsee runs in/, r.out);
      SAYS_WHAT_GOES(r);
    }
    for (const [name, value] of [["TZ", "Asia/Manila"], ["TARSEE_PHONON_THREADS", "2"]]) {
      const r = await run({ action: "set_variable", environment: "staging", name, value, deploy: false }, { env: ON_RAILWAY });
      assert.match(r.out, new RegExp(`^Set ${name} on tarsee .* in staging`), r.out);
    }
  });
});

describe("while TARSEE_AUTO_UPDATE_CLI is among Tarsee's own variables, only TZ and the tuning settings go there", () => {
  // With it, each start installs the newest Claude Code as the Terminal's claude, and that can read names the one running
  // now (the one Tarsee read) doesn't. A write with a deploy starts such a start, and one without waits for the next.
  const auto = (name = "TARSEE_AUTO_UPDATE_CLI", more = []) => ({ [E_TARSEE]: [{ name, serviceId: S_TARSEE, value: "1" }, ...more] });

  it("the owner's keys are refused, with a deploy or without, however it is spelled, saying exactly what goes", async () => {
    for (const spelled of ["TARSEE_AUTO_UPDATE_CLI", "tarsee_auto_update_cli"]) {
      for (const [name, how] of [["SOME_SERVICE_API_KEY", { from_key: "WORKER_PASSWORD" }], ["STATUS_PAGE_URL", { value: "https://status.example.com" }], ["ALERTS_WEBHOOK", { from_key: "ALERTS_WEBHOOK" }]]) {
        for (const deploy of [true, false]) {
          const r = await run({ action: "set_variable", name, ...how, deploy }, { rw: railway({ more: auto(spelled) }), env: ON_RAILWAY });
          assertNothingChanged(r, `${spelled} ${name} deploy=${deploy}`);
          assert.match(r.out, /TARSEE_AUTO_UPDATE_CLI is set on Tarsee's own service, so each time it starts it installs the newest Claude Code/, r.out);
          assert.match(r.out, /only TZ and the tuning settings/, r.out);
          assert.match(r.out, /TARSEE_TIMEZONE, .*TARSEE_PHONON_THREADS/, r.out);
          assert.match(r.out, /by hand in Railway's dashboard/, r.out);
        }
      }
    }
  });

  it("TZ and the tuning settings still go", async () => {
    for (const [name, value] of [["TZ", "Asia/Manila"], ["TARSEE_TIMEZONE", "Asia/Manila"], ["TARSEE_PHONON_THREADS", "2"]]) {
      const rw = railway({ more: auto() });
      const r = await run({ action: "set_variable", name, value }, { rw, env: ON_RAILWAY });
      assert.match(r.out, new RegExp(`^Set ${name} on tarsee`), r.out);
      assert.equal(rw.valueOf(E_TARSEE, S_TARSEE, name), value);
    }
  });

  it("a variable one of Tarsee's is filled in from is refused the same way; what fills nothing still goes", async () => {
    const more = auto("TARSEE_AUTO_UPDATE_CLI", [{ name: "ALERTS_API_KEY", serviceId: S_TARSEE, value: "${{worker.ALERTS_SRC}}" }]);
    const r = await run({ action: "set_variable", service: "worker", name: "ALERTS_SRC", value: "plain-value", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
    assertNothingChanged(r);
    assert.match(r.out, /Tarsee's own ALERTS_API_KEY is filled in from ALERTS_SRC on worker by a Railway reference/, r.out);
    assert.match(r.out, /TARSEE_AUTO_UPDATE_CLI is set on Tarsee's own service/, r.out);
    const free = await run({ action: "set_variable", service: "worker", name: "OTHER_SETTING", value: "1", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
    assert.match(free.out, /^Set OTHER_SETTING on worker/, free.out);
  });

  it("as a shared variable it is nothing; without it on Tarsee's own service the owner's keys go", async () => {
    const elsewhere = { [E_TARSEE]: [{ name: "TARSEE_AUTO_UPDATE_CLI", serviceId: null, value: "1" }] };
    for (const more of [{}, elsewhere]) {
      const r = await run({ action: "set_variable", name: "SOME_SERVICE_API_KEY", from_key: "WORKER_PASSWORD", deploy: false }, { rw: railway({ more }), env: ON_RAILWAY });
      assert.match(r.out, /^Set SOME_SERVICE_API_KEY on tarsee/, r.out);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real vault (a temporary one), the tool switch in tools.js, and what the AI reads about the tool.

describe("through tools.js, the real vault and the MCP server", () => {
  let realFetch;
  before(async () => {
    const { setKey } = await import("../src/lib/key-vault.js");
    setKey("RAILWAY_API_TOKEN", TOKEN, "test token", { owner: true });   // as the owner saves it, in Settings > Keys
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
      assert.match(tool.description, /A variable that one of Tarsee's own variables is filled in from by a Railway reference .* counts as that variable/);
      assert.match(tool.description, /ON TARSEE'S OWN SERVICE IT SETS ONLY/);
      assert.match(tool.description, /ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL/);
      assert.match(tool.description, /appears anywhere in the code of its AI engines or browser library/);
      assert.match(tool.description, /VOICE_STREAM_BASE_URL/);
      assert.match(tool.description, /TZ/);
      assert.match(tool.description, /TARSEE_PHONON_THREADS/);
      assert.match(tool.description, /sealed/);
      assert.match(tool.description, /get_key is denied in Tool Permissions, from_key onto Tarsee's own service, or into a variable it is filled in from, is refused/);
      // Round 4: the Terminal's own Claude Code, and a reference to a service the project doesn't have.
      assert.match(tool.description, /the Terminal's Claude Code/);
      assert.match(tool.description, /TARSEE_AUTO_UPDATE_CLI=1/);
      assert.match(tool.description, /only TZ and the tuning settings/);
      assert.match(tool.description, /a service the project doesn't have/);
      // Round 5: any Tarsee service, and the Claude Code read being the one running now.
      assert.match(tool.description, /ANY TARSEE SERVICE GETS THESE LIMITS/);
      assert.match(tool.description, /SETUP_PASSWORD, ENCRYPTION_KEY or a TARSEE_ name/);
      assert.match(tool.description, /deployed from a repo or image named like Tarsee's/);
      assert.match(tool.description, /while TARSEE_AUTO_UPDATE_CLI is among its variables/);
      assert.match(tool.description, /the one running now/);
      assert.match(tool.description, /If Railway doesn't give a project's variable names, nothing is set in it/);
      assert.match(tool.inputSchema.properties.name.description, /On another Tarsee service, only TZ and the tuning settings/);
      assert.match(tool.inputSchema.properties.name.description, /the Terminal's Claude Code/);
      assert.match(tool.description, /Railway's dashboard/);
      assert.ok(!tool.description.includes(String.fromCharCode(0x2014)), "no long dash");
      assert.match(tool.inputSchema.properties.from_key.description, /Tarsee's own keys .* are refused/);
      assert.match(tool.inputSchema.properties.from_key.description, /onto Tarsee's own service, or into a variable it is filled in from, while get_key is denied/);
      assert.match(tool.inputSchema.properties.name.description, /On Tarsee's own service only/);
      assert.match(tool.inputSchema.properties.name.description, /in none of its engines' code/);
      assert.match(tool.inputSchema.properties.value.description, /A Railway reference \(\$\{\{ \.\.\. \}\}\) is refused/);
    } finally {
      await mcp.close();
    }
  });
});
