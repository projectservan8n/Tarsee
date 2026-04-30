/**
 * Human-readable, leak-safe status labels for tool_use events. Used by the
 * Telegram and Discord channels to show "Running command…" / "Reading
 * README.md…" status messages between narration segments instead of
 * hiding tool execution entirely.
 *
 * Never returns command bodies, env values, full URLs, or query strings —
 * keeps the bot UX safe by construction even if the user disabled the
 * webapp's secret-redaction toggle.
 */

const fileBase = (p) => (p || "").split("/").pop() || "file";

export function toolStatusLabel(name, input = {}) {
  switch (name) {
    case "Bash":      return "Running command…";
    case "Read":      return `Reading ${fileBase(input.file_path)}…`;
    case "Write":     return `Writing ${fileBase(input.file_path)}…`;
    case "Edit":      return `Editing ${fileBase(input.file_path)}…`;
    case "Glob":      return "Searching files…";
    case "Grep":      return "Searching code…";
    case "WebFetch":  return "Fetching URL…";
    case "WebSearch": return "Web searching…";
    case "TodoWrite": return "Updating todo list…";
    default:          return `Running ${name}…`;
  }
}

/**
 * Variant for the post-completion "done" / "failed" line. Pass the
 * original input so file-based tools (Read/Write/Edit) keep their
 * filename context.
 */
export function toolDoneLabel(name, input = {}, isError = false) {
  const verb = isError ? "failed" : "done";
  switch (name) {
    case "Bash":      return `Command ${verb}`;
    case "Read":      return `Read ${fileBase(input.file_path)}`;
    case "Write":     return `Wrote ${fileBase(input.file_path)}`;
    case "Edit":      return `Edited ${fileBase(input.file_path)}`;
    case "Glob":      return `File search ${verb}`;
    case "Grep":      return `Code search ${verb}`;
    case "WebFetch":  return `Fetch ${verb}`;
    case "WebSearch": return `Web search ${verb}`;
    case "TodoWrite": return "Todos updated";
    default:          return `${name} ${verb}`;
  }
}
