import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  slackTextToPlain,
  mentionsUser,
  slackEmojiName,
  displayForSlack,
  splitForSlack,
  openFence,
  stripCommandSentinel,
  MarkerFilter,
} = await import("../src/lib/slack-format.js");

describe("slackTextToPlain", () => {
  it("drops the bot's own mention and keeps the words", () => {
    assert.equal(slackTextToPlain("<@UBOT> what's up?", { botUserId: "UBOT" }), "what's up?");
    assert.equal(slackTextToPlain("hey <@UBOT|tarsee>, help", { botUserId: "UBOT" }), "hey, help");
  });

  it("turns other people's mentions into @names it can read", () => {
    const names = { U1: "alice" };
    assert.equal(
      slackTextToPlain("ask <@U1> and <@U2>", { botUserId: "UBOT", userName: (id) => names[id] || null }),
      "ask @alice and @U2",
    );
  });

  it("turns channel links, special mentions and user groups into plain words", () => {
    assert.equal(slackTextToPlain("see <#C123|general>", {}), "see #general");
    assert.equal(slackTextToPlain("see <#C123>", {}), "see #C123");
    assert.equal(slackTextToPlain("<!here> and <!channel> and <!everyone>", {}), "@here and @channel and @everyone");
    assert.equal(slackTextToPlain("<!subteam^S1|@ops> look", {}), "@ops look");
  });

  it("unwraps links, keeping both label and address when they differ", () => {
    assert.equal(slackTextToPlain("<https://a.com>", {}), "https://a.com");
    assert.equal(slackTextToPlain("<https://a.com|https://a.com>", {}), "https://a.com");
    assert.equal(slackTextToPlain("<https://a.com/x|the docs>", {}), "the docs (https://a.com/x)");
    assert.equal(slackTextToPlain("<mailto:a@b.co|a@b.co>", {}), "a@b.co");
  });

  it("decodes Slack's three HTML entities", () => {
    assert.equal(slackTextToPlain("a &lt;b&gt; &amp; c", {}), "a <b> & c");
  });

  it("handles empty input", () => {
    assert.equal(slackTextToPlain("", {}), "");
    assert.equal(slackTextToPlain(null, {}), "");
  });
});

describe("mentionsUser", () => {
  it("finds a mention of the bot, with or without a label", () => {
    assert.equal(mentionsUser("hi <@UBOT>", "UBOT"), true);
    assert.equal(mentionsUser("hi <@UBOT|tarsee>", "UBOT"), true);
    assert.equal(mentionsUser("hi <@UOTHER>", "UBOT"), false);
    assert.equal(mentionsUser("hi @UBOT", "UBOT"), false);
    assert.equal(mentionsUser("", "UBOT"), false);
  });
});

describe("slackEmojiName", () => {
  it("maps common emoji to Slack's names", () => {
    assert.equal(slackEmojiName("✅"), "white_check_mark");
    assert.equal(slackEmojiName("👍"), "+1");
    assert.equal(slackEmojiName("👀"), "eyes");
    assert.equal(slackEmojiName("❤️"), "heart");
    assert.equal(slackEmojiName("❤"), "heart");
  });

  it("accepts names as Slack writes them, with or without colons", () => {
    assert.equal(slackEmojiName(":tada:"), "tada");
    assert.equal(slackEmojiName("rocket"), "rocket");
    assert.equal(slackEmojiName("thumbsup::skin-tone-3"), "thumbsup::skin-tone-3");
  });

  it("gives null for something it cannot name", () => {
    assert.equal(slackEmojiName("🦩🦩"), null);
    assert.equal(slackEmojiName(""), null);
    assert.equal(slackEmojiName("two words"), null);
  });
});

describe("displayForSlack", () => {
  it("removes reaction markers and tool records, keeps markdown as written", () => {
    const raw = "Done [react: ✅]\n<tool_call>{\"name\":\"Bash\"}</tool_call>\n<tool_response>ok</tool_response>\n\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const out = displayForSlack(raw);
    assert.ok(!out.includes("[react"), out);
    assert.ok(!out.includes("tool_call"), out);
    assert.ok(!out.includes("tool_response"), out);
    assert.ok(out.includes("| a | b |"), "tables stay as markdown: Slack draws them");
    assert.ok(!/\n{3,}/.test(out), "no runs of blank lines");
  });
});

describe("splitForSlack", () => {
  it("keeps short text whole", () => {
    assert.deepEqual(splitForSlack("hi"), ["hi"]);
  });

  it("splits long text under the limit without breaking a code fence", () => {
    const code = "```js\n" + Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n```";
    const pieces = splitForSlack(code, 2000);
    assert.ok(pieces.length > 1);
    for (const p of pieces) {
      assert.ok(p.length <= 2000, `piece too long: ${p.length}`);
      assert.equal((p.match(/^```/gm) || []).length % 2, 0, "every piece opens and closes its fence");
    }
  });
});

describe("openFence", () => {
  it("says which fence is still open at the end of the text", () => {
    assert.equal(openFence("text"), null);
    assert.equal(openFence("```js\ncode\n```\nmore"), null);
    assert.equal(openFence("intro\n```python\nx = 1\n"), "```python");
    assert.equal(openFence("```\nplain"), "```");
  });
});

describe("MarkerFilter", () => {
  const run = (deltas) => {
    const f = new MarkerFilter();
    return deltas.map((d) => f.push(d)).join("") + f.end();
  };

  it("drops a reaction marker even when it arrives in pieces", () => {
    const f = new MarkerFilter();
    assert.equal(f.push("Done [rea"), "Done ");
    assert.equal(f.push("ct: ✅] next"), " next");
    assert.equal(f.end(), "");
  });

  it("drops memory markers in any case", () => {
    assert.equal(run(["Noted. [REMEMBER: likes tea]", " Anything else?"]), "Noted.  Anything else?");
    assert.equal(run(["[remember: x]ok"]), "ok");
  });

  it("lets ordinary brackets and links through, as soon as they cannot be a marker", () => {
    const f = new MarkerFilter();
    assert.equal(f.push("see [li"), "see [li");
    assert.equal(f.push("nk](https://a.com)"), "nk](https://a.com)");
    assert.equal(run(["[re", "ad more](x)"]), "[read more](x)");
    assert.equal(run(["a [1] b"]), "a [1] b");
  });

  it("gives back a half-written marker at the end as plain text", () => {
    assert.equal(run(["oops [rea"]), "oops [rea");
  });

  it("does not hold text forever when a marker never closes", () => {
    const f = new MarkerFilter();
    const out = f.push("[react: " + "x".repeat(400));
    assert.ok(out.length > 0, "released once it is too long to be a marker");
  });
});

describe("stripCommandSentinel", () => {
  it("drops the web-only theme sentinel and keeps the words", () => {
    assert.equal(stripCommandSentinel("__SET_THEME__:dark|Theme set to **dark**."), "Theme set to **dark**.");
    assert.equal(stripCommandSentinel("plain reply"), "plain reply");
  });
});
