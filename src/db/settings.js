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
    const rawKey = this.get(`ai.${providerId}.apiKey`)
      || process.env[providerDef?.envKey || `${providerId.toUpperCase()}_API_KEY`]
      || null;

    // Trim whitespace/quotes that Railway env vars sometimes include
    const apiKey = rawKey ? rawKey.trim().replace(/^["']|["']$/g, "") : null;

    // Debug: log key prefix so we can verify it's correct without exposing the full key
    if (apiKey) {
      console.log(`[settings] provider=${providerId} key=${apiKey.slice(0, 10)}... (${apiKey.length} chars)`);
    }

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
      ready: !!apiKey || !!providerDef?.noKeyRequired,
    };
  }

  /**
   * Get an API key for a provider — vault first, env second.
   * Works for any provider: openai, gemini, anthropic, elevenlabs, etc.
   * @param {string} providerId - e.g. "openai", "gemini", "elevenlabs"
   * @returns {string|null}
   */
  getApiKey(providerId) {
    // 1. Check vault/DB
    const dbKey = this.get(`ai.${providerId}.apiKey`);
    if (dbKey) return dbKey.trim();

    // 2. Check known env var names
    const providerDef = AI_PROVIDERS[providerId];
    const envName = providerDef?.envKey || `${providerId.toUpperCase()}_API_KEY`;
    const envKey = process.env[envName];
    if (envKey) return envKey.trim().replace(/^["']|["']$/g, "");

    return null;
  }

  /**
   * Log what credentials are reachable at startup — AI providers,
   * vault contents, and known env-only integrations. Masks every
   * value. Also runs a vault integrity check so a changed
   * ENCRYPTION_KEY after a redeploy surfaces loudly instead of the
   * first time a tool silently returns null.
   */
  logKeyStatus() {
    const lines = [];

    // AI providers — enumerate AI_PROVIDERS dynamically instead of hardcoding.
    lines.push("  AI providers:");
    for (const [id, def] of Object.entries(AI_PROVIDERS)) {
      const dbKey = this.get(`ai.${id}.apiKey`);
      const envKey = def.envKey ? process.env[def.envKey] : null;
      if (def.noKeyRequired) {
        lines.push(`    ${id}: implicit (no key required)`);
      } else if (dbKey) {
        lines.push(`    ${id}: ${maskForLog(dbKey)} (vault)`);
      } else if (envKey) {
        lines.push(`    ${id}: ${maskForLog(envKey)} (env)`);
      } else {
        lines.push(`    ${id}: not set`);
      }
    }

    // Env-only integrations (ElevenLabs, captcha) — same check, different home.
    const envOnly = [
      { id: "elevenlabs", dbKey: this.get("ai.elevenlabs.apiKey"), envVal: process.env.ELEVENLABS_API_KEY },
      { id: "captcha",    dbKey: this.get("captcha.api_key"),      envVal: process.env.CAPTCHA_API_KEY },
    ];
    lines.push("  Integrations:");
    for (const i of envOnly) {
      if (i.dbKey) lines.push(`    ${i.id}: ${maskForLog(i.dbKey)} (vault)`);
      else if (i.envVal) lines.push(`    ${i.id}: ${maskForLog(i.envVal)} (env)`);
      else lines.push(`    ${i.id}: not set`);
    }

    // Vault — user-scoped credentials, integrity-checked.
    try {
      // Lazy import to avoid circular dep and to work even if the vault
      // file doesn't exist yet on first boot.
      import("../lib/credential-inventory.js").then(({ verifyVaultIntegrity }) => {
        const { total, ok, broken } = verifyVaultIntegrity();
        if (total === 0) {
          console.log("[keys] Vault: empty");
          return;
        }
        if (broken.length === 0) {
          console.log(`[keys] Vault: ${ok}/${total} keys decrypted OK`);
          return;
        }
        console.warn(`[keys] Vault: ${ok}/${total} keys decrypted, ${broken.length} UNREADABLE:`);
        for (const b of broken) {
          console.warn(`    - ${b.name}: ${b.reason}`);
        }
        console.warn(
          "[keys] Unreadable vault entries usually mean ENCRYPTION_KEY changed. " +
          "Either restore the original key or re-save these entries in plaintext."
        );
      }).catch((err) => {
        console.warn("[keys] Vault integrity check failed:", err.message);
      });
    } catch (err) {
      console.warn("[keys] Vault integrity check failed:", err.message);
    }

    console.log(`[keys] Credentials status:\n${lines.join("\n")}`);
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

function maskForLog(value) {
  if (typeof value !== "string" || value.length < 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
