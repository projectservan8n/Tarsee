import {
  encryptIfSecret,
  decryptIfEncrypted,
  isSecretKey,
  maskSecret,
  isEncrypted,
  encryptSecretFields,
  decryptSecretFields,
} from "../lib/vault.js";
import { AI_PROVIDERS } from "../config/constants.js";
import { getProvider } from "../ai/provider-registry.js";

/**
 * The placeholder the old setup wizard saved as the Claude plan's "API key"
 * (setup.js sent apiKey: "subscription"). It never was a key.
 */
const FAKE_SUBSCRIPTION_KEY = "subscription";
const FAKE_SUBSCRIPTION_SLOT = "ai.claude-code.apiKey";
const FAKE_SUBSCRIPTION_FIXUP_KEY = "fixups.fakeSubscriptionKeyRemovedAt";

/** Local AI: the one provider whose host the owner sets (ai.local.baseUrl). */
const LOCAL_AI_ID = "local";

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

    // Long bare integers (Discord snowflakes, Telegram chat IDs, …) exceed
    // Number.MAX_SAFE_INTEGER and silently lose precision through JSON.parse
    // (e.g. …648422 → …648300). Parsing them is never right — keep as string.
    if (typeof value === "string" && /^\d{15,}$/.test(value)) return value;

    try {
      // Decrypt any credential fields nested inside the parsed object. A value
      // written before field-level encryption existed is plaintext and passes
      // straight through, so this upgrades in place with no migration.
      return decryptSecretFields(JSON.parse(value));
    } catch {
      return value;
    }
  }

  /**
   * Set a setting value. Objects are JSON-serialized.
   * Secrets are automatically encrypted at rest.
   */
  set(key, value, opts = {}) {
    // Encrypt credential FIELDS inside structured values before serializing.
    // The key-name test below only sees the top-level key, so a channel config
    // object (channel.telegram, channel.email, …) never matched it and every
    // bot token and mailbox password was stored in plaintext.
    const guarded = value && typeof value === "object" ? encryptSecretFields(value) : value;
    let serialized = typeof guarded === "string" ? guarded : JSON.stringify(guarded);

    // Auto-encrypt secrets whose KEY name marks the whole value as a secret.
    serialized = encryptIfSecret(key, serialized);

    this._set.run(key, serialized);

    // Audit log for secret writes (never the value)
    if (isSecretKey(key)) {
      this._audit({
        action: "credential.write",
        target: key,
        actor: opts.actor || "system",
        ip: opts.ip,
        detail: isEncrypted(serialized) ? "Credential stored (encrypted)" : "Credential stored (not encrypted: ENCRYPTION_KEY is not set)",
      });
    }
  }

  /**
   * Delete a setting.
   */
  delete(key, opts = {}) {
    const result = this._delete.run(key).changes > 0;

    if (result && isSecretKey(key)) {
      this._audit({
        action: "credential.delete",
        target: key,
        actor: opts.actor || "system",
        ip: opts.ip,
        detail: opts.detail,
      });
    }

    return result;
  }

  /**
   * Write an audit row for a credential write or delete. Most routes and channels
   * make their store without the AuditLog, so without one this writes the row
   * itself; a database with no audit table (a test's bare database) is skipped.
   */
  _audit(entry) {
    if (this.auditLog) {
      this.auditLog.log(entry);
      return;
    }
    try {
      this._auditInsert ||= this.db.prepare("INSERT INTO audit_log (action, target, actor, ip, detail) VALUES (?, ?, ?, ?, ?)");
      this._auditInsert.run(entry.action, entry.target || null, entry.actor || "system", entry.ip || null, entry.detail || null);
    } catch { /* no audit table: nowhere to write it */ }
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
   * Returns { provider, model, apiKey, ready } or null.
   * API key is decrypted for use. There is no base URL: a provider's host is a
   * code constant (engine-env.js hostFor), never a setting.
   *
   * The provider is ONLY the owner's choice (`ai.activeProvider`). A provider key
   * in the environment never picks one: an OPENROUTER_API_KEY left on Railway for
   * something else must not silently move every turn to another provider and
   * another bill. This runs on every turn, so it neither logs nor audits the key.
   */
  getActiveProvider() {
    const providerId = this.get("ai.activeProvider");
    if (!providerId) return null;

    const providerDef = AI_PROVIDERS[providerId];
    const { key: apiKey } = this.getKeyWithSource(providerId);

    return {
      provider: providerId,
      model: this.get(`ai.${providerId}.model`) || providerDef?.defaultModel || null,
      apiKey,
      ready: !!apiKey || !!providerDef?.noKeyRequired,
    };
  }

  /**
   * A provider's API key and where it came from. Encrypted Settings first
   * (`ai.<id>.apiKey`), then the environment (Railway): `envName` when given
   * (null: Settings only), else the provider's own variable (`<ID>_API_KEY`;
   * Local AI's is TARSEE_LOCAL_AI_KEY). Sign-in plans (claude, claude-code,
   * chatgpt) have no key at all. Quotes and whitespace Railway sometimes adds
   * are trimmed.
   *
   * @param {string} providerId - e.g. "openrouter", "openai", "elevenlabs"
   * @param {{envName?: string|null}} [opts]
   * @returns {{key: string|null, source: "settings"|`env:${string}`|null, hint: string|null}}
   *   hint shows the last 4 characters only ("…a1b2"), for display and logs.
   */
  getKeyWithSource(providerId, { envName } = {}) {
    const none = { key: null, source: null, hint: null };
    if (!providerId || typeof providerId !== "string") return none;
    const where = keyPlace(providerId);
    // A sign-in plan has no key, saved or in the environment (its slot only ever held the old wizard's placeholder).
    if (where.keyless) return none;

    const saved = cleanKey(this.get(where.slot));
    if (saved) return { key: saved, source: "settings", hint: keyHint(saved) };

    const name = envName === undefined ? where.envName : envName;
    if (!name) return none;
    const fromEnv = cleanKey(process.env[name]);
    if (fromEnv) return { key: fromEnv, source: `env:${name}`, hint: keyHint(fromEnv) };

    return none;
  }

  /**
   * Get an API key for a provider — Settings first, env second.
   * Works for any provider: openai, gemini, anthropic, elevenlabs, etc.
   * @param {string} providerId - e.g. "openai", "gemini", "elevenlabs"
   * @returns {string|null}
   */
  getApiKey(providerId) {
    return this.getKeyWithSource(providerId).key;
  }

  /**
   * Delete a provider's saved API key (audited). A key in the environment, if
   * any, applies again. Clearing a key that isn't there, or no provider, is fine.
   * @param {string|null} providerId
   * @param {{actor?: string, ip?: string}} [opts]
   * @returns {boolean} true if a saved key was deleted
   */
  clearKey(providerId, opts = {}) {
    if (!providerId || typeof providerId !== "string") return false;
    return this.delete(keyPlace(providerId).slot, opts);
  }

  /**
   * Boot fixup: delete the placeholder apiKey "subscription" the old setup
   * wizard saved for the Claude plan. Decrypt-aware (the value is encrypted at
   * rest once ENCRYPTION_KEY is set), idempotent, and only that exact literal in
   * that one slot is deleted; a value it cannot decrypt is left where it is.
   * Records when it removed one in `fixups.fakeSubscriptionKeyRemovedAt`.
   * @returns {{removed: boolean}}
   */
  removeFakeSubscriptionKey() {
    const row = this._get.get(FAKE_SUBSCRIPTION_SLOT);
    if (!row) return { removed: false };

    let value;
    try {
      value = decryptIfEncrypted(row.value);
    } catch {
      console.warn(`[settings] ${FAKE_SUBSCRIPTION_SLOT} could not be decrypted (was ENCRYPTION_KEY changed?); left as it is`);
      return { removed: false };
    }
    if (value !== FAKE_SUBSCRIPTION_KEY && tryParse(value) !== FAKE_SUBSCRIPTION_KEY) return { removed: false };

    this.delete(FAKE_SUBSCRIPTION_SLOT, { actor: "system", detail: "Removed the setup wizard's placeholder (not a key)" });
    this.set(FAKE_SUBSCRIPTION_FIXUP_KEY, new Date().toISOString());
    console.log("[settings] removed the placeholder Claude plan key the old setup wizard saved (it was never a key)");
    return { removed: true };
  }

  /**
   * Boot fixup: delete every per-provider base URL (`ai.<id>.baseUrl`) an older
   * version saved, except Local AI's own server address. A provider's host is a
   * code constant (design 4.5 R3), so no later code may pick a stale one up.
   * Idempotent.
   * @returns {{removed: number}}
   */
  removeProviderBaseUrls() {
    const rows = this.db.prepare("SELECT key FROM settings WHERE key LIKE 'ai.%.baseUrl'").all();
    let removed = 0;
    for (const { key } of rows) {
      const m = /^ai.([^.]+).baseUrl$/.exec(key);
      if (!m || m[1] === LOCAL_AI_ID) continue;
      if (this.delete(key)) removed++;
    }
    if (removed) console.log(`[settings] removed ${removed} saved provider base URL(s): hosts are fixed in code now`);
    return { removed };
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
      const { source, hint } = def.noKeyRequired ? {} : this.getKeyWithSource(id);
      if (def.noKeyRequired) {
        lines.push(`    ${id}: implicit (no key required)`);
      } else if (source) {
        lines.push(`    ${id}: ${hint} (${source})`);
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
   * Set the active AI provider. null clears the choice. A provider's host is
   * not a setting, so no base URL is taken here.
   */
  setActiveProvider(providerId, { model, apiKey } = {}) {
    if (!providerId) {
      this.delete("ai.activeProvider");
      return;
    }
    this.set("ai.activeProvider", providerId);
    if (model) this.set(`ai.${providerId}.model`, model);
    // The old setup wizard sends the placeholder "subscription" as the Claude plan's key; it is not one.
    if (apiKey && !isFakeSubscriptionKey(providerId, apiKey)) this.set(`ai.${providerId}.apiKey`, apiKey);
  }
}

function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** A key as stored or as Railway hands it over: whitespace and one pair of wrapping quotes removed. "" is no key. */
function cleanKey(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().replace(/^["']|["']$/g, "").trim();
  return key || null;
}

/**
 * Where a key is kept: its Settings slot and the environment variable it may come from. The provider registry names
 * both for its providers (any spelling or alias: "claude-code" is the Claude plan), and a sign-in plan (claude,
 * chatgpt) is keyless, so a stray CLAUDE_API_KEY can't hand it one. Any other id (Voice's elevenlabs) is
 * `ai.<id>.apiKey` and `<ID>_API_KEY`.
 */
function keyPlace(providerId) {
  const p = getProvider(providerId);
  if (p) return { slot: `ai.${p.storageId}.apiKey`, envName: p.envKey, keyless: p.kind === "subscription" };
  return { slot: `ai.${providerId}.apiKey`, envName: `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`, keyless: false };
}

/** The last 4 characters of a key, the only part that is ever shown or logged. */
function keyHint(key) {
  if (!key) return null;
  return key.length >= 8 ? `…${key.slice(-4)}` : "…";
}

function isFakeSubscriptionKey(providerId, apiKey) {
  return (providerId === "claude-code" || providerId === "claude") && String(apiKey).trim() === FAKE_SUBSCRIPTION_KEY;
}

function maskForLog(value) {
  if (typeof value !== "string" || value.length < 8) return "****";
  return `…${value.slice(-4)}`;
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
