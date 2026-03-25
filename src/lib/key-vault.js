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
 * to retrieve it.
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { encrypt, decrypt, isEncrypted, isEncryptionEnabled, maskSecret } from "./vault.js";

const VAULT_FILE = path.join(config.DATA_DIR, "vault.json");

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
 * @returns {object} - { name, description, masked }
 */
export function setKey(name, value, description = "") {
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
 * @returns {boolean}
 */
export function deleteKey(name) {
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
