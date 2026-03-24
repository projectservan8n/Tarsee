/**
 * Link understanding for Tarsee.
 * Auto-detects URLs in messages, fetches content, and provides summaries.
 */

const linkCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const PRIVATE_IP_REGEX = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|localhost|::1)/;

export function detectLinks(text) {
  if (!text || typeof text !== "string") return [];
  const urlRegex = /https?:\/\/[^\s<>)"'\]]+/gi;
  const matches = text.match(urlRegex) || [];
  const unique = [...new Set(matches)];

  return unique.filter((url) => {
    try {
      const parsed = new URL(url);
      if (PRIVATE_IP_REGEX.test(parsed.hostname)) return false;
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch { return false; }
  }).slice(0, 5);
}

export async function fetchAndSummarize(url) {
  const cached = linkCache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.summary;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Tarsee/1.0)" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
      return `[${contentType} file at ${url}]`;
    }

    let text = await res.text();
    // Strip HTML tags
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10000);

    if (text.length < 50) return null;

    // Extract title if present
    const titleMatch = text.match(/(?:^|\s)([A-Z][^\n.]{10,100})/);
    const summary = titleMatch ? titleMatch[1].trim() : text.slice(0, 200);

    const result = { url, title: summary, textLength: text.length, preview: text.slice(0, 500) };
    linkCache.set(url, { summary: result, ts: Date.now() });

    if (linkCache.size > 500) {
      const oldest = [...linkCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < 100; i++) linkCache.delete(oldest[i][0]);
    }

    return result;
  } catch (err) {
    return null;
  }
}

export async function processLinks(text) {
  const links = detectLinks(text);
  if (links.length === 0) return [];
  const results = await Promise.all(links.map((url) => fetchAndSummarize(url)));
  return results.filter(Boolean);
}
