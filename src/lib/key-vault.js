/**
 * Key Vault for Tarsee.
 * 
 * Encrypted JSON file storing API keys, tokens, and secrets that the bot
 * can access at runtime. Keys are encrypted at rest using the same 
 * ENCRYPTION_KEY as the settings database.
 *
 * Storage: /data/tarsee/data/vault.json (encrypted values)
 * 
 * Usage: User tells the bot "save my Google Places key as GOOGLE_PLACES"
 * and the bot calls set_key. Later, any tool or subagent can call get_key
 * to retrieve it. The owner also sees, adds, replaces and deletes keys in
 * Settings > Keys (routes/vault-keys.js), which never shows a value.
 * Tarsee's own keys (SERVER_ONLY_KEYS, below) are the exception to get_key.
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { encrypt, decrypt, isEncrypted, isEncryptionEnabled, maskSecret } from "./vault.js";
import { setServerOnlyValuesSource } from "../ai/engine-env.js";

const VAULT_FILE = path.join(config.DATA_DIR, "vault.json");

/**
 * A key's name: text, a letter first, then letters, digits, _ . or -, up to KEY_NAME_MAX (what Settings > Keys takes).
 * setKey, getKey, deleteKey and hasKey take no other name, from anyone, the owner included: JavaScript turns a list or
 * an object into text when it is used as a property name (["RAILWAY_API_TOKEN"] is "RAILWAY_API_TOKEN"), so a name that
 * isn't text would skip every check made on the name and still reach the key it spells. A key saved under a name of
 * another shape before this rule ("my old key") is still read, replaced and deleted by that exact name.
 */
export const KEY_NAME_MAX = 128;
const KEY_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** True for a name of the vault's shape (see KEY_NAME_MAX). */
export function isKeyName(name) {
  return typeof name === "string" && name.length <= KEY_NAME_MAX && KEY_NAME_RE.test(name);
}

/** What a value given for a name or a value is, in words. */
function kindOf(v) {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "number") return "a number";
  if (typeof v === "boolean") return "true or false";
  if (typeof v === "string") return "text";
  return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

const SHAPE = `a key's name starts with a letter and has only letters, digits, _ . or - (up to ${KEY_NAME_MAX}), like STRIPE_SECRET_KEY`;

/**
 * Why the vault won't take `name` as a key's name, or null when it will: one of its shape, or a key saved under that
 * exact name before the rule. vault: the vault to look in (read from disk when not given).
 */
export function keyNameRefusal(name, vault = null) {
  if (typeof name !== "string") return `A key's name is text, like STRIPE_SECRET_KEY, and this one is ${kindOf(name)}.`;
  if (isKeyName(name)) return null;
  if (name !== "__proto__" && Object.hasOwn(vault || loadVault(), name)) return null;
  const shown = JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}…` : name);
  return `${shown} isn't a key's name: ${SHAPE}.`;
}

/** The name, as the vault takes it, or an Error (keyNameRefusal). */
function checkedName(vault, name) {
  const refused = keyNameRefusal(name, vault);
  if (refused) throw new Error(refused);
  return name;
}

/** The vault's entry for a name it took (checkedName), or null: never a property every object has, like constructor. */
const entryOf = (vault, name) => (Object.hasOwn(vault, name) && vault[name] && typeof vault[name] === "object" ? vault[name] : null);

/**
 * Vault keys Tarsee itself uses, never handed to the AI: RAILWAY_API_TOKEN, the token tarsee_railway reaches Railway
 * with (lib/railway-admin.js reads it from here first). With it in hand, one call to Railway's API from the AI's shell
 * would skip every limit that tool keeps. So, whether the AI's commands run as the server's user or as their own:
 *   - the agent's environment never carries one, nor a key holding the same value (ai/agent-env.js); nor, set as a
 *     variable where Tarsee runs, does any engine's environment or the exec tool's (ai/engine-env.js, which keeps its
 *     own copy of this list, SERVER_ONLY_KEY_NAMES, and strips a variable holding the same value too);
 *   - get_key refuses one, and a key holding the same value (lib/tools.js); list_keys still names it;
 *   - the first one is saved only by the owner in Settings > Keys ({ owner: true }), or by set_key in a chat's own
 *     turn (chatTurn), while Tarsee has none yet, in the vault or in its environment: that is how owners give Tarsee
 *     its token from chat. Nothing else ever saves one, not even a first one: background work (a scheduled task or its
 *     direct action, a webhook, the heartbeat, BOOT.md), a turn with no chat (a subagent, an ACP session), another
 *     tool's save_as_key (lib/discord-admin.js), or a caller that names no writer (setKey's `writer`, FIRST_SAVER);
 *   - replacing or deleting one is the owner's alone, in Settings > Keys.
 * Names match in any case, with spaces trimmed. A name that isn't text is refused before any of this (keyNameRefusal).
 */
export const SERVER_ONLY_KEYS = Object.freeze(["RAILWAY_API_TOKEN"]);
/** The tool that uses each one: what the AI is pointed at instead. */
const USED_BY = Object.freeze({ RAILWAY_API_TOKEN: "tarsee_railway" });

/** The server-only key `name` is (its name in capitals), or null. */
export function serverOnlyName(name) {
  const upper = typeof name === "string" ? name.trim().toUpperCase() : "";
  return SERVER_ONLY_KEYS.includes(upper) ? upper : null;
}

/**
 * The server-only key a free-form name means once a tool turns it into a key's name, or null: letters and digits in
 * capitals, every other run of characters one _, none at either end. That is how discord_admin's save_as_key becomes
 * the name it saves under (lib/discord-admin.js keyNameFrom: "railway api token" is RAILWAY_API_TOKEN), so a check
 * made before the tool runs (lib/cron.js) matches what it would write.
 */
export function serverOnlyNameLoose(raw) {
  const name = typeof raw === "string" ? raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") : "";
  return SERVER_ONLY_KEYS.includes(name) ? name : null;
}

/** The tool that uses a server-only key. */
export function serverOnlyTool(name) {
  return USED_BY[serverOnlyName(name)] || "Tarsee's own tool for it";
}

/**
 * Who writes to the vault, as setKey takes it (`writer`), for the rule on Tarsee's own keys (serverOnlyWriteRefusal):
 *   { owner: true }                   the owner's Settings > Keys (routes/vault-keys.js); not a writer, an option
 *   writer: { tool: "set_key", ctx }  set_key, with its turn's tool context (lib/tools.js): the one tool that may save
 *                                     a first one, and only in a chat's own turn (chatTurn)
 *   writer: { tool: "<name>", ctx? }  any other tool that saves to the vault (discord_admin's save_as_key): never one
 *   no writer                         never one
 * The isolation design records this same writer as who set each entry (the owner, or the turn's account).
 */
const FIRST_SAVER = "set_key";

/**
 * Whether a tool context is a chat's own turn: one that answers a message in a conversation (the dashboard, a chat
 * bot, the API), not background work. Background work's context is marked (ai/turn.js: toolCtx.background is "cron"
 * for a scheduled task, its direct action or a webhook, "heartbeat", "boot"), and a turn with no conversation (a
 * subagent, an ACP session) isn't one either.
 */
export function chatTurn(ctx) {
  return !!ctx && typeof ctx === "object" && !ctx.background && typeof ctx.conversationId === "string" && ctx.conversationId.trim() !== "";
}

/** Why `writer` may never save the server-only key `own`, even a first one (see FIRST_SAVER), or null when it may. */
function writerRefusal(own, writer) {
  const why = `${own} is Tarsee's own: ${USED_BY[own]} uses it, and a new one could point Tarsee at another account`;
  const who = `The owner saves or changes it in Settings > Keys; the first one can also come from a chat with the owner, through ${FIRST_SAVER}.`;
  const tool = writer && typeof writer === "object" && typeof writer.tool === "string" ? writer.tool : "";
  if (!tool) return `${own} wasn't saved: only the owner, or ${FIRST_SAVER} in a chat, saves Tarsee's own keys, and this write named neither. ${why}. ${who}`;
  if (tool !== FIRST_SAVER) return `${own} wasn't saved: ${tool} never saves Tarsee's own keys, not even a first one. ${why}. ${who}`;
  const ctx = writer.ctx;
  if (ctx && typeof ctx === "object" && ctx.background) {
    return `${own} wasn't saved: background work (a scheduled task or its direct action, a webhook, the heartbeat, BOOT.md) never saves Tarsee's own keys, not even a first one, since nobody is there to have given it. ${why}. ${who}`;
  }
  if (!chatTurn(ctx)) return `${own} wasn't saved: a first one comes only from a chat's own turn, and this turn isn't a chat's own (a subagent's, an ACP session's, or a tool run with no chat). ${why}. ${who}`;
  return null;
}

/**
 * The server-only keys' values, trimmed, each mapped to its key's name: the vault's (read with `get`) and those in
 * the environments given (the server's own by default). A key holding one of them is a copy of Tarsee's own.
 * Values shorter than 8 characters aren't taken as tokens.
 */
export function serverOnlyValues({ get = getKey, envs = [process.env] } = {}) {
  const out = new Map();
  for (const name of SERVER_ONLY_KEYS) {
    const found = [];
    try { found.push(get(name)); } catch { /* the vault can't be read: nothing of it to compare */ }
    for (const env of envs) found.push(env?.[name]);
    for (const v of found) {
      const value = typeof v === "string" ? v.trim() : "";
      if (value.length >= 8) out.set(value, name);
    }
  }
  return out;
}

/**
 * Why a write by anyone but the owner to the server-only key `name` is refused, or null when it may go ahead: a name
 * that isn't one, or a first save by set_key in a chat's own turn while Tarsee has none yet. deleting: for a delete,
 * which only the owner makes. writer: who saves it (see FIRST_SAVER); none is refused. env: where Tarsee would also
 * find one (its own environment by default).
 */
export function serverOnlyWriteRefusal(name, { deleting = false, env = process.env, writer = null } = {}) {
  const own = serverOnlyName(name);
  if (!own) return null;
  const why = `${own} is Tarsee's own: ${USED_BY[own]} uses it, and a new one could point Tarsee at another account`;
  if (deleting) return hasKey(own) ? `${own} wasn't deleted. ${why}, so only the owner replaces or deletes it: change it in Settings > Keys.` : null;
  // Who writes it comes first: a writer that may never save one is told so, saved yet or not, with no vault read.
  const notThem = writerRefusal(own, writer);
  if (notThem) return notThem;
  if (hasKey(own)) return `${own} is already saved, and it wasn't replaced. ${why}, so only the owner replaces it: change it in Settings > Keys.`;
  if (String(env?.[own] ?? "").trim()) {
    return `${own} wasn't saved. Tarsee already has one in its environment (a variable set where it runs), and the vault's would take its place. ${why}, so only the owner does that: change it in Settings > Keys.`;
  }
  return null;
}

// engine-env strips a variable holding a copy of the vault's server-only keys from every engine's environment (and so
// from the exec tool's): it never imports the vault, so the vault hands over how to read them.
setServerOnlyValuesSource(() => [...serverOnlyValues({ envs: [] }).keys()]);

/**
 * Load the vault from disk.
 * @returns {object} - { keyName: { value, description, createdAt, updatedAt } }
 */
function loadVault() {
  try {
    if (!fs.existsSync(VAULT_FILE)) return {};
    const raw = fs.readFileSync(VAULT_FILE, "utf8");
    const vault = JSON.parse(raw);
    return vault && typeof vault === "object" && !Array.isArray(vault) ? vault : {};
  } catch {
    return {};
  }
}

/**
 * Save the vault to disk.
 */
function saveVault(vault) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2), { mode: 0o600 });
}

/**
 * Set a key in the vault. Value is encrypted at rest.
 * @param {string} name - Key name (e.g., "GOOGLE_PLACES_KEY"): text of the vault's shape (keyNameRefusal), else an Error
 * @param {string} value - The secret value, as text
 * @param {string} [description] - What this key is for
 * @param {{ owner?: boolean, writer?: { tool: string, ctx?: object } }} [opts] - owner: the owner's own Settings >
 *   Keys, the one writer that may replace a server-only key already there. writer: the tool that saves it, with its
 *   turn's tool context: set_key in a chat's own turn may save a first one, and nothing else saves one at all
 *   (FIRST_SAVER, serverOnlyWriteRefusal). Other keys save as before, whoever writes them.
 * @returns {object} - { name, description, masked }
 */
export function setKey(name, value, description = "", { owner = false, writer = null } = {}) {
  const vault = loadVault();
  // The name's type and shape before anything looks at it (KEY_NAME_MAX), then the value's and the description's.
  checkedName(vault, name);
  if (typeof value !== "string") throw new Error(`A key's value is text, and this one is ${kindOf(value)}.`);
  if (description != null && typeof description !== "string") throw new Error(`A key's description is text, and this one is ${kindOf(description)}.`);
  if (!owner) {
    const refused = serverOnlyWriteRefusal(name, { writer });
    if (refused) throw new Error(refused);
  }
  const had = entryOf(vault, name);
  const now = new Date().toISOString();

  vault[name] = {
    value: isEncryptionEnabled() ? encrypt(value) : value,
    description: description || had?.description || "",
    createdAt: had?.createdAt || now,
    updatedAt: now,
  };

  saveVault(vault);
  console.log(`[vault] key set: ${name}`);
  return { name, description: vault[name].description, masked: maskSecret(value) };
}

/**
 * Get a key from the vault. Value is decrypted.
 * @param {string} name - Key name: text of the vault's shape (keyNameRefusal), else an Error
 * @returns {string|null} - The decrypted value, or null if not found
 */
export function getKey(name) {
  const vault = loadVault();
  const entry = entryOf(vault, checkedName(vault, name));
  if (!entry) return null;

  const value = entry.value;
  if (isEncrypted(value)) {
    return decrypt(value);
  }
  return value;
}

/**
 * Delete a key from the vault.
 * @param {string} name - text of the vault's shape (keyNameRefusal), else an Error
 * @param {{ owner?: boolean }} [opts] - owner: the owner's Settings > Keys, the one place a server-only key is deleted
 * @returns {boolean}
 */
export function deleteKey(name, { owner = false } = {}) {
  const vault = loadVault();
  checkedName(vault, name);
  if (!owner) {
    const refused = serverOnlyWriteRefusal(name, { deleting: true });
    if (refused) throw new Error(refused);
  }
  if (!entryOf(vault, name)) return false;
  delete vault[name];
  saveVault(vault);
  console.log(`[vault] key deleted: ${name}`);
  return true;
}

/**
 * List all keys (names + descriptions only, no values).
 * @returns {Array<{name, description, masked, createdAt, updatedAt}>}
 */
export function listKeys() {
  const vault = loadVault();
  return Object.entries(vault).map(([name, entry]) => {
    let rawValue = entry.value;
    if (isEncrypted(rawValue)) {
      try { rawValue = decrypt(rawValue); } catch { rawValue = ""; }
    }
    return {
      name,
      description: entry.description || "",
      masked: maskSecret(rawValue),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  });
}

/**
 * Check if a key exists. name: text of the vault's shape (keyNameRefusal), else an Error.
 */
export function hasKey(name) {
  const vault = loadVault();
  return !!entryOf(vault, checkedName(vault, name));
}

/**
 * Get all keys as a name->value map (for use in tool execution context).
 * CAREFUL: Returns decrypted values.
 */
export function getAllKeysDecrypted() {
  const vault = loadVault();
  const result = {};
  for (const [name, entry] of Object.entries(vault)) {
    try {
      result[name] = isEncrypted(entry.value) ? decrypt(entry.value) : entry.value;
    } catch {
      result[name] = null;
    }
  }
  return result;
}
