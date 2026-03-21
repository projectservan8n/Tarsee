/**
 * Redacts known secret patterns from text.
 * Used to sanitize debug output, logs, and error messages.
 */
export function redactSecrets(text) {
  return String(text)
    // OpenAI keys (sk-...)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // Anthropic keys (sk-ant-...)
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // OpenRouter keys (sk-or-v1-...)
    .replace(/sk-or-v1-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // GitHub tokens (gho_, ghp_, ghs_, ghr_)
    .replace(/gh[opsr]_[A-Za-z0-9_]{10,}/g, "[REDACTED]")
    // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xapp-)
    .replace(/xox[bpars]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/xapp-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    // Telegram bot tokens (123456:ABC...)
    .replace(/\d{5,}:[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // Discord bot tokens (3-part dot-separated base64)
    .replace(/[A-Za-z0-9]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, "[REDACTED]")
    // Google API keys (AIza...)
    .replace(/AIza[A-Za-z0-9_-]{30,}/g, "[REDACTED]")
    // Generic long hex strings (likely API keys, 40+ chars)
    .replace(/\b[0-9a-f]{40,}\b/gi, "[REDACTED]")
    // Generic long base64 strings that look like tokens (64+ chars, no spaces)
    .replace(/(?<![A-Za-z0-9])[A-Za-z0-9+/=_-]{64,}(?![A-Za-z0-9])/g, "[REDACTED]");
}
