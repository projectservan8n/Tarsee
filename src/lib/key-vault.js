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
 *   - written by anyone but the owner (set_key from chat, or any other tool that saves to the vault), one is saved
 *     only while Tarsee has none yet, in the vault or in its environment: that first save is how owners give Tarsee
 *     its token from chat (a chat only: never background work, nor a scheduled task's direct action, lib/cron.js).
 *     Replacing or deleting it is the owner's, in Settings > Keys, which passes { owner: true }.
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

/** The tool that uses a server-only key. */
export function serverOnlyTool(name) {
  return USED_BY[serverOnlyName(name)] || "Tarsee's own tool for it";
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
 * Why a write by anyone but the owner (set_key from chat, another tool) to the server-only key `name` is refused, or
 * null when it may go ahead: a name that isn't one, or a first save while Tarsee has none yet. deleting: for a delete.
 * env: where Tarsee would also find one (its own environment by default).
 */
export function serverOnlyWriteRefusal(name, { deleting = false, env = process.env } = {}) {
  const own = serverOnlyName(name);
  if (!own) return null;
  const why = `${own} is Tarsee's own: ${USED_BY[own]} uses it, and a new one could point Tarsee at another account`;
  const saved = hasKey(own);
  if (deleting) return saved ? `${own} wasn't deleted. ${why}, so only the owner replaces or deletes it: change it in Settings > Keys.` : null;
  if (saved) return `${own} is already saved, and it wasn't replaced. ${why}, so only the owner replaces it: change it in Settings > Keys.`;
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
 * @param {{ owner?: boolean }} [opts] - owner: the owner's own Settings > Keys, the one writer that may replace a
 *   server-only key already there (every other write of one is refused: serverOnlyWriteRefusal)
 * @returns {object} - { name, description, masked }
 */
export function setKey(name, value, description = "", { owner = false } = {}) {
  const vault = loadVault();
  // The name's type and shape before anything looks at it (KEY_NAME_MAX), then the value's and the description's.
  checkedName(vault, name);
  if (typeof value !== "string") throw new Error(`A key's value is text, and this one is ${kindOf(value)}.`);
  if (description != null && typeof description !== "string") throw new Error(`A key's description is text, and this one is ${kindOf(description)}.`);
  if (!owner) {
    const refused = serverOnlyWriteRefusal(name);
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
