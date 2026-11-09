/**
 * codex-events.js: what the Codex SDK streams, as Tarsee's events (design 4.8 "Event mapping"). Pure: no I/O.
 *
 * `codex exec --experimental-json` reports a turn as items (a command, a call to an MCP tool, a patch, a to-do list, a
 * web search, a reasoning summary, a message) that start, update and complete, then turn.completed with the usage or
 * turn.failed. Tarsee's channels, live view, tool status lines and loop guard all speak Claude Code's vocabulary, so
 * the items become the same events Claude Code's turns give, with Claude Code's tool names:
 *
 *   command_execution   Bash {command}             (the shell's own "bash -lc" / PowerShell wrapper taken off)
 *   mcp_tool_call       mcp__<server>__<tool>      (Tarsee's tools: mcp__tarsee__tarsee_<name>), input = arguments
 *   file_change         Write {file_path} for an added file, Edit {file_path} for an update or a delete
 *                       ({change: "delete"}), one per file in the patch
 *   todo_list           TodoWrite {todos}, each time the list changes
 *   web_search          WebSearch {query}
 *   reasoning           thinking start/stop, plus its summary as a thinking step (redacted, at most 4,000 characters)
 *   agent_message       text (a blank line between two messages), plus a text step
 *   error item          a status step (Codex carries on after these)
 * Every tool_use gets its tool_result with the same id, and a tool_start / tool_end step for the live view (the
 * shapes lib/tool-steps.js gives Claude Code's turns, redacted the same way).
 *
 * The end of a turn: turn.completed gives a usage event (and a usage step) and done{end_turn}. Codex reports a
 * thread's RUNNING total there (settled against the pinned binary: a resumed thread's second turn reports both turns'
 * tokens), so the state carries the thread's total before this turn (baseline) and the usage is the difference. When
 * the engine couldn't learn that total (baselineKnown false), no usage is given: all of the running total would count
 * the thread's earlier turns as this one.
 * turn.failed (or an error the stream ends on) is classified by engine-errors.js: a key or sign-in that was turned
 * down gives the provider's own fix as text, an error and done{auth-expired}; anything else an error and
 * done{error}; a thread that can't be resumed is recoverable (the turn layer starts fresh and hands the chat over).
 * "Reconnecting... n/5" errors while Codex retries are status steps. finishCodexEvents() closes a turn that ended
 * any other way (Stop, the turn limit, the binary exiting) with exactly one done; the engine (codex.js) puts that
 * turn's usage, read from the thread's rollout (usageEvents), in front of the done.
 */
import { classifyEngineError, friendly, localNoResponsesMessage } from "../engine-errors.js";
import { getProvider, normalizeProviderId } from "../provider-registry.js";
import { displayToolName, resultPreview, summarizeToolInput, toolInputPreview } from "../../lib/tool-steps.js";
import { redactSecrets } from "../../lib/redact.js";

/** A tool result's text is capped as Claude Code's turns cap it. */
export const RESULT_MAX_CHARS = 2000;
const THINKING_MAX_CHARS = 4000;
const STATUS_MAX_CHARS = 240;

const USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];

/** Codex's own notes that need no one's attention (shown on every turn on a model it has no metadata for). */
const NOISE_RE = /^Model metadata for .* not found/i;
const RECONNECT_RE = /^Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)\s*(?:\(([\s\S]*)\))?\s*$/;
/** Codex's words for a thread it can't resume: the turn starts fresh instead. */
const RESUME_FAILED_RE = /(no rollout found|thread\/resume failed|thread[^\n]*not found|rollout[^\n]*not found|session[^\n]*not found)/i;
/** Codex's words for a server it couldn't reach at all. */
const UNREACHABLE_RE = /(Connection failed|error sending request|connection refused|ECONNREFUSED|ECONNRESET|connection reset|connection closed|stream disconnected|dns error|failed to lookup address|timed out)/i;
const MISSING_BINARY_RE = /(Unable to locate Codex CLI binaries|spawn \S*codex\S* ENOENT|codex(?:\.exe)?\W+ENOENT)/i;

// --- State ---------------------------------------------------------------------------------------------------------

/**
 * A turn's mapping state. opts: providerId, model, baseline (the thread's usage total before this turn, for a resumed
 * thread), baselineKnown (false when a resumed thread's total before this turn couldn't be read: no usage is given),
 * localUrl (Local AI's address, for "can't reach it" words).
 */
export function createCodexEventState({ providerId, model = null, baseline = null, baselineKnown = true, localUrl = null } = {}) {
  const id = normalizeProviderId(providerId) || String(providerId || "");
  return {
    providerId: id,
    label: getProvider(id)?.label || id || "The AI",
    model: model || null,
    localUrl: localUrl || null,
    baseline: baseline ? normalizeUsage(baseline) : null,
    baselineKnown: baselineKnown !== false,
    threadId: null,
    totals: null,
    done: false,
    toolCount: 0,
    started: new Set(),
    open: new Map(),
    todos: new Map(),
    thinking: new Set(),
    textCount: 0,
    lastError: null,
  };
}

// --- Helpers -------------------------------------------------------------------------------------------------------

function normalizeUsage(u) {
  const out = {};
  for (const f of USAGE_FIELDS) out[f] = Math.max(0, Number(u?.[f]) || 0);
  return out;
}

/**
 * This turn's share of a running total: now − baseline. A baseline bigger than now in any field (a thread Codex
 * compacted or replaced) means the count started again, so all of now is this turn's.
 */
export function usageDelta(now, baseline) {
  const n = normalizeUsage(now);
  if (!baseline) return n;
  const b = normalizeUsage(baseline);
  if (USAGE_FIELDS.some((f) => b[f] > n[f])) return n;
  const out = {};
  for (const f of USAGE_FIELDS) out[f] = n[f] - b[f];
  return out;
}

/** Codex's usage as Tarsee's (Anthropic's shape): its input_tokens includes the cached and cache-written parts. */
function tarseeUsage(d) {
  return {
    input_tokens: Math.max(0, d.input_tokens - d.cached_input_tokens - d.cache_write_input_tokens),
    cache_read_input_tokens: d.cached_input_tokens,
    cache_creation_input_tokens: d.cache_write_input_tokens,
    output_tokens: d.output_tokens,
  };
}

function unquote(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/'\\''/g, "'");
  if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) return s.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return s;
}

const POSIX_WRAP_RE = /^"?(?:[^"\s]*[\\/])?(?:bash|sh|zsh|dash)(?:\.exe)?"?\s+-l?c\s+([\s\S]+)$/;
const POWERSHELL_WRAP_RE = /^"?(?:[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-(?!Command\b)\w+)*\s+-Command\s+([\s\S]+)$/i;

/** The command a person would recognise: Codex's shell wrapper ("/bin/bash -lc '…'", PowerShell's -Command) taken off. */
export function unwrapShellCommand(command) {
  const s = String(command ?? "").trim();
  const m = POSIX_WRAP_RE.exec(s) || POWERSHELL_WRAP_RE.exec(s);
  return m ? unquote(m[1]) : s;
}

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function mcpResultText(item) {
  if (item.error?.message) return String(item.error.message);
  const content = item.result?.content;
  if (Array.isArray(content) && content.length) {
    return content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : c?.type ? `[${c.type}]` : "")).join("\n");
  }
  const structured = item.result?.structured_content;
  if (structured != null) { try { return JSON.stringify(structured); } catch { return String(structured); } }
  return "";
}

function stepStart(id, name, input) {
  return {
    type: "step", kind: "tool_start", id, name: displayToolName(name), rawName: name,
    summary: redactSecrets(summarizeToolInput(name, input)), input: toolInputPreview(name, input),
  };
}

/** A tool's start: the tool_use and its step. countItem adds it to the tools started (maxTurns). */
function startTool(state, id, name, input, { countItem = true } = {}) {
  if (state.started.has(id)) return [];
  state.started.add(id);
  state.open.set(id, name);
  if (countItem) state.toolCount += 1;
  return [{ type: "tool_use", id, name, input }, stepStart(id, name, input)];
}

/** A tool's end: the tool_result (text capped) and its step. */
function endTool(state, id, ok, text) {
  state.open.delete(id);
  const result = String(text ?? "").slice(0, RESULT_MAX_CHARS);
  return [{ type: "tool_result", id, ok, result }, { type: "step", kind: "tool_end", id, ok, preview: resultPreview(result) }];
}

/** A file_change item's tools: one Write or Edit per file. */
function fileTools(item) {
  return (Array.isArray(item.changes) ? item.changes : []).map((c, i) => ({
    id: `${item.id}:${i}`,
    name: c.kind === "add" ? "Write" : "Edit",
    input: { file_path: String(c.path ?? ""), ...(c.kind === "delete" ? { change: "delete" } : {}) },
    kind: c.kind,
  }));
}

function todoPair(state, item) {
  const items = Array.isArray(item.items) ? item.items : [];
  const key = JSON.stringify(items.map((t) => [t?.text, !!t?.completed]));
  const seen = state.todos.get(item.id);
  if (seen && seen.key === key) return [];
  const n = (seen?.n || 0) + 1;
  state.todos.set(item.id, { key, n });
  const id = `${item.id}#${n}`;
  const todos = items.map((t) => ({ content: String(t?.text ?? ""), status: t?.completed ? "completed" : "pending", activeForm: String(t?.text ?? "") }));
  return [...startTool(state, id, "TodoWrite", { todos }, { countItem: false }), ...endTool(state, id, true, "The task list was updated.")];
}

function retryStep(state, n, of, reason) {
  const why = String(reason || "").trim();
  const status = /\bstatus (\d{3})(?:\s+([A-Za-z][A-Za-z ]*?))?(?=[:,)]|$)/i.exec(why);
  const what = status
    ? `${state.label} answered ${status[1]}${status[2] ? ` ${status[2].trim()}` : ""}`
    : UNREACHABLE_RE.test(why) ? `Couldn't reach ${state.label}` : `${state.label} had a problem${why ? ` (${clip(why, 120)})` : ""}`;
  return { type: "step", kind: "status", text: redactSecrets(clip(`${what}. Trying again (${n} of ${of}).`, STATUS_MAX_CHARS)) };
}

/** The words worth showing from the SDK's "Codex Exec exited with code N: <stderr>" (its own start-up chatter dropped). */
function cleanCodexError(message) {
  const text = String(message ?? "");
  const m = /^Codex Exec exited with (code \d+|signal \w+):\s*([\s\S]*)$/.exec(text);
  if (!m) return text.trim();
  const lines = m[2].split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^WARNING: proceeding, even though we could not create PATH aliases/.test(l) && !/^Reading (prompt|additional input) from stdin/.test(l))
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARN|INFO)\s+\S+:\s*/, ""));
  return lines.join("\n").trim();
}

/**
 * What a Codex failure means (engine-errors.js classifyEngineError, with Codex's own words for a thread it can't resume,
 * a server it can't reach, a Local AI server with no Responses API and a missing binary). Returns {kind, message,
 * recoverable}.
 */
export function classifyCodexFailure(providerId, rawMessage, { model = null, localUrl = null, status = null, code = null } = {}) {
  const id = normalizeProviderId(providerId) || String(providerId || "");
  const message = cleanCodexError(rawMessage);
  if (MISSING_BINARY_RE.test(message)) {
    return { kind: "unknown", recoverable: false, message: "**Codex isn't installed where Tarsee can run it** (the @openai/codex package or its program for this system is missing). Reinstall Tarsee's dependencies, then try again." };
  }
  if (RESUME_FAILED_RE.test(message)) return { kind: "session", recoverable: true, message: friendly(id, "session") };
  if (/subscription_sharing_usage_unavailable/i.test(message)) {
    return { kind: "unavailable", recoverable: false, message: "**The ChatGPT plan's usage isn't available to Codex right now.** Check the plan at chatgpt.com/codex/settings/usage, or switch to another AI in Settings > AI meanwhile." };
  }
  const c = classifyEngineError(id, "codex", { status, code, message, model });
  // A Local AI server that lists models but has no /responses route (Ollama before 0.13.3, LM Studio before 0.3.29, a
  // chat-completions-only server) answers 404 without a word about a model; a real unknown model's 404 names it.
  if (id === "local" && c.kind === "model" && c.status === 404 && !/model/i.test(message.replace(/,?\s*url:\s*\S+/gi, ""))) {
    return { kind: "unavailable", recoverable: false, message: redactSecrets(localNoResponsesMessage(localUrl)) };
  }
  let kind = c.kind;
  let words = c.message;
  if ((kind === "unknown" || kind === "unavailable") && UNREACHABLE_RE.test(message) && !c.status) kind = "unavailable";
  if (kind === "unavailable" && id === "local") {
    const hint = getProvider("local")?.errorHints?.unreachable || "Can't reach your Local AI at {url}.";
    words = `**${hint.replace("{url}", localUrl || "its address")}** Check that the server is running and that the address in Settings > AI is right.`;
  } else if (kind === "unavailable" && c.kind !== "unavailable") {
    words = friendly(id, "unavailable");
  }
  if (kind === "rate") {
    const when = /try again (?:in|at|after) [^.\n]+/i.exec(message);
    if (when) words = `${words} (${when[0].trim()})`;
  }
  return { kind, recoverable: !!c.recoverable, message: redactSecrets(words) };
}

/** The events a failure ends a turn with (and marks the state done). */
function failureEvents(state, rawMessage) {
  const c = classifyCodexFailure(state.providerId, rawMessage, { model: state.model, localUrl: state.localUrl });
  state.done = true;
  if (c.kind === "auth" || c.kind === "expired") {
    return [
      { type: "text", content: c.message },
      { type: "error", message: c.message, code: c.kind, subtype: "auth-expired", recoverable: false },
      { type: "done", stopReason: "auth-expired" },
    ];
  }
  return [
    { type: "error", message: c.message, code: c.kind, subtype: c.kind, recoverable: c.recoverable },
    { type: "done", stopReason: "error" },
  ];
}

/**
 * The usage event and usage step for a thread's running total (Codex's turn.completed usage, or the last total its
 * rollout recorded for a turn that ended any other way): this turn's share, the total less the baseline.
 */
export function usageEvents(state, totals) {
  const usage = tarseeUsage(usageDelta(totals, state.baseline));
  return [
    { type: "usage", usage },
    {
      type: "step", kind: "usage",
      input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens, output: usage.output_tokens,
      total: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
      calls: null, outTps: null, nowTps: null,
    },
  ];
}

/** Every tool still waiting for its result, closed as not finished. */
function closeOpen(state, why) {
  const out = [];
  for (const id of [...state.open.keys()]) out.push(...endTool(state, id, false, why));
  return out;
}

// --- Mapping -------------------------------------------------------------------------------------------------------

/** Tarsee's events for one Codex SDK event. */
export function mapCodexEvent(ev, state) {
  if (!ev || typeof ev !== "object" || state.done) return [];
  switch (ev.type) {
    case "thread.started":
      if (ev.thread_id) state.threadId = String(ev.thread_id);
      return [];
    case "turn.started":
      return [];
    case "item.started":
      return itemStarted(ev.item, state);
    case "item.updated":
      return ev.item?.type === "todo_list" ? todoPair(state, ev.item) : [];
    case "item.completed":
      return itemCompleted(ev.item, state);
    case "turn.completed": {
      const totals = normalizeUsage(ev.usage);
      state.totals = totals;
      state.done = true;
      return [...closeOpen(state, "Ended without a result."), ...(state.baselineKnown ? usageEvents(state, totals) : []), { type: "done", stopReason: "end_turn" }];
    }
    case "turn.failed":
      return [...closeOpen(state, "The turn failed before it finished."), ...failureEvents(state, ev.error?.message || state.lastError || "The turn failed.")];
    case "error": {
      const msg = String(ev.message ?? "");
      const retry = RECONNECT_RE.exec(msg);
      if (retry) {
        state.lastRetry = retry[3] || "";
        return [retryStep(state, Number(retry[1]), Number(retry[2]), retry[3])];
      }
      state.lastError = msg;
      return [];
    }
    default:
      return [];
  }
}

function itemStarted(item, state) {
  if (!item || !item.id) return [];
  switch (item.type) {
    case "command_execution":
      return startTool(state, item.id, "Bash", { command: unwrapShellCommand(item.command) });
    case "mcp_tool_call":
      return startTool(state, item.id, `mcp__${item.server}__${item.tool}`, item.arguments ?? {});
    case "file_change": {
      const tools = fileTools(item);
      if (!tools.length) return [];
      if (!tools.some((t) => state.started.has(t.id))) state.toolCount += 1;
      return tools.flatMap((t) => startTool(state, t.id, t.name, t.input, { countItem: false }));
    }
    case "todo_list":
      return todoPair(state, item);
    case "web_search":
      return startTool(state, item.id, "WebSearch", { query: String(item.query ?? "") });
    case "reasoning":
      if (state.thinking.has(item.id)) return [];
      state.thinking.add(item.id);
      return [{ type: "thinking", status: "start" }];
    default:
      return [];
  }
}

function itemCompleted(item, state) {
  if (!item) return [];
  switch (item.type) {
    case "command_execution": {
      const out = itemStarted(item, state);
      const ok = item.status !== "failed" && item.exit_code === 0;
      const text = item.aggregated_output || (item.exit_code != null && item.exit_code !== 0 ? `(exit code ${item.exit_code})` : "");
      return [...out, ...endTool(state, item.id, ok, text)];
    }
    case "mcp_tool_call": {
      const out = itemStarted(item, state);
      return [...out, ...endTool(state, item.id, item.status === "completed" && !item.error, mcpResultText(item))];
    }
    case "file_change": {
      const out = itemStarted(item, state);
      const ok = item.status === "completed";
      for (const t of fileTools(item)) {
        const verb = t.kind === "add" ? "Added" : t.kind === "delete" ? "Deleted" : "Updated";
        out.push(...endTool(state, t.id, ok, ok ? `${verb} ${t.input.file_path}` : `The change to ${t.input.file_path} wasn't applied.`));
      }
      return out;
    }
    case "todo_list":
      return todoPair(state, item);
    case "web_search": {
      const out = itemStarted(item, state);
      return [...out, ...endTool(state, item.id, true, "")];
    }
    case "reasoning": {
      const out = state.thinking.has(item.id) ? [] : [{ type: "thinking", status: "start" }];
      state.thinking.delete(item.id);
      const text = String(item.text ?? "").trim();
      if (text) out.push({ type: "step", kind: "thinking", text: redactSecrets(text.slice(0, THINKING_MAX_CHARS)) });
      out.push({ type: "thinking", status: "stop" });
      return out;
    }
    case "agent_message": {
      const text = String(item.text ?? "");
      if (!text) return [];
      const content = state.textCount > 0 ? `\n\n${text}` : text;
      state.textCount += 1;
      const out = [{ type: "text", content }];
      if (text.trim()) out.push({ type: "step", kind: "text", text: text.trim() });
      return out;
    }
    case "error": {
      const msg = String(item.message ?? "").trim();
      if (!msg || NOISE_RE.test(msg)) return [];
      return [{ type: "step", kind: "status", text: redactSecrets(clip(msg, STATUS_MAX_CHARS)) }];
    }
    default:
      return [];
  }
}

/**
 * The end of a turn that didn't end itself (or [] when it did): the tools still open are closed, then
 *   aborted   done{aborted}, no error (Stop, the idle watchdog, a caller giving up)
 *   maxTurns  error{subtype: error_max_turns} and done{max_turns}: the turn started more tools than allowed
 *   error     what the SDK threw (the binary missing or exiting, a thread it couldn't resume), else the last error
 *             Codex reported: classified as for turn.failed
 *   nothing   the engine ended without a word: an error and done{error}
 * Never more than one done.
 */
export function finishCodexEvents(state, { aborted = false, maxTurns = null, error = null } = {}) {
  if (state.done) return [];
  if (maxTurns != null) {
    state.done = true;
    return [
      ...closeOpen(state, "Stopped: the turn limit was reached."),
      { type: "error", subtype: "error_max_turns", code: "max_turns", recoverable: false, message: `Stopped after ${maxTurns} tool steps, the limit for this task. The task needs to be broken into smaller steps.` },
      { type: "done", stopReason: "max_turns" },
    ];
  }
  if (aborted) {
    state.done = true;
    return [...closeOpen(state, "Stopped before it finished."), { type: "done", stopReason: "aborted" }];
  }
  const closed = closeOpen(state, "The turn ended before it finished.");
  const thrown = error ? cleanCodexError(error?.message || error) : "";
  const words = thrown || state.lastError || state.lastRetry;
  if (words) return [...closed, ...failureEvents(state, thrown && state.lastError && !RESUME_FAILED_RE.test(thrown) && !MISSING_BINARY_RE.test(thrown) ? state.lastError : words)];
  state.done = true;
  return [...closed, { type: "error", code: "unknown", recoverable: false, message: `${state.label} stopped without finishing its reply. Try again.` }, { type: "done", stopReason: "error" }];
}
