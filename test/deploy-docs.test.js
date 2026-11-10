// The deploy files and the docs say how to choose an AI (docs/superpowers/specs/2026-11-09-multi-provider-design.md
// 4.4, 4.16, Phase 5 "Docs and defaults"):
// - .env.example, docker-compose.yml and railway.toml name every AI variable with a one-line explanation and never
//   hold a value for one (keys go in Settings > AI or Railway's variables, never in a file); the old "do NOT set
//   ANTHROPIC_API_KEY" advice gives way to the provider model.
// - README: "Choose your AI" with the seven options, what each costs, the plan-or-key terms note, "API keys only",
//   keys only in Settings or Railway variables; no "built for Claude Max" claims; the docker run port is the one the
//   server listens on.
// - docs/providers.md: a guide per AI that matches the in-app guides (js/provider-guides-core.js): every link,
//   command and variable they give is in it.
// - What an AI's key is exposed to (design 4.5 R7, R10): the engines keep a key out of the environment of the commands
//   the agent runs, but on a Linux server those commands run as the same user as Tarsee and its engines, so they can
//   still read it (/proc/<pid>/environ, Tarsee's data folder; test/key-exposure-linux.test.js shows it with the real
//   engines). Every place that tells the owner where keys go says so and calls a capped key the real guard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, PROVIDER_IDS } from "../src/ai/provider-registry.js";
import "../src/public/js/provider-guides-core.js";

const G = globalThis.ProviderGuides;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Every AI variable the owner may set, by name only. */
const AI_VARS = [
  "TARSEE_AI_PROVIDER", "TARSEE_AI_MODEL", "TARSEE_KEYS_ONLY",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY",
  "TARSEE_LOCAL_AI_URL", "TARSEE_LOCAL_AI_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ENCRYPTION_KEY",
];
const SECRET_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "TARSEE_LOCAL_AI_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ENCRYPTION_KEY", "SETUP_PASSWORD"];
const OLD_ADVICE = /do not set (this|anthropic_api_key)|no ANTHROPIC_API_KEY here|silently switch billing/i;
const KEY_SHAPED = /\b(sk-(ant|or|proj|svcacct)-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9]{32,}|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,})/;
const lines = (text) => text.split(/\r?\n/);
/** The text with what's inside fenced code blocks blanked (same length), so a "# comment" in one is no heading. */
const unfenced = (text) => text.replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\r\n]/g, " "));
const strip = (html) => html.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

describe(".env.example", () => {
  const text = read(".env.example");
  const ls = lines(text);
  it("names every AI variable, each with a one-line explanation above it", () => {
    for (const name of AI_VARS) {
      const i = ls.findIndex((l) => l.startsWith(`${name}=`));
      assert.ok(i > 0, `${name}= is listed`);
      assert.match(ls[i - 1], /^#\s*\S/, `${name} has an explanation on the line above`);
    }
  });
  it("holds names only: no variable has a value", () => {
    for (const l of ls) {
      if (/^\s*(#|$)/.test(l)) continue;
      assert.match(l, /^[A-Z][A-Z0-9_]*=$/, `"${l}" has no value`);
    }
    assert.doesNotMatch(text, KEY_SHAPED);
  });
  it("explains the providers instead of warning against ANTHROPIC_API_KEY", () => {
    assert.doesNotMatch(text, OLD_ADVICE);
    assert.match(text, /Settings\s*(>|→)\s*AI/);
    assert.match(text, /TARSEE_AI_PROVIDER=/);
    for (const id of PROVIDER_IDS) assert.match(text, new RegExp(`\\b${id}\\b`), `the provider id ${id} is listed for TARSEE_AI_PROVIDER`);
  });
});

describe("docker-compose.yml", () => {
  const text = read("docker-compose.yml");
  it("passes every AI variable through by name, with no value written in the file", () => {
    for (const name of AI_VARS) {
      assert.match(text, new RegExp(`^\\s*-\\s*${name}\\s*$`, "m"), `- ${name} (taken from your shell or .env, unset when they don't have it)`);
    }
    for (const name of SECRET_VARS) {
      assert.doesNotMatch(text, new RegExp(`^\\s*-?\\s*${name}\\s*[=:]\\s*[^$\\s]`, "m"), `${name} has no value in the file`);
    }
    assert.doesNotMatch(text, KEY_SHAPED);
  });
  it("drops the old advice and says where keys go", () => {
    assert.doesNotMatch(text, OLD_ADVICE);
    assert.match(text, /Settings\s*(>|→)\s*AI/);
  });
  it("still serves on 3000 inside the container", () => {
    assert.match(text, /"\$\{PORT:-3000\}:3000"/);
  });
});

describe("railway.toml", () => {
  const text = read("railway.toml");
  it("lists the AI variables by name in comments and never sets one", () => {
    for (const name of AI_VARS) {
      assert.match(text, new RegExp(`^#.*\\b${name}\\b`, "m"), `${name} is named in a comment`);
      assert.doesNotMatch(text, new RegExp(`^\\s*${name}\\s*=`, "m"), `${name} is not set here`);
    }
  });
  it("keeps the deploy as it was", () => {
    assert.match(text, /healthcheckPath = "\/healthz"/);
    assert.match(text, /requiredMountPath = "\/data"/);
    assert.match(text, /TARSEE_STATE_DIR = "\/data\/tarsee"/);
  });
});

describe("README", () => {
  const text = read("README.md");
  /** A section of the README: its heading line and everything up to the next heading of the same level or higher. */
  const plain = unfenced(text);
  const section = (title) => {
    const m = new RegExp(`^(##+) ${title}[ \\t]*$`, "m").exec(plain);
    assert.ok(m, `a "${title}" section`);
    const from = m.index + m[0].length;
    const end = plain.slice(from).search(new RegExp(`^#{1,${m[1].length}} `, "m"));
    return text.slice(m.index, end < 0 ? text.length : from + end);
  };
  it("a section ends at the next heading of its level, not at its own or a comment in a code block", () => {
    const s = section("Choose your AI");
    assert.ok(s.length > 200, "more than the heading");
    assert.doesNotMatch(unfenced(s).slice(s.indexOf("\n")), /^## /m, "no other level-2 heading inside it");
    const docker = section("Self-Hosting with Docker");
    assert.match(docker, /docker run/, "past the code block's # comment");
  });
  it("has a Choose your AI section with the seven options and what each costs", () => {
    const s = section("Choose your AI");
    for (const id of PROVIDER_IDS) assert.ok(s.includes(PROVIDERS[id].label), `${PROVIDERS[id].label}`);
    for (const id of PROVIDER_IDS) if (PROVIDERS[id].envKey) assert.ok(s.includes(PROVIDERS[id].envKey), PROVIDERS[id].envKey);
    assert.match(s, /claude auth login/);
    assert.match(s, /codex login --device-auth/);
    assert.match(s, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(s, /TARSEE_LOCAL_AI_URL/);
    assert.match(s, /per (message|use)|no per-message cost|free/i);
    assert.match(s, /docs\/providers\.md/);
  });
  it("says a plan is for your own use and other people mean an API key", () => {
    const s = section("Choose your AI");
    assert.match(s, /own (personal )?use/i);
    assert.match(s, /Only use API keys/);
    assert.match(s, /TARSEE_KEYS_ONLY/);
  });
  it("keeps keys in Settings or Railway variables, never in files", () => {
    assert.match(text, /Settings\s*(>|→)\s*AI/);
    assert.match(text, /Railway variable/i);
    assert.match(text, /never (in|into|written to) (a |any )?files?/i);
    assert.doesNotMatch(text, KEY_SHAPED);
  });
  it("no longer says Tarsee is only for Claude Max or needs no API key", () => {
    assert.doesNotMatch(text, /built for Claude Max|Max required|Claude Max subscription\)|No API keys needed|Tarsee is Claude-only|Not multi-provider|Uses your Claude Max subscription/i);
    assert.doesNotMatch(text, OLD_ADVICE);
    const llm = lines(text).find((l) => /^\|\s*\*\*LLM support\*\*/.test(l));
    if (llm) assert.doesNotMatch(llm.split("|")[2], /Claude only/i, "Tarsee's own cell in the comparison");
  });
  it("the docker run maps the port the server listens on (3000)", () => {
    const docker = section("Self-Hosting with Docker");
    assert.match(docker, /-p 3000:3000/);
    assert.doesNotMatch(docker, /8080/);
  });
  it("says what the Docker volume keeps, and where (entrypoint.sh hands the server /data/tarsee)", () => {
    const docker = unfenced(section("Self-Hosting with Docker"));
    assert.match(docker, /`?tarsee-data`? volume/, "names the volume");
    assert.match(docker, /\/data\/tarsee/);
    for (const what of [/database/i, /sign-ins?/i, /workspace/i]) assert.match(docker, what);
  });
  it("lists TARSEE_STATE_DIR, and says to keep it on the volume", () => {
    const row = lines(section("Environment Variables")).find((l) => /^\|\s*`TARSEE_STATE_DIR`\s*\|/.test(l));
    assert.ok(row, "a TARSEE_STATE_DIR row");
    assert.match(row, /\/data\/tarsee/, "its default with a volume");
    assert.match(row, /inside `\/data`/, "keep it on the volume");
    // entrypoint.sh carry_plan_home: only main's layout is moved, once, and only the Claude plan's sign-in and chats.
    assert.match(row, /changing it later moves nothing/i, "a change on this version leaves everything in the folder it was in");
    assert.match(row, /before multi-provider support/, "the move is only for an upgrade from a version before multi-provider");
    assert.match(row, /Claude plan sign-in and its chat history/, "what that upgrade moves");
    assert.match(row, /one way/, "and that it is not undone");
    assert.match(row, /nothing else/, "and nothing else moves");
    assert.match(row, /`\.credentials\.json\.superseded`/, "what happens to the old sign-in when the folder is already signed in");
  });
  it("lists every AI variable in the environment table", () => {
    const env = section("Environment Variables");
    for (const name of AI_VARS) assert.match(env, new RegExp(`\\|\\s*\`${name}\`\\s*\\|`), name);
  });
  it("names the Claude Code pin the Dockerfile has", () => {
    const pin = /^ARG\s+CLAUDE_CODE_VERSION=(\S+)/m.exec(read("Dockerfile"))[1];
    for (const m of text.matchAll(/CLAUDE_CODE_VERSION`?,? (\d+\.\d+\.\d+)/g)) assert.equal(m[1], pin);
  });
});

describe("docs/providers.md", () => {
  it("exists and the README links to it", () => {
    assert.ok(exists("docs/providers.md"));
    assert.match(read("README.md"), /\(docs\/providers\.md(#[a-z0-9-]+)?\)/);
  });
  const doc = exists("docs/providers.md") ? read("docs/providers.md") : "";
  const docPlain = unfenced(doc);
  /** The part of the guide under a provider's heading, up to the next heading of the same level or higher. */
  const part = (name) => {
    const m = new RegExp(`^(#{2,3}) ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m").exec(docPlain);
    assert.ok(m, `a "${name}" heading`);
    const from = m.index + m[0].length;
    const end = docPlain.slice(from).search(new RegExp(`^#{1,${m[1].length}} `, "m"));
    return doc.slice(from, end < 0 ? doc.length : from + end);
  };
  it("has a section per AI, in the order the app offers them", () => {
    let last = -1;
    for (const p of G.PROVIDERS) {
      const i = docPlain.search(new RegExp(`^#{2,3} ${p.name}[ \\t]*$`, "m"));
      assert.ok(i > last, `${p.name} after the one before it`);
      last = i;
    }
    assert.equal(G.PROVIDERS.length, PROVIDER_IDS.length);
  });
  it("each section has every link, command and variable its in-app guide gives", () => {
    for (const p of G.PROVIDERS) {
      const s = part(p.name);
      const html = [...p.steps, ...p.tips].join(" ");
      for (const m of html.matchAll(/href="([^"]+)"/g)) assert.ok(s.includes(m[1]), `${p.name}: ${m[1]}`);
      for (const m of html.matchAll(/<code>(.*?)<\/code>/g)) assert.ok(s.includes(strip(m[1])), `${p.name}: \`${strip(m[1])}\``);
      if (p.getKeyUrl) assert.ok(s.includes(p.getKeyUrl), `${p.name}: ${p.getKeyUrl}`);
      if (p.command) assert.ok(s.includes(p.command), `${p.name}: ${p.command}`);
      for (const preset of p.presets || []) assert.ok(s.includes(preset.url), `${p.name}: ${preset.url}`);
      const envKey = PROVIDERS[p.id].envKey;
      if (envKey) assert.ok(s.includes(envKey), `${p.name}: ${envKey}`);
      assert.match(s, /cost/i, `${p.name} says what it costs`);
    }
  });
  it("covers the matrix, the terms note, spend limits, keys only, Verify, the backup, the cap and Local AI on Railway", () => {
    for (const m of G.TERMS_NOTE.matchAll(/href="([^"]+)"/g)) assert.ok(doc.includes(m[1]), m[1]);
    assert.match(doc, /own (personal )?use/i);
    assert.match(doc, /Only use API keys/);
    assert.match(doc, /TARSEE_KEYS_ONLY/);
    assert.match(doc, /\bVerify\b/);
    assert.match(doc, /Backup/i);
    assert.match(doc, /Monthly spending cap/i);
    assert.match(doc, /railway\.internal/);
    assert.match(doc, /spend(ing)? limit|credit limit|hard limit/i);
    assert.match(doc, /TARSEE_AI_PROVIDER/);
    assert.match(doc, /TARSEE_AI_MODEL/);
    assert.match(doc, /ENCRYPTION_KEY/);
    const table = doc.split(/\r?\n/).filter((l) => l.startsWith("|"));
    for (const id of PROVIDER_IDS) assert.ok(table.some((l) => l.includes(PROVIDERS[id].label)), `the matrix has ${PROVIDERS[id].label}`);
  });
  it("Local AI: llama.cpp as a server like the other two (its build, its ports, the Docker image), the context from the server, the bridge", () => {
    const s = part("Local AI");
    assert.match(s, /Ollama, LM Studio or llama\.cpp/);
    assert.match(s, /b11768 \(v0\.8\.0\) or newer/, "the llama.cpp build Tarsee relies on");
    assert.match(s, /http:\/\/localhost:9931\/v1/);
    assert.match(s, /port 8080/, "older builds and the Docker image");
    assert.match(s, /ghcr\.io\/ggml-org\/llama\.cpp:server/, "the optional Docker line");
    assert.match(s, /CPU only/);
    assert.match(s, /-hf \S+:Q\d/, "a quant tag after the colon");
    assert.match(s, /read from your server/, "the card's context box");
    assert.match(s, /[Ee]mbedding models/, "why they aren't listed");
    assert.match(s, /bridge/, "how Tarsee's tools reach every Local AI model");
    for (const where of ["README.md", ".env.example", "docker-compose.yml", "railway.toml"]) {
      assert.match(read(where), /Ollama, LM Studio or llama\.cpp/, `${where} names all three servers`);
    }
  });

  it("never names a ChatGPT model: what an account can use comes from the account", () => {
    assert.doesNotMatch(doc, /\bgpt-\d/i);
    assert.doesNotMatch(read("README.md"), /\bgpt-\d/i);
  });
  it("holds no key and no value for a secret", () => {
    assert.doesNotMatch(doc, KEY_SHAPED);
    for (const name of SECRET_VARS) assert.doesNotMatch(doc, new RegExp(`${name}=[^\\s\`<]`), `${name} has no value`);
  });
});

describe("what an AI's key is exposed to: the docs say a command the agent runs can still read it (design 4.5 R10)", () => {
  /** The old promise, in any of the words it was made in: the key kept out of the shell's reach, unreadable. */
  const PROMISE = /kept out of the agent['’]s shell|\bkept out\b|commands the agent runs can['’]?t read|can(no|['’])t read (it|this key|the key|a key)|key is not visible to the (agent|AI)['’]s (own )?shell|never sees? the (gateway )?key/i;
  /** The exposure, stated. */
  const STATED = /can still read (this|the|a|its|these|every) keys?/i;
  it("docs/providers.md: where a command can read it from, and that a capped key is the real guard", () => {
    const doc = read("docs/providers.md");
    const at = doc.search(/^## Tools on every AI/m);
    assert.ok(at > 0, "a Tools on every AI section");
    const tools = doc.slice(at, at + doc.slice(at + 1).search(/^## /m) + 1);
    assert.match(tools, STATED);
    assert.match(tools, /same user as Tarsee/i, "why: the commands run as the same user");
    assert.match(tools, /\/proc\/<pid>\/environ/, "from the engine's or Tarsee's process");
    assert.match(tools, /data folder[^.]*encryption key/i, "and from the data folder, which holds the encryption key for keys saved in Settings");
    assert.match(tools, /credit limit or a small balance[^.]*real guard/i);
    assert.match(tools, /vault['’]s keys reach scripts by name, on purpose/i);
    assert.doesNotMatch(doc, PROMISE);
  });
  it("the README says it where it says where keys go", () => {
    const text = read("README.md");
    const where = /\*\*Where keys go\.\*\*[^\r\n]*/.exec(text)?.[0] || "";
    assert.ok(where, "a Where keys go paragraph");
    assert.match(where, STATED);
    assert.match(where, /spending limit/i);
    assert.doesNotMatch(text, PROMISE);
  });
  it("so do the deploy files, beside the key variables", () => {
    for (const file of [".env.example", "docker-compose.yml", "railway.toml"]) {
      const text = read(file);
      assert.match(text, STATED, file);
      assert.match(text, /spending limit/i, file);
      assert.doesNotMatch(text, PROMISE, file);
    }
  });
  // The design document (docs/superpowers/) is gitignored and never ships, so no test reads it: a clean clone and CI
  // don't have it. The files above are the ones an owner reads.
});
