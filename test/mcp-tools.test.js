import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTarseeMcp } from "../src/ai/tarsee-mcp.js";

// Regression guard for the highest-impact bug in the codebase.
//
// `tarsee_schedule_task` declared its nested `action.args` as
// `z.record(z.any())`. That single-argument form was removed in zod 4 (the
// project pins ^4.3.6): it yields a record whose key schema is undefined, and
// the MCP server throws while converting the tool list to JSON Schema.
//
// The failure is NOT scoped to that one tool. tools/list is a single call, so
// one bad schema fails the whole listing: the server is marked failed and
// EVERY mcp__tarsee__* tool disappears. Claude Code then sees none of Tarsee's
// tools while the system prompt still advertises twenty of them, so the model
// improvises — shelling out to curl to reach Telegram, hand-editing MEMORY.md
// instead of calling remember. It looks like a prompting problem and is not.
//
// Nothing caught it because the server *constructs* fine; only listTools
// throws, and that happens inside the Claude Code subprocess where the error
// surfaces as absent tools rather than a crash. So the test has to do what
// the SDK does: connect a real MCP client and list the tools.

/** Connect an in-memory MCP client to the Tarsee server and return it. */
async function connect() {
  const server = createTarseeMcp({});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tarsee-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("tarsee MCP server", () => {
  it("lists its tools without throwing", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    assert.ok(Array.isArray(listed.tools));
    assert.ok(listed.tools.length > 0, "tools/list returned an empty tool list");
    await client.close();
  });

  it("exposes every declared tool, so none is silently dropped", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    // The provider advertises these by name in the system prompt; if one stops
    // being listed, the model is being told about a tool it cannot call.
    const required = [
      "tarsee_send_message",
      "tarsee_schedule_task",
      "tarsee_remember",
      "tarsee_read_file",
      "tarsee_write_file",
      "tarsee_search_memories",
    ];
    const names = new Set(listed.tools.map((t) => t.name));
    for (const name of required) {
      assert.ok(names.has(name), `${name} is missing from tools/list`);
    }
    await client.close();
  });

  it("produces a valid JSON Schema for schedule_task's nested action.args", async () => {
    // The exact shape that used to throw. `args` is a free-form object, so the
    // schema must describe an object — not undefined.
    const { client } = await connect();
    const listed = await client.listTools();
    const scheduleTask = listed.tools.find((t) => t.name === "tarsee_schedule_task");
    assert.ok(scheduleTask, "tarsee_schedule_task not listed");
    const args = scheduleTask.inputSchema?.properties?.action?.properties?.args;
    assert.ok(args, "action.args has no schema");
    assert.equal(args.type, "object");
    await client.close();
  });
});
