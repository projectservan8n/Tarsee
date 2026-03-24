/**
 * Approximate token counting for context budget management.
 * Uses chars/4 as a reasonable approximation when tiktoken is unavailable.
 */

let tokenizer = null;

async function loadTokenizer() {
  if (tokenizer !== null) return tokenizer;
  try {
    const { encoding_for_model } = await import("tiktoken");
    tokenizer = encoding_for_model("gpt-4");
    return tokenizer;
  } catch {
    tokenizer = false;
    return false;
  }
}

export function countTokens(text) {
  if (!text) return 0;
  // Fast approximation: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}

export async function countTokensAccurate(text) {
  if (!text) return 0;
  const enc = await loadTokenizer();
  if (enc) {
    try { return enc.encode(text).length; } catch { /* fall through */ }
  }
  return countTokens(text);
}

export function countMessageTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += 4; // message overhead
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    total += countTokens(content);
    if (m.role) total += countTokens(m.role);
  }
  return total;
}
