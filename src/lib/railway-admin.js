/**
 * Railway for the agent (tarsee_railway): list projects, environments, services and variable names, set a service
 * variable and redeploy a service, done by Tarsee itself with a Railway token it reads from the vault. Without it the
 * only way to set a variable is a command carrying the value (`railway variables --set`, or a GraphQL call with the
 * token in it), which puts a secret into a command line, a transcript and the model's context, and which Claude
 * Code's auto mode rightly blocks.
 *
 * How it reaches Railway: the public GraphQL API (the same documents Railway's CLI 5.x sends: variableCollectionUpsert,
 * deployments + deploymentRedeploy, environment.variables for names), with an account or workspace token as
 * `Authorization: Bearer`. Not the `railway` CLI: its login is a short-lived OAuth token only the CLI refreshes, and a
 * value handed to a child process sits in its argv or stdin. Here a secret value only ever travels inside the HTTPS
 * request body.
 *
 * Which token: the vault key RAILWAY_API_TOKEN, else the RAILWAY_API_TOKEN environment variable (a Railway service
 * variable the owner set; Railway does not inject one itself). Railway's project tokens are not accepted by this API
 * as Bearer, so it takes an account or workspace token.
 *
 * Tarsee usually runs on Railway, which tells every service its own RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID and
 * RAILWAY_SERVICE_ID. With no project given, the tool works on the project Tarsee runs in, in the environment it runs
 * in, on its own service. Redeploying that service (or setting a variable on it with a deploy) restarts Tarsee, which
 * ends the turn doing it: the result says so.
 *
 * Secrets: `from_key` names a vault key; its value is read here, sent to Railway and never put in a result, a log line
 * or an error (every text that leaves is scrubbed of it and of the token). Variable values are never read back:
 * list_variables asks Railway for names only.
 *
 * Nothing here deletes: no variable, service, environment or project is ever removed, and variables are never replaced
 * wholesale (no `replace`).
 *
 * Every call returns a plain-English string (never throws) and logs one line: the action, the project, the
 * environment, the service, never a value or a token.
 */
export const ACTIONS = Object.freeze(["list_projects", "list_variables", "set_variable", "redeploy"]);
const WRITES = new Set(["set_variable", "redeploy"]);

export const API_URL = "https://backboard.railway.com/graphql/v2";
const TIMEOUT_MS = 12_000;   // per call; a set_variable is up to four of them

/** Where the token is looked for, first found wins: the vault key, then the environment variable of the same name. */
export const TOKEN_KEY = "RAILWAY_API_TOKEN";
const LABEL = "the owner's Railway account";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

// The only documents this tool ever sends. None deletes; the upsert never passes `replace`.
export const DOCS = Object.freeze({
  projects: "query TarseeProjects { projects(first: 500) { edges { node { id name deletedAt } } } }",
  project: "query TarseeProject($id: String!) { project(id: $id) { id name deletedAt environments { edges { node { id name deletedAt } } } services { edges { node { id name } } } } }",
  variableNames: "query TarseeVariableNames($projectId: String!, $environmentId: String!) { environment(id: $environmentId, projectId: $projectId) { variables(first: 10000) { edges { node { name serviceId isSealed } } } } }",
  upsert: "mutation TarseeVariableUpsert($projectId: String!, $environmentId: String!, $serviceId: String!, $variables: EnvironmentVariables!, $skipDeploys: Boolean) { variableCollectionUpsert(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, variables: $variables, skipDeploys: $skipDeploys }) }",
  latestDeployment: "query TarseeLatestDeployment($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status createdAt } } } }",
  redeploy: "mutation TarseeRedeploy($id: String!) { deploymentRedeploy(id: $id) { id } }",
});

// Values that look like a secret: these go through from_key, never value.
const SECRET_SHAPES = [
  [/discord(app)?\.com\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+/i, "a Discord webhook URL"],
  [/hooks\.slack\.com\/services\//i, "a Slack webhook URL"],
  [/^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, "a URL with a password in it"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/^(sk-|sk_live_|rk_live_|ghp_|gho_|github_pat_|xox[abpr]-|glpat-)/, "an API key or token"],
  [/^AKIA[0-9A-Z]{16}$/, "an AWS access key"],
];

class RailwayError extends Error {}
const fail = (msg) => { throw new RailwayError(msg); };

/** A failure talking to Railway: kind is auth, rate, server, network, badjson or graphql. */
class ApiError extends Error {
  constructor(kind, message, status = 0) { super(message); this.kind = kind; this.status = status; }
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The vault's mask: the first and last four characters, or **** when short. */
export function maskValue(value) {
  const s = String(value ?? "");
  return s.length < 12 ? "****" : `${s.slice(0, 4)}...${s.slice(-4)}`;
}

/** Where Tarsee itself runs on Railway (the variables Railway gives every service), or nulls off Railway. */
export function hereOf(env = process.env) {
  const id = (k) => (UUID.test(String(env?.[k] || "").trim()) ? String(env[k]).trim() : null);
  return { projectId: id("RAILWAY_PROJECT_ID"), environmentId: id("RAILWAY_ENVIRONMENT_ID"), serviceId: id("RAILWAY_SERVICE_ID") };
}

/**
 * @param {object} args the tool's input (see tarsee_railway in src/ai/tarsee-mcp.js)
 * @param {object} [deps]
 * @param {{ getKey: Function, getAllKeysDecrypted?: Function }} [deps.vault] defaults to lib/key-vault.js
 * @param {object} [deps.env] defaults to process.env (the token's fallback, and where Tarsee runs)
 * @param {Function} [deps.fetch] defaults to the global fetch
 * @param {Function} [deps.log] one line per call (console.log)
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<string>}
 */
export async function railwayAdmin(args = {}, { vault = null, env = process.env, fetch: fetchImpl = globalThis.fetch, log = (line) => console.log(line), timeoutMs = TIMEOUT_MS } = {}) {
  args = args && typeof args === "object" ? args : {};
  const action = String(args.action ?? "");
  const note = { project: null, env: null, service: null, extra: [], secrets: [], outcomeUnknown: false };
  const scrub = (text) => {
    let s = String(text ?? "");
    for (const secret of note.secrets) {
      if (!secret || secret.length < 6) continue;
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) s = s.split(form).join("****");
    }
    return s;
  };
  const logLine = (outcome) => {
    const label = (x) => (x ? `"${x.name}" (${x.id})` : "-");
    const line = `[railway] ${action || "(no action)"} project=${label(note.project)} env=${label(note.env)} service=${label(note.service)}${note.extra.length ? ` ${note.extra.join(" ")}` : ""} ${outcome}`;
    try { log(scrub(line)); } catch { /* logging never fails a call */ }
  };
  try {
    if (!ACTIONS.includes(action)) {
      fail(`Unknown action "${action}". This tool does: ${ACTIONS.join(", ")}. It never deletes anything: deleting a variable, a service or a project is something the owner does by hand in Railway.`);
    }
    if (WRITES.has(action) && !String(args.approved_by ?? "").trim()) {
      fail(`${action} changes a Railway service, so it needs approved_by: who gave the go and for what, in their words, e.g. "the owner in chat: put the alerts webhook on the worker service". Who can give it: the owner, or whoever your instructions (AGENTS.md, USER.md) say may. If nobody has said go for this exact change, ask first. Nothing was done.`);
    }
    if (WRITES.has(action)) note.extra.push(`go="${oneLine(args.approved_by).slice(0, 120)}"`);
    const v = vault || await import("./key-vault.js");
    const token = tokenOf(v, env);
    note.secrets.push(token);
    const api = (doc, variables) => gql(doc, variables, { token, fetchImpl, timeoutMs });
    const ctx = { args, v, api, note, here: hereOf(env) };
    const run = { list_projects: listProjects, list_variables: listVariables, set_variable: setVariable, redeploy }[action];
    const out = await run(ctx);
    logLine("ok");
    return scrub(out);
  } catch (err) {
    let text = err instanceof RailwayError ? err.message : err instanceof ApiError ? apiErrorText(err) : `something went wrong: ${err?.message || String(err)}`;
    if (WRITES.has(action) && !note.outcomeUnknown && !/Nothing was (done|changed)\.$/.test(text)) text += " Nothing was changed.";
    text = scrub(text);
    logLine(`failed: ${oneLine(text).slice(0, 200)}`);
    return `railway ${action || ""} error: ${text}`.replace(/ {2}/g, " ");
  }
}

// ---------------------------------------------------------------- the token

function tokenOf(v, env) {
  let val = null;
  try { val = v.getKey(TOKEN_KEY); } catch (err) { fail(`The vault key ${TOKEN_KEY} could not be read (${err.message}). Nothing was done.`); }
  if (val && String(val).trim()) return String(val).trim();
  const fromEnv = String(env?.[TOKEN_KEY] ?? "").trim();
  if (fromEnv) return fromEnv;
  fail(`There is no Railway token: the vault has no ${TOKEN_KEY} and neither does the environment. Ask the owner for a Railway account or workspace token (Railway: Account Settings > Tokens, or the workspace's Settings > Tokens; a project token will not do) and save it with tarsee_set_key as ${TOKEN_KEY}. Nothing was done.`);
}

// ---------------------------------------------------------------- the API

async function gql(query, variables, { token, fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== "function") throw new ApiError("network", "this Node has no fetch");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, body;
  try {
    res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables: variables || {} }),
      signal: ctrl.signal,
    });
    body = await res.text();
  } catch (err) {
    const why = err?.name === "AbortError" ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : (err?.cause?.code || err?.message || String(err));
    throw new ApiError("network", why);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = JSON.parse(body); } catch { /* handled below */ }
  const firstError = json?.errors?.[0]?.message;
  if (res.status === 401 || res.status === 403) throw new ApiError("auth", firstError || `HTTP ${res.status}`, res.status);
  if (res.status === 429) throw new ApiError("rate", firstError || "Too Many Requests", 429);
  if (res.status >= 500) throw new ApiError("server", firstError || `HTTP ${res.status}`, res.status);
  if (!json) throw new ApiError("badjson", `HTTP ${res.status}`, res.status);
  if (Array.isArray(json.errors) && json.errors.length) {
    const msg = json.errors.map((e) => oneLine(e?.message)).filter(Boolean).join("; ") || "an error with no message";
    throw new ApiError(/not authori[sz]ed|unauthori[sz]ed|invalid token|forbidden/i.test(msg) ? "auth" : "graphql", msg, res.status);
  }
  if (res.status >= 400) throw new ApiError("graphql", `HTTP ${res.status}`, res.status);
  return json.data || {};
}

/** What a failure from Railway means, in plain words. */
function apiErrorText(err) {
  if (err.kind === "auth") {
    return `Railway did not accept this with the token for ${LABEL} (Railway said: "${err.message}"). The token may have been revoked or replaced, it may be a project token (this needs an account or workspace token), or the project may be in a workspace it cannot reach. list_projects shows what it can see; if that fails too, ask the owner for a new token, saved in the vault as ${TOKEN_KEY}.`;
  }
  if (err.kind === "rate") return "Railway is limiting how often it is called right now (too many requests). Wait a minute and try again.";
  if (err.kind === "server") return `Railway's API had a problem on its side (${err.message}). Try again in a minute.`;
  if (err.kind === "network") return `Railway's API could not be reached (${err.message}). Check the internet connection and try again.`;
  if (err.kind === "badjson") return `Railway's API sent back something that is not an answer (${err.message}). Try again in a minute.`;
  return `Railway said: "${err.message}".`;
}

// ---------------------------------------------------------------- names to ids

const nodes = (conn) => (conn?.edges || []).map((e) => e?.node).filter(Boolean);
const live = (list) => list.filter((x) => !x.deletedAt);
const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The one entry whose id, or name in any case, is `want`; a missing or doubled name says so with the choices. */
function pick(list, want, what, where) {
  const raw = String(want ?? "").trim();
  const byId = list.find((x) => x.id === raw);
  if (byId) return byId;
  const same = list.filter((x) => String(x.name).trim().toLowerCase() === raw.toLowerCase());
  if (same.length === 1) return same[0];
  if (same.length > 1) {
    fail(`More than one ${what} in ${where} is named "${raw}": ${same.map((x) => `${x.name} (id ${x.id})`).join(", ")}. Pass the id instead.`);
  }
  const a = squash(raw);
  const near = a.length < 3 ? [] : list.filter((x) => { const b = squash(x.name); return b.length >= 3 && (b.includes(a) || a.includes(b)); });
  const hint = near.length ? ` Did you mean ${near.slice(0, 5).map((x) => `"${x.name}" (id ${x.id})`).join(" or ")}?` : "";
  const all = list.length ? ` The ${what}s there: ${list.slice(0, 40).map((x) => `${x.name} (id ${x.id})`).join(", ")}${list.length > 40 ? ", ..." : ""}.` : ` There are no ${what}s there.`;
  fail(`There is no ${what} "${raw}" in ${where}.${hint}${all}`);
}

async function allProjects({ api }) {
  const data = await api(DOCS.projects, {});
  return live(nodes(data.projects));
}

/** The project asked for, or (with none given) the one Tarsee runs in. */
async function resolveProject(ctx) {
  const { args, api, note, here } = ctx;
  const want = String(args.project ?? "").trim() || here.projectId || "";
  if (!want) fail("project is required: the Railway project's name or id (list_projects shows them).");
  let id = want;
  if (!UUID.test(want)) {
    id = pick(await allProjects(ctx), want, "project", LABEL).id;
  }
  let data;
  try {
    data = await api(DOCS.project, { id });
  } catch (err) {
    if (UUID.test(want) && err instanceof ApiError && (err.kind === "graphql" || err.kind === "auth") && /not found|not authori[sz]ed|unauthori[sz]ed/i.test(err.message)) {
      fail(`${LABEL} cannot see a project with id ${want} (Railway said: "${err.message}"). list_projects shows the ones it can.`);
    }
    throw err;
  }
  const p = data.project;
  if (!p || p.deletedAt) fail(`${LABEL} has no project with id ${id}${p?.deletedAt ? " (it was deleted)" : ""}. list_projects shows the ones it can see.`);
  const project = { id: p.id, name: p.name, environments: live(nodes(p.environments)), services: nodes(p.services), isHere: p.id === here.projectId };
  note.project = project;
  return project;
}

/** The environment asked for; else, in Tarsee's own project, the one it runs in; else production. */
function resolveEnv(project, args, note, here) {
  const want = String(args.environment ?? "").trim() || (project.isHere && here.environmentId) || "production";
  const env = pick(project.environments, want, "environment", `the project "${project.name}"`);
  note.env = env;
  return env;
}

/** The service asked for; else, in Tarsee's own project, Tarsee's own service. */
function resolveService(project, args, note, here) {
  const want = String(args.service ?? "").trim() || (project.isHere && here.serviceId) || "";
  if (!want) fail(`service is required: the service's name or id in the project "${project.name}". Services there: ${project.services.map((s) => `${s.name} (id ${s.id})`).join(", ") || "none"}.`);
  const svc = pick(project.services, want, "service", `the project "${project.name}"`);
  note.service = svc;
  return svc;
}

async function variableNames({ api }, project, env) {
  const data = await api(DOCS.variableNames, { projectId: project.id, environmentId: env.id });
  if (!data.environment) fail(`Railway found no environment ${env.id} in the project "${project.name}".`);
  return nodes(data.environment.variables).map((n) => ({ name: String(n.name), serviceId: n.serviceId || null, sealed: !!n.isSealed }));
}

const where = (svc, env, project) => `${svc.name} (service id ${svc.id}) in ${env.name} (environment id ${env.id}), project "${project.name}" (id ${project.id})`;
const isSelf = (svc, env, here) => !!here.serviceId && svc.id === here.serviceId && (!here.environmentId || env.id === here.environmentId);
const SELF_RESTART = "This is Tarsee's own service: the deploy restarts Tarsee, which ends the turn that asked for it. Tarsee is back once Railway has deployed it (usually a minute or two).";

// ---------------------------------------------------------------- list_projects

async function listProjects(ctx) {
  const { args, here } = ctx;
  if (!String(args.project ?? "").trim()) {
    const list = (await allProjects(ctx)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!list.length) return `${cap(LABEL)} has no projects this token can see.`;
    return [
      `Railway projects in ${LABEL} (${list.length}):`,
      ...list.map((p) => `- ${p.name} (id ${p.id})${p.id === here.projectId ? " (Tarsee runs here)" : ""}`),
      "Pass project (a name or an id) to see its environments and services.",
    ].join("\n");
  }
  const project = await resolveProject(ctx);
  const envs = project.environments.map((e) => `- ${e.name} (id ${e.id})${project.isHere && e.id === here.environmentId ? " (Tarsee runs here)" : ""}`);
  const svcs = project.services.map((s) => `- ${s.name} (id ${s.id})${project.isHere && s.id === here.serviceId ? " (Tarsee itself)" : ""}`);
  return [
    `Project "${project.name}" (id ${project.id}) in ${LABEL}:`,
    `Environments (${envs.length}):`, ...(envs.length ? envs : ["  none"]),
    `Services (${svcs.length}):`, ...(svcs.length ? svcs : ["  none"]),
  ].join("\n");
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- list_variables

async function listVariables(ctx) {
  const { args, note, here } = ctx;
  const project = await resolveProject(ctx);
  const env = resolveEnv(project, args, note, here);
  const svc = resolveService(project, args, note, here);
  const vars = await variableNames(ctx, project, env);
  const mine = vars.filter((x) => x.serviceId === svc.id).sort((a, b) => a.name.localeCompare(b.name));
  const shared = vars.filter((x) => !x.serviceId).sort((a, b) => a.name.localeCompare(b.name));
  const line = (x) => `- ${x.name}${x.sealed ? " (sealed)" : ""}`;
  return [
    `Variables on ${where(svc, env, project)}: ${mine.length} names. Values are never shown.`,
    ...(mine.length ? mine.map(line) : ["  none"]),
    shared.length ? `Shared variables in ${env.name} (any service can reference them):` : `Shared variables in ${env.name}: none`,
    ...shared.map(line),
  ].join("\n");
}

// ---------------------------------------------------------------- set_variable

async function setVariable(ctx) {
  const { args, v, api, note, here } = ctx;
  const name = String(args.name ?? "").trim();
  if (!name) fail("name is required: the variable's name, e.g. ALERTS_WEBHOOK_URL.");
  if (!VAR_NAME.test(name)) fail(`name "${name}" is not a usable variable name: letters, digits and underscores, not starting with a digit.`);
  note.extra.push(`name=${name}`);

  const hasKey = args.from_key != null && String(args.from_key).trim() !== "";
  const hasValue = args.value !== undefined && args.value !== null;
  if (hasKey === hasValue) {
    fail(hasKey
      ? "Pass the value one way only: from_key (a vault key name, for anything secret) or value (plain, non-secret text), not both."
      : "Pass the value: from_key (the vault key that holds it, for anything secret) or value (plain, non-secret text only).");
  }

  let value, shown;
  if (hasKey) {
    const keyName = String(args.from_key).trim();
    let raw = null;
    try { raw = v.getKey(keyName) ?? (keyName !== keyName.toUpperCase() ? v.getKey(keyName.toUpperCase()) : null); } catch (err) { fail(`The vault key ${keyName} could not be read (${err.message}).`); }
    if (raw == null) fail(`The vault has no key named ${keyName}. tarsee_list_keys lists the names.`);
    value = String(raw);
    if (!value) fail(`The vault key ${keyName} is empty, so there is nothing to set.`);
    note.secrets.push(value);
    note.extra.push(`from_key=${keyName}`);
    shown = `from the vault key ${keyName} (masked: ${maskValue(value)}). The value was not shown anywhere.`;
  } else {
    value = String(args.value);
    const inVault = vaultKeyHolding(v, value);
    if (inVault) fail(`That value is the vault key ${inVault}. Pass from_key: "${inVault}" instead, so the value never goes through a chat or a command.`);
    const shape = SECRET_SHAPES.find(([re]) => re.test(value.trim()));
    if (shape) fail(`value looks like a secret (${shape[1]}). Save it in the vault with tarsee_set_key and pass from_key with that key name instead, so it never goes through a chat or a command.`);
    note.extra.push("value=plain");
    shown = `"${value.length > 200 ? `${value.slice(0, 200)}...` : value}" (plain value)`;
  }
  const deploy = args.deploy !== false;
  note.extra.push(`deploy=${deploy ? "yes" : "no"}`);

  const project = await resolveProject(ctx);
  const env = resolveEnv(project, args, note, here);
  const svc = resolveService(project, args, note, here);
  const before = (await variableNames(ctx, project, env)).find((x) => x.serviceId === svc.id && x.name === name);

  let ok;
  try {
    const data = await api(DOCS.upsert, { projectId: project.id, environmentId: env.id, serviceId: svc.id, variables: { [name]: value }, skipDeploys: !deploy });
    ok = data.variableCollectionUpsert;
  } catch (err) {
    if (err instanceof ApiError && err.kind === "network") {
      note.outcomeUnknown = true;
      fail(`Railway's API stopped answering while the variable was being set (${err.message}), so it is not known whether ${name} was set. Check with list_variables before trying again.`);
    }
    throw err;
  }
  if (ok === false) fail(`Railway answered that ${name} was not set on ${svc.name}.`);
  return [
    `Set ${name} on ${where(svc, env, project)}.`,
    `value: ${shown}`,
    before ? `It replaced the value ${name} had${before.sealed ? " (it was sealed)" : ""}.` : `${name} is a new variable on ${svc.name}.`,
    deploy
      ? `deploy: yes. Railway redeploys ${svc.name} in ${env.name} with it, as it does on any variable change.`
      : `deploy: no (deploy: false). ${svc.name} keeps the old value until its next deploy; redeploy starts one.`,
    deploy && isSelf(svc, env, here) ? SELF_RESTART : null,
  ].filter(Boolean).join("\n");
}

/** The vault key whose value is exactly this one, if any (only to point at from_key; nothing is shown). */
function vaultKeyHolding(v, value) {
  if (!value || value.length < 8 || typeof v.getAllKeysDecrypted !== "function") return null;
  try {
    for (const [k, val] of Object.entries(v.getAllKeysDecrypted() || {})) if (val != null && String(val) === value) return k;
  } catch { /* a vault that cannot be read whole is no reason to refuse */ }
  return null;
}

// ---------------------------------------------------------------- redeploy

async function redeploy(ctx) {
  const { args, api, note, here } = ctx;
  const project = await resolveProject(ctx);
  const env = resolveEnv(project, args, note, here);
  const svc = resolveService(project, args, note, here);
  const latest = nodes((await api(DOCS.latestDeployment, { input: { environmentId: env.id, serviceId: svc.id } })).deployments)[0];
  if (!latest) fail(`${svc.name} has no deployment in ${env.name} yet, so there is nothing to redeploy. Its first deploy comes from Railway (a push to its repo, or the dashboard's Deploy button).`);
  let fresh;
  try {
    fresh = (await api(DOCS.redeploy, { id: latest.id })).deploymentRedeploy;
  } catch (err) {
    if (err instanceof ApiError && err.kind === "network") {
      note.outcomeUnknown = true;
      fail(`Railway's API stopped answering while the redeploy was being asked for (${err.message}), so it is not known whether one started. Check the service's deployments in Railway before trying again.`);
    }
    throw err;
  }
  note.extra.push(`from_deployment=${latest.id}`);
  return [
    `Asked Railway to redeploy ${where(svc, env, project)}.`,
    `It redeploys the latest deployment ${latest.id} (${String(latest.status || "status unknown").toLowerCase()}${latest.createdAt ? `, made ${latest.createdAt}` : ""}), with the service's current variables.`,
    fresh?.id ? `new deployment id: ${fresh.id}` : null,
    isSelf(svc, env, here) ? SELF_RESTART : null,
  ].filter(Boolean).join("\n");
}
