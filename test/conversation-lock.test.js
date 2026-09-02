import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  withConversationTurn,
  queueDepth,
  _resetConversationLocks,
} from "../src/lib/conversation-lock.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => _resetConversationLocks());

describe("withConversationTurn", () => {
  it("runs turns for one conversation strictly in order, never overlapping", async () => {
    const events = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const turn = (name, ms) => withConversationTurn("conv-1", async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${name}:end`);
      concurrent--;
      return name;
    });

    // Start a slow turn, then a fast one — the fast one must still wait.
    const a = turn("a", 30);
    const b = turn("b", 1);
    assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
    assert.equal(maxConcurrent, 1, "two turns ran at once on one conversation");
    assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);
  });

  it("does not serialize across different conversations", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const turn = (conv) => withConversationTurn(conv, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await tick();
      concurrent--;
    });
    await Promise.all([turn("a"), turn("b"), turn("c")]);
    // A slow Telegram group must never block Discord.
    assert.equal(maxConcurrent, 3);
  });

  it("keeps draining the queue after a turn throws", async () => {
    const boom = withConversationTurn("conv-1", async () => {
      throw new Error("turn failed");
    });
    await assert.rejects(boom, /turn failed/);

    // The next turn must still run: one failed reply cannot wedge a chat.
    const after = await withConversationTurn("conv-1", async () => "ok");
    assert.equal(after, "ok");
  });

  it("propagates the result and the error to the caller", async () => {
    assert.equal(await withConversationTurn("c", async () => 42), 42);
    await assert.rejects(
      withConversationTurn("c", async () => { throw new Error("nope"); }),
      /nope/,
    );
  });

  it("reports how many turns are ahead when it has to wait", async () => {
    const queuedAt = [];
    const opts = { onQueued: (n) => queuedAt.push(n) };
    const slow = withConversationTurn("conv-1", () => tick(), opts);
    const second = withConversationTurn("conv-1", async () => "2", opts);
    const third = withConversationTurn("conv-1", async () => "3", opts);
    await Promise.all([slow, second, third]);
    // The first did not wait; the others each saw someone ahead of them.
    assert.deepEqual(queuedAt, [1, 2]);
  });

  it("releases state once the conversation goes idle", async () => {
    await withConversationTurn("conv-1", async () => "done");
    await tick();
    assert.equal(queueDepth("conv-1"), 0);
  });

  it("runs immediately when there is no conversation id", async () => {
    assert.equal(await withConversationTurn(null, async () => "anon"), "anon");
  });
});
