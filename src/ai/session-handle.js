/**
 * session-handle.js: the grammar of the session handle a chat stores (conversations.claude_session_id, and the
 * subagent and ACP stores), design 4.10.
 *
 *   Claude plan          the bare raw id, as every existing row already holds (no rewrite, rollback-safe)
 *   every other provider <provider>/<homeKey>/<vendor>:<rawId>
 *     homeKey  cc (Claude Code, the provider's own home), cx (.codex-home-keys) or cxd (.codex-home, the ChatGPT sign-in)
 *     vendor   the model's maker on OpenRouter (the slug's prefix without ~), otherwise the provider id
 *   e.g. deepseek/cc/deepseek:3f2a…, openrouter/cc/anthropic:…, openrouter/cx/openai:…
 *
 * A session resumes only on the same provider, in the same engine home, with the same maker; anything else starts
 * fresh (and the turn layer carries the conversation over with a handoff). Readers that look up transcripts or sizes
 * by id use untag() first. Pure: no I/O.
 */
import { homeKeyFor } from "./engine-env.js";
import { vendorFor } from "./provider-registry.js";

/** The maker a session is tied to (OpenRouter's slug prefix without ~, otherwise the provider): the registry's rule. */
export { vendorFor };

const PLAN_IDS = new Set(["claude", "claude-code"]);
const isPlan = (id) => PLAN_IDS.has(String(id ?? "").toLowerCase());
const canonicalId = (id) => (isPlan(id) ? "claude" : String(id ?? "").toLowerCase());

const ENGINE_OF_HOME = { cc: "claude-code", cx: "codex", cxd: "codex" };
const TAGGED = /^([a-z0-9][a-z0-9-]*)\/(cc|cx|cxd)\/([a-z0-9][a-z0-9._-]*):(\S+)$/;
const BARE = /^[^\s/]+$/;

/** An explicit vendor on a target, cleaned to what a handle can carry. */
const cleanVendor = (s) => String(s ?? "").trim().toLowerCase().replace(/^~/, "").replace(/[^a-z0-9._-]/g, "");

/** The target's home key and vendor: its own when given, else from its engine and model. */
function placeOf(target) {
  if (!target || !target.provider) return null;
  const provider = canonicalId(target.provider);
  const homeKey = target.homeKey || homeKeyFor(provider, target.engine);
  if (!homeKey || !ENGINE_OF_HOME[homeKey]) return null;
  const vendor = target.vendor ? cleanVendor(target.vendor) : vendorFor(provider, target.model);
  return vendor ? { provider, homeKey, vendor } : null;
}

/**
 * The handle to store for a raw session id on a target {provider, engine, model} (or with homeKey and vendor already
 * worked out). null when there is no raw id. Throws when the target can't be placed, or when the handle wouldn't parse
 * back to the same raw id (a space in it, or a slash in a bare one), so a session is never stored under a handle
 * nothing would resume.
 */
export function format(target, rawId) {
  const raw = String(rawId ?? "").trim();
  if (!raw) return null;
  let handle;
  if (isPlan(target?.provider)) handle = raw;
  else {
    const place = placeOf(target);
    if (!place) throw new Error(`session-handle: can't place a session for ${JSON.stringify(target?.provider)} on ${JSON.stringify(target?.engine)}`);
    handle = `${place.provider}/${place.homeKey}/${place.vendor}:${raw}`;
  }
  if (parse(handle)?.rawId !== raw) throw new Error(`session-handle: a raw session id of that shape can't be stored (${JSON.stringify(raw.slice(0, 40))})`);
  return handle;
}

/**
 * {provider, engine, homeKey, vendor, rawId, tagged} for a stored handle, or null for nothing or a malformed tag. A bare
 * id is the Claude plan's.
 */
export function parse(handle) {
  if (typeof handle !== "string") return null;
  const h = handle.trim();
  if (!h) return null;
  const m = TAGGED.exec(h);
  if (m) return { provider: m[1], engine: ENGINE_OF_HOME[m[2]], homeKey: m[2], vendor: m[3], rawId: m[4], tagged: true };
  if (!BARE.test(h)) return null;
  return { provider: "claude", engine: "claude-code", homeKey: "cc", vendor: "claude", rawId: h, tagged: false };
}

/**
 * The raw id to resume for this target, or null to start fresh: the Claude plan resumes only a bare id; every other
 * provider only a handle with its own provider, home key and vendor.
 */
export function sessionFor(handle, target) {
  const parsed = parse(handle);
  if (!parsed || !target?.provider) return null;
  if (isPlan(target.provider)) return parsed.tagged ? null : parsed.rawId;
  if (!parsed.tagged) return null;
  const place = placeOf(target);
  if (!place) return null;
  const same = parsed.provider === place.provider && parsed.homeKey === place.homeKey && parsed.vendor === place.vendor;
  return same ? parsed.rawId : null;
}

/** The raw id inside any stored handle (a bare one as it is), or null for nothing or a malformed tag. */
export function untag(handle) {
  return parse(handle)?.rawId ?? null;
}
