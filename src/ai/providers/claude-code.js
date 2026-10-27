/**
 * Claude Code (Agent) provider
 *
 * Wraps the @anthropic-ai/claude-agent-sdk to run Claude Code headlessly
 * through Tarsee's chat interface. Claude Code manages its own agentic
 * tool-use loop (Read, Write, Edit, Bash, Grep, Glob) — Tarsee just
 * streams the events to the client.
 *
 * Auth: Uses Claude subscription credentials from `claude login` stored
 * in ~/.claude/.credentials.json (no API key needed).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import config from "../../config/env.js";
import { MODEL_TIERS, tierOf, getRecommendedModel } from "../../config/constants.js";
import { SettingsStore } from "../../db/settings.js";
import { resolveModel } from "../../lib/model-catalog.js";
import { EFFORT_IDS, TARSEE_DEFAULT_EFFORT } from "../../lib/model-picker.js";
import { isTranscriptOverCap, transcriptSizeMB, SESSION_JSONL_MAX_MB } from "../../lib/claude-transcript.js";
import { stepsFromSdkMessage, toolResultsFromSdkMessage, createStreamWatcher } from "../../lib/tool-steps.js";
import { claimQueuedTurn, takeQueuedNote } from "../../lib/conversation-lock.js";
import { costSaverEnv } from "../context-limits.js";
import { agentVaultEnv } from "../agent-env.js";
import { getSecurityManager } from "../../lib/security-manager.js";
/**
 * Extract image blocks from content array.
 * Returns { images: ImageBlockParam[], text: string }
 */
/**
 * Extract media blocks (images, PDFs) from content array.
 * Returns { mediaBlocks: ContentBlockParam[], text: string }
 */
/**
 * Classify a text payload that arrived in a `result` or `error` event from
 * the Claude Agent SDK. Returns `null` if it looks like normal model output,
 * or `{ recoverable }` when the payload is actually a wire-level API error.
 *
 * `recoverable: true` means the caller can clear the stored session id and
 * retry the same turn fresh. The two cases we see most often:
 *   1. `diagnostics.previous_message_id` 400s — the resumed session is
 *      sending a stale or invalid message id and the API rejects it.
 *   2. Generic "session not found / invalid session" surfaces.
 *
 * Other API errors (4xx that are about user input, 5xx server errors) are
 * marked non-recoverable so the channel surfaces them to the user instead
 * of looping.
 */
function classifyAgentError(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const isApiError =
    /^API Error[:\s]/i.test(trimmed) ||
    /diagnostics\.previous_message_id/i.test(trimmed) ||
    /previous_message_id/i.test(trimmed) ||
    /\b(?:must be the id from a prior)\b/i.test(trimmed);
  if (!isApiError) return null;
  const recoverable =
    /previous_message_id/i.test(trimmed) ||
    /session.*(?:expired|invalid|not found|corrupt)/i.test(trimmed);
  return { recoverable };
}

/**
 * Claude's sign-in ran out. The CLI then answers with the error as if it were
 * the reply ("Failed to authenticate. API Error: 401 OAuth access token has
 * expired. Re-authenticate to continue."), which classifyAgentError misses
 * because it does not start with "API Error". It is not an answer: the turn
 * says what to do instead. (TarseeMacOS met it as the "reply" to an ordinary
 * question and catches it the same way.)
 */
const AUTH_TEXT_RE = /(Failed to authenticate|OAuth (?:access )?token (?:has )?expired|Re-authenticate to continue|API Error:\s*401)/i;
export const AUTH_EXPIRED_MESSAGE = "**Claude's sign-in has expired**, so I can't reach the model right now. This isn't a network problem, and retrying won't fix it.\n\n"
  + "Open the Terminal in the Tarsee dashboard (the `>_` button at the top), run `claude login` and follow the link it prints. Then send your message again.";

/** Whether an SDK message's words (or its error flag) are Claude's sign-in failing rather than a reply. */
export function isAuthFailure(text, sdkError = null) {
  return sdkError === "authentication_failed" || AUTH_TEXT_RE.test(String(text || ""));
}

/**
 * Build a comma-separated `--fallback-model` ladder for a chosen model.
 *
 * The Claude Code CLI accepts a list and tries each in turn when the primary
 * is overloaded or unavailable. We descend the tier order (fable > opus >
 * sonnet > haiku) starting one tier below the requested model, using bare tier
 * aliases so the ladder never pins a stale version. Haiku has nothing below
 * it, so it gets no ladder.
 *
 * Each step is resolved to the newest model of its tier (lib/model-catalog.js):
 * the CLI the SDK bundles would take a bare tier word to an older model.
 *
 * @param {string} modelId - resolved model id or tier alias
 * @returns {string|undefined} comma-separated models, or undefined for none
 */
function fallbackLadderFor(modelId) {
  const tier = tierOf(modelId);
  if (!tier) return undefined;
  const below = MODEL_TIERS.slice(MODEL_TIERS.indexOf(tier) + 1);
  return below.length ? below.map((t) => resolveModel(t)).join(",") : undefined;
}

/**
 * A conversation's own model and effort, picked in the composer's picker
 * (settings session.<id>.model / session.<id>.effort), for every channel's
 * turns in it. A model the caller chose on purpose (not the default: auto
 * routing, an API caller) is kept. Unset, a conversation thinks at the default
 * effort (ai.defaultEffort, Medium) rather than the CLI's own. Background work
 * (crons, the heartbeat, the boot checklist) has no conversation and keeps
 * its own model and effort.
 */
export function withChatModel(opts) {
  const conv = opts?.toolCtx?.conversationId;
  const db = opts?.toolCtx?.db;
  if (!conv || (!db && !opts?.toolCtx?.settingsStore)) return opts;
  try {
    const store = opts.toolCtx.settingsStore || new SettingsStore(db);
    const out = { ...opts };
    const picked = store.get(`session.${conv}.model`);
    const defaultModel = store.get("ai.claude-code.model") || getRecommendedModel();
    if (picked && (!opts.model || opts.model === defaultModel)) out.model = picked;
    if (!out.effort) {
      const effort = store.get(`session.${conv}.effort`) || store.get("ai.defaultEffort") || TARSEE_DEFAULT_EFFORT;
      if (EFFORT_IDS.includes(effort)) out.effort = effort;
    }
    return out;
  } catch { return opts; }
}

function extractMedia(content) {
  if (!Array.isArray(content)) return { mediaBlocks: [], text: typeof content === "string" ? content : "hello" };
  const mediaBlocks = [];
  const textParts = [];
  for (const block of content) {
    if (block.type === "image" && block.source?.data) {
      mediaBlocks.push({
        type: "image",
        source: { type: "base64", media_type: block.source.media_type || "image/png", data: block.source.data },
      });
    } else if (block.type === "document" && block.source?.data) {
      mediaBlocks.push({
        type: "document",
        source: { type: "base64", media_type: block.source.media_type || "application/pdf", data: block.source.data },
      });
    } else if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return { mediaBlocks, text: textParts.join("\n") || "hello" };
}

/**
 * Public chat(): the engine below, wrapped so every turn is published to the
 * live timeline (turn_start, each live step, turn_end) for the realtime
 * dashboard (lib/live-bus.js). Steps are NOT passed on to callers, so
 * Telegram/Discord/WhatsApp/email/cron behaviour is exactly as before.
 * turn_end is published in `finally`, so it fires however the turn ends
 * (done, error, abort, a caller that stops reading).
 *
 * Which conversation a turn belongs to: `liveConversationId` (crons and the
 * heartbeat use ids like "cron:<id>" that are not conversations), else
 * `toolCtx.conversationId`. `liveSource` says which channel it came from;
 * `liveDisabled` keeps a turn off the timeline altogether.
 *
 * A turn on the timeline can also be stopped from the dashboard whichever
 * channel started it (stopTurns below): the dashboard shows Stop on any chat
 * at work, a Telegram or Discord one included.
 *
 * A turn sent from the dashboard (liveSource "web") asks for summaries of the
 * model's thinking, which the live view shows while it works; other channels
 * do without unless the caller sets `thinkingSummaries` (see chatEngine). A
 * turn that waited in its chat's queue takes the id it was queued under
 * (lib/conversation-lock.js claimQueuedTurn, or `liveTurnId`), so the same
 * "Queued" line becomes its working line.
 *
 * The turn's tokens so far ("usage" steps) go out at most every
 * USAGE_STEP_MS, and their totals ride on turn_end.
 */
const USAGE_STEP_MS = 3000;

/**
 * The note on a prompt that waited behind another turn of its conversation
 * (lib/conversation-lock.js): it is one message, sent once, even if the agent
 * already saw it while it worked on the turn before (it can read the chat's
 * newest messages itself and answer there). Without it, the agent told the
 * person their one message "reached me twice" (seen on TarseeMacOS). Added once
 * only, and never in front of a slash command.
 */
export const QUEUED_NOTE = "[This message came in while you were still working on the one before. If you already saw it then (in the chat's history or the database) and answered it, it is the same single message, sent once, not a second copy: do not say it reached you twice. Carry on from where you are, briefly if it is already answered.]\n\n";

export function withQueuedNote(prompt) {
  if (typeof prompt !== "string" || !prompt || prompt.startsWith(QUEUED_NOTE) || prompt.trimStart().startsWith("/")) return prompt;
  return QUEUED_NOTE + prompt;
}

export async function* chat(opts) {
  opts = withChatModel(opts);
  if (opts.thinkingSummaries == null) opts = { ...opts, thinkingSummaries: opts.liveSource === "web" };
  // (A turn that waited behind another in its conversation says so to the agent, once: QUEUED_NOTE. Not a
  // subagent's turn, which runs off the timeline: its task is not the message that waited.)
  if (opts.queuedNote == null) {
    const convId = opts.liveDisabled ? null : (opts.liveConversationId || opts.toolCtx?.conversationId || null);
    opts = { ...opts, queuedNote: takeQueuedNote(convId) };
  }
  const liveConv = opts?.liveDisabled ? null : (opts?.liveConversationId || opts?.toolCtx?.conversationId || null);
  if (!liveConv) { yield* chatEngine(opts); return; }
  let live = null;
  try { live = await import("../../lib/live-bus.js"); } catch { /* bus unavailable: run plain */ }
  if (!live) { yield* chatEngine(opts); return; }

  // Our own controller, following the caller's signal, so stopTurns() can end
  // this turn without the caller's help.
  const stopper = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) stopper.abort();
    else opts.signal.addEventListener("abort", () => stopper.abort(), { once: true });
  }
  let set = runningTurns.get(liveConv);
  if (!set) { set = new Set(); runningTurns.set(liveConv, set); }
  set.add(stopper);

  // (A turn that waited in its chat's queue keeps the id of its "Queued" line: the same line begins.)
  const turnId = opts.liveTurnId || claimQueuedTurn(liveConv) || live.newTurnId();
  const lastUser = [...(opts.messages || [])].reverse().find((m) => m.role === "user");
  const promptText = typeof lastUser?.content === "string"
    ? lastUser.content
    : (lastUser?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  live.publish(liveConv, "turn_start", {
    model: opts.model || null,
    effort: opts.effort || null,
    source: opts.liveSource || null,
    prompt: String(promptText || "").slice(0, 300),
  }, { turnId });
  let stopReason = null;
  let errorMsg = null;
  // The Claude Code session the turn runs in, named on turn_end: lib/token-usage.js reads the
  // session's transcript and needs to know whose it is (claude_session_id changes on a reset).
  let sessionId = null;
  const onSessionId = (sid) => { sessionId = sid || sessionId; opts.onSessionId?.(sid); };
  let usage = null;
  let usageSentAt = 0;
  let usageTimer = null;
  const sendUsage = () => {
    clearTimeout(usageTimer);
    usageTimer = null;
    if (!usage) return;
    usageSentAt = Date.now();
    live.publish(liveConv, "step", usage, { turnId });
  };
  try {
    for await (const evt of chatEngine({ ...opts, onSessionId, signal: stopper.signal })) {
      if (evt?.type === "step") {
        const { type: _t, ...step } = evt;
        if (step.kind === "usage") {
          usage = step;
          const wait = USAGE_STEP_MS - (Date.now() - usageSentAt);
          if (wait <= 0) sendUsage();
          else if (!usageTimer) { usageTimer = setTimeout(sendUsage, wait); usageTimer.unref?.(); }
          continue;
        }
        live.publish(liveConv, "step", step, { turnId });
        continue;
      }
      if (evt?.type === "done") stopReason = evt.stopReason || "end_turn";
      else if (evt?.type === "error") errorMsg = evt.message || "error";
      yield evt;
    }
  } finally {
    set.delete(stopper);
    if (!set.size && runningTurns.get(liveConv) === set) runningTurns.delete(liveConv);
    if (usageTimer) sendUsage();
    const { kind: _k, ...totals } = usage || {};
    live.publish(liveConv, "turn_end", {
      stopReason: stopReason || (stopper.signal.aborted ? "aborted" : "ended"),
      ...(errorMsg ? { error: String(errorMsg).slice(0, 500) } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage: totals } : {}),
    }, { turnId });
  }
}

/** Live conversation id -> controllers of the turns running in it right now. */
const runningTurns = new Map();

/**
 * Stop every turn running in a conversation, whichever channel started it.
 * @param {string} conversationId a conversation id, or a background job's live id
 * @returns {number} how many turns were told to stop
 */
export function stopTurns(conversationId) {
  const set = runningTurns.get(conversationId);
  if (!set) return 0;
  let n = 0;
  for (const c of set) { if (!c.signal.aborted) { c.abort(); n++; } }
  return n;
}

/**
 * The engine: an async generator that matches Tarsee's provider interface.
 *
 * Unlike other providers, Claude Code runs its own tool loop internally.
 * We yield events as they arrive — the chat route should NOT wrap this
 * in its own tool-use loop. Besides text/tool_use/tool_result/usage/done it
 * yields `step` events for the live timeline, which chat() above consumes.
 *
 * @param {object} opts
 * @param {Array} opts.messages - Conversation history (we extract the latest user message)
 * @param {string} opts.model - Model ID or tier alias (opus, sonnet, haiku, fable,
 *   or a pinned id like claude-opus-5). Forwarded to the CLI as --model.
 * @param {string} [opts.systemPrompt] - System prompt (passed as context to Claude Code)
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @param {string} [opts.sessionId] - Claude Code session ID for resumption
 * @param {Function} [opts.onSessionId] - Callback when session ID is available
 */
async function* chatEngine({
  messages,
  model,
  systemPrompt,
  signal,
  sessionId,
  onSessionId,
  toolCtx,
  effort,
  maxTurns,
  maxBudgetUsd,
  thinkingSummaries = false,
  queuedNote = false,
}) {
  // Extract the latest user message — separate text and images
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const { mediaBlocks, text: extractedText } = extractMedia(lastUserMsg?.content);
  let prompt = extractedText;
  if (queuedNote) prompt = withQueuedNote(prompt);
  const hasMedia = mediaBlocks.length > 0;
  // The pictures among them are kept with the person's message, so the dashboard's chat shows them: no note in the
  // message names them (lib/sent-files.js noteMediaBlocks). Best-effort.
  if (hasMedia && toolCtx?.conversationId) {
    try { (await import("../../lib/sent-files.js")).noteMediaBlocks(toolCtx.conversationId, mediaBlocks); } catch { /* showing them is best-effort */ }
  }

  const cwd = config.CLAUDE_WORKSPACE_DIR || process.cwd();

  // Create MCP server with all Tarsee tools
  const { createTarseeMcp } = await import("../tarsee-mcp.js");
  const tarseeMcp = createTarseeMcp(toolCtx || {});

  // Skills directory — Claude Code discovers SKILL.md files here
  const skillsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "skills");

  const builtinTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
  // Without the mcp__tarsee__* entry, allowedTools silently filters out every
  // tarsee_* tool even though the server is registered and the system prompt
  // advertises them — Claude ends up shelling out to curl/Telegram instead.
  const allTools = [...builtinTools, "mcp__tarsee__*"];

  // Abort plumbing. `query()` accepts exactly two keys — `prompt` and
  // `options` — so the `signal` this function used to pass as a third
  // top-level key was silently dropped on the floor. Nothing could cancel a
  // turn: the web Stop button, the cron 2-minute timeout, and the channel
  // idle-abort all resolved their own promises while the Claude Code
  // subprocess kept running (and kept billing) to completion. The SDK's real
  // mechanism is options.abortController, so bridge the caller's signal onto
  // one here.
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const queryOptions = {
    cwd,
    // The server's environment plus the context cost savers (ai/context-limits.js): compact at 180k tokens, and a
    // Bash output past 8000 characters or a tool result past 12000 goes to a file the agent can read. (The SDK takes
    // this as the whole environment, so process.env comes first.)
    // The vault's keys too, so scripts read them by name and no key is pasted into a command (ai/agent-env.js).
    env: { ...process.env, ...agentVaultEnv({ denied: () => getSecurityManager(toolCtx?.settingsStore).getToolPermission("get_key") === "always_deny" }), ...costSaverEnv() },
    // A bare tier word becomes the newest model of that tier (see fallbackLadderFor).
    model: resolveModel(model || config.CLAUDE_DEFAULT_MODEL),
    tools: allTools,
    allowedTools: allTools,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Interactive chat keeps the generous ceiling; background callers pass a
    // much lower one, because an unattended loop is where cost runs away.
    maxTurns: maxTurns ?? 50,
    includePartialMessages: true,
    mcpServers: { tarsee: tarseeMcp },
    additionalDirectories: [skillsDir],
    abortController,
    // Keep the agent answering when the chosen model is saturated. The CLI
    // takes a comma-separated ladder and walks it in order; we step DOWN one
    // tier at a time from whatever was asked for, so a Fable turn degrades to
    // Opus rather than failing outright.
    fallbackModel: fallbackLadderFor(model || config.CLAUDE_DEFAULT_MODEL),
  };

  // Spend ceiling, when the caller sets one. The SDK ends the turn itself on
  // reaching it, which is the only ceiling that survives a loop we fail to
  // notice from the outside.
  if (typeof maxBudgetUsd === "number" && maxBudgetUsd > 0) {
    queryOptions.maxBudgetUsd = maxBudgetUsd;
  }

  // Thinking effort. `xhigh` sits BETWEEN high and max, and is the sweet spot
  // for most coding and agentic work.
  //
  // This used to rewrite xhigh -> max, with a comment saying the Agent SDK had
  // no dedicated xhigh level yet. It does now — the installed SDK types effort
  // as ('low'|'medium'|'high'|'xhigh'|'max') and performs its own per-model
  // downgrade when a model doesn't support a level. So the rewrite no longer
  // works around anything; it just silently charged users MORE effort than they
  // asked for. Pass the level through and let the SDK resolve it.
  if (effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    queryOptions.effort = effort;
  }

  // Summaries of the model's thinking, for the dashboard's live view (chat() turns them on for a turn sent from
  // the dashboard, where someone is watching). Without this the API leaves thinking out ("omitted") and the live
  // line can only say "Thinking". They cost time: the answer's first words come about 3s later on a turn that
  // thinks, so a Telegram, Discord or email reply, which nobody watches being written, does without.
  if (thinkingSummaries) {
    queryOptions.thinking = { type: "adaptive", display: "summarized" };
  }

  // The head of every turn's system prompt. It used to repeat the first 8 lines
  // of SOUL.md (about 500 bytes on every call), which the system prompt that
  // follows carries in full (lib/build-system-prompt.js), and to tell a new
  // session to read MEMORY.md and USER.md first: USER.md is in that prompt too,
  // and MEMORY.md is a pointer there saying to grep it for what a task needs.
  const tarseeContext = `You ARE Tarsee — a headless AI agent running 24/7 on a server.

## MCP Tools (call as mcp__tarsee__tarsee_<name>)
- **send_message**(channel, message, channel_id) — push to Telegram/Discord/WhatsApp/web
- **send_file**(channel, file_path, caption?, channel_id?) — send a file as a real attachment to Telegram/Discord/WhatsApp or a dashboard chat (web); with no channel_id it goes to the chat you are in. When someone asks for a file, send it: never answer with a folder path or say the channel can't take files
- **schedule_task**(id, schedule, prompt, channel?, once?, action?) — create cron jobs
- **remember**(content) — append to MEMORY.md
- **daily_log**(content) — append to today's log
- **read_file**(filename) / **write_file**(filename, content) — workspace files
- **search_memories**(query) — keyword search through memory files
- **search_memories_deep**(query) — dumps ALL memories for semantic reasoning (use when keyword search finds nothing)
- **create_canvas**(title, html, css?, js?) — create live interactive HTML/CSS/JS canvas (renders as iframe in chat)
- **web_fetch**(url) / **web_search**(query) — web access
- **get_key**(name) / **set_key**(name, value) — encrypted vault
- **calculator**(expression) — precise math. ALWAYS use this for any calculation, never do math in your head
- **datetime**(timezone?, date?, format?) — current date/time/day or timezone conversion. ALWAYS use this for dates and days of the week, never guess. Default timezone: ${config.TIMEZONE}
- **browser**(action, url?, selector?, text?, ...) — stealth Playwright browser with captcha solving
- **discord_admin**(action, ...) — list, make and edit Discord channels and make webhooks with Tarsee's own bot (never the bot token from Bash); changes need approved_by, a webhook URL goes to the vault, nothing deletes
- **railway**(action, project?, environment?, service?, ...) — list Railway projects and variable names, set a variable (secrets via from_key, a vault key name) or redeploy, with the vault's RAILWAY_API_TOKEN; writes need approved_by. Use it instead of Railway calls from Bash

## Memory
Use remember for durable facts. Use daily_log for session notes. Only append, never overwrite.
Before saying "I don't know" or "I can't remember":
1. Try search_memories first (fast, keyword-based)
2. If nothing found, use search_memories_deep (reads everything, lets you reason about relevance)

## CLI Tools Installed
- **railway** — Railway CLI for logs and deploys (to set a variable or redeploy, use the railway tool above: never a secret in a command)
- **gog** — Google Workspace (Gmail, Calendar, Drive, Contacts, Sheets)
- **himalaya** — Zoho/IMAP email
- **gh** — GitHub CLI
- **claude** — Claude Code CLI
- **whisper-cli** — local speech-to-text
- Use Bash to run any of these directly.

## Skill Discovery
You have skills installed in the skills/ directory. Before saying "I can't do that":
1. Check if a skill exists: list files in ${cwd}/skills/ or read a skill's SKILL.md
2. If a matching skill exists, read its SKILL.md and follow the instructions
3. If no skill exists, ask the user if they want you to create one

## Workspace: ${cwd}`;

  let effectiveSystemPrompt = tarseeContext + (systemPrompt ? `\n\n${systemPrompt}` : "");
  // Strip invalid Unicode surrogates that break JSON serialization
  effectiveSystemPrompt = effectiveSystemPrompt.replace(/[\uD800-\uDFFF]/g, "");
  queryOptions.systemPrompt = effectiveSystemPrompt;

  // Resume existing session if available — unless its transcript has grown
  // past the cap. Claude Code re-reads the whole .jsonl on resume, so a
  // bloated transcript refills the context window before the user's message
  // is even considered: turns get slower, more expensive, and eventually
  // hang. Past the cap we start a FRESH session instead of resuming the
  // bloat. (Settings -> Token Health surfaces which sessions are near it.)
  if (sessionId) {
    if (isTranscriptOverCap(sessionId)) {
      const mb = transcriptSizeMB(sessionId);
      console.warn(
        `[claude-code] session ${sessionId} transcript ${mb}MB > ${SESSION_JSONL_MAX_MB}MB cap — starting FRESH instead of resuming the bloat`,
      );
    } else {
      queryOptions.resume = sessionId;
    }
  }

  console.log(`[claude-code] Starting task in ${cwd}, model: ${queryOptions.model}, session: ${sessionId || "new"}, media: ${mediaBlocks.length}, mcp: ${tarseeMcp ? "yes" : "NO"}, allowedTools: ${allTools.join(",")}`);

  // Build prompt: use AsyncIterable with image content blocks if images present
  let queryPrompt;
  if (hasMedia) {
    // Native image support via AsyncIterable<SDKUserMessage>
    const contentBlocks = [...mediaBlocks, { type: "text", text: prompt }];
    async function* imagePrompt() {
      yield {
        type: "user",
        message: { role: "user", content: contentBlocks },
        parent_tool_use_id: null,
      };
    }
    queryPrompt = imagePrompt();
  } else {
    queryPrompt = prompt;
  }

  try {
    let messageCount = 0;
    let everStreamed = false; // True if ANY text was streamed via stream_event
    let inThinking = false;
    let textOut = false; // True once any words went to the caller (an auth error after that is not the whole reply)
    const seenToolIds = new Set(); // tool_use ids already turned into live steps
    // Thinking summaries, API retries, compacting and the tokens so far, for the live view (lib/tool-steps.js).
    const watcher = createStreamWatcher();
    for await (const message of query({ prompt: queryPrompt, options: queryOptions, signal })) {
      messageCount++;
      if (signal?.aborted) break;
      for (const step of watcher.onMessage(message)) yield { type: "step", ...step };

      switch (message.type) {
        case "stream_event": {
          // Token-by-token streaming — text deltas and thinking
          const evt = message.event;
          if (evt?.type === "content_block_delta") {
            if (evt.delta?.type === "text_delta" && evt.delta.text) {
              yield { type: "text", content: evt.delta.text };
              everStreamed = true;
              textOut = true;
            } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
              // Don't emit thinking content as text — but signal that thinking is active
              everStreamed = true;
            }
          } else if (evt?.type === "content_block_start") {
            if (evt.content_block?.type === "thinking") {
              inThinking = true;
              yield { type: "thinking", status: "start" };
            }
          } else if (evt?.type === "content_block_stop") {
            if (inThinking) {
              inThinking = false;
              yield { type: "thinking", status: "stop" };
            }
          }
          break;
        }

        case "assistant": {
          // Claude's sign-in failing, delivered as if it were the reply: say what to do instead (AUTH_TEXT_RE).
          if (!message.parent_tool_use_id && !textOut) {
            const words = Array.isArray(message.message?.content)
              ? message.message.content.filter((b) => b.type === "text").map((b) => b.text).join("")
              : String(message.message?.content || "");
            if (isAuthFailure(words, message.error)) {
              console.error(`[claude-code] Claude's sign-in failed: ${words.slice(0, 200)}`);
              yield { type: "text", content: AUTH_EXPIRED_MESSAGE };
              yield { type: "done", stopReason: "auth-expired" };
              return;
            }
          }
          // Live steps (the words and each tool as it starts), for the
          // dashboard. A subagent's own messages carry parent_tool_use_id:
          // its inner steps stay inside its one Task step.
          if (!message.parent_tool_use_id) {
            for (const step of stepsFromSdkMessage(message, seenToolIds)) yield { type: "step", ...step };
          }
          // Full assistant message — skip text if already streamed token-by-token
          if (!everStreamed) {
            const text = typeof message.message?.content === "string"
              ? message.message.content
              : Array.isArray(message.message?.content)
                ? message.message.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join("")
                : "";
            if (text) {
              yield { type: "text", content: text };
              everStreamed = true;
              textOut = true;
            }
          }

          // Check for tool_use blocks in the content
          if (Array.isArray(message.message?.content)) {
            for (const block of message.message.content) {
              if (block.type === "tool_use") {
                yield {
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                };
              }
            }
          }
          break;
        }

        case "user": {
          // Tool results. The SDK has no "tool_result" message type: a tool's
          // output comes back as a `user` message whose content holds a
          // tool_result block with the tool_use_id it answers. (A case for
          // "tool_result" sat here before and never fired, so no caller ever
          // saw a tool's output.) Replays of earlier turns on resume are
          // skipped, and so are a subagent's inner results.
          if (message.isReplay || message.parent_tool_use_id) break;
          for (const step of stepsFromSdkMessage(message, seenToolIds)) yield { type: "step", ...step };
          for (const r of toolResultsFromSdkMessage(message)) {
            yield { type: "tool_result", id: r.id, ok: r.ok, result: r.result.slice(0, 2000) };
          }
          break;
        }

        case "result": {
          // Final result — capture session ID and usage
          const sid = message.session_id || message.sessionId;
          if (sid && onSessionId) {
            onSessionId(sid);
          }
          if (message.usage) {
            // Forward cache fields too so the frontend can compute true
            // prompt size = input + cache_read + cache_creation. Without
            // these we'd undercount filled context whenever caching kicks in.
            yield {
              type: "usage",
              usage: {
                input_tokens: message.usage.input_tokens || 0,
                output_tokens: message.usage.output_tokens || 0,
                cache_read_input_tokens: message.usage.cache_read_input_tokens || 0,
                cache_creation_input_tokens: message.usage.cache_creation_input_tokens || 0,
              },
            };
          }
          // A `result` message is NOT necessarily a success. The SDK uses the
          // same type for error_during_execution / error_max_turns /
          // error_max_budget_usd / error_max_structured_output_retries, and
          // those carry no `result` field at all — they carry `errors[]`. This
          // used to read `message.result || ""`, find nothing, and emit a
          // normal end_turn, so a job that burned its entire turn budget was
          // recorded as having completed successfully with an empty answer.
          if (message.subtype && message.subtype !== "success") {
            const detail = Array.isArray(message.errors) && message.errors.length
              ? message.errors.join("; ")
              : message.subtype;
            const friendly = message.subtype === "error_max_turns"
              ? `Stopped after hitting the turn limit (${message.num_turns} turns). The task needs to be broken into smaller steps.`
              : message.subtype === "error_max_budget_usd"
                ? "Stopped after hitting the configured spend ceiling for this task."
                : `Claude Code ended with ${message.subtype}: ${detail}`;
            yield { type: "error", message: friendly, recoverable: false, subtype: message.subtype };
            yield { type: "done", stopReason: message.subtype };
            break;
          }
          const resultText = message.result || "";
          if (!textOut && isAuthFailure(resultText)) {
            console.error(`[claude-code] Claude's sign-in failed: ${resultText.slice(0, 200)}`);
            yield { type: "text", content: AUTH_EXPIRED_MESSAGE };
            yield { type: "done", stopReason: "auth-expired" };
            break;
          }
          const classified = classifyAgentError(resultText);
          if (classified) {
            // API/SDK error landed in result.result — don't leak it as a chat
            // reply, surface as a structured error event so the channel layer
            // can decide whether to retry, clear the session, or show a clean
            // user-facing message.
            yield { type: "error", message: resultText, recoverable: classified.recoverable };
            yield { type: "done", stopReason: "error" };
            break;
          }
          // Yield result text as fallback if nothing was streamed at all
          if (!everStreamed && resultText) {
            yield { type: "text", content: resultText };
            textOut = true;
          }
          yield { type: "done", stopReason: "end_turn" };
          break;
        }

        case "error": {
          const errMsg = message.error?.message || message.error || "Unknown Claude Code error";
          const classified = classifyAgentError(errMsg);
          // Detect auth failures
          if (/unauthorized|authentication|login|credential/i.test(errMsg) || isAuthFailure(errMsg)) {
            yield { type: "text", content: `${AUTH_EXPIRED_MESSAGE}\n\nError: ${errMsg}` };
          }
          yield { type: "error", message: errMsg, recoverable: !!classified?.recoverable };
          yield { type: "done", stopReason: "error" };
          break;
        }

        case "system": {
          // Capture session ID from init event
          if (message.session_id && onSessionId) {
            onSessionId(message.session_id);
          }
          // Surface MCP connection status. The tarsee server can fail to
          // register (a bad tool schema fails the whole tools/list call) while
          // the system prompt keeps advertising twenty tools, so the model
          // improvises with curl and Bash and the failure looks like bad
          // prompting. Nothing logged this, so it went unnoticed. Log loudly
          // when the server did not come up connected.
          if (Array.isArray(message.mcp_servers)) {
            for (const srv of message.mcp_servers) {
              if (srv?.status && srv.status !== "connected") {
                console.error(
                  `[claude-code] MCP server "${srv.name}" is ${srv.status} — its tools are NOT available to Claude this turn.`,
                );
              }
            }
          }
          break;
        }

        default:
          // Forward any other message types
          if (message.type && !["rate_limit_event", "user"].includes(message.type)) {
            console.log(`[claude-code] Event: ${message.type}`, JSON.stringify(message).slice(0, 200));
          }
          break;
      }
    }
    console.log(`[claude-code] Stream ended. Messages: ${messageCount}, streamed: ${everStreamed}`);
    if (messageCount === 0) {
      yield { type: "text", content: "**Claude Code returned no response.** Check the server logs for details. If its sign-in has expired, open the Terminal in the Tarsee dashboard (the `>_` button at the top) and run `claude login`." };
      yield { type: "done", stopReason: "error" };
    }
  } catch (error) {
    // Stopped on purpose (Stop, the idle watchdog, a caller giving up): the
    // SDK throws "process aborted by user". That is not a failure, and must
    // not reach the user as an error.
    if (abortController.signal.aborted) {
      console.log("[claude-code] Turn stopped.");
      yield { type: "done", stopReason: "aborted" };
      return;
    }
    console.error("[claude-code] Exception:", error);
    const errMsg = error.message || "Claude Code crashed";

    if (/ENOENT.*claude/i.test(errMsg)) {
      yield { type: "text", content: `**Claude Code isn't installed where Tarsee can run it.** Check the server logs.\n\nError: ${errMsg}` };
    } else if (/unauthorized|authentication|login|credential/i.test(errMsg) || isAuthFailure(errMsg)) {
      yield { type: "text", content: `${AUTH_EXPIRED_MESSAGE}\n\nError: ${errMsg}` };
    }

    yield { type: "error", message: errMsg };
    yield { type: "done", stopReason: "error" };
  }
}
