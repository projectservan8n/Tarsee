/**
 * Human-readable, leak-safe status labels for tool_use events. The Telegram, Discord and Slack channels show them
 * while a tool runs ("Running command…", "Sending report.pdf…") and when it ends ("Command done", "Sent report.pdf").
 *
 * Never returns command bodies, env values, key names or values, full URLs, or query strings: the bot UX stays safe
 * by construction even if the user disabled the webapp's secret-redaction toggle.
 *
 * Claude Code names a tool from an MCP server mcp__<server>__<tool>, so Tarsee's own tools arrive as
 * mcp__tarsee__tarsee_send_file and so on: they get words of their own, and any other server's tool shows by its own
 * name without the prefix.
 */

/** The file name at the end of a path, either slash. */
const fileBase = (p) => String(p || "").split(/[\\/]/).pop() || "file";
/** A PDF's file name, from a path or a web address (never its query string or fragment, which can hold a token). */
const pdfBase = (i) => fileBase(String(i?.path || i?.source || "").split(/[?#]/)[0]);

/** mcp__tarsee__tarsee_send_file → tarsee_send_file; a built-in tool's name stays as it is. */
const bareName = (name) => String(name || "tool").replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");

// Tarsee's own tools: [while it runs, when it is done, when it failed]. A function gets the tool's input.
const TARSEE = {
  tarsee_send_file: [(i) => `Sending ${fileBase(i.file_path)}…`, (i) => `Sent ${fileBase(i.file_path)}`, (i) => `Sending ${fileBase(i.file_path)} failed`],
  tarsee_send_message: ["Sending a message…", "Message sent", "Sending the message failed"],
  tarsee_send_email_thread: ["Sending an email…", "Email sent", "Sending the email failed"],
  tarsee_configure_email_channel: ["Setting up email…", "Email set up", "Setting up email failed"],
  tarsee_push_notification: ["Sending a notification…", "Notification sent", "Sending the notification failed"],
  tarsee_web_search: ["Web searching…", "Web search done", "Web search failed"],
  tarsee_web_fetch: ["Fetching URL…", "Fetch done", "Fetch failed"],
  tarsee_browser: ["Using the browser…", "Browser done", "Browser failed"],
  tarsee_remember: ["Saving a memory…", "Memory saved", "Saving the memory failed"],
  tarsee_search_memories: ["Searching memories…", "Memory search done", "Memory search failed"],
  tarsee_search_memories_deep: ["Searching memories…", "Memory search done", "Memory search failed"],
  tarsee_daily_log: ["Writing the daily log…", "Daily log written", "Writing the daily log failed"],
  tarsee_read_file: [(i) => `Reading ${fileBase(i.filename)}…`, (i) => `Read ${fileBase(i.filename)}`, (i) => `Reading ${fileBase(i.filename)} failed`],
  tarsee_pdf_read: [(i) => `Reading ${pdfBase(i)}…`, (i) => `Read ${pdfBase(i)}`, (i) => `Reading ${pdfBase(i)} failed`],
  tarsee_write_file: [(i) => `Writing ${fileBase(i.filename)}…`, (i) => `Wrote ${fileBase(i.filename)}`, (i) => `Writing ${fileBase(i.filename)} failed`],
  tarsee_list_files: ["Listing files…", "Files listed", "Listing files failed"],
  // A task the AI schedules is saved paused, until the owner switches it on (lib/cron.js).
  tarsee_schedule_task: ["Scheduling a task…", "Task saved, waiting for your OK", "Scheduling the task failed"],
  tarsee_create_canvas: ["Making a canvas…", "Canvas made", "Making the canvas failed"],
  tarsee_create_diagram: ["Drawing a diagram…", "Diagram drawn", "Drawing the diagram failed"],
  tarsee_datetime: ["Checking the time…", "Time checked", "Checking the time failed"],
  tarsee_calculator: ["Calculating…", "Calculated", "Calculation failed"],
  tarsee_discord_admin: ["Working on Discord…", "Discord done", "Discord failed"],
  tarsee_railway: ["Working on Railway…", "Railway done", "Railway failed"],
  // The vault: never a key's name, let alone its value.
  tarsee_get_key: ["Checking the vault…", "Vault checked", "Vault check failed"],
  tarsee_list_keys: ["Checking the vault…", "Vault checked", "Vault check failed"],
  tarsee_set_key: ["Saving a key…", "Key saved", "Saving the key failed"],
  tarsee_delete_key: ["Removing a key…", "Key removed", "Removing the key failed"],
};

const tarseeLabel = (name, input, which) => {
  const entry = TARSEE[bareName(name)];
  if (!entry) return null;
  const label = entry[which];
  return typeof label === "function" ? label(input || {}) : label;
};

/** A readable name for a tool nothing above knows: mcp__github__list_pull_requests → "list pull requests". */
const otherName = (name) => (String(name || "").startsWith("mcp__") ? bareName(name).replace(/_/g, " ") : name);

export function toolStatusLabel(name, input = {}) {
  const own = tarseeLabel(name, input, 0);
  if (own) return own;
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
    default:          return `Running ${otherName(name)}…`;
  }
}

/**
 * Variant for the post-completion "done" / "failed" line. Pass the
 * original input so file-based tools (Read/Write/Edit) keep their
 * filename context.
 */
export function toolDoneLabel(name, input = {}, isError = false) {
  const own = tarseeLabel(name, input, isError ? 2 : 1);
  if (own) return own;
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
    default:          return `${otherName(name)} ${verb}`;
  }
}
