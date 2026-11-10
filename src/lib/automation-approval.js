import crypto from "node:crypto";
import { readWorkspaceFile, truncateContent, getHeartbeatContext, getBootContext } from "./workspace-files.js";

/**
 * The owner's OK for HEARTBEAT.md and BOOT.md.
 *
 * Both files run the AI on their own: HEARTBEAT.md every 30 minutes (lib/heartbeat.js), BOOT.md when Tarsee restarts
 * (lib/boot-runner.js), and each run is paid for. The AI can write either file with its file tools in any chat, so
 * neither runs text the owner hasn't OK'd. The owner OKs a text by:
 *   - saving it in Settings > Automation's editor (the editor's autosave, then POST /api/automation-approval/approve
 *     with via "editor"), or
 *   - clicking Let it run (BOOT.md: Run at each restart) on the "Changed outside Settings" note, which OKs only the
 *     text the page showed (routes/automation-approval.js).
 * Both come only from the owner's signed-in dashboard: the API token can't OK anything.
 *
 * The first start of this version OKs what is already there, once (upgradeApproval), so an existing install keeps
 * running exactly as it did.
 *
 * Kept in the settings, per file (<key> is "heartbeat" or "boot"):
 *   <key>.approvedHash   textHash() of the OK'd text
 *   <key>.approval       { by, at }: by is "editor" (saved in Settings), "button" (the note's button) or "upgrade"
 *   <key>.waiting        { hash, since }: a text that changed outside Settings and waits for the owner's OK
 * POST /api/settings/general refuses these keys (isApprovalKey): only the routes above write them.
 */
export const AUTOMATION_FILES = Object.freeze({
  "HEARTBEAT.md": Object.freeze({ key: "heartbeat", prompt: getHeartbeatContext }),
  "BOOT.md": Object.freeze({ key: "boot", prompt: getBootContext }),
});

const APPROVAL_FIELDS = ["approvedHash", "approval", "waiting"];

export function isAutomationFile(name) {
  return typeof name === "string" && Object.hasOwn(AUTOMATION_FILES, name);
}

/** Whether a settings key holds the owner's OK (or the note that one is waited for). */
export function isApprovalKey(key) {
  return Object.values(AUTOMATION_FILES).some(({ key: k }) => APPROVAL_FIELDS.some((f) => key === `${k}.${f}`));
}

function specOf(name) {
  if (!isAutomationFile(name)) throw new Error(`Only ${Object.keys(AUTOMATION_FILES).join(" and ")} need the owner's OK`);
  return AUTOMATION_FILES[name];
}

/** The text with its line endings made one kind, so a file saved on Windows matches the text the page showed. */
export function normalizeText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n");
}

/** What is stored for an OK'd text. Prefixed, so the settings store never reads it back as a number. */
export function textHash(text) {
  return `sha256:${crypto.createHash("sha256").update(normalizeText(text), "utf8").digest("hex")}`;
}

function clearWaiting(store, key) {
  if (store.get(`${key}.waiting`) != null) store.delete(`${key}.waiting`);
}

/** The owner's OK for `text`: what runs from now on, until the file changes. */
export function approveText(store, name, text, by) {
  const { key } = specOf(name);
  const approval = { by, at: new Date().toISOString() };
  store.set(`${key}.approvedHash`, textHash(text));
  store.set(`${key}.approval`, approval);
  clearWaiting(store, key);
  return approval;
}

/**
 * The owner's OK for the text the page showed. Approves only when the file still holds that text (line endings aside);
 * otherwise nothing is OK'd and { ok: false } comes back, for the page to show the new text. changed says whether the
 * OK'd text is another one than before (the editor's autosave OKs the same text again and again).
 */
export function approveIfUnchanged(store, name, shownText, by) {
  const { key } = specOf(name);
  const current = readWorkspaceFile(name);
  if (normalizeText(current) !== normalizeText(shownText)) return { ok: false };
  const changed = store.get(`${key}.approvedHash`) !== textHash(current);
  approveText(store, name, current, by);
  return { ok: true, changed };
}

/**
 * The first start of this version: no OK is stored yet for `name`, so what is there now (written under an older
 * Tarsee, which ran it without asking) counts as OK'd, and that is noted ({ by: "upgrade" }). Runs once: after it,
 * an OK is always stored, so a change the AI makes later waits, through restarts too. Returns whether it ran.
 */
export function upgradeApproval(store, name, log = console.log) {
  const { key } = specOf(name);
  if (store.get(`${key}.approvedHash`) != null) return false;
  const text = readWorkspaceFile(name);
  approveText(store, name, text, "upgrade");
  if (specOf(name).prompt()) {
    log(`[${key}] first start of this version: the ${name} already here counts as OK'd by the owner, so it keeps running as before. From now on a change made outside Settings waits for the owner's OK.`);
  }
  return true;
}

/**
 * Whether `name` may run now, and what it sends: { run: true, prompt } for text the owner has OK'd; otherwise
 * { run: false, reason } with empty: true (nothing to do, as before) or waiting: true. A text that waits is noted in
 * the settings (<key>.waiting) and logged once a change, not at every check.
 */
export function gateAutomation(store, name, log = console.log) {
  const { key, prompt: promptOf } = specOf(name);
  const text = readWorkspaceFile(name);
  const prompt = promptOf();
  if (!prompt) {
    clearWaiting(store, key);
    return { run: false, empty: true, reason: `${name} is empty` };
  }
  // The prompt comes from a second read of the file. Should a write land between the two, what would be sent isn't
  // the text checked below: nothing runs this time, and the next check sees the file as it is.
  if (prompt !== truncateContent(text)) {
    return { run: false, reason: `${name} changed while Tarsee was reading it: checked again next time` };
  }
  const hash = textHash(text);
  if (store.get(`${key}.approvedHash`) === hash) {
    clearWaiting(store, key);
    return { run: true, prompt };
  }
  const reason = `${name} changed outside Settings: waiting for the owner's OK`;
  if (store.get(`${key}.waiting`)?.hash !== hash) {
    store.set(`${key}.waiting`, { hash, since: new Date().toISOString() });
    log(`[${key}] ${reason}`);
  }
  return { run: false, waiting: true, reason };
}

/**
 * One file as Settings > Automation shows it: { name, text, empty, approved, waiting, approval, waitingSince }.
 * waiting means it holds something to do that the owner hasn't OK'd.
 */
export function automationStatus(store, name) {
  const { key, prompt: promptOf } = specOf(name);
  const text = readWorkspaceFile(name);
  const empty = !promptOf();
  const approved = store.get(`${key}.approvedHash`) === textHash(text);
  const approval = store.get(`${key}.approval`);
  const waiting = store.get(`${key}.waiting`);
  return {
    name,
    text,
    empty,
    approved,
    waiting: !empty && !approved,
    approval: approval && typeof approval === "object" ? approval : null,
    waitingSince: !empty && !approved && waiting?.hash === textHash(text) ? waiting.since || null : null,
  };
}
