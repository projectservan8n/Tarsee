/**
 * boot-fixups.js: what src/server.js tidies once at boot, before anything reads the settings or the state folder.
 *
 * Older versions left things behind that later code must never pick up, and a turn the last shutdown stopped mid-way
 * left its temporary files. Each step is idempotent, never fails the boot (a step that throws is logged and the others
 * still run), and is tested where it lives:
 *   - the placeholder apiKey "subscription" the old setup wizard saved for the Claude plan (db/settings.js
 *     removeFakeSubscriptionKey, test/settings-keys.test.js);
 *   - per-provider base URLs: a provider's host is fixed in code, Local AI's own address stays (removeProviderBaseUrls,
 *     test/provider-base-url.test.js);
 *   - the masked keys ("sk-p...wxyz") an older Voice tab saved over real ones, and its copy of the OpenAI key nothing
 *     reads (removeVoiceKeyLeftovers, test/settings-key-leftovers.test.js);
 *   - secrets saved empty, such as an older Security tab's captcha Save with the box left empty (removeEmptySecrets,
 *     test/settings-captcha-key.test.js);
 *   - a stopped turn's copies of the person's pictures and a Verify's workspace, over an hour old (lib/turn-leftovers.js,
 *     test/turn-leftovers.test.js).
 * src/server.js calls runBootFixups once, right after it makes the settings store (test/server-boot.test.js).
 */
import { sweepTurnLeftovers } from "./turn-leftovers.js";
import { hideProviders, localAiHiddenHere } from "../ai/provider-registry.js";

/**
 * Run every boot fixup. Returns what each did: { settings: { placeholderKey, baseUrls, voiceKeys, emptySecrets }
 * (each step's own result, null for one that failed), leftovers: { pictures, verify }, hidden: the AIs this install
 * doesn't offer (Local AI on Railway with no address: provider-registry.js localAiHiddenHere) }. Never throws.
 */
export function runBootFixups({ settingsStore, stateDir, tmpDir, now, env = process.env } = {}) {
  const step = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      console.warn(`${what} failed:`, err?.message || err);
      return null;
    }
  };
  const settings = {
    placeholderKey: step("[settings] placeholder key fixup", () => settingsStore.removeFakeSubscriptionKey()),
    baseUrls: step("[settings] base URL fixup", () => settingsStore.removeProviderBaseUrls()),
    voiceKeys: step("[settings] Voice key fixup", () => settingsStore.removeVoiceKeyLeftovers()),
    emptySecrets: step("[settings] empty key fixup", () => settingsStore.removeEmptySecrets()),
  };
  // tmpDir and now default to the system's temp folder and the time now; a test passes its own.
  const leftovers = step("[boot] the stopped turns' leftovers sweep", () => sweepTurnLeftovers({ stateDir, tmpDir, now })) || { pictures: 0, verify: 0 };
  if (leftovers.pictures || leftovers.verify) {
    console.log(`[boot] removed what stopped turns left behind: ${leftovers.pictures} picture folder(s), ${leftovers.verify} Verify workspace(s)`);
  }
  const hidden = step("[boot] which AIs this install offers", () => {
    const ids = localAiHiddenHere({ env, store: settingsStore }) ? ["local"] : [];
    hideProviders(ids);
    if (ids.length) console.log("[ai] Local AI isn't offered on Railway (it has no GPUs). To use a model server you run elsewhere, set TARSEE_LOCAL_AI_URL to its address.");
    return ids;
  }) || [];
  return { settings, leftovers, hidden };
}
