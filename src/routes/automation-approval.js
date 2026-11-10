import { Router } from "express";
import { SettingsStore } from "../db/settings.js";
import { AUTOMATION_FILES, isAutomationFile, approveIfUnchanged, automationStatus } from "../lib/automation-approval.js";

/**
 * The owner's OK for HEARTBEAT.md and BOOT.md (lib/automation-approval.js), for Settings > Automation.
 * Mounted at /api/automation-approval behind sign-in and the CSRF check (src/server.js).
 *
 *   GET  /            { files: [{ name, text, empty, approved, waiting, approval, waitingSince }] }, HEARTBEAT.md
 *                     first. waiting: the file changed outside Settings and won't run until the owner OKs it.
 *   POST /approve     { name, text, via? }: the owner's OK for `text`, the text the page showed (via "editor" when the
 *                     Settings editor saved it, otherwise the note's button). 409, with the file as it is now, when
 *                     the file no longer holds that text.
 */
export const automationApprovalRouter = Router();

function storeOf(req) {
  return req.app.get("settingsStore") || new SettingsStore(req.app.get("db"));
}

function allFiles(store) {
  return Object.keys(AUTOMATION_FILES).map((name) => automationStatus(store, name));
}

automationApprovalRouter.get("/", (req, res) => {
  try {
    res.json({ files: allFiles(storeOf(req)) });
  } catch (err) {
    res.status(500).json({ error: `Could not read HEARTBEAT.md and BOOT.md: ${err.message}` });
  }
});

automationApprovalRouter.post("/approve", (req, res) => {
  // The owner's signed-in dashboard only, as for switching on a scheduled task the AI made: the API token (Bearer)
  // also drives Tarsee from scripts, and it sits on the same disk the AI's own shell can read, so an OK given with it
  // wouldn't be the owner's. The dashboard sends this without the token (js/settings.js _ownerPost).
  if (req.auth?.method !== "session") {
    return res.status(403).json({ error: "Only you can OK this, from Tarsee's dashboard while signed in. The API token can't." });
  }
  const { name, text, via } = req.body || {};
  if (!isAutomationFile(name)) {
    return res.status(400).json({ error: `Only ${Object.keys(AUTOMATION_FILES).join(" and ")} wait for your OK.` });
  }
  if (typeof text !== "string") {
    return res.status(400).json({ error: "Send the text the page showed, so only that text is OK'd." });
  }
  const store = storeOf(req);
  const by = via === "editor" ? "editor" : "button";
  try {
    const result = approveIfUnchanged(store, name, text, by);
    if (!result.ok) {
      return res.status(409).json({
        error: `${name} changed again since this page showed it, so nothing was OK'd. Read the new text, then OK it if it's right.`,
        file: automationStatus(store, name),
      });
    }
    if (result.changed) console.log(`[automation] the owner OK'd ${name} (${by === "editor" ? "saved in Settings" : "from the Settings note"})`);
    res.json({ ok: true, file: automationStatus(store, name) });
  } catch (err) {
    res.status(500).json({ error: `Could not save your OK for ${name}: ${err.message}` });
  }
});
