import crypto from "node:crypto";
import config from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const ENCRYPTED_PREFIX = "enc:v1:";

/**
 * Derives a 256-bit key from the ENCRYPTION_KEY env var.
 * Uses PBKDF2 with a fixed salt (the salt is not secret — the key is).
 * The fixed salt ensures deterministic key derivation across restarts.
 */
let derivedKey = null;

function getKey() {
  if (derivedKey) return derivedKey;

  if (!config.ENCRYPTION_KEY) {
    return null; // No encryption configured
  }

  // PBKDF2 with high iteration count for key stretching
  derivedKey = crypto.pbkdf2Sync(
    config.ENCRYPTION_KEY,
    "opusclaw-vault-v1", // fixed application salt
    100_000,             // iterations
    KEY_LENGTH,
    "sha512"
  );

  return derivedKey;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a prefixed string: "enc:v1:<iv>:<authTag>:<ciphertext>" (all base64).
 *
 * @param {string} plaintext
 * @returns {string} Encrypted string with prefix
 */
export function encrypt(plaintext) {
  const key = getKey();
  if (!key) return plaintext; // No encryption key — store plaintext

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
}

/**
 * Decrypt a vault-encrypted string.
 * If the string doesn't have the encrypted prefix, returns it as-is (plaintext fallback).
 *
 * @param {string} value
 * @returns {string} Decrypted plaintext
 */
export function decrypt(value) {
  if (!value || !value.startsWith(ENCRYPTED_PREFIX)) {
    return value; // Not encrypted — return as-is
  }

  const key = getKey();
  if (!key) {
    throw new Error("ENCRYPTION_KEY required to decrypt secrets. Set it in your environment.");
  }

  const payload = value.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted value");
  }

  const iv = Buffer.from(parts[0], "base64");
  const authTag = Buffer.from(parts[1], "base64");
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Check if a value is already encrypted.
 */
export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Check if encryption is available (ENCRYPTION_KEY is set).
 */
export function isEncryptionEnabled() {
  return !!config.ENCRYPTION_KEY;
}

/**
 * Patterns that identify a settings key as containing a secret.
 * Any setting key matching these patterns will be auto-encrypted.
 */
const SECRET_KEY_PATTERNS = [
  /\.apiKey$/,           // ai.anthropic.apiKey, ai.openai.apiKey, etc.
  /\.token$/,            // channel.discord.token, etc.
  /\.appToken$/,         // channel.slack.appToken
  /\.secret$/,           // any .secret suffix
  /\.password$/,         // any .password suffix
  /\.key$/,              // generic .key suffix
  /^encryption\./,       // encryption config keys
  /api[_-]?key/i,        // anything with "apikey" or "api_key"
  /secret/i,             // anything with "secret"
];

/**
 * Check if a settings key should be treated as a secret.
 * @param {string} key - The settings key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Encrypt a value if the key indicates it's a secret.
 * @param {string} key - The settings key
 * @param {string} value - The value to potentially encrypt
 * @returns {string}
 */
export function encryptIfSecret(key, value) {
  if (typeof value !== "string") return value;
  if (isEncrypted(value)) return value; // Already encrypted
  if (!isSecretKey(key)) return value;  // Not a secret key
  return encrypt(value);
}

/**
 * Decrypt a value if it's encrypted.
 * @param {string} value
 * @returns {string}
 */
export function decryptIfEncrypted(value) {
  if (typeof value !== "string") return value;
  if (!isEncrypted(value)) return value;
  return decrypt(value);
}

/**
 * Mask a secret for display (show first 4 and last 4 chars).
 * @param {string} value
 * @returns {string}
 */
export function maskSecret(value) {
  if (!value || value.length < 12) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
