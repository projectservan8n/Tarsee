// The composer's model picker (src/lib/model-picker.js, lib/model-catalog.js): its list is Claude Code's own catalog
// (the account's cache or the one in the installed CLI's build, the newer wins), the newest of each family on top in
// Claude Code's order, older ones under More models newest first, a newer version than the catalog lists going on top
// by itself, the effort levels with the CLI's Recommended one, Max's warning and Fable's note. Every entry is picked by
// its exact id, and a bare family word is resolved to the newest model before a turn. A chat's model and effort are
// its own (session.<id>.model / .effort) and its turns run on them on every channel; unset, Sonnet at Medium.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-model-picker-"));
process.env.TARSEE_STATE_DIR = tmp;
const { buildPicker, parsePickerId, jsLiteralToJson, catalogFromBuildText, literalEnd, FABLE_NOTE } = await import("../src/lib/model-picker.js");
const catalog = await import("../src/lib/model-catalog.js");

const effort = (id, name, extra = {}) => ({ id, name, ...extra });
const REC = { badge: { message: "Recommended", variant: "neutral" } };
const levels = (rec, max = {}) => ({
  type: "effort",
  description: "Higher effort means more thorough responses, but takes longer and uses your limits faster.",
  effort_options: [effort("low", "Low"), effort("medium", "Medium", rec === "medium" ? REC : {}), effort("high", "High", rec === "high" ? REC : {}),
    effort("xhigh", "Extra", rec === "xhigh" ? REC : {}), effort("max", "Max", max)],
});
const model = (id, name, section, family, rec, more = {}) => ({ id, name, section, thinking: levels(rec, more.max), runtime: { family, default_effort: rec }, ...more.extra });
// Shaped like <claude home>/cache/model-catalog/<org>-<account>-cc.json (the order is the catalog's own).
const CATALOG = {
  models: [
    model("claude-opus-5-5", "Opus 5.5", "main", "opus", "medium", { max: { badge: { message: "3.5× or more usage", variant: "warning" }, tooltip: { content: "Claude thinks longer with Max effort." } } }),
    model("claude-fable-5-1", "Fable 5.1", "main", "fable", "high", { extra: { notice: { text: "Fable is the most capable model and draws down usage much faster than Opus" } } }),
    model("claude-sonnet-5-5", "Sonnet 5.5", "main", "sonnet", "medium"),
    model("claude-haiku-5-5", "Haiku 5.5", "main", "haiku", "medium"),
    { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", section: "overflow", thinking: { type: "none" }, runtime: { family: "haiku" } },
    model("claude-sonnet-5", "Sonnet 5", "overflow", "sonnet", "high"),
    model("claude-opus-5", "Opus 5", "overflow", "opus", "high"),
    model("claude-fable-5", "Fable 5", "overflow", "fable", "high"),
    model("claude-opus-4-8", "Opus 4.8", "overflow", "opus", "high"),
    model("claude-opus-4-7", "Opus 4.7", "overflow", "opus", "xhigh"),
    { ...model("claude-opus-4-6", "Opus 4.6", "overflow", "opus", "high"), thinking: { type: "effort", effort_options: [effort("low", "Low"), effort("medium", "Medium"), effort("high", "High", REC), effort("max", "Max")] } },
    model("claude-sonnet-4-6", "Sonnet 4.6", "overflow", "sonnet", "high"),
  ],
  provider_alias_targets: { opus: { default: "claude-opus-5-5" }, fable: { default: "claude-fable-5-1" }, sonnet: { default: "claude-sonnet-5-5" }, haiku: { default: "claude-haiku-5-5" } },
};
// Tarsee offers no family words in the list: the SDK's bundled CLI would take one to an older model.
const NO_ALIASES = {};
const names = (list) => list.map((e) => e.name);

describe("model picker: the list from Claude Code's catalog", () => {
  const p = buildPicker({ catalog: CATALOG, aliases: NO_ALIASES, source: "test", fetchedAt: 1 });

  it("the newest of each family on top, in Claude Code's order: Opus, Fable, Sonnet, Haiku", () => {
    assert.deepEqual(names(p.main), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert.deepEqual(p.main.map((e) => e.alias), [null, null, null, null], "every entry is picked by its exact id");
  });

  it("the older ones under More models, newest first", () => {
    assert.deepEqual(names(p.more), ["Opus 5", "Fable 5", "Sonnet 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6", "Haiku 4.5"]);
    assert.ok(p.more.every((e) => e.alias === null), "an older one is picked by its own id");
    assert.equal(p.more.find((e) => e.name === "Haiku 4.5").id, "claude-haiku-4-5", "a dated id is folded into its base id");
  });

  it("the effort levels as Claude Code names them, with the CLI's Recommended one per model", () => {
    const opus = p.main[0];
    assert.deepEqual(opus.efforts.map((e) => e.name), ["Low", "Medium", "High", "Extra", "Max"]);
    assert.deepEqual(opus.efforts.filter((e) => e.recommended).map((e) => e.id), ["medium"]);
    assert.deepEqual(p.main[1].efforts.filter((e) => e.recommended).map((e) => e.id), ["high"], "Fable: High is the CLI's own");
    assert.deepEqual(p.more.find((e) => e.name === "Opus 4.7").efforts.filter((e) => e.recommended).map((e) => e.id), ["xhigh"]);
    assert.equal(p.effortNote, "Higher effort means more thorough responses, but takes longer and uses your limits faster.");
  });

  it("Max carries its warning where the CLI gives one", () => {
    const max = p.main[0].efforts.find((e) => e.id === "max");
    assert.deepEqual(max.badge, { text: "3.5× or more usage", tone: "warning" });
    assert.equal(p.main[2].efforts.find((e) => e.id === "max").badge, null);
  });

  it("Fable carries the usage credits note, and every Fable does", () => {
    assert.equal(p.main[1].note.text, FABLE_NOTE);
    assert.match(p.main[1].note.tip, /draws down usage much faster than Opus/);
    assert.equal(p.more.find((e) => e.name === "Fable 5").note.text, FABLE_NOTE);
    assert.equal(p.main[0].note, undefined);
  });

  it("no levels where the model has no effort", () => {
    assert.deepEqual(p.more.find((e) => e.name === "Haiku 4.5").efforts, []);
  });

  it("no word from the CLI on which level: Tarsee's default (Medium) is the recommended one", () => {
    const bare = { models: [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5", section: "main", thinking: { type: "effort", effort_options: [effort("low", "Low"), effort("medium", "Medium"), effort("high", "High")] } }] };
    const q = buildPicker({ catalog: bare, aliases: NO_ALIASES });
    assert.deepEqual(q.main[0].efforts.filter((e) => e.recommended).map((e) => e.id), ["medium"]);
  });
});

describe("model picker: a new model shows up by itself", () => {
  it("a newer catalog: the new one on top, the one it replaced under More models", () => {
    const next = { ...CATALOG, models: [model("claude-sonnet-6", "Sonnet 6", "main", "sonnet", "medium"), ...CATALOG.models.map((m) => (m.id === "claude-sonnet-5-5" ? { ...m, section: "overflow" } : m))],
      provider_alias_targets: { ...CATALOG.provider_alias_targets, sonnet: { default: "claude-sonnet-6" } } };
    const p = buildPicker({ catalog: next, aliases: NO_ALIASES });
    assert.deepEqual(names(p.main), ["Opus 5.5", "Fable 5.1", "Sonnet 6", "Haiku 5.5"]);
    assert.equal(p.main[2].id, "claude-sonnet-6");
    assert.equal(p.more[0].name, "Sonnet 5.5", "newest first");
  });

  it("a version known here that the catalog does not list yet: on top, with its family's levels", () => {
    const p = buildPicker({ catalog: CATALOG, aliases: NO_ALIASES, knownIds: ["claude-opus-6", "claude-opus-4-1", "claude-mythos-5"] });
    assert.deepEqual(names(p.main), ["Opus 6", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert.equal(p.main[0].id, "claude-opus-6");
    assert.deepEqual(p.main[0].efforts.map((e) => e.id), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(p.more[0].name, "Opus 5.5");
    assert.ok(!names(p.more).includes("Opus 4.1"), "an older one the catalog does not offer stays out");
    assert.ok(![...p.main, ...p.more].some((e) => e.family === "mythos"), "only the four families");
  });

  it("no catalog at all: the models known here, the newest of each family on top", () => {
    const p = buildPicker({ knownIds: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-sonnet-4-6"], aliases: NO_ALIASES });
    assert.deepEqual(names(p.main), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert.deepEqual(names(p.more), ["Opus 5", "Sonnet 4.6", "Haiku 4.5"]);
    assert.deepEqual(p.main[2].efforts.filter((e) => e.recommended).map((e) => e.id), ["medium"]);
    assert.equal(p.source, "known models");
  });

  it("names come from the ids when nothing else gives one", () => {
    assert.equal(parsePickerId("claude-opus-5-5").name, "Opus 5.5");
    assert.equal(parsePickerId("claude-sonnet-6").name, "Sonnet 6");
    assert.equal(parsePickerId("claude-haiku-4-5-20251001").id, "claude-haiku-4-5");
    assert.equal(parsePickerId("gpt-5"), null);
  });
});

describe("model picker: the catalog inside the CLI's build", () => {
  const BUILD = 'var a=1;function l(e){return e}var py={$schema:"https://downloads.claude.ai/model-catalog/v1/schema.json",schema_version:1,version:2902,issued_at:"2026-10-23T00:57:07Z",surfaces:{cc:{model_selector_config:[{id:"cc",models:[{id:"claude-opus-5-5",name:"Opus 5.5",section:"main",quick_select:!0,hidden:!1,runtime:{max_input_tokens:1e6,family:"opus",default_effort:"medium"},thinking:{type:"effort",effort_options:[{id:"medium",name:"Medium",badge:{message:"Recommended",variant:"neutral"}},{id:"max",name:"Max",tooltip:{content:"Uses \\xD7 more, it\'s \\"a lot\\""}}]}},{id:"claude-sonnet-5",name:"Sonnet 5",section:"overflow",x:void 0,y:.5}]}]}}},zz=2;';

  it("reads the object literal as data", () => {
    const text = BUILD.slice(BUILD.indexOf("{$schema"));
    const end = literalEnd(text, 0);
    const doc = JSON.parse(jsLiteralToJson(text.slice(0, end)));
    assert.equal(doc.version, 2902);
    const m = doc.surfaces.cc.model_selector_config[0].models;
    assert.equal(m[0].quick_select, true);
    assert.equal(m[0].hidden, false);
    assert.equal(m[0].runtime.max_input_tokens, 1e6);
    assert.equal(m[0].thinking.effort_options[1].tooltip.content, 'Uses × more, it\'s "a lot"');
    assert.equal(m[1].x, null);
    assert.equal(m[1].y, 0.5);
  });

  it("never runs anything: a call or a variable is refused", () => {
    assert.throws(() => jsLiteralToJson('{a:process.exit(1)}'), /not plain data/);
    assert.throws(() => jsLiteralToJson("{a:b}"), /not plain data/);
  });

  it("finds Claude Code's surface in the build's text", () => {
    const c = catalogFromBuildText(BUILD);
    assert.equal(c.issuedAt, Date.parse("2026-10-23T00:57:07Z"));
    assert.deepEqual(c.config.models.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5"]);
    assert.equal(catalogFromBuildText("no catalog here"), null);
  });
});

describe("model picker: Claude Code's own files, the newer wins", () => {
  const dir = path.join(tmp, "model-catalog");
  before(() => fs.mkdirSync(dir, { recursive: true }));
  after(() => catalog.__setForTests({ catalogDirs: null, cli: null }));

  const write = (name, fetchedAt, models) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 2, fetchedAt, catalog: { surface: "cc", config: { id: "cc", models } } }));

  it("the account's cached catalog, the newest cc file of them, in any Claude home", () => {
    write("org-a-cc.json", 1000, CATALOG.models);
    write("org-b-cc.json", 500, [model("claude-opus-4-8", "Opus 4.8", "main", "opus", "high")]);
    fs.writeFileSync(path.join(dir, "tok-x-ccd.json"), JSON.stringify({ version: 2, fetchedAt: 9999, catalog: { surface: "ccd", config: { models: [] } } }));
    catalog.__setForTests({ catalogDirs: [path.join(tmp, "no-such-home"), dir], cli: null });
    const p = catalog.getModelPicker();
    assert.equal(p.source, "Claude Code's catalog for this account");
    assert.deepEqual(names(p.main), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
  });

  it("an installed CLI build with a newer catalog than the account's cache wins", () => {
    catalog.__setForTests({ catalogDirs: [dir], cli: { bin: "/x", catalog: { issuedAt: 2000, config: { models: [model("claude-opus-6", "Opus 6", "main", "opus", "high"), ...CATALOG.models.map((m) => (m.id === "claude-opus-5-5" ? { ...m, section: "overflow" } : m))] } } } });
    const p = catalog.getModelPicker();
    assert.equal(p.source, "Claude Code's built-in catalog");
    assert.equal(p.main[0].name, "Opus 6");
    assert.equal(p.more[0].name, "Opus 5.5");
  });

  it("no Claude Code files: Tarsee's own table, still with the newest on top", () => {
    catalog.__setForTests({ catalogDirs: [path.join(tmp, "none")], cli: null });
    const p = catalog.getModelPicker();
    assert.equal(p.source, "known models");
    assert.deepEqual(p.main.map((e) => e.family), ["opus", "fable", "sonnet", "haiku"]);
    assert.ok(p.more.length > 0);
  });

  it("reads the catalog out of a CLI file without running it", async () => {
    const bin = path.join(tmp, "fake-claude");
    const BUILD = 'junk;var x={$schema:"https://downloads.claude.ai/model-catalog/v1/schema.json",issued_at:"2026-10-23T00:57:07Z",surfaces:{cc:{model_selector_config:[{id:"cc",models:[{id:"claude-sonnet-5-5",name:"Sonnet 5.5",section:"main"}]}]}}};more';
    fs.writeFileSync(bin, Buffer.concat([Buffer.alloc(1024, 0), Buffer.from(BUILD)]));
    const c = await catalog.readCliCatalog(bin);
    assert.deepEqual(c.config.models.map((m) => m.id), ["claude-sonnet-5-5"]);
    fs.writeFileSync(bin, "no catalog in here");
    assert.equal(await catalog.readCliCatalog(bin), null);
  });
});

describe("model picker: a family word runs the newest model", () => {
  before(() => catalog.__setForTests({ catalogDirs: [path.join(tmp, "none")], cli: { bin: "/x", catalog: { issuedAt: 1, config: CATALOG } } }));
  after(() => catalog.__setForTests({ catalogDirs: null, cli: null }));

  it("opus, sonnet, haiku and fable (any case) become the newest of their family", () => {
    assert.equal(catalog.resolveModel("opus"), "claude-opus-5-5");
    assert.equal(catalog.resolveModel("Sonnet"), "claude-sonnet-5-5");
    assert.equal(catalog.resolveModel("haiku"), "claude-haiku-5-5");
    assert.equal(catalog.resolveModel("fable"), "claude-fable-5-1");
  });

  it("an exact id, or a word with no known family, goes as it is", () => {
    assert.equal(catalog.resolveModel("claude-opus-4-7"), "claude-opus-4-7");
    assert.equal(catalog.resolveModel("default"), "default");
    assert.equal(catalog.resolveModel(undefined), undefined);
  });
});

describe("model picker: a chat's own model and effort", () => {
  let server, base, db, settings, convId;
  before(async () => {
    const { initDb } = await import("../src/db/sqlite.js");
    const { SettingsStore } = await import("../src/db/settings.js");
    const { ConversationStore } = await import("../src/db/conversations.js");
    const { chatRouter } = await import("../src/routes/chat.js");
    db = initDb(path.join(tmp, "picker.db"));
    settings = new SettingsStore(db);
    convId = new ConversationStore(db).create({ title: "picker" }).id;
    catalog.__setForTests({ catalogDirs: [path.join(tmp, "none")], cli: { bin: "/x", catalog: { issuedAt: 1, config: CATALOG } } });
    const app = express();
    app.set("db", db);
    app.use(express.json());
    app.use("/api/chat", chatRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api/chat`;
  });
  after(() => { server?.close(); catalog.__setForTests({ catalogDirs: null, cli: null }); db?.close(); });

  const put = (body) => fetch(`${base}/conversations/${convId}/picker`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("the list comes with the models, and a chat with nothing of its own shows the defaults: Sonnet, Medium", async () => {
    const m = await (await fetch(`${base}/models`)).json();
    assert.deepEqual(m.picker.main.map((e) => e.name), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    assert.ok(Array.isArray(m.models), "the table is still there for Settings");
    const pick = await (await fetch(`${base}/conversations/${convId}/picker`)).json();
    assert.deepEqual(pick, { model: null, effort: null, defaults: { model: "sonnet", effort: "medium" } });
  });

  it("a pick is saved for the chat, under the keys /think uses", async () => {
    const r = await (await put({ model: "claude-opus-5-5", effort: "xhigh" })).json();
    assert.equal(r.model, "claude-opus-5-5");
    assert.equal(r.effort, "xhigh");
    assert.equal(settings.get(`session.${convId}.model`), "claude-opus-5-5");
    assert.equal(settings.get(`session.${convId}.effort`), "xhigh");
    assert.equal((await (await put({ model: "claude-opus-4-7" })).json()).model, "claude-opus-4-7");
  });

  it("null goes back to the default; an unknown model or level is refused", async () => {
    const r = await (await put({ model: null, effort: null })).json();
    assert.equal(r.model, null);
    assert.equal(r.effort, null);
    assert.equal(settings.get(`session.${convId}.model`), null);
    assert.equal((await put({ model: "gpt-5" })).status, 400);
    assert.equal((await put({ effort: "ultracode" })).status, 400, "not a level the Agent SDK takes");
    assert.equal((await put({ effort: "turbo" })).status, 400);
    assert.equal((await fetch(`${base}/conversations/nope/picker`)).status, 404);
  });

  it("the chat's turns run on its model and effort on every channel; a caller's own model is left alone", async () => {
    const { withChatModel } = await import("../src/ai/providers/claude-code.js");
    const ctx = (id) => ({ db, conversationId: id });
    settings.set(`session.${convId}.model`, "claude-opus-4-8");
    assert.equal(withChatModel({ model: "sonnet", toolCtx: ctx(convId) }).model, "claude-opus-4-8", "the channels pass the default");
    assert.equal(withChatModel({ model: undefined, toolCtx: ctx(convId) }).model, "claude-opus-4-8");
    assert.equal(withChatModel({ model: "haiku", toolCtx: ctx(convId) }).model, "haiku", "a model chosen on purpose stays");
    assert.equal(withChatModel({ model: "sonnet", toolCtx: ctx("other") }).model, "sonnet");
    settings.delete(`session.${convId}.model`);
    assert.equal(withChatModel({ model: "sonnet", toolCtx: ctx(convId) }).model, "sonnet");
    assert.equal(withChatModel({ model: "sonnet", toolCtx: ctx(convId) }).effort, "medium", "unset: Medium");
    settings.set(`session.${convId}.effort`, "high");
    assert.equal(withChatModel({ toolCtx: ctx(convId) }).effort, "high");
    assert.equal(withChatModel({ effort: "low", toolCtx: ctx(convId) }).effort, "low", "/think or !think for one message wins");
    settings.delete(`session.${convId}.effort`);
    const bg = { model: "haiku", toolCtx: { db, conversationId: null } };
    assert.deepEqual(withChatModel(bg), bg, "background work keeps its own model and effort");
  });

  it("/think says Medium is the default", async () => {
    const { processCommand } = await import("../src/lib/commands.js");
    const out = await processCommand("/think", { settingsStore: settings, conversationId: convId });
    assert.match(String(out?.response ?? out), /medium \(the default\)/);
  });
});
