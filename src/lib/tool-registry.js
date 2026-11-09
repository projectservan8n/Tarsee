/**
 * tool-registry.js: every tool Tarsee's agent can run, in one list, for Settings > Security
 * (GET /api/admin/tool-registry, routes/admin.js).
 *
 * Three sources, merged:
 *   - Tarsee's own tools as lib/tools.js defines them (getToolDefinitions): read_file, exec, pdf_read, ...
 *   - the tarsee MCP server's live list (ai/tarsee-mcp.js, asked over an in-memory MCP client exactly as an
 *     engine asks it): tarsee_send_message, tarsee_push_notification, tarsee_pdf_read, ... Each one runs
 *     executeTool("<name without tarsee_>"), so it is the same tool as lib/tools.js's of that name.
 *   - the tools built into the engines themselves: Claude Code's Read, Write, Edit, Bash, Glob and Grep, and
 *     Codex's shell, file patch and plan tools (named in Claude's words, as the live view shows them).
 *
 * Each entry: { name, label, description, group, policyCovered, mcpName, engines, mode? }
 *   name           the Tool Permissions name (what POST /api/admin/tool-permissions takes): "push_notification"
 *   mcpName        what the agent calls it ("tarsee_push_notification"; the engine sees mcp__tarsee__<mcpName>),
 *                  null for a tool the agent can't call through the tarsee server
 *   policyCovered  true when Settings > Tool Permissions applies (everything through executeTool); false for the
 *                  engines' own tools, which nothing in Tarsee can gate (design 2, non-goals: said honestly)
 *   engines        for a built-in tool, the engines that have it
 *   mode           the current Tool Permissions setting (filled by the route)
 */

const MCP_PREFIX = "tarsee_";

/** Plain-language names and groups for the tools Tarsee ships. Anything else is named from its id, in "Other". */
const KNOWN = {
  send_message: ["Send a message", "Messages"],
  send_file: ["Send a file", "Messages"],
  send_email_thread: ["Send an email", "Messages"],
  push_notification: ["Send a phone or browser notification", "Messages"],
  remember: ["Remember a fact", "Memory and notes"],
  daily_log: ["Write in today's log", "Memory and notes"],
  search_memories: ["Search memories", "Memory and notes"],
  search_memories_deep: ["Search memories in depth", "Memory and notes"],
  read_file: ["Read a workspace file", "Workspace files"],
  write_file: ["Write a workspace file", "Workspace files"],
  edit_file: ["Edit a workspace file", "Workspace files"],
  append_file: ["Add to a workspace file", "Workspace files"],
  list_files: ["List workspace files", "Workspace files"],
  grep: ["Search workspace files", "Workspace files"],
  web_fetch: ["Open a web address", "Web"],
  web_search: ["Search the web", "Web"],
  browser: ["Use a web browser", "Web"],
  get_key: ["Read a saved key", "Vault keys"],
  set_key: ["Save a key", "Vault keys"],
  list_keys: ["List saved keys", "Vault keys"],
  delete_key: ["Delete a saved key", "Vault keys"],
  schedule_task: ["Schedule a task", "Scheduling"],
  discord_admin: ["Manage a Discord server", "Admin"],
  railway: ["Manage Railway services", "Admin"],
  configure_email_channel: ["Set up the email channel", "Admin"],
  pdf_read: ["Read a PDF", "Documents and visuals"],
  create_canvas: ["Make an interactive page", "Documents and visuals"],
  create_diagram: ["Draw a diagram", "Documents and visuals"],
  calculator: ["Calculate", "Utilities"],
  datetime: ["Check the date and time", "Utilities"],
  exec: ["Run a command on the server", "Shell"],
};

/** The tools built into the engines, in the names the live view uses for them. Tool Permissions can't limit them. */
export const BUILT_IN_TOOLS = Object.freeze([
  { name: "Bash", label: "Run commands in a shell", description: "Runs shell commands in the workspace. Built into the AI itself.", engines: ["claude-code", "codex"] },
  { name: "Read", label: "Read files", description: "Reads any file the server can open. Built into the AI itself.", engines: ["claude-code"] },
  { name: "Write", label: "Write files", description: "Creates or replaces files. Built into the AI itself.", engines: ["claude-code"] },
  { name: "Edit", label: "Edit files", description: "Changes part of a file. Built into the AI itself.", engines: ["claude-code", "codex"] },
  { name: "Glob", label: "Find files by name", description: "Lists files matching a pattern. Built into the AI itself.", engines: ["claude-code"] },
  { name: "Grep", label: "Search inside files", description: "Searches file contents. Built into the AI itself.", engines: ["claude-code"] },
  { name: "TodoWrite", label: "Keep a task list", description: "Tracks the steps of a long job. Built into the AI itself.", engines: ["codex"] },
].map((t) => Object.freeze({ ...t, engines: Object.freeze([...t.engines]) })));

export const BUILT_IN_GROUP = "Built into the AI";

/** The first sentence of a description, short enough for a settings row. */
function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  const one = m ? m[1] : s;
  return one.length > 220 ? `${one.slice(0, 219).trimEnd()}…` : one;
}

/** "brand_new" -> "Brand new". */
function labelFromName(name) {
  const s = String(name).replace(/_/g, " ").trim();
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : String(name);
}

/**
 * The registry from its sources (pure). toolDefs: [{ name, description }] (lib/tools.js getToolDefinitions),
 * mcpTools: [{ name, description }] (the tarsee MCP server's tools/list). Tarsee's tools sorted by group then
 * label, the engines' own last.
 */
export function buildToolRegistry({ toolDefs = [], mcpTools = [] } = {}) {
  const byName = new Map();
  const entry = (name) => {
    if (!byName.has(name)) {
      const [label, group] = KNOWN[name] || [labelFromName(name), "Other"];
      byName.set(name, { name, label, description: "", group, policyCovered: true, mcpName: null, engines: null });
    }
    return byName.get(name);
  };
  for (const d of toolDefs) {
    if (!d?.name) continue;
    const e = entry(d.name);
    if (!e.description) e.description = firstSentence(d.description);
  }
  for (const t of mcpTools) {
    if (!t?.name || !t.name.startsWith(MCP_PREFIX)) continue;
    const e = entry(t.name.slice(MCP_PREFIX.length));
    e.mcpName = t.name;
    // What the agent is told is what it acts on: the MCP description wins.
    const d = firstSentence(t.description);
    if (d) e.description = d;
  }
  const own = [...byName.values()].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  const builtIn = BUILT_IN_TOOLS.map((t) => ({
    name: t.name, label: t.label, description: t.description, group: BUILT_IN_GROUP, policyCovered: false, mcpName: null, engines: [...t.engines],
  }));
  return [...own, ...builtIn];
}

let _mcpList = null;

/**
 * The tarsee MCP server's tools as an engine sees them ([{ name, description }]), asked once per process over an
 * in-memory MCP client. An empty list if the server can't be built (the registry then shows lib/tools.js's tools).
 */
export function mcpToolList() {
  if (!_mcpList) {
    _mcpList = (async () => {
      const [{ createTarseeMcp }, { Client }, { InMemoryTransport }] = await Promise.all([
        import("../ai/tarsee-mcp.js"),
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/inMemory.js"),
      ]);
      const server = createTarseeMcp({});
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tarsee-tool-registry", version: "1.0.0" }, { capabilities: {} });
      await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
      try {
        const { tools } = await client.listTools();
        return (tools || []).map((t) => ({ name: t.name, description: t.description || "" }));
      } finally {
        await client.close().catch(() => {});
      }
    })().catch((err) => {
      console.warn(`[tools] could not list the tarsee MCP tools: ${err.message}`);
      _mcpList = null;
      return [];
    });
  }
  return _mcpList;
}

/** The live registry: lib/tools.js's definitions and the tarsee MCP server's list, with the engines' own tools. */
export async function toolRegistry() {
  const [{ getToolDefinitions }, mcpTools] = await Promise.all([import("./tools.js"), mcpToolList()]);
  return buildToolRegistry({ toolDefs: getToolDefinitions(), mcpTools });
}
