/**
 * clip-result.js: keep a tarsee_* tool result small in the agent's context.
 *
 * A tool result stays in the context until the next compaction and is re-read
 * from cache on every model call after it (one list call on TarseeMacOS put
 * about 12k tokens in a session, re-read on dozens of calls). Past the cap, the
 * full text goes to a file and the result carries its head, its tail and the
 * file's path, the way Claude Code treats a long Bash output, so nothing is
 * lost: the agent can grep or read the file for the rest.
 *
 * TARSEE_TOOL_RESULT_MAX_CHARS overrides the cap (default 12000 characters).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 12_000;
const HEAD = 0.8;

/** The cap in force: TARSEE_TOOL_RESULT_MAX_CHARS, else 12000. */
export function toolResultMaxChars(env = process.env) {
  const n = Number(env.TARSEE_TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(n) && n >= 1000 ? Math.round(n) : DEFAULT_TOOL_RESULT_MAX_CHARS;
}

/** One result's text, cut to about `max` characters with the whole of it saved to a file. */
export function clipToolResult(toolName, text, {
  max = toolResultMaxChars(),
  dir = path.join(os.tmpdir(), "tarsee-tool-output"),
  now = Date.now(),
} = {}) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  let where = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    where = path.join(dir, `${String(toolName).replace(/[^\w.-]/g, "_")}-${now}.txt`);
    fs.writeFileSync(where, s, { mode: 0o600 });
  } catch { where = null; }
  const head = s.slice(0, Math.floor(max * HEAD));
  const tail = s.slice(s.length - Math.floor(max * (1 - HEAD) * 0.8));
  const note = where
    ? `[${s.length} characters, cut to keep the context small. The whole result is in ${JSON.stringify(where)}: grep it or read a range of it for what you need.]`
    : `[${s.length} characters, cut to keep the context small. Ask with narrower arguments for the rest.]`;
  return `${head}\n\n…\n\n${tail}\n\n${note}`;
}

/** A tool's MCP result ({ content: [...] }) with each text part clipped; images and the rest pass through. */
export function clipMcpResult(toolName, result, opts) {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((c) => (c?.type === "text" && typeof c.text === "string" ? { ...c, text: clipToolResult(toolName, c.text, opts) } : c)),
  };
}

/** SDK tool definitions whose handlers clip what they return. */
export function withClippedResults(tools) {
  return tools.map((t) => ({ ...t, handler: async (args, extra) => clipMcpResult(t.name, await t.handler(args, extra)) }));
}
