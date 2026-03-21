import { encryptIfSecret, decryptIfEncrypted, isSecretKey, maskSecret, isEncrypted } from "../lib/vault.js";
import { AI_PROVIDERS } from "../config/constants.js";

/**
 * Key-value settings store backed by SQLite.
 * Stores provider configs, channel tokens, and app preferences.
 *
 * Secrets (API keys, tokens) are automatically encrypted at rest
 * when ENCRYPTION_KEY is set. Decrypted on read transparently.
 */
export class SettingsStore {
  constructor(db, auditLog) {
    this.db = db;
    this.auditLog = auditLog || null;
    this._get = db.prepare("SELECT value FROM settings WHERE key = ?");
    this._set = db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    );
    this._delete = db.prepare("DELETE FROM settings WHERE key = ?");
    this._all = db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key");
    this._getByPrefix = db.prepare("SELECT key, value FROM settings WHERE key LIKE ? || '%' ORDER BY key");
  }

  /**
   * Get a setting value. Returns null if not found.
   * Secrets are automatically decrypted.
   */
  get(key) {
    const row = this._get.get(key);
    if (!row) return null;

    let value = row.value;

    // Decrypt if it's an encrypted value
    value = decryptIfEncrypted(value);

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /**
   * Set a setting value. Objects are JSON-serialized.
   * Secrets are automatically encrypted at rest.
   */
  set(key, value, opts = {}) {
    let serialized = typeof value === "string" ? value : JSON.stringify(value);

    // Auto-encrypt secrets
    serialized = encryptIfSecret(key, serialized);

    this._set.run(key, serialized);

    // Audit log for secret writes
    if (isSecretKey(key) && this.auditLog) {
      this.auditLog.log({
        action: "credential.write",
        target: key,
        actor: opts.actor || "system",
        ip: opts.ip,
        detail: "Credential stored (encrypted)",
      });
    }
  }

  /**
   * Delete a setting.
   */
  delete(key, opts = {}) {
    const result = this._delete.run(key).changes > 0;

    if (result && isSecretKey(key) && this.auditLog) {
      this.auditLog.log({
        action: "credential.delete",
        target: key,
        actor: opts.actor || "system",
        ip: opts.ip,
      });
    }

    return result;
  }

  /**
   * Get all settings. Secrets are masked for display.
   */
  all() {
    return this._all.all().map((row) => {
      let value = row.value;
      const secret = isSecretKey(row.key);

      if (secret) {
        // Decrypt, then mask for display
        try {
          const decrypted = decryptIfEncrypted(value);
          const parsed = tryParse(decrypted);
          // For objects (like channel configs), mask token fields
          if (typeof parsed === "object" && parsed !== null) {
            return {
              key: row.key,
              value: maskObjectSecrets(parsed),
              updatedAt: row.updated_at,
              encrypted: isEncrypted(value),
            };
          }
          return {
            key: row.key,
            value: maskSecret(typeof parsed === "string" ? parsed : decrypted),
            updatedAt: row.updated_at,
            encrypted: isEncrypted(value),
          };
        } catch {
          return { key: row.key, value: "****", updatedAt: row.updated_at, encrypted: true };
        }
      }

      return {
        key: row.key,
        value: tryParse(value),
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Get all settings with a given prefix.
   * Secrets are decrypted for internal use.
   */
  getByPrefix(prefix) {
    return this._getByPrefix.all(prefix).map((row) => ({
      key: row.key,
      value: tryParse(decryptIfEncrypted(row.value)),
    }));
  }

  /**
   * Get the active AI provider configuration.
   * Returns { provider, model, apiKey, baseUrl } or null.
   * API key is decrypted for use.
   */
  getActiveProvider() {
    let providerId = this.get("ai.activeProvider");

    // Auto-detect from env vars if no provider configured in DB
    if (!providerId) {
      for (const [id, def] of Object.entries(AI_PROVIDERS)) {
        if (process.env[def.envKey]) {
          providerId = id;
          break;
        }
      }
    }

    if (!providerId) return null;

    const providerDef = AI_PROVIDERS[providerId];
    const apiKey = this.get(`ai.${providerId}.apiKey`)
      || process.env[providerDef?.envKey || `${providerId.toUpperCase()}_API_KEY`]
      || null;

    // Audit credential read
    if (apiKey && this.auditLog) {
      this.auditLog.log({
        action: "credential.read",
        target: `ai.${providerId}.apiKey`,
        actor: "system",
        detail: "Provider key accessed for AI request",
      });
    }

    return {
      provider: providerId,
      model: this.get(`ai.${providerId}.model`) || providerDef?.defaultModel || null,
      apiKey,
      baseUrl: this.get(`ai.${providerId}.baseUrl`) || providerDef?.baseUrl || null,
    };
  }

  /**
   * Set the active AI provider.
   */
  setActiveProvider(providerId, { model, apiKey, baseUrl } = {}) {
    this.set("ai.activeProvider", providerId);
    if (model) this.set(`ai.${providerId}.model`, model);
    if (apiKey) this.set(`ai.${providerId}.apiKey`, apiKey);
    if (baseUrl) this.set(`ai.${providerId}.baseUrl`, baseUrl);
  }
}

function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Mask secret fields in an object (e.g., channel configs with tokens).
 */
function maskObjectSecrets(obj) {
  const masked = { ...obj };
  for (const key of Object.keys(masked)) {
    if (/token|key|secret|password/i.test(key) && typeof masked[key] === "string") {
      masked[key] = maskSecret(masked[key]);
    }
  }
  return masked;
}
