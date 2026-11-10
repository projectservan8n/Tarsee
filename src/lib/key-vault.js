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

const VAULT_FILE = path.join(config.DATA_DIR, "vault.json");

/**
 * Vault keys Tarsee itself uses, never handed to the AI: RAILWAY_API_TOKEN, the token tarsee_railway reaches Railway
 * with (lib/railway-admin.js reads it from here first). With it in hand, one call to Railway's API from the AI's shell
 * would skip every limit that tool keeps. So, whether the AI's commands run as the server's user or as their own:
 *   - the agent's environment never carries one, nor a key holding the same value (ai/agent-env.js);
 *   - get_key refuses one, and a key holding the same value (lib/tools.js); list_keys still names it;
 *   - written by anyone but the owner (set_key from chat, or any other tool that saves to the vault), one is saved
 *     only while Tarsee has none yet, in the vault or in its environment: that first save is how owners give Tarsee
 *     its token from chat. Replacing or deleting it is the owner's, in Settings > Keys, which passes { owner: true }.
 * Names match in any case, with spaces trimmed.
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

/**
 * Load the vault from disk.
 * @returns {object} - { keyName: { value, description, createdAt, updatedAt } }
 */
function loadVault() {
  try {
    if (!fs.existsSync(VAULT_FILE)) return {};
    const raw = fs.readFileSync(VAULT_FILE, "utf8");
    return JSON.parse(raw);
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
 * @param {string} name - Key name (e.g., "GOOGLE_PLACES_KEY")
 * @param {string} value - The secret value
 * @param {string} [description] - What this key is for
 * @param {{ owner?: boolean }} [opts] - owner: the owner's own Settings > Keys, the one writer that may replace a
 *   server-only key already there (every other write of one is refused: serverOnlyWriteRefusal)
 * @returns {object} - { name, description, masked }
 */
export function setKey(name, value, description = "", { owner = false } = {}) {
  if (!owner) {
    const refused = serverOnlyWriteRefusal(name);
    if (refused) throw new Error(refused);
  }
  const vault = loadVault();
  const now = new Date().toISOString();
  
  vault[name] = {
    value: isEncryptionEnabled() ? encrypt(value) : value,
    description: description || vault[name]?.description || "",
    createdAt: vault[name]?.createdAt || now,
    updatedAt: now,
  };
  
  saveVault(vault);
  console.log(`[vault] key set: ${name}`);
  return { name, description: vault[name].description, masked: maskSecret(value) };
}

/**
 * Get a key from the vault. Value is decrypted.
 * @param {string} name - Key name
 * @returns {string|null} - The decrypted value, or null if not found
 */
export function getKey(name) {
  const vault = loadVault();
  const entry = vault[name];
  if (!entry) return null;
  
  const value = entry.value;
  if (isEncrypted(value)) {
    return decrypt(value);
  }
  return value;
}

/**
 * Delete a key from the vault.
 * @param {string} name
 * @param {{ owner?: boolean }} [opts] - owner: the owner's Settings > Keys, the one place a server-only key is deleted
 * @returns {boolean}
 */
export function deleteKey(name, { owner = false } = {}) {
  if (!owner) {
    const refused = serverOnlyWriteRefusal(name, { deleting: true });
    if (refused) throw new Error(refused);
  }
  const vault = loadVault();
  if (!vault[name]) return false;
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
 * Check if a key exists.
 */
export function hasKey(name) {
  const vault = loadVault();
  return !!vault[name];
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
