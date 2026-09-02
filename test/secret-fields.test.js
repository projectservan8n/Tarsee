import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// A real key, so encryption actually happens rather than silently no-opping.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a".repeat(64);

const { encryptSecretFields, decryptSecretFields, redactSecretFields, isEncrypted } =
  await import("../src/lib/vault.js");
const { initDb } = await import("../src/db/sqlite.js");
const { SettingsStore } = await import("../src/db/settings.js");
const { safePath, isSensitivePath } = await import("../src/lib/safe-path.js");

// Every channel stores its whole config as ONE JSON object under a key like
// `channel.telegram`. The at-rest encryption only ever tested the top-level
// KEY name against patterns like /\.token$/, and `channel.telegram` matches
// none of them — so bot tokens, IMAP and SMTP passwords and webhook secrets
// were written to SQLite in plaintext, on a product that logs "credential
// encryption: ENABLED" at boot and audits each write as "(encrypted)".

describe("secret fields inside structured settings", () => {
  it("encrypts credential-named fields and leaves the rest readable", () => {
    const out = encryptSecretFields({
      enabled: true,
      token: "bot-secret-123",
      mentionKeyword: "tarsee",
    });
    assert.ok(isEncrypted(out.token), "token was not encrypted");
    assert.equal(out.enabled, true);
    assert.equal(out.mentionKeyword, "tarsee", "non-secret field should stay readable");
  });

  it("reaches credentials nested inside sub-objects", () => {
    const out = encryptSecretFields({
      imap: { host: "imap.example.com", user: "a@b.c", password: "hunter2" },
      smtp: { host: "smtp.example.com", password: "hunter3" },
    });
    assert.ok(isEncrypted(out.imap.password));
    assert.ok(isEncrypted(out.smtp.password));
    assert.equal(out.imap.host, "imap.example.com");
  });

  it("round-trips back to the original values", () => {
    const original = { token: "abc", imap: { password: "p@ss" }, webhook_secret: "wh" };
    assert.deepEqual(decryptSecretFields(encryptSecretFields(original)), original);
  });

  it("is idempotent, so a read-modify-write cycle cannot double-encrypt", () => {
    const once = encryptSecretFields({ token: "abc" });
    const twice = encryptSecretFields(once);
    assert.equal(once.token, twice.token);
    assert.equal(decryptSecretFields(twice).token, "abc");
  });

  it("leaves values written before field encryption existed alone", () => {
    // Plaintext in the database must keep working: this upgrades in place.
    assert.deepEqual(decryptSecretFields({ token: "legacy-plaintext" }), { token: "legacy-plaintext" });
  });

  it("redacts credentials to has* booleans for display", () => {
    const shown = redactSecretFields({ enabled: true, token: "abc", imap: { user: "u", password: "p" } });
    assert.equal(shown.token, undefined, "raw token must not survive redaction");
    assert.equal(shown.hasToken, true);
    assert.equal(shown.imap.password, undefined);
    assert.equal(shown.imap.hasPassword, true);
    assert.equal(shown.imap.user, "u");
    assert.equal(shown.enabled, true);
  });

  it("reports an absent credential as false rather than hiding the field", () => {
    assert.equal(redactSecretFields({ token: "" }).hasToken, false);
  });
});

describe("SettingsStore end to end", () => {
  const TEST_DB = path.join("/tmp", `tarsee-secret-${Date.now()}.db`);
  let db, store;

  before(() => {
    db = initDb(TEST_DB);
    store = new SettingsStore(db);
  });

  after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
  });

  it("stores a channel token encrypted but returns it usable", () => {
    store.set("channel.telegram", { enabled: true, token: "12345:SECRET", allowlist: [] });

    // What the application sees: the real token, so the bot can log in.
    assert.equal(store.get("channel.telegram").token, "12345:SECRET");

    // What is actually on disk: not the token.
    const raw = db.prepare("SELECT value FROM settings WHERE key = ?").get("channel.telegram").value;
    assert.ok(!raw.includes("12345:SECRET"), "plaintext token found in the database");
    assert.ok(raw.includes("enc:v1:"), "token was not encrypted at rest");
  });

  it("protects nested mailbox passwords the same way", () => {
    store.set("channel.email", { enabled: true, imap: { host: "h", password: "mailpass" } });
    assert.equal(store.get("channel.email").imap.password, "mailpass");
    const raw = db.prepare("SELECT value FROM settings WHERE key = ?").get("channel.email").value;
    assert.ok(!raw.includes("mailpass"), "plaintext mailbox password found in the database");
  });
});

describe("file API boundaries", () => {
  it("refuses credential and database files inside an allowed root", () => {
    const root = "/tmp/tarsee-fileroot";
    for (const bad of [".credentials.json", "api.token", ".encryption-key", "tarsee.db", "vault.json"]) {
      assert.throws(() => safePath(bad, [root]), /not accessible/, `${bad} was reachable`);
    }
  });

  it("still allows ordinary workspace files", () => {
    const root = "/tmp/tarsee-fileroot";
    assert.ok(safePath("notes.md", [root]).endsWith("notes.md"));
    assert.ok(safePath("memory/2026-01-01.md", [root]).includes("memory"));
  });

  it("still refuses traversal out of the root", () => {
    assert.throws(() => safePath("../../etc/passwd", ["/tmp/tarsee-fileroot"]), /outside allowed/);
  });

  it("flags the Claude credential directory at any depth", () => {
    assert.equal(isSensitivePath("/data/tarsee/.claude-code-home/.credentials.json"), true);
    assert.equal(isSensitivePath("/data/tarsee/workspace/notes.md"), false);
  });
});
