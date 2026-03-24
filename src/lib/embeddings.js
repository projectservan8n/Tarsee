/**
 * Multi-provider embedding system for Tarsee vector memory.
 * Supports OpenAI, Gemini, Ollama (local/free), with auto-detection.
 */

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

export async function getEmbedding(text, opts = {}) {
  const cacheKey = text.slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.embedding;

  const provider = detectEmbeddingProvider(opts.settingsStore);
  let embedding;

  switch (provider.type) {
    case "openai":
      embedding = await openaiEmbed(text, provider.apiKey);
      break;
    case "gemini":
      embedding = await geminiEmbed(text, provider.apiKey);
      break;
    case "ollama":
      embedding = await ollamaEmbed(text, provider.baseUrl);
      break;
    default:
      return null;
  }

  if (embedding) {
    cache.set(cacheKey, { embedding, ts: Date.now() });
    if (cache.size > 5000) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < 1000; i++) cache.delete(oldest[i][0]);
    }
  }
  return embedding;
}

export async function batchEmbed(texts, opts = {}) {
  const results = [];
  for (let i = 0; i < texts.length; i += 20) {
    const chunk = texts.slice(i, i + 20);
    const embeddings = await Promise.all(chunk.map((t) => getEmbedding(t, opts)));
    results.push(...embeddings);
  }
  return results;
}

function detectEmbeddingProvider(settingsStore) {
  const openaiKey = process.env.OPENAI_API_KEY || settingsStore?.get?.("ai.openai.apiKey");
  if (openaiKey) return { type: "openai", apiKey: openaiKey };
  const geminiKey = process.env.GEMINI_API_KEY || settingsStore?.get?.("ai.gemini.apiKey");
  if (geminiKey) return { type: "gemini", apiKey: geminiKey };
  const ollamaUrl = process.env.OLLAMA_BASE_URL || settingsStore?.get?.("ai.custom.baseUrl") || "http://localhost:11434";
  return { type: "ollama", baseUrl: ollamaUrl };
}

export function getEmbeddingProviderInfo(settingsStore) {
  return detectEmbeddingProvider(settingsStore);
}

async function openaiEmbed(text, apiKey) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`OpenAI embedding error: ${data.error.message}`);
  return new Float32Array(data.data[0].embedding);
}

async function geminiEmbed(text, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Gemini embedding error: ${data.error.message}`);
  return new Float32Array(data.embedding.values);
}

async function ollamaEmbed(text, baseUrl) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/embeddings`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!data.embedding) return null;
    return new Float32Array(data.embedding);
  } catch { return null; }
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
