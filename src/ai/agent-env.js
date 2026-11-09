/**
 * The vault's keys in the agent's environment, so its scripts read a key by name (os.environ["OPENAI_API_KEY"],
 * process.env.RESEND_API_KEY) and it never pastes one into a command. A key pasted into a command lands in the
 * session's transcript, and Claude Code's own checks rightly refuse commands that carry credentials. Ported from
 * TarseeMacOS ("the point of the vault is that the agent can use any key it was given").
 *
 * It gives the agent nothing new: tarsee_get_key already returns any key. So when the owner has set get_key to
 * "always deny" in Settings > Tool Permissions, no key goes in either.
 *
 * Every key whose name is an environment variable name in capitals goes in, except:
 *   - names already set in Tarsee's own environment (those win)
 *   - Claude's settings and login (CLAUDE_*) and Anthropic API keys (ANTHROPIC_*), which would move the agent off
 *     the Claude subscription onto pay-per-use billing; Codex's (CODEX_*) and OPENAI_BASE_URL, which would change
 *     the Codex engine's login, home or host (ai/engine-env.js strips them again before every turn)
 *   - Tarsee's own secrets (ENCRYPTION_KEY, SETUP_PASSWORD)
 *   - names that change how programs run rather than what they can reach: Tarsee's own settings (TARSEE_*), Node
 *     and the loader (NODE_*, LD_*, DYLD_*), npm's, Python's start-up and paths, the shell's, and the proxies
 * A value over 32 KB, or one with a NUL in it, stays out too (tarsee_get_key still has it).
 * TARSEE_AGENT_ENV_KEYS: a comma-separated list of names to use instead of every key, or "off" for none.
 * Read from the vault at most once a minute for the default call (Tarsee's own environment); a call that passes its own
 * `env` (engine-env's baseEnv(), say) compares against that one, so it is never answered from, or stored in, that cache.
 * Denying get_key applies at once either way.
 */
import { getKey, listKeys } from "../lib/key-vault.js";

export const AGENT_ENV_KEEP_OUT = /^(CLAUDE_|ANTHROPIC_|CODEX_|TARSEE_|NODE_|LD_|DYLD_|NPM_|PYTHON|GIT_|SSL_|BASH_)/;
const KEEP_OUT_NAMES = new Set(["PATH", "HOME", "USER", "SHELL", "ENV", "PWD", "TMPDIR", "LANG", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "MAX_MCP_OUTPUT_TOKENS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "OPENAI_BASE_URL", "ENCRYPTION_KEY", "SETUP_PASSWORD"]);

let cached = { at: 0, value: {} };
const VALUE_MAX_CHARS = 32 * 1024;

/**
 * { NAME: value } for the agent's environment. names/get/list/now: for tests. env: the environment the vault's names
 * are compared against (default process.env, the only one cached). denied(): true when the owner has denied get_key.
 */
export function agentVaultEnv({ names, get = getKey, list = () => listKeys().map((k) => k.name), env, now = Date.now(), denied = () => false } = {}) {
  // Only the default call shares the cache: names, the vault and the environment are all the live ones.
  const cachable = names === undefined && get === getKey && env === undefined;
  env ??= process.env;
  let blocked = false;
  try { blocked = !!denied(); } catch { blocked = false; }
  if (cachable && !blocked && now - cached.at < 60_000) return cached.value;
  const out = {};
  const skipped = [];
  const setting = String(env.TARSEE_AGENT_ENV_KEYS ?? "").trim();
  if (!blocked && setting.toLowerCase() !== "off") {
    let wanted = names;
    if (wanted === undefined && setting) wanted = setting.split(",");
    if (wanted === undefined) { try { wanted = list(); } catch { wanted = []; } }
    for (const raw of wanted) {
      const name = String(raw || "").trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || AGENT_ENV_KEEP_OUT.test(name) || KEEP_OUT_NAMES.has(name) || env[name]) continue;
      let value = null;
      try { value = String(get(name) || "").trim() || null; } catch { /* vault unavailable */ }
      // Linux refuses a single environment string past about 128 KB, and then the agent could not start at all; a
      // value that big (a certificate bundle, a credentials file) is for tarsee_get_key. A NUL can't be in one either.
      if (value && (value.length > VALUE_MAX_CHARS || value.includes("\0"))) { skipped.push(name); continue; }
      if (value) out[name] = value;
    }
  }
  if (cachable) {
    const had = Object.keys(cached.value).sort().join(",");
    const has = Object.keys(out).sort().join(",");
    if (had !== has) console.log(`[claude-code] ${Object.keys(out).length} vault key(s) in the agent's environment${blocked ? " (none: get_key is denied in Tool Permissions)" : ""}${skipped.length ? ` (too big or not text, left to tarsee_get_key: ${skipped.join(", ")})` : ""}`);
    // A denied answer isn't kept as fresh: allowing get_key again takes effect on the next turn.
    cached = { at: blocked ? 0 : now, value: out };
  }
  return out;
}

/** For tests: forget the cached keys. */
export function __resetAgentEnv() { cached = { at: 0, value: {} }; }
