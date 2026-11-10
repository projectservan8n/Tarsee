import { Router } from "express";
import { CLAUDE_MODELS } from "../config/constants.js";
import { ConversationStore } from "../db/conversations.js";
import { SettingsStore } from "../db/settings.js";
import { PROVIDER_IDS, getProvider, normalizeProviderId, isShipped as registryShipped } from "../ai/provider-registry.js";
import { parseModelRef, formatModelRef } from "../ai/model-ref.js";
import { EFFORT_IDS, clampEffort } from "../lib/model-picker.js";
import { getModelGroups, providerReadiness, defaultPick, readPick, checkModel, levelsFor } from "../lib/model-catalog.js";

/**
 * The composer's models for every AI, and a chat's own pick (design 4.11). Mounted at /api/models:
 *
 *   GET /api/models
 *     { groups, unavailable, defaults, picker, models }: one group per AI that is switched on and ready, the default
 *     AI first (lib/model-catalog.js getModelGroups); the AIs that are switched on but not ready, with what to do;
 *     what a chat with nothing of its own runs on; `picker`, what the page keeps (the groups, plus the Claude list's
 *     main and more as GET /api/chat/models always had them); `models`, Tarsee's Claude table for the Settings page.
 *
 *   GET /api/models/picker?conversationId=…
 *     The chat's own AI, model and effort (null: the default), as the composer shows them:
 *     { conversationId, provider, model, modelId, effort, defaults, warning }. `model` is a model ref
 *     ("deepseek:deepseek-flash") when the chat has an AI of its own, so it names that AI wherever it goes; `modelId`
 *     is the bare id. `warning` is set when that AI is no longer ready ("DeepSeek not connected, using default").
 *
 *   PUT /api/models/picker  { conversationId, provider?, model?, effort? }
 *     Give a chat an AI, a model and an effort; null goes back to the default. `model` may be a model ref, which
 *     names the AI itself. Stored as session.<conv>.provider, .model and .effort, the effort clamped to the levels the
 *     model has. Refused: an AI Tarsee doesn't know or doesn't switch on (400), one that isn't ready (409, with its
 *     fix), a model the AI doesn't offer or that must be verified first (400), a level that doesn't exist (400).
 *
 * The same handlers serve the old addresses (createModelsHandlers): GET /api/chat/models and
 * GET|PUT /api/chat/conversations/:id/picker, where the chat comes from the path.
 *
 * deps (tests, or a caller with its own): isShipped, statusFor (readiness), env, listChatgptModels, stateDir.
 */
export function createModelsHandlers(deps = {}) {
  let stores = null;
  const storesFor = (req) => {
    if (!stores || stores.db !== req.app.get("db")) {
      const db = req.app.get("db");
      stores = { db, settings: new SettingsStore(db, req.app.get("auditLog")), convs: new ConversationStore(db) };
    }
    return stores;
  };
  const env = () => deps.env || process.env;
  const shipped = (id) => (deps.isShipped || registryShipped)(id);
  const ready = (id, settings) => providerReadiness(id, { store: settings, env: env(), statusFor: deps.statusFor, isShipped: deps.isShipped, stateDir: deps.stateDir });
  const conversationOf = (req) => String(req.params?.id ?? req.query?.conversationId ?? req.body?.conversationId ?? "").trim();

  /** What the composer shows for a chat. */
  async function pickView(settings, conversationId) {
    const pick = readPick(settings, conversationId);
    const defaults = defaultPick(settings, { env: env(), isShipped: deps.isShipped });
    let warning = null;
    if (pick.provider) {
      const s = await ready(pick.provider, settings);
      if (!s.ready) warning = s.state === "blocked-keys-only" ? `${s.label} is off (API keys only), using default` : `${s.label} not connected, using default`;
    }
    return {
      conversationId,
      provider: pick.provider,
      model: pick.provider ? formatModelRef(pick.provider, pick.model || "") : pick.model,
      modelId: pick.model,
      effort: pick.effort,
      defaults,
      warning,
    };
  }

  async function list(req, res) {
    const { settings } = storesFor(req);
    const out = await getModelGroups({
      store: settings, env: env(), isShipped: deps.isShipped, statusFor: deps.statusFor,
      listChatgptModels: deps.listChatgptModels, stateDir: deps.stateDir,
    });
    res.json({ ...out, models: CLAUDE_MODELS });
  }

  async function getPick(req, res) {
    const { settings, convs } = storesFor(req);
    const id = conversationOf(req);
    if (!id) return res.status(400).json({ error: "Which chat? Send conversationId." });
    if (!convs.get(id)) return res.status(404).json({ error: "Conversation not found" });
    res.json(await pickView(settings, id));
  }

  async function putPick(req, res) {
    const { settings, convs } = storesFor(req);
    const id = conversationOf(req);
    if (!id) return res.status(400).json({ error: "Which chat? Send conversationId." });
    if (!convs.get(id)) return res.status(404).json({ error: "Conversation not found" });
    const body = req.body || {};
    const has = (k) => Object.hasOwn(body, k);
    const blank = (v) => v == null || (typeof v === "string" && !v.trim());
    const key = (k) => `session.${id}.${k}`;
    const cur = readPick(settings, id);
    let provider = cur.provider;
    let model = cur.model;
    let modelChanged = false;

    if (has("provider") || has("model")) {
      let wantProvider = has("provider") && !blank(body.provider) ? String(body.provider).trim() : null;
      let rawModel = has("model") && !blank(body.model) ? String(body.model).trim() : null;
      if (wantProvider && !normalizeProviderId(wantProvider)) return res.status(400).json({ error: `Tarsee doesn't know the AI "${wantProvider}".` });
      if (rawModel) {
        const ref = parseModelRef(rawModel);
        if (ref.provider) {
          if (wantProvider && normalizeProviderId(wantProvider) !== ref.provider) return res.status(400).json({ error: "The model belongs to another AI than the one sent." });
          wantProvider = ref.provider;
          rawModel = ref.model;
        }
      }
      wantProvider = normalizeProviderId(wantProvider);

      if (!wantProvider && !rawModel) {
        // Back to the default AI and model.
        provider = null;
        model = null;
      } else if (wantProvider) {
        const p = getProvider(wantProvider);
        if (!shipped(p.id)) return res.status(400).json({ error: `${p.label} can't be used in this version of Tarsee.` });
        const s = await ready(p.id, settings);
        if (!s.ready) return res.status(409).json({ error: `${p.label} isn't ready. ${s.detail || ""}`.trim(), state: s.state, fix: s.fix });
        if (rawModel || has("model") || p.id !== cur.provider) {
          const r = checkModel(p.id, rawModel, settings);
          if (!r.ok) return res.status(400).json({ error: r.error, verify: !!r.verify });
          model = r.model;
        }
        provider = p.id;
      } else {
        // A bare model (the Claude-only picker sent only that): the chat's AI, then the default AI, then any ready AI with that exact model.
        const found = await findProviderFor(rawModel, settings, cur.provider);
        if (!found.ok) return res.status(400).json({ error: found.error, verify: !!found.verify });
        provider = found.provider;
        model = found.model;
      }
      modelChanged = provider !== cur.provider || model !== cur.model;
    }

    let effort = cur.effort;
    if (has("effort")) {
      if (blank(body.effort)) effort = null;
      else {
        const e = String(body.effort).toLowerCase().trim();
        if (!EFFORT_IDS.includes(e)) return res.status(400).json({ error: `Unknown effort ${e}` });
        effort = e;
      }
    }
    if (effort && (has("effort") || modelChanged)) {
      const target = provider ? { provider, model } : defaultPick(settings, { env: env(), isShipped: deps.isShipped });
      effort = clampEffort(levelsFor(target.provider, target.model, settings), effort);
    }

    const put = (k, v) => (v ? settings.set(key(k), v) : settings.delete(key(k)));
    put("provider", provider);
    put("model", model);
    put("effort", effort);
    res.json({ ok: true, ...(await pickView(settings, id)) });
  }

  /** The AI a bare model belongs to: { ok, provider, model } or { ok: false, error }. */
  async function findProviderFor(rawModel, settings, current) {
    const def = defaultPick(settings, { env: env(), isShipped: deps.isShipped }).provider;
    const order = [...new Set([current, def].filter(Boolean))];
    for (const id of order) {
      if (!shipped(id)) continue;
      const r = checkModel(id, rawModel, settings);
      if (r.ok && r.model) {
        const s = await ready(id, settings);
        if (!s.ready) return { ok: false, error: `${s.label} isn't ready. ${s.detail || ""}`.trim() };
        return { ok: true, provider: id, model: r.model };
      }
    }
    let lastError = null;
    for (const id of PROVIDER_IDS) {
      if (order.includes(id) || !shipped(id)) continue;
      const s = await ready(id, settings);
      if (!s.ready) continue;
      const r = checkModel(id, rawModel, settings);
      if (r.ok && r.model && (getProvider(id).catalog === "claude" || r.model === rawModel)) return { ok: true, provider: id, model: r.model };
      if (r.verify) lastError = r;
    }
    return lastError ? { ok: false, error: lastError.error, verify: true } : { ok: false, error: `Unknown model ${rawModel}` };
  }

  return { list: wrap(list), getPick: wrap(getPick), putPick: wrap(putPick) };
}

/** An async handler whose failure answers 500 instead of leaving the request hanging. */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error("[models]", err);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't load the models." });
  });
}

/** The router for /api/models. */
export function createModelsRouter(deps = {}) {
  const h = createModelsHandlers(deps);
  const router = Router();
  router.get("/", h.list);
  router.get("/picker", h.getPick);
  router.put("/picker", h.putPick);
  return router;
}

/** /api/models with the registry's own readiness and switches (server.js mounts it). */
export const modelsRouter = createModelsRouter();

/** The same handlers for the old addresses in routes/chat.js (GET /models, GET|PUT /conversations/:id/picker). */
export const modelsHandlers = createModelsHandlers();
