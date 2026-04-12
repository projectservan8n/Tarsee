/**
 * URL Safety — checks URLs before browser navigation.
 * Blocks known phishing, malware, and suspicious domains.
 *
 * Layers:
 *   1. Local blocklist (instant, no API)
 *   2. Suspicious pattern detection (typosquatting, data URIs, IP addresses)
 *   3. Google Safe Browsing API (if key configured, 10K free lookups/day)
 */

// Known malicious TLDs and patterns
const BLOCKED_TLDS = new Set([
  ".zip", ".mov", ".top", ".xyz", ".tk", ".ml", ".ga", ".cf", ".gq",
  ".buzz", ".click", ".link", ".surf", ".icu", ".monster",
]);

// Known legitimate domains (never block these)
const TRUSTED_DOMAINS = new Set([
  "google.com", "github.com", "gitlab.com", "stackoverflow.com",
  "claude.ai", "anthropic.com", "openai.com",
  "railway.app", "vercel.app", "netlify.app", "render.com",
  "npmjs.com", "pypi.org", "hub.docker.com",
  "youtube.com", "twitter.com", "x.com", "reddit.com",
  "linkedin.com", "facebook.com", "instagram.com",
  "discord.com", "discord.gg", "telegram.org", "t.me",
  "notion.so", "figma.com", "canva.com",
  "aws.amazon.com", "azure.microsoft.com", "cloud.google.com",
  "huggingface.co", "kaggle.com",
  "wikipedia.org", "medium.com", "dev.to",
  "stripe.com", "paypal.com",
  "zoom.us", "meet.google.com",
  "docs.google.com", "drive.google.com", "sheets.google.com",
  "outlook.com", "mail.google.com",
]);

// Suspicious domain patterns (typosquatting, lookalikes)
const SUSPICIOUS_PATTERNS = [
  /g[o0]{2}gle/i,        // g00gle, gooogle
  /faceb[o0]{2}k/i,      // faceb00k
  /amaz[o0]n/i,          // amaz0n
  /paypa[l1]/i,           // paypa1
  /m[i1]cr[o0]s[o0]ft/i, // micr0soft
  /app[l1]e\./i,         // app1e
  /l[o0]gin|s[i1]gn[i1]n/i, // login pages with letter swaps
  /secure.*update.*account/i, // phishing pattern
  /verify.*identity.*confirm/i, // phishing pattern
];

// Blocked URL schemes
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "blob:", "vbscript:"]);

/**
 * Check if a URL is safe to visit.
 * @param {string} urlStr - URL to check
 * @param {object} [settingsStore] - Settings store for API keys
 * @returns {Promise<{safe: boolean, reason?: string, level?: string}>}
 */
export async function checkUrlSafety(urlStr, settingsStore) {
  try {
    // Parse URL
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return { safe: false, reason: "Invalid URL", level: "blocked" };
    }

    // Block dangerous schemes
    if (BLOCKED_SCHEMES.has(parsed.protocol)) {
      return { safe: false, reason: `Blocked scheme: ${parsed.protocol}`, level: "blocked" };
    }

    // Only allow http/https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { safe: false, reason: `Non-HTTP scheme: ${parsed.protocol}`, level: "blocked" };
    }

    const hostname = parsed.hostname.toLowerCase();
    const domain = hostname.split(".").slice(-2).join(".");

    // Trusted domains — always safe
    if (TRUSTED_DOMAINS.has(domain) || TRUSTED_DOMAINS.has(hostname)) {
      return { safe: true };
    }

    // Block raw IP addresses (except localhost)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) && hostname !== "127.0.0.1") {
      return { safe: false, reason: `Raw IP address: ${hostname} — likely phishing or C2`, level: "warning" };
    }

    // Block suspicious TLDs
    const tld = "." + hostname.split(".").pop();
    if (BLOCKED_TLDS.has(tld)) {
      return { safe: false, reason: `Suspicious TLD: ${tld}`, level: "warning" };
    }

    // Check for typosquatting patterns
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(hostname)) {
        return { safe: false, reason: `Suspicious domain (possible typosquatting): ${hostname}`, level: "warning" };
      }
    }

    // Very long subdomains are suspicious (phishing)
    if (hostname.split(".").some(part => part.length > 30)) {
      return { safe: false, reason: `Unusually long subdomain in ${hostname}`, level: "warning" };
    }

    // Google Safe Browsing API check (if key configured)
    const safeBrowsingKey = settingsStore?.get?.("google.safe_browsing_key");
    if (safeBrowsingKey) {
      try {
        const result = await checkGoogleSafeBrowsing(urlStr, safeBrowsingKey);
        if (!result.safe) return result;
      } catch (err) {
        console.warn("[url-safety] Safe Browsing API error:", err.message);
        // Don't block on API failure — just warn
      }
    }

    return { safe: true };
  } catch {
    // On any error, allow but log
    return { safe: true };
  }
}

/**
 * Check URL against Google Safe Browsing API.
 */
async function checkGoogleSafeBrowsing(url, apiKey) {
  const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client: { clientId: "tarsee", clientVersion: "1.0" },
      threatInfo: {
        threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: [{ url }],
      },
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();

  if (data.matches?.length > 0) {
    const threat = data.matches[0].threatType;
    return { safe: false, reason: `Google Safe Browsing: ${threat}`, level: "blocked" };
  }

  return { safe: true };
}
