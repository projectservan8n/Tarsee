/**
 * Credential inventory — one-shot snapshot of every credential Tarsee
 * can reach, injected into the system prompt on session start so Claude
 * knows what's available without running a tool to find out.
 *
 * Covers:
 *   - Vault keys (names + descriptions, never values)
 *   - AI provider readiness (configured via DB or env)
 *   - Channels that are actually running vs configured but stopped
 *   - Opt-in integrations with their own config shape (captcha, push)
 *
 * Also does a boot-time integrity check — tries to decrypt every vault
 * entry so we loudly surface anything that got orphaned by a changed
 * ENCRYPTION_KEY after a redeploy. The volume persists but the key
 * doesn't; this catches that mismatch in seconds instead of the first
 * time a tool silently returns null.
 */

import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { isEncrypted, decrypt, maskSecret } from "./vault.js";
import { AI_PROVIDERS } from "../config/constants.js";

const VAULT_FILE = path.join(config.DATA_DIR, "vault.json");

/**
 * Known env-only integrations — credentials Tarsee might have that
 * don't live in the vault and don't belong to a specific AI provider.
 * Listed here so the inventory can report them as "available" even
 * when the vault is empty.
 */
const ENV_INTEGRATIONS = [
  { name: "ELEVENLABS_API_KEY", label: "ElevenLabs TTS", envKey: "ELEVENLABS_API_KEY", settingsKey: "ai.elevenlabs.apiKey" },
  { name: "CAPTCHA",            label: "Captcha solver",  envKey: "CAPTCHA_API_KEY",    settingsKey: "captcha.api_key" },
];

/**
 * Collect the full credential inventory.
 *
 * @param {object} opts
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @param {import('../channels/manager.js').ChannelManager} [opts.channelManager]
 * @returns {{
 *   vault: Array<{name: string, description: string, masked: string, updatedAt: string}>,
 *   broken: Array<{name: string, reason: string}>,
 *   providers: Array<{id: string, configured: boolean, source: 'env'|'db'|'implicit', model: string|null}>,
 *   integrations: Array<{label: string, configured: boolean, source: 'env'|'db'|null}>,
 *   channels: Record<string, {status: string, error?: string}>,
 * }}
 */
export function getCredentialInventory({ settingsStore, channelManager = null }) {
  const vault = [];
  const broken = [];
  for (const entry of safeListKeys()) {
    if (entry._broken) {
      broken.push({ name: entry.name, reason: entry._brokenReason });
    } else {
      vault.push({
        name: entry.name,
        description: entry.description,
        masked: entry.masked,
        updatedAt: entry.updatedAt,
      });
    }
  }

  const providers = [];
  for (const [id, def] of Object.entries(AI_PROVIDERS)) {
    const dbKey = settingsStore.get(`ai.${id}.apiKey`);
    const envKey = def.envKey ? process.env[def.envKey] : null;
    const model = settingsStore.get(`ai.${id}.model`) || def.defaultModel || null;
    let source = null;
    let configured = false;
    if (def.noKeyRequired) { configured = true; source = "implicit"; }
    else if (dbKey)        { configured = true; source = "db"; }
    else if (envKey)       { configured = true; source = "env"; }
    providers.push({ id, configured, source, model });
  }

  const integrations = ENV_INTEGRATIONS.map((i) => {
    const dbVal = i.settingsKey ? settingsStore.get(i.settingsKey) : null;
    const envVal = i.envKey ? process.env[i.envKey] : null;
    return {
      label: i.label,
      configured: !!(dbVal || envVal),
      source: dbVal ? "db" : envVal ? "env" : null,
    };
  });

  let channels = {};
  if (channelManager?.getStatus) {
    try { channels = channelManager.getStatus(); } catch { channels = {}; }
  }

  return { vault, broken, providers, integrations, channels };
}

/**
 * Render the inventory into a compact system-prompt section. Only the
 * sections with actual content render — an unconfigured provider list
 * never shows up, so the prompt stays lean when the operator hasn't
 * wired much up yet.
 *
 * Returned string is prefixed with two newlines + `## Available`
 * section header, ready to concatenate onto the prompt buffer.
 *
 * @param {ReturnType<getCredentialInventory>} inv
 * @returns {string}
 */
export function renderInventoryPromptSection(inv) {
  const lines = [];
  lines.push("\n\n## Available Credentials");
  lines.push(
    "(Inventory auto-loaded so you don't have to call a tool to check. " +
    "Values live in the vault — fetch with `tarsee_get_key` when you need them. " +
    "`tarsee_list_keys` re-queries live if something changes this session.)"
  );

  const readyProviders = inv.providers.filter((p) => p.configured);
  if (readyProviders.length) {
    lines.push("\n**AI providers ready:**");
    for (const p of readyProviders) {
      const via = p.source === "implicit" ? "no key required" : `configured via ${p.source}`;
      lines.push(`- ${p.id}${p.model ? ` (${p.model})` : ""} — ${via}`);
    }
  }

  if (inv.vault.length) {
    lines.push(`\n**Vault (${inv.vault.length} ${inv.vault.length === 1 ? "key" : "keys"}):**`);
    for (const k of inv.vault) {
      const desc = k.description ? ` — ${k.description}` : "";
      lines.push(`- \`${k.name}\`${desc}`);
    }
  }

  const readyIntegrations = inv.integrations.filter((i) => i.configured);
  if (readyIntegrations.length) {
    lines.push("\n**Integrations:**");
    for (const i of readyIntegrations) {
      lines.push(`- ${i.label} — configured via ${i.source}`);
    }
  }

  const runningChannels = Object.entries(inv.channels).filter(
    ([, v]) => v.status === "running" || v.status === "stopped"
  );
  if (runningChannels.length) {
    lines.push("\n**Channels:**");
    for (const [name, info] of runningChannels) {
      lines.push(`- ${name}: ${info.status}${info.error ? ` (${info.error})` : ""}`);
    }
  }

  if (inv.broken.length) {
    lines.push(
      `\n**⚠ ${inv.broken.length} vault ${inv.broken.length === 1 ? "entry" : "entries"} unreadable:**`
    );
    for (const b of inv.broken) {
      lines.push(`- \`${b.name}\` (${b.reason}) — tell the user this happened and ask to re-save`);
    }
    lines.push(
      "These keys survived the redeploy but can't be decrypted — usually means " +
      "the ENCRYPTION_KEY env var changed. Surface this to the user proactively."
    );
  }

  // Nothing configured — don't bother rendering the header at all.
  if (lines.length <= 2) return "";

  return lines.join("\n");
}

/**
 * Walk the vault and try to decrypt every entry. Returns counts + a
 * list of anything that failed so boot logging can call it out.
 *
 * @returns {{total: number, ok: number, broken: Array<{name: string, reason: string}>}}
 */
export function verifyVaultIntegrity() {
  const total = safeListKeys();
  const broken = total.filter((k) => k._broken).map((k) => ({ name: k.name, reason: k._brokenReason }));
  return { total: total.length, ok: total.length - broken.length, broken };
}

/**
 * Walk the raw vault file and classify every entry as decryptable or
 * broken. Keeping this separate from key-vault's listKeys() so decrypt
 * failure is distinguishable from a legitimately short (masked as
 * "****") secret — listKeys loses that distinction.
 */
function safeListKeys() {
  let raw;
  try {
    if (!fs.existsSync(VAULT_FILE)) return [];
    raw = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8"));
  } catch {
    return [];
  }
  return Object.entries(raw).map(([name, entry]) => {
    const stored = entry?.value ?? "";
    const wasEncrypted = isEncrypted(stored);
    let plain = stored;
    let broken = false;
    let reason = "";
    if (wasEncrypted) {
      try {
        plain = decrypt(stored);
      } catch (err) {
        broken = true;
        reason = (err?.message || "decrypt failed").slice(0, 80);
        plain = "";
      }
    }
    return {
      name,
      description: entry?.description || "",
      masked: plain ? maskSecret(plain) : "****",
      createdAt: entry?.createdAt,
      updatedAt: entry?.updatedAt,
      _broken: broken,
      _brokenReason: broken ? reason : "",
    };
  });
}
