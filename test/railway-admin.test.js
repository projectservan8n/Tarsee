// tarsee_railway (src/lib/railway-admin.js): Railway projects, variable names, set_variable and redeploy, done by Tarsee
// with a token it reads from the vault, so a secret never goes through a command or the model's context. Railway is
// never reached: fetch is a stand-in that answers like Railway's GraphQL API, and the vault is a stand-in or a
// temporary one.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Keep every module that reads config away from the real state dir, vault and DB, and from a real Railway service.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-railway-admin-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.ENCRYPTION_KEY = "railway-admin-test-encryption-key-0123456789";
for (const k of ["RAILWAY_API_TOKEN", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"]) delete process.env[k];
const { railwayAdmin, ACTIONS, DOCS, API_URL, TOKEN_KEY, maskValue, hereOf } = await import("../src/lib/railway-admin.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "../src/lib/railway-admin.js"), "utf8");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TOKEN = "owner-tok-SECRET-11111111-2222-3333";
const HOOK = "https://discord.com/api/webhooks/1564447804183547987/wh-SECRET-abcdefghij_KLMNOP-0123456789xyz";
const GO = "the owner in chat: put the alerts webhook on the watchdog and deploy";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P_ACME = id(1), P_TWIN1 = id(2), P_TWIN2 = id(3), P_GONE = id(4), P_TARSEE = id(5), P_OTHER = id(9);
const E_PROD = id(11), E_STAGE = id(12), E_OLD = id(13);
const S_WATCH = id(21), S_WEB = id(22), S_W1 = id(23), S_W2 = id(24);
const D_LAST = id(31), D_NEW = id(32);
const E_TARSEE = id(43), S_TARSEE = id(44), D_TARSEE = id(45);
/** Where Tarsee runs, as Railway tells a service. */
const ON_RAILWAY = { RAILWAY_PROJECT_ID: P_TARSEE, RAILWAY_ENVIRONMENT_ID: E_TARSEE, RAILWAY_SERVICE_ID: S_TARSEE };

/** What the token can see, with its variables and deployments. */
function railwayData() {
  return {
    [TOKEN]: {
      projects: [
        { id: P_ACME, name: "Acme", deletedAt: null, environments: [{ id: E_PROD, name: "production" }, { id: E_STAGE, name: "Staging" }, { id: E_OLD, name: "pr-12", deletedAt: "2026-10-01T00:00:00Z" }], services: [{ id: S_WATCH, name: "watchdog" }, { id: S_WEB, name: "web" }, { id: S_W1, name: "worker" }, { id: S_W2, name: "Worker" }] },
        { id: P_TWIN1, name: "Twin", deletedAt: null, environments: [{ id: id(41), name: "production" }], services: [] },
        { id: P_TWIN2, name: "twin", deletedAt: null, environments: [{ id: id(42), name: "production" }], services: [] },
        { id: P_GONE, name: "Old Thing", deletedAt: "2026-09-01T00:00:00Z", environments: [], services: [] },
        { id: P_TARSEE, name: "Tarsee", deletedAt: null, environments: [{ id: E_TARSEE, name: "production" }], services: [{ id: S_TARSEE, name: "tarsee" }] },
      ],
      variables: {
        [E_PROD]: [
          { name: "DATABASE_URL", serviceId: S_WATCH, isSealed: true, value: "postgres://u:pw-SECRET@db/x" },
          { name: "LOG_LEVEL", serviceId: S_WATCH, isSealed: false, value: "info" },
          { name: "PORT", serviceId: S_WEB, isSealed: false, value: "8080" },
          { name: "SHARED_REGION", serviceId: null, isSealed: false, value: "sin" },
        ],
        [E_STAGE]: [],
        [E_TARSEE]: [{ name: "SETUP_PASSWORD", serviceId: S_TARSEE, isSealed: false, value: "1234" }],
      },
      deployments: {
        [`${E_PROD}/${S_WATCH}`]: [{ id: D_LAST, status: "SUCCESS", createdAt: "2026-10-26T10:00:00Z" }],
        [`${E_TARSEE}/${S_TARSEE}`]: [{ id: D_TARSEE, status: "SUCCESS", createdAt: "2026-10-27T08:00:00Z" }],
      },
    },
  };
}

/**
 * A stand-in for Railway's GraphQL endpoint: answers by operation name, for the token in the Authorization header,
 * and records every call (url, headers, the parsed body). `fail` makes one operation fail in a chosen way.
 */
function railway({ fail = null } = {}) {
  const data = railwayData();
  const calls = [];
  const reply = (status, body) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const op = /(?:query|mutation) (\w+)/.exec(body.query)?.[1];
    calls.push({ url, method: init.method, headers: init.headers, body, op });
    if (fail && (fail.op === op || fail.op === "*")) {
      if (fail.network) throw Object.assign(new TypeError("fetch failed"), { cause: { code: fail.network } });
      if (fail.hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      if (fail.raw) return reply(fail.status || 200, fail.raw);
      return reply(fail.status || 200, { errors: (fail.errors || ["boom"]).map((message) => ({ message })), data: null });
    }
    const token = /^Bearer (.+)$/.exec(init.headers.Authorization || "")?.[1];
    const acct = data[token];
    if (!acct) return reply(401, { errors: [{ message: "Not Authorized" }] });
    const v = body.variables || {};
    const edges = (list) => ({ edges: list.map((node) => ({ node })) });
    switch (op) {
      case "TarseeProjects":
        return reply(200, { data: { projects: edges(acct.projects.map(({ id: pid, name, deletedAt }) => ({ id: pid, name, deletedAt }))) } });
      case "TarseeProject": {
        const p = acct.projects.find((x) => x.id === v.id);
        if (!p) return reply(200, { errors: [{ message: "Project not found" }], data: null });
        return reply(200, { data: { project: { id: p.id, name: p.name, deletedAt: p.deletedAt, environments: edges(p.environments.map((e) => ({ deletedAt: null, ...e }))), services: edges(p.services) } } });
      }
      case "TarseeVariableNames": {
        const list = acct.variables[v.environmentId];
        if (!list) return reply(200, { errors: [{ message: "Environment not found" }], data: null });
        // Only what the document asks for: names, never values.
        const wantsValue = /\bvalue\b/.test(body.query);
        return reply(200, { data: { environment: { variables: edges(list.map((x) => (wantsValue ? x : { name: x.name, serviceId: x.serviceId, isSealed: x.isSealed }))) } } });
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
        return reply(400, { errors: [{ message: `Cannot query: unknown operation ${op}` }] });
    }
  };
  const writes = () => calls.filter((c) => /^mutation/.test(c.body.query));
  return { fetch, calls, data, writes };
}

function fakeVault(entries = { RAILWAY_API_TOKEN: TOKEN, ALERTS_WEBHOOK: HOOK }) {
  const keys = new Map(Object.entries(entries));
  return { keys, getKey: (k) => (keys.has(k) ? keys.get(k) : null), getAllKeysDecrypted: () => Object.fromEntries(keys) };
}

/** Runs the tool with its log lines kept, so a test can check they carry no secret. Off Railway unless env says so. */
async function run(args, { rw = railway(), vault = fakeVault(), env = {}, timeoutMs } = {}) {
  const lines = [];
  const out = await railwayAdmin(args, { vault, env, fetch: rw.fetch, log: (l) => lines.push(l), ...(timeoutMs ? { timeoutMs } : {}) });
  return { out, lines, rw, vault, text: out + "\n" + lines.join("\n") };
}

const tokensSent = (rw) => [...new Set(rw.calls.map((c) => c.headers.Authorization))];

// ---------------------------------------------------------------------------------------------------------------

describe("list_projects", () => {
  it("every project the token can see, by name with its id; deleted ones left out; no go needed", async () => {
    const { out, lines, rw } = await run({ action: "list_projects" });
    assert.match(out, /^Railway projects in the owner's Railway account \(4\):/, out);
    assert.match(out, new RegExp(`- Acme \\(id ${P_ACME}\\)`));
    assert.match(out, new RegExp(`- Tarsee \\(id ${P_TARSEE}\\)\\n`));
    assert.ok(!out.includes("Old Thing"), "a deleted project is not listed");
    assert.ok(!out.includes("Tarsee runs here"), "off Railway nothing is marked");
    assert.equal(rw.calls.length, 1);
    assert.equal(rw.calls[0].url, API_URL);
    assert.equal(rw.calls[0].method, "POST");
    assert.equal(rw.calls[0].body.query, DOCS.projects);
    assert.deepEqual(tokensSent(rw), [`Bearer ${TOKEN}`]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[railway\] list_projects project=- env=- service=- ok$/);
  });

  it("with project (a name in any case, or an id): its environments and services with ids, deleted environments left out", async () => {
    const { out, rw } = await run({ action: "list_projects", project: "ACME" });
    assert.match(out, new RegExp(`^Project "Acme" \\(id ${P_ACME}\\) in the owner's Railway account:`));
    assert.match(out, /Environments \(2\):\n- production \(id [0-9a-f-]+\)\n- Staging/);
    assert.match(out, new RegExp(`- watchdog \\(id ${S_WATCH}\\)`));
    assert.ok(!out.includes("pr-12"));
    assert.deepEqual(rw.calls.map((c) => c.op), ["TarseeProjects", "TarseeProject"]);
    const byId = await run({ action: "list_projects", project: P_ACME });
    assert.deepEqual(byId.rw.calls.map((c) => c.op), ["TarseeProject"], "an id goes straight to the project");
    assert.equal(byId.out, out);
  });
});

describe("the token: the vault's RAILWAY_API_TOKEN, else the environment's", () => {
  it("the vault key comes first, even with one in the environment", async () => {
    const { rw } = await run({ action: "list_projects" }, { env: { RAILWAY_API_TOKEN: "env-tok-SECRET-000000000" } });
    assert.deepEqual(tokensSent(rw), [`Bearer ${TOKEN}`]);
    assert.equal(TOKEN_KEY, "RAILWAY_API_TOKEN");
  });

  it("with none in the vault, the environment variable is used", async () => {
    const { out, rw } = await run({ action: "list_projects" }, { vault: fakeVault({}), env: { RAILWAY_API_TOKEN: ` ${TOKEN} ` } });
    assert.match(out, /^Railway projects in the owner's Railway account \(4\):/);
    assert.deepEqual(tokensSent(rw), [`Bearer ${TOKEN}`]);
  });

  it("with neither, it says where to get one and how to save it, and nothing is sent", async () => {
    const none = await run({ action: "list_projects" }, { vault: fakeVault({ RAILWAY_API_TOKEN: "  " }) });
    assert.match(none.out, /^railway list_projects error: There is no Railway token: the vault has no RAILWAY_API_TOKEN and neither does the environment\. Ask the owner for a Railway account or workspace token .*a project token will not do.* save it with tarsee_set_key as RAILWAY_API_TOKEN\. Nothing was done\.$/);
    assert.equal(none.rw.calls.length, 0);
  });

  it("a vault that cannot be read says so", async () => {
    const broken = { getKey: () => { throw new Error("bad decrypt"); } };
    const { out, rw } = await run({ action: "list_projects" }, { vault: broken });
    assert.match(out, /The vault key RAILWAY_API_TOKEN could not be read \(bad decrypt\)/);
    assert.equal(rw.calls.length, 0);
  });
});

describe("on Railway: Tarsee's own project, environment and service by default", () => {
  it("reads where it runs from Railway's variables, ids only", () => {
    assert.deepEqual(hereOf(ON_RAILWAY), { projectId: P_TARSEE, environmentId: E_TARSEE, serviceId: S_TARSEE });
    assert.deepEqual(hereOf({ RAILWAY_PROJECT_ID: "not-an-id" }), { projectId: null, environmentId: null, serviceId: null });
    assert.deepEqual(hereOf({}), { projectId: null, environmentId: null, serviceId: null });
  });

  it("list_projects marks Tarsee's own project, environment and service", async () => {
    const all = await run({ action: "list_projects" }, { env: ON_RAILWAY });
    assert.match(all.out, new RegExp(`- Tarsee \\(id ${P_TARSEE}\\) \\(Tarsee runs here\\)`));
    const one = await run({ action: "list_projects", project: "tarsee" }, { env: ON_RAILWAY });
    assert.match(one.out, /- production \(id [^)]+\) \(Tarsee runs here\)/);
    assert.match(one.out, /- tarsee \(id [^)]+\) \(Tarsee itself\)/);
  });

  it("with no project, list_variables is about Tarsee's own service (an id goes straight to it)", async () => {
    const { out, rw } = await run({ action: "list_variables" }, { env: ON_RAILWAY });
    assert.match(out, new RegExp(`^Variables on tarsee \\(service id ${S_TARSEE}\\) in production \\(environment id ${E_TARSEE}\\), project "Tarsee"`));
    assert.match(out, /- SETUP_PASSWORD\n/);
    assert.ok(!out.includes("1234"));
    assert.deepEqual(rw.calls.map((c) => c.op), ["TarseeProject", "TarseeVariableNames"]);
  });

  it("another project named is not given Tarsee's environment or service", async () => {
    const { out } = await run({ action: "list_variables", project: "Acme" }, { env: ON_RAILWAY });
    assert.match(out, /service is required: the service's name or id in the project "Acme"/);
  });

  it("redeploying Tarsee itself, or setting a variable on it with a deploy, says it restarts Tarsee and ends the turn", async () => {
    const re = await run({ action: "redeploy", approved_by: GO }, { env: ON_RAILWAY });
    assert.match(re.out, new RegExp(`^Asked Railway to redeploy tarsee \\(service id ${S_TARSEE}\\)`));
    assert.deepEqual(re.rw.calls.at(-1).body.variables, { id: D_TARSEE });
    assert.match(re.out, /This is Tarsee's own service: the deploy restarts Tarsee, which ends the turn that asked for it\./);
    const set = await run({ action: "set_variable", name: "LOG_LEVEL", value: "debug", approved_by: GO }, { env: ON_RAILWAY });
    assert.match(set.out, /restarts Tarsee/);
    const quiet = await run({ action: "set_variable", name: "LOG_LEVEL", value: "debug", deploy: false, approved_by: GO }, { env: ON_RAILWAY });
    assert.ok(!/restarts Tarsee/.test(quiet.out), "no deploy, no restart");
    const other = await run({ action: "redeploy", project: "Acme", service: "watchdog", approved_by: GO }, { env: ON_RAILWAY });
    assert.ok(!/restarts Tarsee/.test(other.out), "another service is not Tarsee");
  });
});

describe("names to ids: project, environment and service", () => {
  it("a project name that matches nothing lists the projects and the near ones, and nothing is changed", async () => {
    const { out, rw } = await run({ action: "set_variable", project: "acme-prod", service: "watchdog", name: "X_FLAG", value: "on", approved_by: GO });
    assert.match(out, /There is no project "acme-prod" in the owner's Railway account\. Did you mean "Acme" \(id 0+-0000-4000-8000-0+1\)\?/);
    assert.match(out, /The projects there: .*Tarsee \(id /);
    assert.match(out, /Nothing was changed\.$/);
    assert.equal(rw.writes().length, 0);
  });

  it("two projects with the same name (in any case) are refused, with both ids to pick from", async () => {
    const { out, rw } = await run({ action: "set_variable", project: "twin", service: "x", name: "X_FLAG", value: "on", approved_by: GO });
    assert.match(out, new RegExp(`More than one project in the owner's Railway account is named "twin": Twin \\(id ${P_TWIN1}\\), twin \\(id ${P_TWIN2}\\)\\. Pass the id instead\\.`));
    assert.equal(rw.writes().length, 0);
  });

  it("an id the token cannot see says so plainly", async () => {
    const { out } = await run({ action: "list_projects", project: P_OTHER });
    assert.match(out, new RegExp(`the owner's Railway account cannot see a project with id ${P_OTHER} \\(Railway said: "Project not found"\\)\\. list_projects shows the ones it can\\.`));
  });

  it("the environment is production unless named; a name in any case or an id works; a missing one lists the choices", async () => {
    const prod = await run({ action: "list_variables", project: "Acme", service: "watchdog" });
    assert.equal(prod.rw.calls.at(-1).body.variables.environmentId, E_PROD);
    const stage = await run({ action: "list_variables", project: "Acme", environment: "staging", service: "watchdog" });
    assert.equal(stage.rw.calls.at(-1).body.variables.environmentId, E_STAGE);
    const byId = await run({ action: "list_variables", project: "Acme", environment: E_STAGE, service: S_WATCH });
    assert.equal(byId.rw.calls.at(-1).body.variables.environmentId, E_STAGE);
    const missing = await run({ action: "list_variables", project: "Acme", environment: "prod", service: "web" });
    assert.match(missing.out, /There is no environment "prod" in the project "Acme"\. Did you mean "production" \(id [^)]+\)\? The environments there: production \(id [^)]+\), Staging \(id [^)]+\)\./);
    const deleted = await run({ action: "list_variables", project: "Acme", environment: "pr-12", service: "web" });
    assert.match(deleted.out, /There is no environment "pr-12"/, "a deleted environment is not picked");
  });

  it("a service: by name or id; missing, doubled, or not given each say so with the services listed", async () => {
    const missing = await run({ action: "redeploy", project: "Acme", service: "watchdog-x", approved_by: GO });
    assert.match(missing.out, /There is no service "watchdog-x" in the project "Acme"\. Did you mean "watchdog" \(id [^)]+\)\? The services there: watchdog \(id [^)]+\), web/);
    const doubled = await run({ action: "redeploy", project: "Acme", service: "WORKER", approved_by: GO });
    assert.match(doubled.out, new RegExp(`More than one service in the project "Acme" is named "WORKER": worker \\(id ${S_W1}\\), Worker \\(id ${S_W2}\\)\\. Pass the id instead\\.`));
    const byId = await run({ action: "redeploy", project: "Acme", service: S_W2, approved_by: GO });
    assert.match(byId.out, /Worker has no deployment in production yet/);
    const none = await run({ action: "list_variables", project: "Acme" });
    assert.match(none.out, /service is required: the service's name or id in the project "Acme"\. Services there: watchdog/);
    for (const r of [missing, doubled, byId]) assert.equal(r.rw.writes().length, 0);
  });

  it("no project at all (and not on Railway) is refused", async () => {
    const { out, rw } = await run({ action: "list_variables", service: "web" });
    assert.match(out, /project is required/);
    assert.equal(rw.calls.length, 0);
  });
});

describe("list_variables: names, never values", () => {
  it("the service's names, sealed marked, and the environment's shared names; values are not even asked for", async () => {
    const { out, rw } = await run({ action: "list_variables", project: "Acme", service: "watchdog" });
    assert.match(out, new RegExp(`^Variables on watchdog \\(service id ${S_WATCH}\\) in production \\(environment id ${E_PROD}\\), project "Acme" \\(id ${P_ACME}\\): 2 names\\. Values are never shown\\.`));
    assert.match(out, /- DATABASE_URL \(sealed\)\n- LOG_LEVEL\n/);
    assert.match(out, /Shared variables in production \(any service can reference them\):\n- SHARED_REGION$/);
    assert.ok(!out.includes("PORT"), "another service's variable is not listed");
    for (const secretish of ["pw-SECRET", "info", "sin\n", "postgres://"]) assert.ok(!out.includes(secretish));
    const q = rw.calls.at(-1).body.query;
    assert.equal(q, DOCS.variableNames);
    assert.ok(!/\bvalue\b/.test(q), "the names query asks for no value");
  });

  it("an environment with none says so", async () => {
    const { out } = await run({ action: "list_variables", project: "Acme", environment: "Staging", service: "web" });
    assert.match(out, /: 0 names\. Values are never shown\.\n {2}none\nShared variables in Staging: none$/);
  });
});

describe("set_variable with from_key: the value goes to Railway and nowhere else", () => {
  it("Railway gets the vault value; the result says what was set with a masked value; the log line has neither", async () => {
    const { out, lines, rw, text } = await run({ action: "set_variable", project: "Acme", service: "watchdog", name: "ALERTS_WEBHOOK_URL", from_key: "ALERTS_WEBHOOK", approved_by: GO });
    const [w] = rw.writes();
    assert.equal(w.body.query, DOCS.upsert);
    assert.deepEqual(w.body.variables, { projectId: P_ACME, environmentId: E_PROD, serviceId: S_WATCH, variables: { ALERTS_WEBHOOK_URL: HOOK }, skipDeploys: false });
    assert.equal(w.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(rw.data[TOKEN].variables[E_PROD].find((x) => x.name === "ALERTS_WEBHOOK_URL").value, HOOK, "it reached Railway");
    assert.equal(out, [
      `Set ALERTS_WEBHOOK_URL on watchdog (service id ${S_WATCH}) in production (environment id ${E_PROD}), project "Acme" (id ${P_ACME}).`,
      `value: from the vault key ALERTS_WEBHOOK (masked: ${maskValue(HOOK)}). The value was not shown anywhere.`,
      "ALERTS_WEBHOOK_URL is a new variable on watchdog.",
      "deploy: yes. Railway redeploys watchdog in production with it, as it does on any variable change.",
    ].join("\n"));
    assert.equal(maskValue(HOOK), "http...9xyz");
    for (const secret of [HOOK, "wh-SECRET", TOKEN]) assert.ok(!text.includes(secret), `no ${secret.slice(0, 12)} in the result or the log`);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], `[railway] set_variable project="Acme" (${P_ACME}) env="production" (${E_PROD}) service="watchdog" (${S_WATCH}) go="${GO}" name=ALERTS_WEBHOOK_URL from_key=ALERTS_WEBHOOK deploy=yes ok`);
  });

  it("deploy: false sets it with skipDeploys and says it takes effect on the next deploy", async () => {
    const { out, rw } = await run({ action: "set_variable", project: "Acme", service: "watchdog", name: "ALERTS_WEBHOOK_URL", from_key: "ALERTS_WEBHOOK", deploy: false, approved_by: GO });
    assert.equal(rw.writes()[0].body.variables.skipDeploys, true);
    assert.match(out, /deploy: no \(deploy: false\)\. watchdog keeps the old value until its next deploy; redeploy starts one\.$/);
  });

  it("a variable that is already there is replaced, and the result says so (sealed noted)", async () => {
    const { out } = await run({ action: "set_variable", project: "Acme", service: "watchdog", name: "DATABASE_URL", from_key: "ALERTS_WEBHOOK", approved_by: GO });
    assert.match(out, /It replaced the value DATABASE_URL had \(it was sealed\)\./);
  });

  it("when Railway's error repeats the value (as is or JSON-escaped), the error and the log show **** instead", async () => {
    const quoted = 'p"a\\ss-SECRET-word-0987';
    for (const [key, val, echo] of [["ALERTS_WEBHOOK", HOOK, HOOK], ["ODD_KEY", quoted, JSON.stringify(quoted).slice(1, -1)]]) {
      const rw = railway({ fail: { op: "TarseeVariableUpsert", errors: [`Invalid value "${echo}" for ${key === "ODD_KEY" ? "X" : "ALERTS_WEBHOOK_URL"}`] } });
      const { out, text } = await run({ action: "set_variable", project: "Acme", service: "watchdog", name: "ALERTS_WEBHOOK_URL", from_key: key, approved_by: GO }, { rw, vault: fakeVault({ RAILWAY_API_TOKEN: TOKEN, [key]: val }) });
      assert.match(out, /^railway set_variable error: Railway said: "Invalid value "\*\*\*\*" for /, out);
      assert.match(out, /Nothing was changed\.$/);
      assert.ok(!text.includes(val) && !text.includes(echo) && !text.includes("SECRET"), "no trace of the value");
    }
  });

  it("an error that repeats the token is scrubbed too, the environment's token included", async () => {
    const rw = railway({ fail: { op: "TarseeProjects", status: 401, errors: [`bad token ${TOKEN}`] } });
    const { out, text } = await run({ action: "list_projects" }, { rw });
    assert.match(out, /Railway did not accept this with the token for the owner's Railway account \(Railway said: "bad token \*\*\*\*"\)/);
    assert.match(out, /it may be a project token \(this needs an account or workspace token\)/);
    assert.ok(!text.includes(TOKEN));
    const viaEnv = await run({ action: "list_projects" }, { rw: railway({ fail: { op: "*", status: 401, errors: [`bad token ${TOKEN}`] } }), vault: fakeVault({}), env: { RAILWAY_API_TOKEN: TOKEN } });
    assert.ok(!viaEnv.text.includes(TOKEN));
  });

  it("a vault key that is not there, or is empty, is refused before anything is sent", async () => {
    const missing = await run({ action: "set_variable", project: "Acme", service: "web", name: "A_B", from_key: "NOPE_KEY", approved_by: GO });
    assert.match(missing.out, /The vault has no key named NOPE_KEY\. tarsee_list_keys lists the names\. Nothing was changed\.$/);
    assert.equal(missing.rw.calls.length, 0);
    const empty = await run({ action: "set_variable", project: "Acme", service: "web", name: "A_B", from_key: "EMPTY_KEY", approved_by: GO }, { vault: fakeVault({ RAILWAY_API_TOKEN: TOKEN, EMPTY_KEY: "" }) });
    assert.match(empty.out, /The vault key EMPTY_KEY is empty/);
    assert.equal(empty.rw.calls.length, 0);
  });

  it("a lower-case key name finds the key saved in capitals", async () => {
    const { out, rw } = await run({ action: "set_variable", project: "Acme", service: "watchdog", name: "ALERTS_WEBHOOK_URL", from_key: "alerts_webhook", approved_by: GO });
    assert.match(out, /^Set ALERTS_WEBHOOK_URL on watchdog/, out);
    assert.equal(rw.writes()[0].body.variables.variables.ALERTS_WEBHOOK_URL, HOOK);
  });

  it("if Railway stops answering during the write, it says the outcome is unknown and to check first", async () => {
    const rw = railway({ fail: { op: "TarseeVariableUpsert", network: "ECONNRESET" } });
    const { out } = await run({ action: "set_variable", project: "Acme", service: "watchdog", name: "ALERTS_WEBHOOK_URL", from_key: "ALERTS_WEBHOOK", approved_by: GO }, { rw });
    assert.match(out, /stopped answering while the variable was being set \(ECONNRESET\), so it is not known whether ALERTS_WEBHOOK_URL was set\. Check with list_variables before trying again\.$/);
    assert.ok(!out.includes("Nothing was changed"));
  });
});

describe("set_variable: from_key or value, exactly one", () => {
  const base = { action: "set_variable", project: "Acme", service: "web", name: "FEATURE_FLAG", approved_by: GO };

  it("both, or neither, is refused before anything is sent", async () => {
    const both = await run({ ...base, from_key: "ALERTS_WEBHOOK", value: "on" });
    assert.match(both.out, /Pass the value one way only: from_key .* or value .*, not both\. Nothing was changed\.$/);
    const neither = await run({ ...base });
    assert.match(neither.out, /Pass the value: from_key \(the vault key that holds it, for anything secret\) or value \(plain, non-secret text only\)\./);
    for (const r of [both, neither]) assert.equal(r.rw.calls.length, 0);
  });

  it("a plain value is set as given and shown, with Railway's usual deploy", async () => {
    const { out, rw, lines } = await run({ ...base, value: "on" });
    assert.deepEqual(rw.writes()[0].body.variables.variables, { FEATURE_FLAG: "on" });
    assert.match(out, /^Set FEATURE_FLAG on web .*\nvalue: "on" \(plain value\)\nFEATURE_FLAG is a new variable on web\.\ndeploy: yes\./);
    assert.match(lines[0], /name=FEATURE_FLAG value=plain deploy=yes ok$/);
    assert.ok(!lines[0].includes('"on"'), "even a plain value stays out of the log");
  });

  it("a value that is a vault key's value is refused and pointed at from_key", async () => {
    const { out, rw } = await run({ ...base, value: HOOK });
    assert.match(out, /That value is the vault key ALERTS_WEBHOOK\. Pass from_key: "ALERTS_WEBHOOK" instead/);
    assert.ok(!out.includes(HOOK));
    assert.equal(rw.calls.length, 0);
  });

  it("a value shaped like a secret is refused (webhook URLs, URLs with a password, keys)", async () => {
    for (const [value, what] of [
      ["https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi", "a Discord webhook URL"],
      ["postgres://app:hunter2@db.example.com:5432/app", "a URL with a password in it"],
      ["sk-ant-api03-abcdefghijklmnop", "an API key or token"],
      ["-----BEGIN RSA PRIVATE KEY-----\nabc", "a private key"],
    ]) {
      const { out, rw } = await run({ ...base, value });
      assert.match(out, new RegExp(`value looks like a secret \\(${what}\\)\\. Save it in the vault with tarsee_set_key and pass from_key`), value);
      assert.equal(rw.calls.length, 0);
    }
  });

  it("a bad variable name is refused", async () => {
    for (const name of ["", "1ST", "has space", "dash-ed"]) {
      const { out, rw } = await run({ ...base, name, value: "x" });
      assert.match(out, name ? /is not a usable variable name/ : /name is required/);
      assert.equal(rw.calls.length, 0);
    }
  });
});

describe("approved_by: a change needs someone's go", () => {
  for (const action of ["set_variable", "redeploy"]) {
    it(`${action} without it (or with only spaces) does nothing and says to ask`, async () => {
      for (const approved_by of [undefined, "", "   "]) {
        const { out, rw, lines } = await run({ action, project: "Acme", service: "watchdog", name: "X_Y", from_key: "ALERTS_WEBHOOK", approved_by });
        assert.match(out, new RegExp(`^railway ${action} error: ${action} changes a Railway service, so it needs approved_by: who gave the go and for what`));
        assert.match(out, /Who can give it: the owner, or whoever your instructions \(AGENTS\.md, USER\.md\) say may\. If nobody has said go for this exact change, ask first\. Nothing was done\.$/);
        assert.equal(rw.calls.length, 0);
        assert.match(lines[0], new RegExp(`^\\[railway\\] ${action} project=- .* failed: `));
      }
    });
  }

  it("the reads need no go", async () => {
    for (const action of ["list_projects", "list_variables"]) {
      const { out } = await run({ action, project: "Acme", service: "web" });
      assert.ok(!/error/.test(out.split("\n")[0]), out);
    }
  });
});

describe("redeploy", () => {
  it("redeploys the service's latest deployment in the environment and gives the new deployment's id", async () => {
    const { out, rw, lines } = await run({ action: "redeploy", project: "Acme", service: "watchdog", approved_by: GO });
    assert.deepEqual(rw.calls.map((c) => c.op), ["TarseeProjects", "TarseeProject", "TarseeLatestDeployment", "TarseeRedeploy"]);
    assert.deepEqual(rw.calls[2].body.variables, { input: { environmentId: E_PROD, serviceId: S_WATCH } });
    assert.deepEqual(rw.calls[3].body.variables, { id: D_LAST });
    assert.match(out, new RegExp(`^Asked Railway to redeploy watchdog \\(service id ${S_WATCH}\\) in production .*\\nIt redeploys the latest deployment ${D_LAST} \\(success, made 2026-10-26T10:00:00Z\\), with the service's current variables\\.\\nnew deployment id: ${D_NEW}$`));
    assert.match(lines[0], new RegExp(`from_deployment=${D_LAST} ok$`));
  });

  it("a service with no deployment says so and asks for nothing", async () => {
    const { out, rw } = await run({ action: "redeploy", project: "Acme", service: "web", approved_by: GO });
    assert.match(out, /web has no deployment in production yet, so there is nothing to redeploy\./);
    assert.equal(rw.writes().length, 0);
  });

  it("if Railway stops answering during the redeploy, the outcome is unknown and it says to check", async () => {
    const rw = railway({ fail: { op: "TarseeRedeploy", network: "ETIMEDOUT" } });
    const { out } = await run({ action: "redeploy", project: "Acme", service: "watchdog", approved_by: GO }, { rw });
    assert.match(out, /it is not known whether one started\. Check the service's deployments in Railway before trying again\.$/);
  });
});

describe("Railway's refusals in plain English", () => {
  const cases = [
    [{ status: 401, errors: ["Not Authorized"] }, /Railway did not accept this with the token for the owner's Railway account \(Railway said: "Not Authorized"\)\. The token may have been revoked or replaced, .* list_projects shows what it can see; if that fails too, ask the owner for a new token, saved in the vault as RAILWAY_API_TOKEN\./],
    [{ status: 200, errors: ["Not Authorized"] }, /Railway did not accept this with the token/],
    [{ status: 429, errors: ["Too many requests"] }, /Railway is limiting how often it is called right now \(too many requests\)\. Wait a minute and try again\./],
    [{ status: 503, raw: "<html>Service Unavailable</html>" }, /Railway's API had a problem on its side \(HTTP 503\)\. Try again in a minute\./],
    [{ network: "ENOTFOUND" }, /Railway's API could not be reached \(ENOTFOUND\)\. Check the internet connection and try again\./],
    [{ status: 200, raw: "<html>login</html>" }, /Railway's API sent back something that is not an answer \(HTTP 200\)/],
    [{ status: 400, errors: ["Cannot query field \"foo\" on type \"Query\"."] }, /Railway said: "Cannot query field "foo" on type "Query"\."\./],
  ];
  for (const [failure, want] of cases) {
    it(`${failure.network || failure.status} ${failure.errors?.[0] || failure.raw || ""}`.trim(), async () => {
      const { out } = await run({ action: "list_projects" }, { rw: railway({ fail: { op: "*", ...failure } }) });
      assert.match(out, /^railway list_projects error: /);
      assert.match(out, want, out);
    });
  }

  it("no answer in time is a plain timeout", async () => {
    const { out } = await run({ action: "list_projects" }, { rw: railway({ fail: { op: "*", hang: true } }), timeoutMs: 30 });
    assert.match(out, /Railway's API could not be reached \(no answer within 0 seconds\)/);
  });

  it("a write that Railway refuses ends with Nothing was changed", async () => {
    const rw = railway({ fail: { op: "TarseeVariableUpsert", errors: ["Service instance not found"] } });
    const { out } = await run({ action: "set_variable", project: "Acme", service: "web", name: "A_B", value: "1", approved_by: GO }, { rw });
    assert.equal(out, 'railway set_variable error: Railway said: "Service instance not found". Nothing was changed.');
  });
});

describe("unknown actions and no delete paths", () => {
  it("anything not in the list is refused, deletes by name included, and nothing is sent", async () => {
    for (const action of ["delete_variable", "variable_delete", "delete_service", "delete_project", "", undefined, "set_variables"]) {
      const { out, rw } = await run({ action, project: "Acme", service: "web", name: "PORT", approved_by: GO });
      assert.match(out, /Unknown action ".*"\. This tool does: list_projects, list_variables, set_variable, redeploy\. It never deletes anything/);
      assert.equal(rw.calls.length, 0);
    }
  });

  it("the actions are the four, none a delete; the documents it can send delete nothing and never replace the whole set", () => {
    assert.deepEqual([...ACTIONS], ["list_projects", "list_variables", "set_variable", "redeploy"]);
    for (const doc of Object.values(DOCS)) {
      assert.ok(!/[a-z]Delete\b|Remove\b|\breplace\b|destroy/i.test(doc), doc);
    }
    assert.ok(!/variableDelete|serviceDelete|projectDelete|environmentDelete|deploymentRemove|replace:/i.test(SRC), "no delete or replace anywhere in the module");
  });

  it("every action run end to end sends only the tool's own documents", async () => {
    const known = new Set(Object.values(DOCS));
    const rw = railway();
    for (const args of [
      { action: "list_projects" },
      { action: "list_projects", project: "Acme" },
      { action: "list_variables", project: "Acme", service: "web" },
      { action: "set_variable", project: "Acme", service: "web", name: "A_B", value: "1", approved_by: GO },
      { action: "set_variable", project: "Acme", service: "watchdog", name: "HOOK_URL", from_key: "ALERTS_WEBHOOK", deploy: false, approved_by: GO },
      { action: "redeploy", project: "Acme", service: "watchdog", approved_by: GO },
    ]) await railwayAdmin(args, { vault: fakeVault(), env: {}, fetch: rw.fetch, log: () => {} });
    assert.ok(rw.calls.length >= 12);
    for (const c of rw.calls) assert.ok(known.has(c.body.query), c.body.query);
    assert.deepEqual(rw.writes().map((c) => c.op), ["TarseeVariableUpsert", "TarseeVariableUpsert", "TarseeRedeploy"]);
  });
});

describe("wording", () => {

  it("no long dash in the module", () => {
    assert.ok(!SRC.includes("\u2014"), "src/lib/railway-admin.js");
  });

  it("the default TOOLS.md has a Railway section", () => {
    const tools = fs.readFileSync(path.join(here, "../src/workspace-defaults/TOOLS.md"), "utf8");
    assert.match(tools, /## Railway \(projects, variables, redeploys\)\n- List projects, services and variable names, set a variable or redeploy with tarsee_railway\./);
    assert.match(tools, /pass set_variable from_key \(the vault key name\)/);
    assert.match(tools, /approved_by/);
    assert.match(tools, /Redeploying Tarsee's own service restarts it/);
    const section = tools.slice(tools.indexOf("## Railway"));
    assert.ok(!section.includes("\u2014"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real vault (a temporary one), the tool switch, and the MCP server in front.

describe("the real vault (here a temporary one) and tools.js", () => {
  let realFetch;
  before(async () => {
    const { setKey } = await import("../src/lib/key-vault.js");
    setKey("RAILWAY_API_TOKEN", TOKEN, "test token");
    setKey("ALERTS_WEBHOOK", HOOK, "test webhook");
    realFetch = globalThis.fetch;
  });
  after(() => { globalThis.fetch = realFetch; });

  it("with no vault given, the token and the from_key value come from lib/key-vault.js, encrypted at rest", async () => {
    const rw = railway();
    const out = await railwayAdmin({ action: "set_variable", project: "Acme", service: "watchdog", name: "ALERTS_WEBHOOK_URL", from_key: "ALERTS_WEBHOOK", approved_by: GO }, { env: {}, fetch: rw.fetch, log: () => {} });
    assert.match(out, /^Set ALERTS_WEBHOOK_URL on watchdog/, out);
    assert.equal(rw.writes()[0].body.variables.variables.ALERTS_WEBHOOK_URL, HOOK);
    assert.ok(!out.includes(HOOK));
    const file = path.join(tmp, "data", "vault.json");
    assert.ok(fs.existsSync(file), "the temporary vault file");
    assert.ok(!fs.readFileSync(file, "utf8").includes("wh-SECRET"), "encrypted on disk");
  });

  it("executeTool('railway') runs the tool (here with fetch stubbed) and returns its text", async () => {
    const rw = railway();
    globalThis.fetch = rw.fetch;
    try {
      const { executeTool } = await import("../src/lib/tools.js");
      const out = await executeTool("railway", { action: "list_projects" }, {});
      assert.match(out, /^Railway projects in the owner's Railway account \(4\):/, out);
      assert.equal(rw.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the MCP server offers tarsee_railway with the right words, and a call runs the tool", async () => {
    const { createTarseeMcp } = await import("../src/ai/tarsee-mcp.js");
    const server = createTarseeMcp({});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "railway-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.instance.connect(serverTransport), mcp.connect(clientTransport)]);
    const rw = railway();
    globalThis.fetch = rw.fetch;
    try {
      const { tools } = await mcp.listTools();
      const tool = tools.find((t) => t.name === "tarsee_railway");
      assert.ok(tool, "tarsee_railway is offered");
      assert.deepEqual(tool.inputSchema.properties.action.enum, [...ACTIONS]);
      assert.equal(tool.inputSchema.properties.account, undefined, "one account: the owner's");
      assert.ok(tool.inputSchema.required?.includes("action"));
      const words = tool.description + JSON.stringify(tool.inputSchema);
      assert.ok(!words.includes("\u2014"), "no long dash in what the agent reads");
      assert.match(tool.description, /from the owner, or from whoever your instructions \(AGENTS\.md, USER\.md\) say may give it/, "owner-neutral");
      assert.match(tool.description, /SECRETS GO THROUGH from_key/);
      assert.match(tool.description, /never put a Railway token or a secret value in a command/);
      assert.match(tool.description, /value is for plain, non-secret text only/);
      assert.match(tool.description, /needs the owner's go/);
      assert.match(tool.description, /TARSEE'S OWN SERVICE: .*restarts Tarsee and ends the turn doing it/);
      assert.match(tool.description, /NOTHING HERE DELETES/);
      assert.match(tool.inputSchema.properties.value.description, /NON-SECRET/);
      const res = await mcp.callTool({ name: "tarsee_railway", arguments: { action: "list_projects", project: "Acme" } });
      assert.match(res.content[0].text, /^Project "Acme" \(id /);
      const bad = await mcp.callTool({ name: "tarsee_railway", arguments: { action: "delete_variable", project: "Acme" } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
      assert.ok(bad.isError, "a delete does not pass the schema");
      assert.deepEqual(rw.calls.map((c) => c.op), ["TarseeProjects", "TarseeProject"], "and never reaches Railway");
    } finally {
      globalThis.fetch = realFetch;
      await mcp.close();
    }
  });
});

