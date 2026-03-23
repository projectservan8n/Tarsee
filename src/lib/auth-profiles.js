/**
 * Auth Profiles — multiple API keys per provider with cooldown and rotation.
 *
 * Profiles stored in settings DB as "auth.profiles" JSON array.
 * Each profile: { id, name, provider, apiKey, model?, baseUrl?, enabled }
 *
 * Features:
 * - Multiple keys per provider
 * - Cooldown tracking (failed keys enter 5-min cooldown)
 * - Auto-rotation on failure
 * - Usage stats per profile
 * - Select via /model name@provider:profile syntax
 */

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const cooldowns = new Map(); // profileId → { until: timestamp, reason: string }
const usageStats = new Map(); // profileId → { requests: number, lastUsed: string, errors: number }

let _settingsStore = null;

/**
 * Initialize auth profiles system.
 * @param {import('../db/settings.js').SettingsStore} settingsStore
 */
export function initAuthProfiles(settingsStore) {
  _settingsStore = settingsStore;
}

/**
 * Load all auth profiles from settings DB.
 * @returns {Array<{id: string, name: string, provider: string, apiKey: string, model?: string, baseUrl?: string, enabled: boolean}>}
 */
export function loadProfiles() {
  if (!_settingsStore) return [];
  try {
    const raw = _settingsStore.get("auth.profiles");
    if (!raw) return [];
    const profiles = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(profiles) ? profiles : [];
  } catch {
    return [];
  }
}

/**
 * Save profiles to settings DB.
 */
function saveProfiles(profiles) {
  if (!_settingsStore) return;
  _settingsStore.set("auth.profiles", JSON.stringify(profiles));
}

/**
 * Add a new auth profile.
 * @param {object} profile - { name, provider, apiKey, model?, baseUrl?, enabled? }
 * @returns {object} The created profile (without apiKey in response)
 */
export function addProfile({ name, provider, apiKey, model, baseUrl, enabled = true }) {
  if (!name || !provider || !apiKey) {
    throw new Error("name, provider, and apiKey are required");
  }

  const profiles = loadProfiles();
  const id = `profile_${Date.now().toString(36)}`;
  const newProfile = { id, name, provider, apiKey, model: model || null, baseUrl: baseUrl || null, enabled };
  profiles.push(newProfile);
  saveProfiles(profiles);

  return { id, name, provider, model, baseUrl, enabled };
}

/**
 * Update an existing profile.
 * @param {string} id
 * @param {object} updates
 * @returns {object|null}
 */
export function updateProfile(id, updates) {
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const allowed = ["name", "provider", "apiKey", "model", "baseUrl", "enabled"];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      profiles[idx][key] = updates[key];
    }
  }

  saveProfiles(profiles);
  return { ...profiles[idx], apiKey: undefined }; // Don't return key
}

/**
 * Remove a profile.
 * @param {string} id
 * @returns {boolean}
 */
export function removeProfile(id) {
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return false;

  profiles.splice(idx, 1);
  saveProfiles(profiles);
  cooldowns.delete(id);
  usageStats.delete(id);
  return true;
}

/**
 * Put a profile into cooldown (after a failure).
 * @param {string} profileId
 * @param {string} reason
 */
export function setCooldown(profileId, reason = "API error") {
  cooldowns.set(profileId, {
    until: Date.now() + COOLDOWN_MS,
    reason,
  });

  const stats = usageStats.get(profileId) || { requests: 0, lastUsed: null, errors: 0 };
  stats.errors++;
  usageStats.set(profileId, stats);
}

/**
 * Check if a profile is in cooldown.
 * @param {string} profileId
 * @returns {boolean}
 */
export function isInCooldown(profileId) {
  const cd = cooldowns.get(profileId);
  if (!cd) return false;
  if (Date.now() >= cd.until) {
    cooldowns.delete(profileId);
    return false;
  }
  return true;
}

/**
 * Track usage for a profile.
 * @param {string} profileId
 */
export function trackUsage(profileId) {
  const stats = usageStats.get(profileId) || { requests: 0, lastUsed: null, errors: 0 };
  stats.requests++;
  stats.lastUsed = new Date().toISOString();
  usageStats.set(profileId, stats);
}

/**
 * Resolve the best available profile for a provider.
 * Skips profiles in cooldown, returns first available enabled profile.
 *
 * @param {string} provider - Provider ID
 * @param {string} [profileName] - Specific profile name (from @syntax)
 * @returns {object|null} { profileId, apiKey, model, baseUrl }
 */
export function resolveProfile(provider, profileName) {
  const profiles = loadProfiles();
  const candidates = profiles.filter(
    (p) => p.provider === provider && p.enabled
  );

  if (candidates.length === 0) return null;

  // If specific profile requested
  if (profileName) {
    const specific = candidates.find(
      (p) => p.name.toLowerCase() === profileName.toLowerCase()
    );
    if (specific && !isInCooldown(specific.id)) {
      return {
        profileId: specific.id,
        apiKey: specific.apiKey,
        model: specific.model,
        baseUrl: specific.baseUrl,
      };
    }
    // Fall through to rotation if specific is in cooldown
  }

  // Auto-rotation: pick first non-cooldown profile
  for (const p of candidates) {
    if (!isInCooldown(p.id)) {
      return {
        profileId: p.id,
        apiKey: p.apiKey,
        model: p.model,
        baseUrl: p.baseUrl,
      };
    }
  }

  // All in cooldown — return first anyway (will likely fail, but better than nothing)
  return {
    profileId: candidates[0].id,
    apiKey: candidates[0].apiKey,
    model: candidates[0].model,
    baseUrl: candidates[0].baseUrl,
  };
}

/**
 * Get all profiles with stats (redacted keys).
 * @returns {Array}
 */
export function getProfilesWithStats() {
  const profiles = loadProfiles();
  return profiles.map((p) => ({
    id: p.id,
    name: p.name,
    provider: p.provider,
    model: p.model,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    apiKeyHint: p.apiKey ? "***" + p.apiKey.slice(-4) : null,
    inCooldown: isInCooldown(p.id),
    cooldownReason: cooldowns.get(p.id)?.reason || null,
    stats: usageStats.get(p.id) || { requests: 0, lastUsed: null, errors: 0 },
  }));
}
