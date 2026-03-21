/**
 * Key-value settings store backed by SQLite.
 * Stores provider configs, channel tokens, and app preferences.
 */
export class SettingsStore {
  constructor(db) {
    this.db = db;
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
   * If the value is JSON, it's automatically parsed.
   */
  get(key) {
    const row = this._get.get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  /**
   * Set a setting value. Objects are JSON-serialized.
   */
  set(key, value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    this._set.run(key, serialized);
  }

  /**
   * Delete a setting.
   */
  delete(key) {
    return this._delete.run(key).changes > 0;
  }

  /**
   * Get all settings.
   */
  all() {
    return this._all.all().map((row) => ({
      key: row.key,
      value: tryParse(row.value),
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Get all settings with a given prefix.
   * E.g., getByPrefix("provider.") returns all provider settings.
   */
  getByPrefix(prefix) {
    return this._getByPrefix.all(prefix).map((row) => ({
      key: row.key,
      value: tryParse(row.value),
    }));
  }

  /**
   * Get the active AI provider configuration.
   * Returns { provider, model, apiKey } or null.
   */
  getActiveProvider() {
    const providerId = this.get("ai.activeProvider");
    if (!providerId) return null;

    return {
      provider: providerId,
      model: this.get(`ai.${providerId}.model`) || null,
      apiKey: this.get(`ai.${providerId}.apiKey`) || process.env[`${providerId.toUpperCase()}_API_KEY`] || null,
      baseUrl: this.get(`ai.${providerId}.baseUrl`) || null,
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
