// Whether the Agent SDK's bundled Claude Code CLI is installed here. It comes in one of the SDK's optional platform
// packages, so `npm ci --omit=optional` or a system with no build leaves it out; a suite that runs the real CLI skips
// then instead of failing with engine errors. Node built-ins only, so importing this never loads Tarsee's config.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK_PKG = path.join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");

/** True when one of the SDK's platform packages holds the claude program. */
export function cliInstalled() {
  try {
    const pkg = JSON.parse(fs.readFileSync(SDK_PKG, "utf8"));
    return Object.keys(pkg.optionalDependencies || {}).some((dep) => ["claude", "claude.exe"].some((bin) => fs.existsSync(path.join(ROOT, "node_modules", dep, bin))));
  } catch { return false; }
}

/** The proxy variables a host may carry. A real CLI aimed at a loopback fake must not get them. */
export const PROXY_NAMES = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);

/** This machine's environment minus any proxy setting. */
export function envWithoutProxy(env = process.env) {
  const out = { ...env };
  for (const k of PROXY_NAMES) delete out[k];
  return out;
}
