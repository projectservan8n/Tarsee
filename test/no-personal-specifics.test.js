// Tarsee is open source: what ships (the code, the web UI, the workspace files a new install starts with, the image
// and its boot script, the README and docs/providers.md) stays generic. No one owner's name, company, email address or
// key, and no real-looking credential (fixtures use obvious fakes such as "sk-test-canary-..."). The repository's own
// home (its GitHub address) is fine: that is where the project lives.
// Design: docs/superpowers/specs/2026-11-09-multi-provider-design.md G10, Phase 5 "Docs".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TEXT = /\.(js|mjs|cjs|json|html|css|md|txt|sh|toml|yml|yaml|svg|webmanifest)$/i;

/** Every text file under a folder, skipping vendored code. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
}

const SHIPPED = [
  ...walk(path.join(ROOT, "src")),
  ...["README.md", "docs/providers.md", ".env.example", "docker-compose.yml", "railway.toml", "Dockerfile", "entrypoint.sh"]
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f)),
];

// One owner's details, as they would appear. Matched as whole words, any case.
const PERSONAL = [/\btony\b/i, /\bherrera\b/i, /opus\s*automations/i, /opusautomations/i];
// Real-looking credentials: long random tails on the providers' key prefixes, bot tokens, private keys.
const CREDENTIAL = [
  /\bsk-ant-(api|oat)\d*-[A-Za-z0-9_-]{20,}/,
  /\bsk-or-v1-[a-f0-9]{32,}/,
  /\bsk-(proj|svcacct)-[A-Za-z0-9_-]{20,}/,
  /\bxox[abp]-\d{6,}-[A-Za-z0-9-]{10,}/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
// Email addresses other than example ones and the project's placeholders.
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const EMAIL_OK = /@(example\.(com|org|net)|(your)?domain\.com|company\.com|b\.com|users\.noreply\.github\.com)$|^(you|admin|user|name|someone|tarsee|bot|noreply|no-reply)@/i;

describe("what ships is generic", () => {
  it("there is something to check", () => {
    assert.ok(SHIPPED.length > 50, `${SHIPPED.length} files`);
    assert.ok(SHIPPED.some((f) => f.endsWith(path.join("workspace-defaults", "SOUL.md"))));
  });
  it("names no one owner or their company", () => {
    const hits = [];
    for (const f of SHIPPED) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of PERSONAL) if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: ${re}`);
    }
    assert.deepEqual(hits, []);
  });
  it("holds no real-looking credential", () => {
    const hits = [];
    for (const f of SHIPPED) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of CREDENTIAL) if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: ${re}`);
    }
    assert.deepEqual(hits, []);
  });
  it("gives only example email addresses", () => {
    const hits = [];
    for (const f of SHIPPED.filter((x) => /\.(md|html|toml|yml|example|sh)$|Dockerfile$/.test(x) || x.includes(`${path.sep}workspace-defaults${path.sep}`))) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) hits.push(`${path.relative(ROOT, f)}: ${m[0]}`);
    }
    assert.deepEqual(hits, []);
  });
});
