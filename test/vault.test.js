import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// Set ENCRYPTION_KEY before importing vault
process.env.ENCRYPTION_KEY = "test-key-for-unit-tests-only-32chars!";

const { encrypt, decrypt, isEncrypted, isSecretKey, encryptIfSecret, decryptIfEncrypted, maskSecret } = await import("../src/lib/vault.js");

describe("vault encryption", () => {
  it("encrypts and decrypts a string", () => {
    const plaintext = "sk-ant-api03-abc123xyz";
    const encrypted = encrypt(plaintext);
    assert.ok(encrypted.startsWith("enc:v1:"), "Should have encrypted prefix");
    assert.notEqual(encrypted, plaintext, "Encrypted should differ from plaintext");

    const decrypted = decrypt(encrypted);
    assert.equal(decrypted, plaintext, "Decrypted should match original");
  });

  it("produces different ciphertexts for same input (random IV)", () => {
    const plaintext = "my-secret-key";
    const enc1 = encrypt(plaintext);
    const enc2 = encrypt(plaintext);
    assert.notEqual(enc1, enc2, "Each encryption should use a unique IV");

    // But both decrypt to the same value
    assert.equal(decrypt(enc1), plaintext);
    assert.equal(decrypt(enc2), plaintext);
  });

  it("returns plaintext unchanged if not encrypted", () => {
    assert.equal(decrypt("hello world"), "hello world");
    assert.equal(decrypt(""), "");
    assert.equal(decrypt(null), null);
  });

  it("detects encrypted values", () => {
    const encrypted = encrypt("test");
    assert.ok(isEncrypted(encrypted));
    assert.ok(!isEncrypted("not encrypted"));
    assert.ok(!isEncrypted(""));
    assert.ok(!isEncrypted(null));
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encrypt("secret-value");
    // Tamper with the ciphertext
    const tampered = encrypted.slice(0, -2) + "XX";
    assert.throws(() => decrypt(tampered), /Unsupported state|error|unable/i);
  });
});

describe("isSecretKey", () => {
  it("identifies API key patterns", () => {
    assert.ok(isSecretKey("ai.anthropic.apiKey"));
    assert.ok(isSecretKey("ai.openai.apiKey"));
    assert.ok(isSecretKey("channel.discord.token"));
    assert.ok(isSecretKey("channel.slack.appToken"));
    assert.ok(isSecretKey("some.secret"));
    assert.ok(isSecretKey("some.password"));
  });

  it("rejects non-secret keys", () => {
    assert.ok(!isSecretKey("ai.activeProvider"));
    assert.ok(!isSecretKey("ai.anthropic.model"));
    assert.ok(!isSecretKey("voice.engine"));
  });
});

describe("encryptIfSecret", () => {
  it("encrypts values for secret keys", () => {
    const result = encryptIfSecret("ai.openai.apiKey", "sk-abc123");
    assert.ok(isEncrypted(result));
    assert.equal(decrypt(result), "sk-abc123");
  });

  it("leaves non-secret values as plaintext", () => {
    const result = encryptIfSecret("ai.activeProvider", "anthropic");
    assert.equal(result, "anthropic");
    assert.ok(!isEncrypted(result));
  });

  it("does not double-encrypt", () => {
    const first = encryptIfSecret("ai.openai.apiKey", "sk-abc123");
    const second = encryptIfSecret("ai.openai.apiKey", first);
    assert.equal(first, second, "Should not encrypt already-encrypted value");
  });
});

describe("maskSecret", () => {
  it("masks long secrets", () => {
    assert.equal(maskSecret("sk-ant-api03-abcdefghij"), "sk-a...ghij");
  });

  it("masks short secrets", () => {
    assert.equal(maskSecret("short"), "****");
  });

  it("handles empty/null", () => {
    assert.equal(maskSecret(""), "****");
    assert.equal(maskSecret(null), "****");
  });
});
