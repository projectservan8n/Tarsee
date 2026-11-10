import crypto from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Router } from "express";
import { validateSessionFromRequest, signInEnded, signInRanOut } from "../middleware/auth.js";
import { csrfProtect } from "../middleware/security.js";
import { SettingsStore, isAiKeySlot, isEmptySetting, OLD_VOICE_KEY } from "../db/settings.js";
import { getProvider, isShipped, shippedProviders, checkKeySlot } from "../ai/provider-registry.js";
import { providerStatus, activeTarget, credentialPresence } from "../ai/provider-status.js";
import { ensureLocalModels } from "../ai/provider-models.js";
import { readWorkspaceFile, writeWorkspaceFile, hasBootstrapFile, deleteBootstrapFile } from "../lib/workspace-files.js";
import { initTTSEngine } from "../voice/engine-registry.js";
import { redactSecretFields, isSecretKey } from "../lib/vault.js";
import { brandStatus, saveBrandIcon, resetBrandIcon, decodeBase64 } from "../lib/brand-icon.js";
import { isApprovalKey } from "../lib/automation-approval.js";
import { vaultKeysRouter } from "./vault-keys.js";

export const settingsRouter = Router();

let settingsStore = null;

settingsRouter.use((req, _res, next) => {
  if (!settingsStore) settingsStore = new SettingsStore(req.app.get("db"));
  next();
});

// Settings > Keys: the vault's keys, for the owner's live sign-in only (routes/vault-keys.js).
settingsRouter.use("/keys", vaultKeysRouter);

/**
 * GET /api/settings
 * Get all settings (redacted API keys).
 */
settingsRouter.get("/", (_req, res) => {
  const all = settingsStore.all();

  // Redact API keys — show only last 4 chars
  const redacted = all.map((s) => {
    if (s.key.endsWith(".apiKey") && typeof s.value === "string" && s.value.length > 4) {
      return { ...s, value: "***" + s.value.slice(-4) };
    }
    // Strip credential fields out of ANY structured setting, at any depth.
    //
    // This used to special-case `channel.email` only, so IMAP and SMTP
    // passwords were hidden while the Telegram bot token, the Discord bot
    // token, the Slack app token and the WHAPI webhook secret were all
    // returned in cleartext to anything that could call this endpoint —
    // including the debug console and any script holding the API token.
    // Each of those is enough to impersonate the bot on its platform.
    // Fields come back as `hasToken` / `hasPassword` booleans, which is all
    // the UI ever needed to render "configured".
    if (s.value && typeof s.value === "object") {
      return { ...s, value: redactSecretFields(s.value) };
    }
    return s;
  });

  res.json({ settings: redacted });
});

/**
 * POST /api/settings/provider
 * The old setup wizard's route, kept as a thin shim: Settings > AI uses /api/ai (routes/ai.js).
 * Body: { provider, model?, apiKey? }. provider is a public id or the Claude plan's "claude-code"; it is stored
 * under the provider's storage id. A key is checked as Settings > AI checks it (format and wrong slot) and saved
 * encrypted; the placeholder apiKey "subscription" the old wizard sent for the Claude plan is ignored. A baseUrl is
 * refused: a provider's host is fixed in code, so a stored key only ever goes to its own provider.
 */
settingsRouter.post("/provider", (req, res) => {
  const { provider, model, apiKey } = req.body || {};

  const p = getProvider(provider);
  if (!p || !isShipped(p.id)) {
    return res.status(400).json({ error: "Invalid provider. Valid: " + shippedProviders().map((s) => s.id).join(", ") });
  }
  if (req.body?.baseUrl != null && req.body.baseUrl !== "") {
    return res.status(400).json({ error: "A provider's base URL can't be set: each provider's host is fixed, so its key only ever goes there." });
  }
  const key = typeof apiKey === "string" ? apiKey.trim().replace(/^(["'])(.*)\1$/, "$2").trim() : "";
  const placeholder = p.id === "claude" && key === "subscription";
  if (key && !placeholder) {
    const slot = checkKeySlot(p.id, key);
    if (!slot.ok) return res.status(400).json({ error: slot.message });
    if (/\s|\0/.test(key)) return res.status(400).json({ error: "This key has a line break or a space in it. Copy it again and paste it whole." });
  }

  settingsStore.setActiveProvider(p.storageId, { model: typeof model === "string" && model.trim() ? model.trim() : undefined });
  if (key && !placeholder) settingsStore.set(`ai.${p.storageId}.apiKey`, key, { actor: "user", ip: req.ip });

  res.json({ ok: true, provider: p.storageId, model: (typeof model === "string" && model.trim()) || p.defaultModel || null });
});

/**
 * POST /api/settings/channel
 * Configure a messaging channel.
 *
 * Token-based channels (Discord, Telegram, Slack):
 *   Body: { type, token, appToken?, enabled, ...opts }
 *
 * Email channel:
 *   Body: { type: "email", enabled, tarseeEmailAddress, imap:{host,port,user,password,secure?},
 *           smtp:{host,port,user,password,secure?}, allowlistFromAddresses?:string[],
 *           mentionKeyword?:string, replyAllMarker?:string, fromName?:string }
 *   Passwords in imap.password / smtp.password auto-encrypt via the
 *   vault's .password$ regex (see src/lib/vault.js). A password left out keeps the saved one only while the side's
 *   server stays the same: a save that changes its host, port, user or secure setting must carry its password, or it
 *   gets 400 with needsPassword: ["imap"|"smtp"] and nothing is saved. A host, port or user left empty keeps the saved
 *   one; secure left out keeps the saved setting (and requireTLS) while the port stays.
 *   senderCheck?: { trustFromLine, authservId }: what the owner trusts to say who sent a mail, for the IMAP host saved.
 *   From the owner's live sign-in (whoIsAsking) all of it goes in, and the allowlist is the owner's. With the API token
 *   alone, which the AI's shell can read, what would change who can reach the AI by email or where its mail goes is
 *   saved as waiting (waiting), as the chat tool's is (src/channels/email.js holdForOwner): turning email on, another
 *   IMAP or SMTP host or user, a wider allowlist, more trust in who sent a mail. What narrows goes straight in.
 *   Body { type: "email", waitingAnswer: "approve", waitingId }: the owner's OK for what waits, the very change the page
 *   showed; the owner's live sign-in only. { waitingAnswer: "discard" } turns it down.
 *   Body { type: "email", senderNote: "dismiss" }: the owner's OK on the note saying why mail was refused.
 */
settingsRouter.post("/channel", async (req, res) => {
  const body = req.body || {};
  const { type, enabled } = body;

  if (!["discord", "telegram", "slack", "email", "whatsapp"].includes(type)) {
    return res.status(400).json({ error: "Invalid channel type. Valid: discord, telegram, slack, email, whatsapp" });
  }

  if (type === "email") {
    // The same rules as the chat tool (lib/tools.js configure_email_channel), from src/channels/email.js:
    // test/email-channel-settings.test.js.
    const {
      mailServerOf, mailServerChanges, normalizeAllowlist, senderCheckFor, holdForOwner, ownerSaved, applyWaiting, SENDER_NOTE_KEY,
    } = await import("../channels/email.js");
    const { tarseeEmailAddress, imap, smtp, allowlistFromAddresses, mentionKeyword, replyAllMarker, fromName, defaultSubject } = body;
    const prev = settingsStore.get("channel.email") || {};
    const channelManager = req.app.get("channelManager");
    const restartIfOn = (cfg) => {
      if (channelManager && cfg.enabled && cfg.imap?.host && cfg.smtp?.host) {
        channelManager.restart("email").catch((err) => {
          console.warn("[channels] auto-start email failed:", err.message);
        });
      }
    };
    // The owner is the signed-in dashboard; the API token alone may be the AI's shell, which can read it.
    const who = whoIsAsking(req);
    const liveOwner = who === "owner" && validateSessionFromRequest(req);
    /** 403 for what only the owner's live sign-in may do (`what`: the words after "Sign in again, then"). */
    const ownerOnly = (what, error) => {
      if (who === "stale-page") return res.status(403).json({ error: STALE_PAGE });
      if (who === "signed-out") return res.status(403).json({ error: signInRanOut(what), needsSignIn: true });
      return res.status(403).json({ error, needsSignIn: true });
    };
    const shown = (w) => (w ? redactSecretFields(w) : null);

    // The owner's answer to what waits (the card at the top of Settings > Channels > Email). Approve is the owner's OK,
    // as switching on a scheduled task the AI made is: the owner's live sign-in only, and only for the very change the
    // card showed (waitingId). Discard only turns it down, so the token may send that too.
    if (body.waitingAnswer !== undefined) {
      const answer = body.waitingAnswer;
      if (answer !== "approve" && answer !== "discard") {
        return res.status(400).json({ error: "waitingAnswer must be approve or discard" });
      }
      if (answer === "approve" && !liveOwner) {
        return ownerOnly("approve it", "Only you can OK this, signed in to your dashboard: the API token can't, because the AI can read it. Approve it in Settings > Channels > Email.");
      }
      const current = ownerSaved(prev);
      if (!current.waiting) return res.status(409).json({ error: "Nothing is waiting for your OK any more.", waiting: null });
      if (answer === "approve") {
        if (typeof body.waitingId !== "string" || !body.waitingId) {
          return res.status(400).json({ error: "Tarsee can't tell which change you looked at. Reload the page, look at it again, then approve it." });
        }
        if (body.waitingId !== current.waiting.id) {
          return res.status(409).json({
            error: "What waits for your OK changed after this page showed it, so nothing was changed. Look at it again, then approve it if it's right.",
            waiting: shown(current.waiting),
          });
        }
      }
      let next = current;
      if (answer === "approve") {
        next = applyWaiting(current);
      } else {
        next = { ...current };
        delete next.waiting;
      }
      settingsStore.set("channel.email", next);
      if (answer === "approve") {
        const moved = String(next.imap?.host || "").toLowerCase() !== String(prev.imap?.host || "").toLowerCase();
        if (moved) settingsStore.delete(SENDER_NOTE_KEY);
        console.log(`[channels] the owner OK'd the email change that waited: email ${next.enabled ? "on" : "off"}, reading ${next.imap?.user || "?"} at ${next.imap?.host || "?"}, ${next.allowlistFromAddresses?.length ? `answering ${next.allowlistFromAddresses.join(", ")}` : "answering any sender"}`);
        restartIfOn(next);
      }
      return res.json({ ok: true, type: "email", enabled: next.enabled === true, allowlistFromAddresses: next.allowlistFromAddresses || [] });
    }

    // The owner's "OK" on the one-time note saying why mail was refused (email.js SENDER_NOTE_KEY). It is only hidden,
    // so the channel doesn't write it again for that server; a change of server or trust clears it.
    if (body.senderNote !== undefined) {
      if (body.senderNote !== "dismiss") return res.status(400).json({ error: "senderNote must be dismiss" });
      if (!liveOwner) return ownerOnly("dismiss it", "Only you can dismiss this note, signed in to your dashboard.");
      const note = settingsStore.get(SENDER_NOTE_KEY);
      if (note && typeof note === "object") settingsStore.set(SENDER_NOTE_KEY, { ...note, dismissedAt: new Date().toISOString() });
      return res.json({ ok: true, type: "email" });
    }

    // Signed in, with a page whose CSRF token has run out: the dashboard fetches a fresh one and sends this again, so
    // the owner's save is the owner's (as POST /cron).
    if (who === "stale-page") return res.status(403).json({ error: STALE_PAGE });
    if (enabled) {
      if (!imap?.host || !imap?.user) return res.status(400).json({ error: "IMAP host + user required" });
      if (!smtp?.host || !smtp?.user) return res.status(400).json({ error: "SMTP host + user required" });
    }

    // Each side's server. A host, port or user left empty keeps the saved one (the form sends every field it shows).
    // The saved password stays only with the server it was saved for: another host, port, user or secure setting
    // needs its password in this save, whoever sends it.
    const servers = {};
    const needs = [];
    for (const side of ["imap", "smtp"]) {
      const NAME = side.toUpperCase();
      const given = body[side] ?? {};
      if (typeof given !== "object" || Array.isArray(given)) {
        return res.status(400).json({ error: `${side} must be an object with host, port, user and password.` });
      }
      const was = prev[side] && typeof prev[side] === "object" ? prev[side] : {};
      const saved = mailServerOf(side, was);
      let port = saved.port;
      if (given.port != null && given.port !== "") {
        port = Number(given.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return res.status(400).json({ error: `The ${NAME} port must be a whole number from 1 to 65535.` });
        }
      }
      const text = (v) => (typeof v === "string" ? v.trim() : "");
      const next = {
        host: text(given.host) || saved.host,
        port,
        user: text(given.user) || saved.user,
        // The form has no secure switch. The setting stays as saved while the port does (the chat tool saves secure:
        // false for a STARTTLS port); a new port starts with TLS on, as this form always has.
        secure: typeof given.secure === "boolean" ? given.secure : port === saved.port ? saved.secure : true,
      };
      const password = typeof given.password === "string" ? given.password : "";
      const savedPassword = typeof was.password === "string" ? was.password : "";
      const changed = mailServerChanges(saved, next);
      if (changed.length === 0) {
        // The same server: everything saved for it stays (requireTLS too), with a new password if one was typed.
        servers[side] = { ...was, ...saved, password: password || savedPassword };
        continue;
      }
      if (!password && savedPassword) {
        needs.push({ side, changed });
        continue;
      }
      // Another server, with its own password (or none saved to keep). STARTTLS that must succeed (requireTLS, saved
      // by the chat tool) stays while the port and secure setting do; a new port takes the form's defaults.
      const keepTls = was.requireTLS === true && next.port === saved.port && next.secure === saved.secure;
      servers[side] = { ...next, password, ...(keepTls ? { requireTLS: true } : {}) };
    }
    if (needs.length) {
      const words = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0]);
      const what = needs.map(({ side, changed }) => `the ${side.toUpperCase()} ${words(changed)}`).join(" and ");
      const which = needs.length > 1 ? "the IMAP and SMTP app passwords" : `the ${needs[0].side.toUpperCase()} app password`;
      return res.status(400).json({
        error: `You changed ${what}, so type ${which} again: Tarsee only sends a saved password to the server it was saved for. Nothing was saved.`,
        needsPassword: needs.map(({ side }) => side),
      });
    }

    if (allowlistFromAddresses != null && (!Array.isArray(allowlistFromAddresses) || allowlistFromAddresses.some((a) => typeof a !== "string"))) {
      return res.status(400).json({ error: "allowlistFromAddresses must be a list of email addresses." });
    }
    // What the owner trusts to say who sent a mail (email.js senderVouched): a server name of their own, or the From
    // line itself, for a server that checks nothing.
    const check = body.senderCheck;
    if (check != null) {
      const id = check.authservId;
      if (typeof check !== "object" || Array.isArray(check)
        || (check.trustFromLine != null && typeof check.trustFromLine !== "boolean")
        || (id != null && (typeof id !== "string" || !/^[A-Za-z0-9.-]{0,253}$/.test(id.trim())))) {
        return res.status(400).json({ error: "senderCheck is { trustFromLine: true or false, authservId: your mail server's name, such as mail.example.com }." });
      }
    }
    const askedCheck = check != null ? { trustFromLine: check.trustFromLine === true, authservId: typeof check.authservId === "string" ? check.authservId.trim().toLowerCase() : "" } : null;

    const next = {
      ...prev,
      enabled: !!enabled,
      tarseeEmailAddress: tarseeEmailAddress || prev.tarseeEmailAddress || imap?.user || "",
      fromName: fromName || prev.fromName || "Tarsee",
      defaultSubject: defaultSubject || prev.defaultSubject || "Tarsee",
      mentionKeyword: mentionKeyword || prev.mentionKeyword || "tarsee",
      replyAllMarker: replyAllMarker || prev.replyAllMarker || "[reply-all]",
      allowlistFromAddresses: allowlistFromAddresses != null
        ? normalizeAllowlist(allowlistFromAddresses)
        : (Array.isArray(prev.allowlistFromAddresses) ? prev.allowlistFromAddresses : []),
      imap: servers.imap,
      smtp: servers.smtp,
    };

    let payload;
    let held = [];
    if (liveOwner) {
      // The owner's own save: all of it in force. The list is the owner's from now on, and so is the sender check, kept
      // with the IMAP host it is for. What waited stays waiting unless this save made it moot.
      payload = { ...next };
      if (allowlistFromAddresses != null) payload.allowlistOwner = next.allowlistFromAddresses;
      if (askedCheck) {
        if (askedCheck.trustFromLine || askedCheck.authservId) payload.senderCheck = { imapHost: servers.imap.host || "", ...askedCheck };
        else delete payload.senderCheck;
      }
      payload = ownerSaved(payload);
      const before = senderCheckFor(prev.senderCheck, prev.imap?.host);
      const after = senderCheckFor(payload.senderCheck, payload.imap?.host);
      const moved = String(payload.imap?.host || "").toLowerCase() !== String(prev.imap?.host || "").toLowerCase();
      if (moved || before.trustFromLine !== after.trustFromLine || before.authservId !== after.authservId) settingsStore.delete(SENDER_NOTE_KEY);
    } else {
      // Anyone else, the API token alone above all: what would let more reach the AI, or send its mail elsewhere,
      // waits for the owner's OK, as the chat tool's does.
      ({ cfg: payload, held } = holdForOwner(prev, { ...next, senderCheck: askedCheck }, {
        enabled: true,
        imap: body.imap != null,
        smtp: body.smtp != null,
        allowlist: allowlistFromAddresses != null,
        senderCheck: askedCheck != null,
      }, "token"));
      // The owner's tab whose sign-in ran out: sign in again rather than leave the owner's own change waiting.
      if (held.length && who === "signed-out") {
        return res.status(403).json({ error: signInRanOut("save again"), needsSignIn: true });
      }
    }
    settingsStore.set("channel.email", payload);

    if (channelManager && payload.enabled) restartIfOn(payload);
    else if (channelManager && !payload.enabled) channelManager.stop("email").catch(() => {});

    return res.json({
      ok: true,
      type: "email",
      enabled: payload.enabled === true,
      ...(payload.waiting ? { waiting: shown(payload.waiting) } : {}),
      ...(held.length ? { note: "Part of this save would change who can reach Tarsee by email or where its mail goes, so it waits for the owner's OK in Settings > Channels > Email. Until then Tarsee goes on with the settings in force." } : {}),
    });
  }

  if (type === "whatsapp") {
    // WhatsApp via WHAPI. Each channel needs a per-instance webhook secret
    // (WHAPI does not sign webhooks) — minted on first enable, preserved
    // across re-saves, regenerated only via the dedicated endpoint below.
    const prev = settingsStore.get("channel.whatsapp") || {};
    const { token, baseUrl } = body;
    if (enabled && !token && !prev.token) {
      return res.status(400).json({ error: "WHAPI token required to enable" });
    }
    const webhook_secret = prev.webhook_secret || crypto.randomBytes(32).toString("hex");
    const payload = {
      enabled: !!enabled,
      token: token || prev.token || null,
      baseUrl: baseUrl || prev.baseUrl || "https://gate.whapi.cloud",
      webhook_secret,
    };
    settingsStore.set("channel.whatsapp", payload);

    const channelManager = req.app.get("channelManager");
    if (channelManager && payload.enabled && payload.token) {
      channelManager.restart("whatsapp").catch((err) => {
        console.warn("[channels] auto-start whatsapp failed:", err.message);
      });
    } else if (channelManager) {
      channelManager.stop("whatsapp").catch(() => {});
    }

    return res.json({
      ok: true,
      type: "whatsapp",
      enabled: payload.enabled,
      webhook_url: `/api/channels/whapi/${webhook_secret}`,
    });
  }

  if (type === "slack") {
    // Two tokens: the bot token (xoxb-) for the Web API and the app-level token (xapp-) for the Socket Mode
    // connection. Either one left out keeps the stored one, so a save from the page (which never gets the tokens
    // back) changes only what was typed. They are easy to paste the wrong way round, so say which is which.
    const prev = settingsStore.get("channel.slack") || {};
    const token = String(body.token || "").trim();
    const appToken = String(body.appToken || "").trim();
    if (token && !token.startsWith("xoxb-")) {
      return res.status(400).json({ error: "The bot token starts with xoxb- (Slack app → OAuth & Permissions → Bot User OAuth Token). An xapp- token goes in the app-level token box." });
    }
    if (appToken && !appToken.startsWith("xapp-")) {
      return res.status(400).json({ error: "The app-level token starts with xapp- (Slack app → Basic Information → App-Level Tokens, scope connections:write)." });
    }
    const effectiveToken = token || prev.token || null;
    const effectiveAppToken = appToken || prev.appToken || null;
    if (enabled && !effectiveToken) return res.status(400).json({ error: "The bot token (xoxb-) is required to turn Slack on" });
    if (enabled && !effectiveAppToken) return res.status(400).json({ error: "The app-level token (xapp-) is required to turn Slack on: Socket Mode connects with it" });

    const { type: _t, enabled: _e, token: _tk, appToken: _at, ...opts } = body;
    settingsStore.set("channel.slack", { ...prev, ...opts, enabled: !!enabled, token: effectiveToken, appToken: effectiveAppToken });

    const channelManager = req.app.get("channelManager");
    if (channelManager && enabled) {
      channelManager.restart("slack").catch((err) => {
        console.warn("[channels] auto-start slack failed:", err.message);
      });
    } else if (channelManager) {
      channelManager.stop("slack").catch(() => {});
    }
    return res.json({ ok: true, type: "slack", enabled: !!enabled });
  }

  // Token-based channels (Discord, Telegram).
  //
  // Preserve the stored token when the client does not send one, the way the
  // email and WhatsApp branches already do. GET /api/settings no longer hands
  // back bot tokens in cleartext, so the settings form cannot round-trip one
  // it never received; without this, saving any unrelated channel option (an
  // allowlist edit, toggling mention mode) would blank the token and silently
  // disconnect the bot.
  const { token, appToken, ...opts } = body;
  const prevChannel = settingsStore.get(`channel.${type}`) || {};
  const effectiveToken = token || prevChannel.token || null;
  const effectiveAppToken = appToken || prevChannel.appToken || null;
  if (enabled && !effectiveToken) {
    return res.status(400).json({ error: "Token is required to enable a channel" });
  }

  settingsStore.set(`channel.${type}`, {
    ...prevChannel,
    enabled: !!enabled,
    token: effectiveToken,
    appToken: effectiveAppToken,
    ...opts,
  });

  const channelManager = req.app.get("channelManager");
  if (channelManager && enabled && token) {
    channelManager.restart(type).catch((err) => {
      console.warn(`[channels] auto-start ${type} failed:`, err.message);
    });
  } else if (channelManager && !enabled) {
    channelManager.stop(type).catch(() => {});
  }

  res.json({ ok: true, type, enabled: !!enabled });
});

/**
 * GET /api/settings/channel/slack/manifest
 * The Slack app manifest (src/channels/slack-app-manifest.yml), for the "Copy manifest" button: pasted into
 * api.slack.com/apps → Create New App → From a manifest, it sets up every scope and event the bot uses.
 */
settingsRouter.get("/channel/slack/manifest", (_req, res) => {
  try {
    const yml = fs.readFileSync(new URL("../channels/slack-app-manifest.yml", import.meta.url), "utf8");
    res.type("text/yaml").send(yml);
  } catch (err) {
    res.status(500).json({ error: `Could not read the Slack app manifest: ${err.message}` });
  }
});

/**
 * POST /api/settings/channel/whatsapp/regenerate-secret
 * Mints a fresh webhook secret for the WhatsApp channel. The old URL
 * stops working immediately — the operator must paste the new one into
 * the WHAPI dashboard.
 */
settingsRouter.post("/channel/whatsapp/regenerate-secret", (req, res) => {
  const prev = settingsStore.get("channel.whatsapp") || {};
  if (!prev.token) {
    return res.status(400).json({ error: "Configure the WhatsApp channel before regenerating its secret" });
  }
  const webhook_secret = crypto.randomBytes(32).toString("hex");
  settingsStore.set("channel.whatsapp", { ...prev, webhook_secret });
  res.json({
    ok: true,
    webhook_secret,
    webhook_url: `/api/channels/whapi/${webhook_secret}`,
  });
});

/**
 * GET /api/settings/channel/whatsapp/webhook-url
 *
 * The operator has to paste this URL into the WHAPI dashboard, so unlike the
 * bot tokens it genuinely has to reach the browser. It is served from its own
 * endpoint rather than riding along in the bulk settings payload, so the
 * secret is disclosed only when the WhatsApp panel actually asks for it.
 */
settingsRouter.get("/channel/whatsapp/webhook-url", (_req, res) => {
  const cfg = settingsStore.get("channel.whatsapp") || {};
  if (!cfg.webhook_secret) {
    return res.json({ configured: false, webhook_url: null });
  }
  res.json({ configured: true, webhook_url: `/api/channels/whapi/${cfg.webhook_secret}` });
});

/**
 * GET /api/settings/setup-status
 * Check if first-time setup is needed.
 *
 * An AI counts as set up when the owner chose one (the wizard or Settings > AI save ai.activeProvider), or when
 * Railway variables alone set up a ready one: TARSEE_AI_PROVIDER plus that provider's key, or the Claude plan's
 * CLAUDE_CODE_OAUTH_TOKEN. A Claude sign-in that merely happens to be on the machine doesn't skip the wizard: the
 * owner still picks. ai says which AI would answer and whether it is ready (providerStatus, as Settings > AI shows
 * it); railway lists the providers connected through Railway variables, so the wizard can say so. No key is ever
 * in the answer.
 */
settingsRouter.get("/setup-status", async (req, res) => {
  const env = process.env;
  const chosen = settingsStore.get("ai.activeProvider");
  let target = activeTarget(settingsStore, { env });
  let status = await providerStatus(target.provider, { store: settingsStore, env });
  // Local AI with an address and no model named runs on the first model its server lists, and that list lives only
  // in memory: read it once (ensureLocalModels never throws), so a restart doesn't bring the wizard back.
  if (target.provider === "local" && status.state === "needs-setup") {
    await ensureLocalModels(settingsStore, { env });
    target = activeTarget(settingsStore, { env });
    status = await providerStatus(target.provider, { store: settingsStore, env });
  }
  const fromRailway = (s) => typeof s.keySource === "string" && s.keySource.startsWith("env:");
  const railwayOnly = !chosen && status.ready && (target.chosenBy === "env" || (target.provider === "claude" && fromRailway(status)));
  const configured = !!chosen || railwayOnly;
  const railway = shippedProviders()
    .map((p) => ({ p, s: credentialPresence(p.id, { store: settingsStore, env }) }))
    .filter(({ s }) => fromRailway(s))
    .map(({ p, s }) => ({ id: p.id, label: p.label, envKey: s.keySource.slice(4) }));

  const botName = settingsStore.get("identity.name");
  // Personality is "done" if bot name was set, OR if SOUL.md/systemPrompt exist,
  // OR if setup was explicitly completed, OR if conversations already exist (not first-time)
  const setupCompleted = !!settingsStore.get("setup.completed");
  const db = req.app.get("db");
  const hasConversations = db ? (db.prepare("SELECT COUNT(*) as c FROM conversations").get()?.c || 0) > 0 : false;
  const hasPersonality = !!botName || !!settingsStore.get("identity.systemPrompt") || setupCompleted || hasConversations;
  res.json({
    needsSetup: !configured,
    needsPersonality: !hasPersonality,
    botName: botName || "Tarsee",
    provider: configured ? target.provider : null,
    hasKey: configured,
    ai: {
      provider: target.provider,
      label: target.label,
      model: target.model,
      chosenBy: target.chosenBy,
      state: status.state,
      ready: status.ready,
      detail: status.detail,
      fix: status.fix,
    },
    railway,
  });
});

/**
 * GET /api/settings/workspace-file
 * Read a workspace identity file (SOUL.md, USER.md, MEMORY.md).
 * Query: ?name=SOUL.md
 */
const ALLOWED_WORKSPACE_FILES = [
  "SOUL.md", "USER.md", "MEMORY.md",
  "AGENTS.md", "IDENTITY.md", "TOOLS.md",
  "HEARTBEAT.md", "BOOT.md", "BOOTSTRAP.md",
];

settingsRouter.get("/workspace-file", (req, res) => {
  const name = req.query.name;
  if (!name || !ALLOWED_WORKSPACE_FILES.includes(name)) {
    return res.status(400).json({ error: `Invalid file. Allowed: ${ALLOWED_WORKSPACE_FILES.join(", ")}` });
  }
  const content = readWorkspaceFile(name);
  res.json({ name, content });
});

/**
 * PUT /api/settings/workspace-file
 * Write a workspace identity file.
 * Body: { name, content }
 */
settingsRouter.put("/workspace-file", (req, res) => {
  const { name, content } = req.body || {};
  if (!name || !ALLOWED_WORKSPACE_FILES.includes(name)) {
    return res.status(400).json({ error: `Invalid file. Allowed: ${ALLOWED_WORKSPACE_FILES.join(", ")}` });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ error: "Content must be a string" });
  }
  writeWorkspaceFile(name, content);
  res.json({ ok: true, name });
});

/**
 * POST /api/settings/general
 * Update general settings.
 * Body: { key, value }. For a secret (a key, token or password) an empty value (none, null, "" or only spaces)
 * deletes it: { ok, removed } says whether there was one.
 */
settingsRouter.post("/general", (req, res) => {
  const { key, value } = req.body || {};

  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "Key is required" });
  }

  // Prevent overwriting protected keys (except API keys set via Settings UI)
  const protectedPrefixes = ["channel."];
  if (protectedPrefixes.some((p) => key.startsWith(p))) {
    return res.status(400).json({ error: "Use the dedicated endpoint for channel settings" });
  }

  // An AI's key goes through Settings > AI (PUT /api/ai/keys/<id>), which checks it is that AI's key and never a
  // masked display ("sk-p...wxyz") posted back. The old Voice tab's copy of the OpenAI key is read by nothing.
  if (isAiKeySlot(key) || key === OLD_VOICE_KEY) {
    return res.status(400).json({ error: "Save AI keys in Settings > AI." });
  }

  // The owner's OK for HEARTBEAT.md and BOOT.md is given only from the dashboard's own session
  // (routes/automation-approval.js); written here, the API token could OK what the AI wrote.
  if (isApprovalKey(key)) {
    return res.status(400).json({ error: "OK HEARTBEAT.md and BOOT.md in Settings > Automation." });
  }

  // The saved scheduled tasks change only through /cron below, which keeps the owner's OK: written here, the API token
  // could save a task switched on that the owner never saw, and it would start with Tarsee's next restart.
  if (key === "cron.jobs") {
    return res.status(400).json({ error: "Add, switch on or delete scheduled tasks in Settings > Automation > Scheduled tasks." });
  }

  // Enum-shaped settings — defend the API even though the UI dropdown
  // already constrains the input. Anyone can hit /api/settings/general.
  if (key.endsWith(".mention_mode") && value !== "required" && value !== "off") {
    return res.status(400).json({ error: "mention_mode must be 'required' or 'off'" });
  }

  // A secret sent with nothing in it (Settings > Security's Remove sends "" for the captcha key) is a removal: the row
  // is deleted and audited as credential.delete. Saved, it would sit in the table as an encrypted empty string that
  // read back as a saved key.
  let removed;
  if (isSecretKey(key) && isEmptySetting(value)) {
    removed = settingsStore.delete(key, { actor: "user", ip: req.ip, detail: "Removed in Settings" });
  } else {
    settingsStore.set(key, value, { actor: "user", ip: req.ip });
  }

  // Hot-reload: re-init TTS engine when voice settings change (no restart needed)
  if (key.startsWith("voice.")) {
    initTTSEngine(settingsStore).catch((err) => {
      console.warn("[settings] TTS hot-reload failed:", err.message);
    });
  }

  res.json(removed === undefined ? { ok: true } : { ok: true, removed });
});

/**
 * GET /api/settings/bootstrap-status
 * Check if BOOTSTRAP.md exists (first-run detection).
 */
settingsRouter.get("/bootstrap-status", (_req, res) => {
  res.json({ hasBootstrap: hasBootstrapFile() });
});

/**
 * DELETE /api/settings/bootstrap
 * Delete BOOTSTRAP.md after first-run setup is complete.
 */
settingsRouter.delete("/bootstrap", (_req, res) => {
  deleteBootstrapFile();
  res.json({ ok: true });
});

/**
 * GET /api/settings/session-reset
 * Get session reset configuration.
 */
settingsRouter.get("/session-reset", (_req, res) => {
  res.json({
    mode: settingsStore.get("session.reset.mode") || "manual",
    atHour: Number(settingsStore.get("session.reset.atHour")) || 0,
    idleMinutes: Number(settingsStore.get("session.reset.idleMinutes")) || 60,
  });
});

/**
 * POST /api/settings/session-reset
 * Update session reset configuration.
 * Body: { mode, atHour?, idleMinutes? }
 */
settingsRouter.post("/session-reset", (req, res) => {
  const { mode, atHour, idleMinutes } = req.body || {};

  if (mode && !["manual", "daily", "idle"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode. Valid: manual, daily, idle" });
  }

  if (mode) settingsStore.set("session.reset.mode", mode);
  if (atHour !== undefined) settingsStore.set("session.reset.atHour", String(Math.max(0, Math.min(23, Number(atHour) || 0))));
  if (idleMinutes !== undefined) settingsStore.set("session.reset.idleMinutes", String(Math.max(5, Number(idleMinutes) || 60)));

  res.json({ ok: true });
});

/**
 * GET /api/settings/cron
 * List all cron jobs.
 */
settingsRouter.get("/cron", async (_req, res) => {
  try {
    const { getCronStatus } = await import("../lib/cron.js");
    res.json(getCronStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Who asks to switch a scheduled task on, or to add one switched on:
 *   "owner"       the owner's own dashboard: signed in (the session cookie), with the page's CSRF token.
 *   "stale-page"  signed in, but the page's CSRF token has run out (the dashboard fetches a fresh one and asks again).
 *   "signed-out"  the dashboard after its sign-in ran out: the sign-in's cookie, no longer on (signInEnded), and the API
 *                 token the page still sends. Not the owner, but told to sign in again rather than of the token.
 *   "token"       anything else, the API token alone above all.
 * The API token is never enough. Tarsee saves it in the state folder (api.token) unless TARSEE_API_TOKEN is set, and the
 * AI's shell runs as the same user, so with the token alone the AI could OK the task it has just scheduled. The
 * dashboard sends the token too (js/api.js), and sessionAuth names a request by its token first (req.auth.method
 * "bearer"), so a token request is checked here for the sign-in and the CSRF token, which csrfProtect skips for it. A
 * request let in by the sign-in alone ("session") has passed both (server.js mounts this router behind requireAuth and
 * csrfProtect). With no req.auth at all, nobody signed in.
 */
function whoIsAsking(req) {
  if (req.auth?.method === "session") return "owner";
  if (req.auth?.method === "bearer" && validateSessionFromRequest(req)) return hasPageCsrfToken(req) ? "owner" : "stale-page";
  return signInEnded(req) ? "signed-out" : "token";
}

/** Whether a request carries the page's CSRF token: csrfProtect's own check, run as for a signed-in request. */
function hasPageCsrfToken(req) {
  let passed = false;
  const asSignedIn = { auth: { method: "session" }, method: req.method, headers: req.headers };
  const refused = { status: () => ({ json: () => {} }) };
  try {
    csrfProtect(asSignedIn, refused, () => { passed = true; });
  } catch {
    // a token that isn't one Tarsee made
  }
  return passed;
}

// "CSRF token" in it: js/api.js then fetches a fresh token and sends the request once more.
const STALE_PAGE = "This page's security check (its CSRF token) has run out. Reload the page, then try again.";

const tokenCantSwitchOn = (id) => `Only you can switch a scheduled task on, signed in to your dashboard: the API token can't, because the AI can read it. Switch it on in Settings > Automation > Scheduled tasks, or with /cron on ${id} from your own chat.`;

/**
 * Whether a task is still the one the owner's row showed (CronCore.seenOf in js/cron-core.js): its schedule, and its
 * prompt or, for a task that runs a tool directly, its action.
 */
function sameAsSeen(job, seen) {
  if (!seen || typeof seen !== "object" || seen.schedule !== job.schedule) return false;
  if (job.action?.tool) return isDeepStrictEqual(seen.action, job.action);
  return seen.action == null && seen.prompt === (job.prompt ?? "");
}

/**
 * POST /api/settings/cron
 * Add a task. Body: { schedule, prompt, channel?, enabled? }
 * From the owner's dashboard (the form in Settings > Automation > Scheduled tasks) it is the owner's, switched on. With
 * the API token alone it may be the AI's (whoIsAsking), so it is saved as one the AI made: switched off and waiting for
 * the owner's OK, whatever enabled says, with a note saying so.
 */
settingsRouter.post("/cron", async (req, res) => {
  const { schedule, prompt, channel, enabled } = req.body || {};
  if (!schedule || !prompt) {
    return res.status(400).json({ error: "schedule and prompt are required" });
  }
  const who = whoIsAsking(req);
  if (who === "stale-page") return res.status(403).json({ error: STALE_PAGE });
  try {
    const { addCronJob } = await import("../lib/cron.js");
    if (who === "owner") {
      return res.status(201).json(addCronJob({ schedule, prompt, channel, enabled: enabled !== false, createdBy: "owner" }));
    }
    const job = addCronJob({ schedule, prompt, channel, createdBy: "ai" });
    res.status(201).json({ ...job, note: `Added switched off: a task added with the API token waits for the owner's OK in Settings > Automation > Scheduled tasks (or /cron on ${job.id} from the owner's own chat).` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /api/settings/cron/:id
 * Switch a task on or off (the Switch on and Pause buttons). Body: { enabled: true | false, seen? }.
 * Pausing only stops runs: anyone signed in or with the API token may. Switching on is the owner's OK (a task the AI
 * made stops waiting and gets its timer), so it takes:
 *   - the owner's dashboard (whoIsAsking): the API token alone gets 403, with needsSignIn (the dashboard then asks the
 *     owner to sign in again: its sign-in ran out and it went on with the token). A tab whose sign-in has run out is
 *     told just that ("signed-out"); a caller with no sign-in at all gets the API token's own words;
 *   - seen: what the owner's row showed (CronCore.seenOf): { schedule, prompt }, or { schedule, action }. A task that no
 *     longer matches it (changed where it is saved after the list was drawn) gets 409, and the page draws the list
 *     again; a switch-on without it gets 400.
 */
settingsRouter.patch("/cron/:id", async (req, res) => {
  const { enabled, seen } = req.body || {};
  const id = req.params.id;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be true or false" });
  }
  if (enabled) {
    const who = whoIsAsking(req);
    if (who === "stale-page") return res.status(403).json({ error: STALE_PAGE });
    if (who === "signed-out") return res.status(403).json({ error: signInRanOut("switch the task on"), needsSignIn: true });
    if (who !== "owner") return res.status(403).json({ error: tokenCantSwitchOn(id), needsSignIn: true });
  }
  try {
    const { loadCronJobs, setCronJobEnabled } = await import("../lib/cron.js");
    if (enabled) {
      const saved = loadCronJobs().find((j) => j.id === id);
      if (!saved) return res.status(404).json({ error: `No scheduled task ${id}` });
      if (seen == null) {
        return res.status(400).json({ error: "Tarsee can't tell which version of this task you looked at. Reload the page, look at the task again, then switch it on." });
      }
      if (!sameAsSeen(saved, seen)) {
        return res.status(409).json({ error: "This task changed after your list was drawn: when it runs or what it does is different now. Look at it again, then switch it on if you still want it." });
      }
    }
    // Nothing waits between the check and this: both read and write the saved tasks synchronously.
    const job = setCronJobEnabled(id, enabled);
    if (!job) return res.status(404).json({ error: `No scheduled task ${id}` });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/settings/cron/:id
 * Remove a cron job.
 */
settingsRouter.delete("/cron/:id", async (req, res) => {
  try {
    const { removeCronJob } = await import("../lib/cron.js");
    const removed = removeCronJob(req.params.id);
    if (!removed) return res.status(404).json({ error: "Job not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/settings/skills-status
 * Scan skills and report installed vs needs-install status.
 */
settingsRouter.get("/skills-status", async (_req, res) => {
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { execSync } = await import("node:child_process");
  // fileURLToPath, not .pathname: on Windows that is "/E:/AGENTIC%20SCALE%20AI/...", which no folder matches.
  const { fileURLToPath } = await import("node:url");
  const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));
  try {
    const results = [];
    const dirs = fs.default.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const skillMd = nodePath.default.join(skillsDir, dir.name, "SKILL.md");
      if (!fs.default.existsSync(skillMd)) continue;
      const content = fs.default.readFileSync(skillMd, "utf8").slice(0, 600);
      const descMatch = content.match(/^description:\s*(.+)/m);
      const binsMatch = content.match(/"bins":\s*\[([^\]]+)\]/);
      const bins = binsMatch ? (binsMatch[1].match(/"([^"]+)"/g) || []).map(b => b.replace(/"/g, "")) : [];
      const missing = bins.filter(b => { try { execSync(`which ${b}`, { stdio: "ignore" }); return false; } catch { return true; } });
      results.push({ name: dir.name, description: descMatch?.[1]?.trim() || "", status: bins.length === 0 || missing.length === 0 ? "ready" : "needs_install", bins, missing });
    }
    results.sort((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1) || a.name.localeCompare(b.name));
    res.json({ skills: results, ready: results.filter(s => s.status === "ready").length, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Tarsee's icon (Settings → Appearance; src/lib/brand-icon.js makes and serves the files).
 * GET    /api/settings/brand-icon  { custom, version, updatedAt }
 * POST   /api/settings/brand-icon  Body: { master: base64 PNG (square, 64 to 2048 px), original?: { name, type, data: base64 } }
 * DELETE /api/settings/brand-icon  back to the default icon
 * Both changes go in the audit log. The body fits inside the JSON limit (LIMITS.JSON_BODY_MAX): a 10 MB original is
 * about 13.4 MB as base64, and the 1024 px master a few MB more.
 */
settingsRouter.get("/brand-icon", (_req, res) => {
  res.json(brandStatus());
});

settingsRouter.post("/brand-icon", async (req, res) => {
  const { master, original } = req.body || {};
  const masterBytes = decodeBase64(master);
  if (!masterBytes) return res.status(400).json({ error: "The icon did not come through: master must be a PNG in base64." });
  let orig;
  if (original != null) {
    const data = typeof original === "object" ? decodeBase64(original.data) : null;
    if (!data) return res.status(400).json({ error: "The original file did not come through: original.data must be base64." });
    orig = { name: typeof original.name === "string" ? original.name : "", type: typeof original.type === "string" ? original.type : "", data };
  }
  try {
    const status = await saveBrandIcon({ master: masterBytes, original: orig });
    req.app.get("auditLog")?.log({ action: "settings.brand_icon", target: "brand-icon", actor: "user", ip: req.ip, detail: `new icon ${status.version}` });
    res.json(status);
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.warn("[brand-icon] save failed:", err?.message);
    res.status(500).json({ error: `The icon could not be saved: ${err?.message || err}` });
  }
});

settingsRouter.delete("/brand-icon", async (req, res) => {
  try {
    const status = await resetBrandIcon();
    req.app.get("auditLog")?.log({ action: "settings.brand_icon_reset", target: "brand-icon", actor: "user", ip: req.ip });
    res.json(status);
  } catch (err) {
    console.warn("[brand-icon] reset failed:", err?.message);
    res.status(500).json({ error: `The icon could not be reset: ${err?.message || err}` });
  }
});
