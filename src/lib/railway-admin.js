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
 * or an error (every text that leaves is scrubbed of it and of the token). Variable values are never shown:
 * list_variables asks Railway for names only. The one read of values is a write in Tarsee's own project, which asks
 * for Tarsee's own variables with their references left in (`unrendered`), keeps only the names inside `${{ ... }}`
 * and drops the rest (see feedersOfOwnSettings).
 *
 * Nothing here deletes: no variable, service, environment or project is ever removed, and variables are never replaced
 * wholesale (no `replace`).
 *
 * Limits, whoever approved_by names (what the AI asks for can come from a web page or a message it read, and the AI's
 * commands can read the variables of Tarsee's own service once it has been deployed with them):
 *   - a value with a Railway reference in it (`${{ ... }}`, filled in by Railway from another variable when the service
 *     deploys) is refused on every service, so no shared secret or other service's secret is pulled in;
 *   - Tarsee's own keys (SERVER_ONLY_KEYS: its Railway token, its sign-in and encryption secrets) are never copied
 *     into a service, by from_key, under another vault name, or typed in as value;
 *   - on Tarsee's own service (any environment of it) only an allowlist is set (selfServiceRefusal): a key or address
 *     for the owner's own scripts, TZ, and a few of Tarsee's tuning settings. Every other name is refused, so nothing
 *     that changes how Railway builds or runs Tarsee, how programs or shells start, where files are, who can sign in,
 *     or which AI and keys Tarsee uses is ever set there. Nor is any name that appears in the shipped code of Tarsee's
 *     AI engines or its browser library (engine-env-names.json, kept up to date by test/railway-tool-limits.test.js),
 *     since an engine may read it. With a deploy or without, so nothing is left for the next redeploy to apply. Each
 *     refusal says where the owner makes that change instead (Railway's dashboard);
 *   - a variable that any variable on Tarsee's own service is filled in from by a Railway reference the owner made (on
 *     another service, on Tarsee's own, through a shared variable, through a chain of them) counts as that variable:
 *     at Tarsee's next deploy, whoever starts it, a write to it is a write to Tarsee's own service under the
 *     referencing name. So the rules above, and the get_key one below, apply to that name too (feedersOfOwnService). A
 *     sealed variable can't be read, so while a guarded one (or a link on the way to it) is sealed, nothing is set in
 *     that environment of Tarsee's project, and while any is, no vault key either if get_key is denied. So a redeploy
 *     of Tarsee only ever applies changes the owner made;
 *   - while the owner has denied get_key in Tool Permissions, no vault key goes onto Tarsee's own service (from_key),
 *     nor into a variable it is filled in from: after the next deploy the AI's commands could read it there.
 * These hold whichever OS user the AI's commands run as: a variable on Tarsee's own service reaches the server itself.
 *
 * Every call returns a plain-English string (never throws) and logs one line: the action, the project, the
 * environment, the service, never a value or a token.
 */
import fs from "node:fs";
import { AUTH_ENV_RE, PROVIDER_KEY_NAMES, TARSEE_SECRETS } from "../ai/engine-env.js";

export const ACTIONS = Object.freeze(["list_projects", "list_variables", "set_variable", "redeploy"]);
const WRITES = new Set(["set_variable", "redeploy"]);

export const API_URL = "https://backboard.railway.com/graphql/v2";
const TIMEOUT_MS = 12_000;   // per call; a set_variable is up to four of them

/** Where the token is looked for, first found wins: the vault key, then the environment variable of the same name. */
export const TOKEN_KEY = "RAILWAY_API_TOKEN";
const LABEL = "the owner's Railway account";

/**
 * Vault keys Tarsee keeps for itself, never copied into a service: its own Railway token (with it a service could read
 * and change every variable this account reaches, Tarsee's own included), and its sign-in and encryption secrets, in
 * case one was saved in the vault too.
 */
export const SERVER_ONLY_KEYS = Object.freeze([TOKEN_KEY, ...TARSEE_SECRETS, "TARSEE_MCP_TOKEN"]);

/** Railway's reference syntax: `${{ NAME }}`, `${{ shared.NAME }}`, `${{ Service.NAME }}`. */
const REFERENCE = "${{";
const REFERENCE_REFUSAL = "a Railway reference (${{ ... }}). Railway fills one in from another variable when the service deploys, and that can be a shared secret or another service's secret, so this tool never sets one. A reference is for the owner to add by hand, in Railway's dashboard (the service's Variables tab).";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

// The only documents this tool ever sends. None deletes; the upsert never passes `replace`.
export const DOCS = Object.freeze({
  projects: "query TarseeProjects { projects(first: 500) { edges { node { id name deletedAt } } } }",
  project: "query TarseeProject($id: String!) { project(id: $id) { id name deletedAt environments { edges { node { id name deletedAt } } } services { edges { node { id name } } } } }",
  variableNames: "query TarseeVariableNames($projectId: String!, $environmentId: String!) { environment(id: $environmentId, projectId: $projectId) { variables(first: 10000) { edges { node { name serviceId isSealed } } } } }",
  // A service's variables as { NAME: value } with `${{ ... }}` left in; serviceId left out (not null) gives the
  // environment's shared ones, as Railway's Manage Variables guide shows. Only ever for Tarsee's own project, and only
  // the references are kept (feedersOfOwnSettings).
  unrendered: "query TarseeUnrenderedVariables($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true) }",
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
 * @param {Function} [deps.getKeyDenied] true when the owner has denied get_key in Settings > Tool Permissions
 *   (defaults to lib/security-manager.js, the same check agent-env.js makes)
 * @returns {Promise<string>}
 */
export async function railwayAdmin(args = {}, { vault = null, env = process.env, fetch: fetchImpl = globalThis.fetch, log = (line) => console.log(line), timeoutMs = TIMEOUT_MS, getKeyDenied = getKeyDeniedByPolicy } = {}) {
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
    // Both copies of the token count as Tarsee's own: the one in use, and the environment's when the vault's wins.
    const ownTokens = [...new Set([token, String(env?.[TOKEN_KEY] ?? "").trim()])].filter((t) => t.length >= 16);
    note.secrets.push(token, ...ownTokens);
    const api = (doc, variables) => gql(doc, variables, { token, fetchImpl, timeoutMs });
    const ctx = { args, v, api, note, ownTokens, here: hereOf(env), getKeyDenied };
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

/** Whether the owner has set get_key to "always deny" in Settings > Tool Permissions (server.js loads those at boot). */
async function getKeyDeniedByPolicy() {
  const { getSecurityManager } = await import("./security-manager.js");
  return getSecurityManager().getToolPermission("get_key") === "always_deny";
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
/** Tarsee's own service in any environment of its project: what selfServiceRefusal() guards. */
const isOwnService = (svc, here) => !!here.serviceId && String(svc.id).toLowerCase() === here.serviceId.toLowerCase();
const SELF_RESTART = "This is Tarsee's own service: the deploy restarts Tarsee, which ends the turn that asked for it. Tarsee is back once Railway has deployed it (usually a minute or two).";

// ---------------------------------------------------------------- what may be set on Tarsee's own service

/*
 * The rule, in plain words: on Tarsee's own service this tool sets only names that are clearly a key or address for the
 * owner's own scripts, TZ, and a few of Tarsee's settings that only tune it. Everything else is the owner's to set by
 * hand in Railway's dashboard, because a variable there reaches Railway's build of Tarsee, its start-up script (run as
 * root), the server, its AI engines and every program they start: it could change how Tarsee is built or runs, how
 * programs or shells start, where files are, who can sign in, or which AI and keys Tarsee uses. That holds today, when
 * the AI's commands run as the server's user, and once they run as a user of their own (agent isolation), since the
 * server and the start-up script still read every variable.
 *
 * selfServiceRefusal() checks in this order:
 *   1. SELF_SERVICE_SETTINGS (TZ and the tuning settings): set, TZ only with a time zone name for its value;
 *   2. the families and names below (sign-in, the AI, Tarsee's own keys, the build, the programs and shells, the
 *      browser, what Tarsee and its engines read): refused, saying why. These come first because some look like a key
 *      of the owner's (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, SELENIUM_REMOTE_URL, GOOGLE_API_KEY);
 *   3. SCRIPT_KEY: set, unless the name appears in the AI engines' or the browser library's code (inEngineCode);
 *   4. anything else: refused, with the rule.
 * test/railway-tool-limits.test.js scans Tarsee's code, its start-up script and its Dockerfile for every variable they
 * read, re-extracts the engines' names from node_modules, and fails, naming it, when one would get through.
 */

/** Tarsee's own settings this tool may set on its service: tuning only, none of them switches a protection off. */
const SELF_TUNING = [
  "TARSEE_TIMEZONE", "TARSEE_DEFAULT_EFFORT", "TARSEE_COMPACT_WINDOW", "TARSEE_MODEL_CONTEXT_TOKENS",
  "TARSEE_TOOL_RESULT_MAX_CHARS", "TARSEE_BASH_OUTPUT_MAX_CHARS", "TARSEE_SESSION_JSONL_MAX_MB", "TARSEE_PHONON_THREADS",
];
/** The settings this tool may set on Tarsee's own service besides the owner's keys: TZ and the tuning ones. */
export const SELF_SERVICE_SETTINGS = Object.freeze(["TZ", ...SELF_TUNING]);
const SETTINGS = new Set(SELF_SERVICE_SETTINGS);
/** TZ's value: a time zone name (Asia/Manila, UTC, Etc/GMT-8), never a path (glibc reads a time zone file from one). */
const TZ_VALUE = /^(?!.*\.\.)[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
/**
 * A key or address for the owner's own scripts: capitals, digits and underscores, the last word saying what it holds
 * (SOME_SERVICE_API_KEY, ALERTS_WEBHOOK, STATUS_PAGE_URL). Only once no part of Tarsee is found to read the name.
 */
const SCRIPT_KEY_ENDINGS = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_WEBHOOK", "_URL"];
const SCRIPT_KEY = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|WEBHOOK|URL)$/;

/** Who can sign in to Tarsee, for how long, and the key its saved secrets are locked with. */
const SIGN_IN = new Set([...TARSEE_SECRETS, "TARSEE_MCP_TOKEN", "TARSEE_SESSION_MAX_AGE_DAYS", "TARSEE_CSRF_MAX_AGE_HOURS"]);
/** Which AI answers, with what key or sign-in, and where its turns are sent. AUTH_ENV_RE adds every engine login. */
const AI_CHOICE = new Set([...PROVIDER_KEY_NAMES, "TARSEE_KEYS_ONLY", "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_LOCAL_AI_URL"]);
const AI_PREFIX = /^(ANTHROPIC|OPENAI|OPENROUTER|DEEPSEEK|CODEX)_/;
/** Other keys Tarsee itself reads from its environment; each has a place in Settings. */
const OWN_KEYS = new Set(["ELEVENLABS_API_KEY", "CAPTCHA_API_KEY"]);
/**
 * How Railway builds and runs the service: Railway's own settings (the user it runs as, the Dockerfile it builds) and
 * its builders', and BuildKit's and Docker's, since every service variable reaches the build: BUILDKIT_SYNTAX alone
 * hands the whole build to an image of its choosing.
 */
const BUILD = /^(RAILWAY|NIXPACKS|RAILPACK|BUILDKIT|BUILDX|DOCKER|COMPOSE)_|^SOURCE_DATE_EPOCH$/;
/**
 * What changes which programs run and how, and where files and connections are:
 *   - where programs and files are looked for, and who a shell thinks it is;
 *   - how a shell starts: bash's start-up files and options, its prompts (PS0 to PS4 run the $(...) in them), readline's
 *     keys, its history, the locale, the resolver's files, the terminal database, the pager (the Terminal starts bash
 *     with Tarsee's own environment);
 *   - the loader, the runtimes and package managers and where they download from (Node, npm, Python, pip, uv, Hugging
 *     Face and the rest);
 *   - git, ssh (git falls back on SSH_ASKPASS for a password), TLS trust, proxies, telemetry, gRPC;
 *   - the AI engines' own settings (CLAUDE_), and any folder, home, path, program, file or options a variable names.
 */
const RUNTIME = new RegExp([
  "^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|CDPATH|PORT|TMPDIR|TEMP|TMP|EDITOR|VISUAL|PAGER|MANPAGER|MANPATH|BROWSER|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$",
  "^(ENV|BASH_ENV|ZDOTDIR|IFS|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|GLOBIGNORE|PS[0-4]|INPUTRC|TERM|TERMINFO|TERMINFO_DIRS|TERMCAP|LANG|LANGUAGE|LOCPATH|NLSPATH|HOSTALIASES|LOCALDOMAIN|RES_OPTIONS|MAIL|MAILPATH|MAILCHECK)$",
  "^(HIST|LC_|LESS|BASH_)",
  "^(NODE_|NPM_|YARN_|PNPM_|BUN_|DENO_|COREPACK_|LD_|DYLD_|GLIBC_|MALLOC_|PYTHON|PIP_|UV_|CONDA_|POETRY_|PIPENV_|VIRTUAL_ENV|PERL|RUBY|GEM_|BUNDLE_|JAVA_|_JAVA_|JDK_|CARGO_|RUSTUP_|RUST_|HF_|HUGGINGFACE_|HUGGING_FACE_|TRANSFORMERS_|TORCH_)",
  "^(GIT_|SSH_|SSL_|OPENSSL_|GNUTLS_|CURL_|GRPC_|OTEL_|DOTENV_)",
  "_PROXY$",
  "^CLAUDE_",
  "_(DIR|HOME|PATH|BIN|FILE|CONF|CONFIG|OPTIONS|OPTS|PRELOAD)$",
].join("|"));
/**
 * The browser Tarsee drives and its desktop: Playwright's, Puppeteer's and Selenium's settings, Chrome's and Chromium's,
 * the keys Chromium reads for Google's services (GOOGLE_API_KEY and its GOOGLE_API_KEY_<service> forms,
 * GOOGLE_DEFAULT_CLIENT_ID and _SECRET, GOOGLE_CLIENT_ID_<client> and GOOGLE_CLIENT_SECRET_<client>, and
 * GOOGLE_METRICS_SIGNING_KEY: the names of that kind in Playwright's Chromium), fonts, the display and its session bus.
 * Chromium itself is downloaded when the image is built, outside node_modules, so it isn't in engine-env-names.json.
 */
const BROWSER = /^(PLAYWRIGHT_|PUPPETEER_|SELENIUM_|CHROME|CHROMIUM|GOOGLE_API_KEY|GOOGLE_DEFAULT_CLIENT_|GOOGLE_CLIENT_ID_|GOOGLE_CLIENT_SECRET_|GOOGLE_METRICS_SIGNING_KEY$|FONTCONFIG_|DBUS_|GTK_|GDK_|QT_|XDG_|DISPLAY$|WAYLAND_DISPLAY$|XAUTHORITY$)/;
/**
 * Names that look like a key for the owner's scripts but that Tarsee, its AI engines (Claude Code, Codex) or a library
 * it runs read themselves: the GitHub sign-in the engines and gh use, the cloud logins Claude Code can bill through
 * (AWS for Bedrock, Azure for Foundry) and GitHub's sign-in for a workflow, MCP's and the cloud runners' secrets, web
 * push's identity, the chat bots' tokens, and the hosts the Agent SDK, Playwright and the chat libraries send to.
 */
const READ_BY_TARSEE_PREFIX = /^(GH|GITHUB|ACTIONS|AWS|AZURE|MCP|SELF_HOSTED_RUNNER|CCR|VAPID|CI)_/;
const READ_BY_TARSEE = new Set([
  "APP_URL", "SESSION_INGRESS_URL", "BUILD_URL", "JENKINS_URL", "GCM_API_KEY", "ETHEREAL_API_KEY",
  "DISCORD_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "TELEGRAM_BOT_TOKEN",
]);

/*
 * The names in the AI engines' and the browser library's code. Claude Code reads most of its settings through typed
 * lists of names (each read as process.env[name]), much of its CLI is bytecode, and Codex is a compiled program, so no
 * search for process.env.NAME finds everything they read (VOICE_STREAM_BASE_URL, where voice mode sends the claude.ai
 * sign-in, is one such). So the rule is blunter: a name that appears as a string anywhere in their shipped code is never
 * set on Tarsee's own service. engine-env-names.json keeps the ones the allowlist would otherwise let through (every
 * other name it refuses anyway), extracted from the Claude Agent SDK and its CLI, the Codex SDK and Codex's programs,
 * and Playwright, for every platform. test/railway-tool-limits.test.js re-extracts them from node_modules and fails,
 * naming them, when an engine update brings one the list lacks.
 *
 * Read once, when this module loads (the server starts it before any AI turn). A list that can't be read refuses every
 * key-shaped name on Tarsee's own service, since none can be shown not to be an engine's.
 */
const ENGINE_NAMES_FILE = new URL("./engine-env-names.json", import.meta.url);

/** The list's text as { names: Set, runs: [] }; throws when it isn't one. */
export function parseEngineNames(text) {
  const data = JSON.parse(text);
  const strings = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (!strings(data?.names) || !data.names.length || !strings(data?.runs)) throw new Error("it has no list of names and runs");
  return { names: new Set(data.names), runs: data.runs };
}

let shippedEngineNames;
try {
  shippedEngineNames = parseEngineNames(fs.readFileSync(ENGINE_NAMES_FILE, "utf8"));
} catch (err) {
  shippedEngineNames = err instanceof Error ? err : new Error(String(err));
}

/**
 * Whether the run `run` holds `name`. A native program can keep its strings one after another with nothing between
 * them (GH_TOKENGITHUB_TOKEN), so a name counts where it starts at the run's start or after any character but an
 * underscore, and ends at the run's end or before any character but an underscore.
 */
export function heldInRun(run, name) {
  if (!name) return false;
  for (let i = run.indexOf(name); i !== -1; i = run.indexOf(name, i + 1)) {
    const end = i + name.length;
    if ((i === 0 || run[i - 1] !== "_") && (end === run.length || run[end] !== "_")) return true;
  }
  return false;
}

/** Whether `name` appears in the AI engines' or the browser library's code. Throws when the list couldn't be read. */
export function inEngineCode(name, list = shippedEngineNames) {
  if (list instanceof Error) throw list;
  return list.names.has(name) || list.runs.some((run) => heldInRun(run, name));
}

const IN_RAILWAY = "Only the owner changes it, by hand in Railway's dashboard (Tarsee's service > Variables).";
const OWN = "so this tool never sets it on Tarsee's own service.";
const THE_RULE = `On Tarsee's own service this tool sets only: a key or address for the owner's own scripts, named in capitals and ending in ${SCRIPT_KEY_ENDINGS.slice(0, -1).join(", ")} or ${SCRIPT_KEY_ENDINGS.at(-1)} (for example SOME_SERVICE_API_KEY or ALERTS_WEBHOOK), when no part of Tarsee reads that name itself and it appears nowhere in the code of its AI engines or browser library; TZ, with a time zone name; and Tarsee's tuning settings ${SELF_TUNING.join(", ")}.`;

/**
 * Why `name` is not set on Tarsee's own service, in plain words with where the owner changes it instead; null when it
 * may be. The refused families are matched in any case (npm reads npm_config_* in any case); the allowlist only as
 * written. `value`, when given, is checked too (TZ takes a time zone name only). `engineNames` is the list of names in
 * the engines' code (the shipped one, or an Error when it couldn't be read).
 */
export function selfServiceRefusal(rawName, value, { engineNames = shippedEngineNames } = {}) {
  const name = String(rawName ?? "").trim();
  const upper = name.toUpperCase();
  if (SETTINGS.has(name)) {
    if (name === "TZ" && value !== undefined && !TZ_VALUE.test(String(value).trim())) {
      return `TZ on Tarsee's own service takes a time zone name such as Asia/Manila, UTC or Etc/GMT-8, never a path to a file: with one, every program Tarsee runs would read its time zone from that file. ${IN_RAILWAY}`;
    }
    return null;
  }
  if (SIGN_IN.has(upper)) {
    return `${name} is part of how Tarsee signs people in or locks its saved keys, ${OWN} ${IN_RAILWAY}`;
  }
  if (AI_CHOICE.has(upper) || AUTH_ENV_RE.test(upper) || AI_PREFIX.test(upper)) {
    return `${name} chooses which AI answers, the key or sign-in it uses, or where its chats are sent, ${OWN} AI keys and the choice of AI belong in Settings > AI; the owner can also change the variable by hand in Railway's dashboard.`;
  }
  if (OWN_KEYS.has(upper)) {
    return `${name} is a key Tarsee itself uses, ${OWN} It belongs in Tarsee's Settings (the voice and captcha keys are saved there); the owner can also set it by hand in Railway's dashboard.`;
  }
  if (BUILD.test(upper)) {
    return `${name} is one of the settings for how Railway builds and runs Tarsee (every variable reaches its build), ${OWN} ${IN_RAILWAY}`;
  }
  if (RUNTIME.test(upper)) {
    return `${name} changes how programs and shells start, which programs Tarsee runs, where its files are, or where its connections go, ${OWN} ${IN_RAILWAY}`;
  }
  if (BROWSER.test(upper)) {
    return `${name} is read by the browser Tarsee drives (Chromium, through Playwright) or by its desktop: it can change which browser runs and how, what it loads, where it connects, or which keys its Google services use, ${OWN} ${IN_RAILWAY}`;
  }
  if (READ_BY_TARSEE.has(upper) || READ_BY_TARSEE_PREFIX.test(upper)) {
    return `${name} is read by Tarsee itself, its AI engines or a program it runs, and setting it would change how Tarsee works, ${OWN} A key for the owner's own scripts needs a name of its own. ${IN_RAILWAY}`;
  }
  if (upper.startsWith("TARSEE_")) {
    return `${name} is one of Tarsee's own settings, and those can switch off a protection or change how Tarsee runs, ${OWN} ${THE_RULE} ${IN_RAILWAY}`;
  }
  if (SCRIPT_KEY.test(name)) {
    let found;
    try {
      found = inEngineCode(name, engineNames);
    } catch (err) {
      return `Tarsee could not read the list of names in its AI engines' code (src/lib/engine-env-names.json: ${err.message}). Without it, it can't tell whether an engine reads ${name}, so this tool sets no such name on Tarsee's own service. ${IN_RAILWAY}`;
    }
    if (found) {
      return `${name} appears in the code of Tarsee's AI engines or its browser library (the Claude Agent SDK and Claude Code, Codex, Playwright), which may read it from the environment and change how they work, ${OWN} A key for the owner's own scripts needs a name of its own. ${IN_RAILWAY}`;
    }
    return null;
  }
  return `${name || "That name"} is not one of the names this tool sets on Tarsee's own service. ${THE_RULE} Any other name could change how Tarsee is built, starts or runs. ${IN_RAILWAY}`;
}

/**
 * Why a variable that `own` on Tarsee's own service is filled in from by a Railway reference is never set, or null: the
 * reason `own` itself is never set there, since at Tarsee's next deploy a change to the one is a change to the other.
 * TZ too, which the tool sets only with a time zone name: through a reference it can't check the value TZ would get.
 */
function refusalThroughReference(own) {
  if (String(own).trim() === "TZ") {
    return `TZ on Tarsee's own service takes a time zone name only, and through a reference this tool can't check the value TZ would get. ${IN_RAILWAY}`;
  }
  return selfServiceRefusal(own);
}

/** Why the vault key `keyName` is never copied into a service, or null. */
function serverOnlyRefusal(keyName) {
  const upper = String(keyName ?? "").trim().toUpperCase();
  if (!SERVER_ONLY_KEYS.includes(upper)) return null;
  if (upper === TOKEN_KEY) {
    return `${TOKEN_KEY} is the token Tarsee itself uses to reach Railway: with it a service could read and change every variable this account reaches, Tarsee's own included, so this tool never copies it into a service. If a service needs a Railway token, the owner makes one in Railway (Account Settings > Tokens) and sets it on that service by hand.`;
  }
  return `${upper} is one of Tarsee's own secrets (how it signs people in or locks its saved keys), so this tool never copies it into a service. If another service really needs it, the owner sets it there by hand in Railway's dashboard.`;
}

/** True when `value` has one of Tarsee's own Railway tokens in it. */
const holdsOwnToken = (value, ownTokens) => ownTokens.some((t) => value.includes(t));
const TOKEN_ELSEWHERE = "Tarsee's own Railway token, and this tool never copies it into a service. If a service needs a Railway token, the owner makes one in Railway (Account Settings > Tokens) and sets it on that service by hand.";

// ---------------------------------------------------------------- what Tarsee's own variables are filled in from

const SHARED = "shared";
/** A service id (or SHARED) and a variable name, as one key: ids and names in any case. */
const slot = (key, name) => `${String(key).toLowerCase()}\0${String(name).toUpperCase()}`;
/** How many variables feedersOfOwnService() looks at before it gives up (and the write with it). */
const MAX_REFERENCE_STEPS = 10_000;

/**
 * The references in a value: `${{ NAME }}` (the same service's), `${{ shared.NAME }}`, `${{ Service.NAME }}` (a
 * service name can hold dots; a variable name can't). [{ service: name or null, variable }].
 */
function referencesIn(value) {
  const out = [];
  for (const m of String(value ?? "").matchAll(/\$\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const dot = m[1].lastIndexOf(".");
    const variable = m[1].slice(dot + 1).trim();
    if (variable) out.push({ service: dot < 0 ? null : m[1].slice(0, dot).trim(), variable });
  }
  return out;
}

/**
 * In `env` of Tarsee's own project: what every variable on Tarsee's own service (any name, not only the guarded ones)
 * is filled in from by Railway references, followed through the variables they point at, on any service (Tarsee's own
 * included) or a shared one, to the end of each chain. At Tarsee's next deploy a change to one of those is a change to
 * the variable of Tarsee's it fills. `names` is the environment's variables (variableNames: name, service, sealed or
 * not).
 *
 * Returns { fed, blind }. fed: a Map of slot(service id or SHARED, NAME) to the Set of names on Tarsee's own service it
 * fills. blind: the sealed variables met ({ own, name, key, direct }, `own` itself included, direct when it is the
 * sealed one): Railway never gives a sealed variable's value back, so a reference in one can't be followed, and `own`
 * could be filled in from any variable in the environment.
 *
 * Values are read only to find their `${{ ... }}`: each is dropped as soon as its references are taken, and none is
 * kept, shown or logged. Fails (and with it the write) when Railway can't answer.
 */
async function feedersOfOwnService({ api, here }, project, env, names) {
  const idsByName = new Map();
  for (const s of project.services) {
    const n = String(s.name).trim().toLowerCase();
    idsByName.set(n, [...(idsByName.get(n) || []), s.id]);
  }
  const sealed = new Set(names.filter((x) => x.sealed).map((x) => slot(x.serviceId || SHARED, x.name)));
  const loaded = new Map();   // service id or SHARED -> Map(NAME -> { name, refs })
  const load = async (key) => {
    const k = String(key).toLowerCase();
    if (!loaded.has(k)) {
      // Railway's Manage Variables guide: leave serviceId out for the environment's shared variables.
      const vars = { projectId: project.id, environmentId: env.id, ...(key === SHARED ? {} : { serviceId: key }) };
      const data = await api(DOCS.unrendered, vars);
      const got = data?.variables && typeof data.variables === "object" ? data.variables : {};
      loaded.set(k, new Map(Object.entries(got).map(([name, value]) => [name.toUpperCase(), { name, refs: referencesIn(value) }])));
    }
    return loaded.get(k);
  };

  const self = String(here.serviceId).toLowerCase();
  const own = [...new Set(names.filter((x) => String(x.serviceId || "").toLowerCase() === self).map((x) => x.name))];
  const fed = new Map();
  const blind = [];
  let steps = 0;
  for (const root of own) {
    const queue = [{ key: here.serviceId, name: root }];
    const seen = new Set();
    while (queue.length) {
      // Not followed to the end: as unknown as a sealed one.
      if (++steps > MAX_REFERENCE_STEPS) {
        fail(`Tarsee's own variables in ${env.name} reference other variables too many times over to follow (over ${MAX_REFERENCE_STEPS} steps), so this tool can't tell what they are filled in from, and sets nothing there. The owner makes the change by hand in Railway's dashboard (the service's Variables tab).`);
      }
      const { key, name } = queue.shift();
      const at = slot(key, name);
      if (seen.has(at)) continue;
      seen.add(at);
      if (sealed.has(at)) {
        blind.push({ own: root, name, key, direct: at === slot(here.serviceId, root) });
        continue;
      }
      for (const ref of (await load(key)).get(String(name).toUpperCase())?.refs || []) {
        const to = ref.service == null ? [key] : ref.service.toLowerCase() === SHARED ? [SHARED] : idsByName.get(ref.service.toLowerCase()) || [];
        for (const target of to) {
          const into = slot(target, ref.variable);
          if (!fed.has(into)) fed.set(into, new Set());
          fed.get(into).add(root);
          queue.push({ key: target, name: ref.variable });
        }
      }
    }
  }
  return { fed, blind };
}

/** "Tarsee's own X is sealed", or "Tarsee's own X is filled in from Y on Z, which is sealed", and how many more. */
function sealedWhat(blind, project) {
  const label = (key) => (key === SHARED ? "the shared variables" : project.services.find((s) => String(s.id).toLowerCase() === String(key).toLowerCase())?.name || key);
  const first = blind[0];
  const what = first.direct ? `Tarsee's own ${first.own} is sealed` : `Tarsee's own ${first.own} is filled in from ${first.name} on ${label(first.key)}, which is sealed`;
  const more = blind.length > 1 ? ` (${blind.length - 1} more sealed: ${blind.slice(1, 4).map((b) => b.name).join(", ")}${blind.length > 4 ? ", ..." : ""})` : "";
  return `${what}${more}`;
}

/** Why nothing is set in this environment of Tarsee's project while a sealed variable hides what a guarded one of Tarsee's is filled in from. */
function sealedRefusal(blind, project, env) {
  const first = blind[0];
  return `${sealedWhat(blind, project)}, so Railway never shows its value and this tool can't see whether it is filled in from another variable by a Railway reference (\${{ ... }}). Any variable in ${env.name} of the project "${project.name}" could be that one, and changing it would change ${first.own} at Tarsee's next deploy, so while it is sealed this tool sets nothing there. Only the owner makes this change, by hand in Railway's dashboard (the service's Variables tab). Other environments and other projects are not affected.`;
}

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
  const { args, v, api, note, here, ownTokens } = ctx;
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
    note.extra.push(`from_key=${keyName}`);
    const serverOnly = serverOnlyRefusal(keyName);
    if (serverOnly) fail(serverOnly);
    let raw = null;
    try { raw = v.getKey(keyName) ?? (keyName !== keyName.toUpperCase() ? v.getKey(keyName.toUpperCase()) : null); } catch (err) { fail(`The vault key ${keyName} could not be read (${err.message}).`); }
    if (raw == null) fail(`The vault has no key named ${keyName}. tarsee_list_keys lists the names.`);
    value = String(raw);
    if (!value) fail(`The vault key ${keyName} is empty, so there is nothing to set.`);
    note.secrets.push(value);
    if (holdsOwnToken(value, ownTokens)) fail(`The vault key ${keyName} holds ${TOKEN_ELSEWHERE}`);
    if (value.includes(REFERENCE)) fail(`The vault key ${keyName} holds ${REFERENCE_REFUSAL}`);
    shown = `from the vault key ${keyName} (masked: ${maskValue(value)}). The value was not shown anywhere.`;
  } else {
    value = String(args.value);
    if (holdsOwnToken(value, ownTokens)) fail(`That value holds ${TOKEN_ELSEWHERE}`);
    if (value.includes(REFERENCE)) fail(`That value holds ${REFERENCE_REFUSAL}`);
    const inVault = vaultKeyHolding(v, value);
    if (inVault) fail(serverOnlyRefusal(inVault) || `That value is the vault key ${inVault}. Pass from_key: "${inVault}" instead, so the value never goes through a chat or a command.`);
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
  const onOwn = isOwnService(svc, here);
  // With deploy: false too: a refused name left waiting on Tarsee's service would be applied by the next redeploy.
  if (onOwn) {
    const why = selfServiceRefusal(name, value);
    if (why) fail(why);
    if (hasKey) await refuseWhileGetKeyDenied(ctx, GET_KEY_ON_OWN);
  }
  // A variable one of Tarsee's own is filled in from counts as that one: at Tarsee's next deploy the change reaches it,
  // under its name. So the same rules apply, under that name. And while a sealed variable hides what one of Tarsee's is
  // filled in from: nothing in this environment if that one is guarded, and no vault key while get_key is denied.
  let names = null;
  if (project.isHere && here.serviceId) {
    names = await variableNames(ctx, project, env);
    const { fed, blind } = await feedersOfOwnService(ctx, project, env, names);
    const fills = [...(fed.get(slot(svc.id, name)) || [])].filter((own) => !(onOwn && own.toUpperCase() === name.toUpperCase()));
    for (const own of fills) {
      const why = refusalThroughReference(own);
      if (why) fail(`Tarsee's own ${own} is filled in from ${name} on ${svc.name} by a Railway reference (\${{ ... }}), so setting ${name} would set ${own} on Tarsee's own service at its next deploy. ${why}`);
    }
    const guarded = blind.filter((b) => refusalThroughReference(b.own));
    if (guarded.length) fail(sealedRefusal(guarded, project, env));
    if (hasKey && fills.length) await refuseWhileGetKeyDenied(ctx, getKeyThroughReference(fills[0], name, svc));
    if (hasKey && blind.length) await refuseWhileGetKeyDenied(ctx, getKeyWhileSealed(blind, project, env));
  }
  const before = (names || await variableNames(ctx, project, env)).find((x) => x.serviceId === svc.id && x.name === name);

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

/**
 * from_key where it would reach Tarsee's own service while the owner has denied get_key: that denial keeps the vault's
 * keys out of the AI's reach (none goes into its commands' environment, agent-env.js), and a key set on Tarsee's own
 * service, or into a variable one of its variables is filled in from, would reach them at the next deploy. Refused with
 * `deniedText` when denied, and refused too when Tarsee can't tell.
 */
async function refuseWhileGetKeyDenied({ getKeyDenied }, deniedText) {
  let denied;
  try {
    denied = !!(await getKeyDenied());
  } catch (err) {
    fail(`Tarsee could not tell whether get_key is denied in Settings > Tool Permissions (${err?.message || err}), so no vault key goes where it would reach Tarsee's own service: once deployed there, the AI's commands could read it. The owner can set it by hand in Railway's dashboard (the service's Variables tab).`);
  }
  if (denied) fail(deniedText);
}

const GET_KEY_DENIED = "get_key is denied in Settings > Tool Permissions, which keeps the vault's keys out of the AI's reach";
const GET_KEY_STILL = "a plain value, and from_key onto a variable nothing of Tarsee's is filled in from, still work";
const GET_KEY_ON_OWN = `${GET_KEY_DENIED}, and a vault key set on Tarsee's own service would reach the AI's commands at the next deploy. So while it is denied, from_key onto Tarsee's own service is refused. The owner can set it by hand in Railway's dashboard (Tarsee's service > Variables); ${GET_KEY_STILL}.`;

/** Why from_key into a variable `own` on Tarsee's own service is filled in from is refused while get_key is denied. */
function getKeyThroughReference(own, name, svc) {
  return `${GET_KEY_DENIED}. Tarsee's own ${own} is filled in from ${name} on ${svc.name} by a Railway reference (\${{ ... }}), so a vault key set there would reach Tarsee's own service as ${own} at its next deploy, and the AI's commands with it. So while get_key is denied, from_key into a variable Tarsee's own service is filled in from is refused. The owner can set it by hand in Railway's dashboard (the service's Variables tab); ${GET_KEY_STILL}.`;
}

/** Why from_key anywhere in this environment of Tarsee's project is refused while get_key is denied and a sealed variable hides a reference. */
function getKeyWhileSealed(blind, project, env) {
  return `${GET_KEY_DENIED}, and ${sealedWhat(blind, project)}: Railway never shows its value, so this tool can't see whether it is filled in from this variable by a Railway reference (\${{ ... }}), and a vault key set here could reach Tarsee's own service at its next deploy. So while get_key is denied, from_key anywhere in ${env.name} of the project "${project.name}" is refused. The owner can set it by hand in Railway's dashboard (the service's Variables tab); plain values, other environments and other projects still work.`;
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
