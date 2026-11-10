import { Router } from "express";
import { liveSessionId, signInEnded, signInRanOut } from "../middleware/auth.js";
import { AuditLog } from "../db/audit.js";
import { listKeys, setKey, deleteKey, serverOnlyName, serverOnlyTool } from "../lib/key-vault.js";

/**
 * Settings > Keys: the vault's keys (lib/key-vault.js) for the owner to see by name, add or replace, and delete.
 * Mounted at /api/settings/keys (routes/settings.js), behind sign-in and the CSRF check (src/server.js).
 *
 *   GET    /         { keys: [{ name, description, savedAt, createdAt, serverOnly, usedBy }] }, by name. savedAt:
 *                    when its value was last saved. serverOnly: one of Tarsee's own keys (SERVER_ONLY_KEYS, the
 *                    Railway token), which the AI never gets; usedBy, the tool that uses it (else null).
 *   POST   /         { name, value, description? }: adds the key, or replaces the value of the one with that name
 *                    (its description stays unless a new one is sent). { ok, replaced, key }.
 *   DELETE /:name    deletes it. 404 when the vault has no key of that name.
 *
 * Only the owner's live sign-in (liveSessionId), as for the owner's chat commands: the API token alone is refused,
 * since the AI's shell can read it (api.token in the state folder) and would otherwise replace Tarsee's own Railway
 * token here, which set_key from chat may not (lib/key-vault.js serverOnlyWriteRefusal). The dashboard sends these
 * with the sign-in's cookie and the CSRF token only (js/settings.js _vaultKeysRequest).
 *
 * No answer carries a value or any part of one (not even the masked ends list_keys shows the AI). Writes and deletes
 * are audited by the key's name.
 */
export const vaultKeysRouter = Router();

/** A name the form takes: a letter first, then letters, digits, _ . or -. A key saved under another (from chat) is
 * still replaced and deleted here by its exact name. */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const NAME_MAX = 128;
const VALUE_MAX = 64 * 1024;
const DESCRIPTION_MAX = 300;

function ownerOnly(req, res, next) {
  if (liveSessionId(req)) return next();
  if (signInEnded(req)) return res.status(403).json({ error: signInRanOut(), needsSignIn: true });
  return res.status(403).json({
    error: "Only you can see and change the vault's keys, from Tarsee's dashboard while signed in. The API token can't: the AI can read it.",
    needsSignIn: true,
  });
}
vaultKeysRouter.use(ownerOnly);

function audit(req, action, name, detail) {
  try {
    const log = req.app.get("auditLog") || (req.app.get("db") ? new AuditLog(req.app.get("db")) : null);
    log?.log({ action, target: `vault.${name}`, actor: "user", ip: req.ip, detail });
  } catch { /* the audit never stops the owner's change */ }
}

/** A key as the page shows it: never its value. */
function shown(k) {
  const own = !!serverOnlyName(k.name);   // get_key and the agent's environment never give it to the AI
  return {
    name: k.name,
    description: k.description || "",
    savedAt: k.updatedAt || k.createdAt || null,
    createdAt: k.createdAt || null,
    serverOnly: own,
    usedBy: own && serverOnlyName(k.name) === k.name ? serverOnlyTool(k.name) : null,
  };
}

const savedNames = () => new Set(listKeys().map((k) => k.name));

vaultKeysRouter.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const keys = listKeys().map(shown).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: `Could not read the vault: ${err.message}` });
  }
});

vaultKeysRouter.post("/", (req, res) => {
  const { name: rawName, value, description } = req.body || {};
  const typed = typeof rawName === "string" ? rawName.trim() : "";
  // One of Tarsee's own keys typed in another case is saved under the name Tarsee reads.
  const name = serverOnlyName(typed) || typed;
  let saved;
  try { saved = savedNames(); } catch (err) { return res.status(500).json({ error: `Could not read the vault: ${err.message}` }); }
  const known = saved.has(name);
  if (!name) return res.status(400).json({ error: "Give the key a name, like STRIPE_SECRET_KEY." });
  if (!known && (name.length > NAME_MAX || !NAME_RE.test(name))) {
    return res.status(400).json({ error: `A key's name starts with a letter and has only letters, digits, _ . or - (up to ${NAME_MAX}), like STRIPE_SECRET_KEY.` });
  }
  if (typeof value !== "string" || !value.trim()) return res.status(400).json({ error: `Paste the value to save as ${name}.` });
  const clean = value.trim();
  if (clean.length > VALUE_MAX) return res.status(400).json({ error: `That value is over ${VALUE_MAX / 1024} KB: too big for the vault.` });
  if (description != null && typeof description !== "string") return res.status(400).json({ error: "The description is text." });
  const about = typeof description === "string" ? description.trim() : "";
  if (about.length > DESCRIPTION_MAX) return res.status(400).json({ error: `Keep the description to ${DESCRIPTION_MAX} characters.` });
  try {
    setKey(name, clean, about, { owner: true });
    const key = listKeys().find((k) => k.name === name);
    audit(req, "credential.write", name, known ? "Replaced in Settings > Keys" : "Added in Settings > Keys");
    res.json({ ok: true, replaced: known, key: shown(key || { name, description: about }) });
  } catch (err) {
    res.status(500).json({ error: `Could not save ${name}: ${err.message}` });
  }
});

vaultKeysRouter.delete("/:name", (req, res) => {
  const name = String(req.params.name ?? "");
  try {
    if (!savedNames().has(name)) return res.status(404).json({ error: `The vault has no key named ${name}.` });
    deleteKey(name, { owner: true });
    audit(req, "credential.delete", name, "Deleted in Settings > Keys");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not delete ${name}: ${err.message}` });
  }
});
