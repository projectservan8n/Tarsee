/**
 * mcp-stub.js: a tiny stand-in for Tarsee's loopback MCP endpoint (src/ai/mcp-http.js), for tests that run the real
 * Codex binary. It serves a few tools named like Tarsee's over streamable HTTP (stateless, JSON responses) on
 * 127.0.0.1, takes only its own bearer token, and records every call, so a test can prove Codex reached a tool with the
 * turn's token and that the call was approved without anyone asking.
 *
 *   const mcp = await startMcpStub({ token: "mcp-test-token" });
 *   mcp.url     "http://127.0.0.1:<port>/mcp"
 *   mcp.calls   [{ tool, args }]
 *   mcp.auth    every request's Authorization header
 *   await mcp.close()
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export async function startMcpStub({ token }) {
  const calls = [];
  const auth = [];
  const sockets = new Set();

  const tools = (server) => {
    server.tool("tarsee_datetime", "The current date and time.", { timezone: z.string().optional() }, async (args) => {
      calls.push({ tool: "tarsee_datetime", args });
      return { content: [{ type: "text", text: "Monday, 9 November 2026, 09:00 UTC (stub)" }] };
    });
    server.tool("tarsee_remember", "Remember a fact.", { content: z.string() }, async (args) => {
      calls.push({ tool: "tarsee_remember", args });
      return { content: [{ type: "text", text: "Remembered." }] };
    });
    server.tool("tarsee_fail", "A tool that reports an error.", {}, async (args) => {
      calls.push({ tool: "tarsee_fail", args });
      return { isError: true, content: [{ type: "text", text: "This tool always fails (stub)." }] };
    });
  };

  const httpServer = http.createServer(async (req, res) => {
    auth.push(req.headers.authorization || "");
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; } catch { res.writeHead(400).end(); return; }
    const server = new McpServer({ name: "tarsee", version: "1.0.0" });
    tools(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  httpServer.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    auth,
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
