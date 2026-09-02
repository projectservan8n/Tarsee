/**
 * Advanced security manager for Tarsee.
 * Tool permissions, dangerous command detection, SSRF protection, rate limiting.
 */

const DANGEROUS_COMMANDS = /\b(rm\s+-rf|sudo|chmod\s+777|mkfs|dd\s+if|shutdown|reboot|kill\s+-9|iptables|passwd)\b/i;
// Hosts a tool must never be pointed at.
//
// 169.254.0.0/16 is the addition that matters most in a cloud deployment:
// 169.254.169.254 is the instance metadata endpoint on AWS, GCP and Azure, and
// on many setups it hands out credentials to anything that can make an HTTP
// request from the box. An agent that fetches URLs found in an email or a web
// page is exactly such a requester, so leaving it out made prompt injection a
// credential-theft path. The rest close the usual loopback and RFC1918 holes.
const PRIVATE_IP_REGEX = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|localhost$|localhost\.|::1|\[::1\]|\[?fd[0-9a-f]{2}:|\[?fe80:)/i;

const toolPermissions = new Map();
const toolRateLimits = new Map(); // toolName -> { calls: [], maxPerMinute }
const channelPermissions = new Map(); // channel -> Set of blocked tools

// Default permissions
const DEFAULT_PERMISSIONS = {
  exec: "warn", // warn on dangerous commands but allow
  write_file: "always_allow",
  browser: "always_allow",
  web_fetch: "check_ssrf",
};

export class SecurityManager {
  constructor(settingsStore) {
    this.settingsStore = settingsStore;
    // Load saved permissions
    try {
      const saved = settingsStore?.get?.("security.toolPermissions");
      if (saved) {
        for (const [k, v] of Object.entries(saved)) toolPermissions.set(k, v);
      }
    } catch { /* use defaults */ }
  }

  setToolPermission(toolName, mode) {
    toolPermissions.set(toolName, mode);
    try {
      const all = Object.fromEntries(toolPermissions);
      this.settingsStore?.set?.("security.toolPermissions", all);
    } catch { /* best effort */ }
  }

  getToolPermission(toolName) {
    return toolPermissions.get(toolName) || DEFAULT_PERMISSIONS[toolName] || "always_allow";
  }

  checkToolPermission(toolName, input = {}, channel = null) {
    // Check channel-level blocks
    if (channel && channelPermissions.get(channel)?.has(toolName)) {
      return { allowed: false, reason: `Tool '${toolName}' is blocked for ${channel} channel` };
    }

    const perm = this.getToolPermission(toolName);
    if (perm === "always_deny") return { allowed: false, reason: `Tool '${toolName}' is denied by policy` };

    // Rate limiting
    if (toolRateLimits.has(toolName)) {
      const rl = toolRateLimits.get(toolName);
      const now = Date.now();
      rl.calls = rl.calls.filter((t) => now - t < 60000);
      if (rl.calls.length >= rl.maxPerMinute) {
        return { allowed: false, reason: `Rate limit exceeded for '${toolName}' (${rl.maxPerMinute}/min)` };
      }
      rl.calls.push(now);
    }

    // Specific checks
    if (toolName === "exec" && input.command) {
      if (DANGEROUS_COMMANDS.test(input.command)) {
        return { allowed: true, warning: `Potentially dangerous command: ${input.command}` };
      }
    }

    if (toolName === "web_fetch" && input.url) {
      try {
        const parsed = new URL(input.url);
        if (PRIVATE_IP_REGEX.test(parsed.hostname)) {
          return { allowed: false, reason: `SSRF protection: blocked request to private IP ${parsed.hostname}` };
        }
      } catch { /* invalid URL, let it fail naturally */ }
    }

    if (toolName === "browser" && input.url) {
      try {
        const parsed = new URL(input.url);
        if (PRIVATE_IP_REGEX.test(parsed.hostname)) {
          return { allowed: false, reason: `Browser navigation to private IP blocked` };
        }
      } catch { /* ignore */ }
    }

    return { allowed: true };
  }

  setRateLimit(toolName, maxPerMinute) {
    toolRateLimits.set(toolName, { calls: [], maxPerMinute });
  }

  setChannelBlock(channel, toolName) {
    if (!channelPermissions.has(channel)) channelPermissions.set(channel, new Set());
    channelPermissions.get(channel).add(toolName);
  }

  validateToolInput(toolName, input) {
    // Basic input validation
    if (toolName === "write_file" && input.filename) {
      if (input.filename.includes("..")) return { valid: false, reason: "Path traversal detected" };
    }
    if (toolName === "exec" && input.command) {
      if (input.command.length > 10000) return { valid: false, reason: "Command too long" };
    }
    return { valid: true };
  }

  sanitizeEnv() {
    const blocked = ["AWS_SECRET", "ENCRYPTION_KEY", "DATABASE_URL", "SETUP_PASSWORD"];
    const clean = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (blocked.some((b) => k.toUpperCase().includes(b))) continue;
      clean[k] = v;
    }
    return clean;
  }

  listPermissions() {
    const result = {};
    for (const [k, v] of toolPermissions) result[k] = v;
    return result;
  }
}

let instance = null;
export function getSecurityManager(settingsStore) {
  if (!instance) instance = new SecurityManager(settingsStore);
  return instance;
}
