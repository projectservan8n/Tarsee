/**
 * Redacts known secret patterns from text.
 * Used to sanitize debug output, logs, error messages, and the tool-call
 * timeline that streams to the UI / persists to the DB.
 */
export function redactSecrets(text) {
  return String(text)
    // OpenAI keys (sk-...)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // Anthropic keys (sk-ant-...)
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // OpenRouter keys (sk-or-v1-...)
    .replace(/sk-or-v1-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // Stripe keys (sk_live_, sk_test_, pk_live_, pk_test_, whsec_)
    .replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{16,}/g, "[REDACTED]")
    .replace(/\bwhsec_[A-Za-z0-9]{16,}/g, "[REDACTED]")
    // GitHub tokens (gho_, ghp_, ghs_, ghr_, ghu_, github_pat_)
    .replace(/gh[opsruh]_[A-Za-z0-9_]{10,}/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xapp-)
    .replace(/xox[bpars]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/xapp-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    // Telegram bot tokens (123456:ABC...)
    .replace(/\d{5,}:[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // Discord bot tokens (3-part dot-separated base64)
    .replace(/[A-Za-z0-9]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, "[REDACTED]")
    // Google API keys (AIza...)
    .replace(/AIza[A-Za-z0-9_-]{30,}/g, "[REDACTED]")
    // AWS access key IDs (20-char AKIA prefix)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    // Bearer tokens in Authorization headers
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "$1[REDACTED]")
    // Postgres / MongoDB connection strings with embedded password
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+):([^@\s]+)@/gi, "$1:[REDACTED]@")
    .replace(/(mongodb(?:\+srv)?:\/\/[^:\s]+):([^@\s]+)@/gi, "$1:[REDACTED]@")
    // JWTs (three base64url segments, ≥8 chars each, with the standard
    // "eyJ" header marking the JWT alg/header.)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    // Inline KEY=value where KEY ends in TOKEN/SECRET/KEY/PASSWORD and the
    // value is ≥8 chars and not a URL (so MY_PUBLIC_KEY=https://… stays).
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD))=(?!https?:\/\/)([^\s"']{8,})/g, "$1=[REDACTED]")
    // Generic long hex strings (likely API keys, 40+ chars)
    .replace(/\b[0-9a-f]{40,}\b/gi, "[REDACTED]")
    // Generic long base64 strings that look like tokens (64+ chars, no spaces)
    .replace(/(?<![A-Za-z0-9])[A-Za-z0-9+/=_-]{64,}(?![A-Za-z0-9])/g, "[REDACTED]");
}

/**
 * Recursively redact secrets across strings inside an object/array. Used for
 * tool-call inputs (Anthropic tool blocks are nested JSON: Bash → {command},
 * WebFetch → {url}, etc.). Non-string values pass through unchanged.
 */
export function redactDeep(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const o = {};
    for (const k of Object.keys(value)) o[k] = redactDeep(value[k]);
    return o;
  }
  return value;
}
