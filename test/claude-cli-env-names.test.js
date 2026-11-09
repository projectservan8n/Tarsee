// The Claude Code CLI the Agent SDK ships reads its sign-in, key and host from environment variables, and every one of
// them must be stripped from every non-plan engine's environment (engine-env.js AUTH_ENV_RE, design 4.5 R2). The CLI
// adds such variables from release to release, so this scans the installed binary for every CLAUDE_* name shaped like a
// credential, a host or a proxy and checks each one is either stripped or on the reviewed list below. An SDK bump
// that brings a new one fails here, naming it, until someone decides which side it belongs on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAuthEnvName } from "../src/ai/engine-env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = path.join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk");

/** Names shaped like a credential, a host or a proxy. Deliberately wide: a false hit only costs a line below. */
const SHAPE = /TOKEN|KEY|OAUTH|AUTH|BASE_URL|_BASE$|_URL$|SECRET|PASS|CREDENTIAL|DESCRIPTOR|CERT|PROXY/;

/**
 * Credential-shaped CLAUDE_* names in the pinned CLI that are deliberately NOT stripped, and why. Reviewed against
 * Agent SDK 0.3.142 (the CLI's own code was read for each one).
 */
const REVIEWED_NOT_STRIPPED = {
  // Not environment variables at all.
  CLAUDE_AI_AUTHORIZE_URL: "a field of the CLI's OAuth settings object",
  CLAUDE_AI_OAUTH_SCOPES: "an exported constant name",
  CLAUDE_API_KEY: "placeholder text in the CLI's secrets screen",
  CLAUDE_BASE: "an internal constant",
  // Token counts and thresholds, not tokens.
  CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT: "a feature switch",
  CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "a size limit",
  CLAUDE_CODE_IDLE_TOKEN_THRESHOLD: "a size limit",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "a size limit (engine-env sets it on gateway turns)",
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "a size limit",
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "a size limit",
  // Set by the SDK or the CLI itself for its own children.
  CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "set by the Agent SDK in the child it starts",
  CLAUDE_CODE_MCP_SERVER_URL: "set by the CLI for an MCP headers helper it runs",
  CLAUDE_CODE_PROXY_URL: "set by the CLI for its proxy auth helper",
  CLAUDE_CODE_PROXY_HOST: "set by the CLI for its proxy auth helper",
  CLAUDE_CODE_PROXY_AUTHENTICATE: "set by the CLI for its proxy auth helper",
  CLAUDE_CODE_HOST_HTTP_PROXY_PORT: "the CLI's sandbox proxy port",
  CLAUDE_CODE_HOST_SOCKS_PROXY_PORT: "the CLI's sandbox proxy port",
  // The operator's own network, the same for every provider (like HTTPS_PROXY): not a provider's login, billing or host.
  CLAUDE_CODE_HTTP_PROXY: "the operator's proxy",
  CLAUDE_CODE_HTTPS_PROXY: "the operator's proxy",
  CLAUDE_CODE_PROXY_RESOLVES_HOSTS: "the operator's proxy",
  CLAUDE_CODE_SIMULATE_PROXY_USAGE: "a proxy test switch",
  CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER: "the operator's proxy login",
  CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS: "the operator's proxy login",
  CLAUDE_CODE_CERT_STORE: "which CA certificates to trust",
  CLAUDE_CODE_CLIENT_CERT: "the operator's mTLS client identity",
  CLAUDE_CODE_CLIENT_KEY: "the operator's mTLS client identity",
  CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: "the operator's mTLS client identity",
  // Only matter with a CLAUDE_CODE_USE_* backend, which is stripped.
  CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: "needs CLAUDE_CODE_USE_ANTHROPIC_AWS",
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: "needs CLAUDE_CODE_USE_BEDROCK",
  CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "needs CLAUDE_CODE_USE_FOUNDRY",
  CLAUDE_CODE_SKIP_MANTLE_AUTH: "needs CLAUDE_CODE_USE_MANTLE",
  CLAUDE_CODE_SKIP_VERTEX_AUTH: "needs CLAUDE_CODE_USE_VERTEX",
};

/** The Claude sign-in and host variables the pinned CLI was found to read; each must stay stripped. */
const KNOWN_CREDENTIALS = [
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_LOCAL_OAUTH_API_BASE",
  "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE", "CLAUDE_TRUSTED_DEVICE_TOKEN",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE", "CLAUDE_BG_AUTH_SNAPSHOT_PATH", "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
];

/** The CLI binary of whichever of the SDK's platform packages is installed here, or null. */
function cliBinary() {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(SDK, "package.json"), "utf8")); } catch { return null; }
  for (const dep of Object.keys(pkg.optionalDependencies || {})) {
    for (const dir of [path.join(ROOT, "node_modules", dep), path.join(SDK, "node_modules", dep)]) {
      for (const name of ["claude", "claude.exe"]) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) return { file, version: pkg.version };
      }
    }
  }
  return null;
}

/** Every CLAUDE_* name in a (large) binary, read in chunks so the whole file is never one string. */
function claudeNames(file) {
  const CHUNK = 16 * 1024 * 1024;
  const OVERLAP = 512;
  const names = new Set();
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK + OVERLAP);
    for (let pos = 0; pos < size; pos += CHUNK) {
      const n = fs.readSync(fd, buf, 0, CHUNK + OVERLAP, pos);
      const text = buf.toString("latin1", 0, n);
      const last = pos + CHUNK >= size;
      for (const m of text.matchAll(/(?<![A-Z0-9_])CLAUDE_[A-Z0-9_]+/g)) {
        // A name starting in the overlap is read whole by the next chunk; one cut off at the end isn't a name.
        if (m.index >= CHUNK || (!last && m.index + m[0].length >= n)) continue;
        names.add(m[0]);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return names;
}

describe("the pinned Claude Code CLI's credential variables", () => {
  const cli = cliBinary();

  it("every credential-shaped CLAUDE_* name the CLI knows is stripped, or reviewed as not a provider credential", { skip: cli ? false : "the Agent SDK's CLI binary isn't installed here" }, () => {
    const names = [...claudeNames(cli.file)].filter((n) => SHAPE.test(n)).sort();
    assert.ok(names.length > 20, `found only ${names.length} names in ${cli.file}: is this the CLI?`);
    const unreviewed = names.filter((n) => !isAuthEnvName(n) && !Object.hasOwn(REVIEWED_NOT_STRIPPED, n));
    assert.deepEqual(unreviewed, [],
      `Agent SDK ${cli.version}'s CLI reads credential-shaped variables nobody has classified. For each, read what the CLI ` +
      "does with it: if it chooses a login, a key, billing or a host, add it to AUTH_ENV_RE in src/ai/engine-env.js (and " +
      "design 4.5 R2); otherwise add it to REVIEWED_NOT_STRIPPED here with the reason.");
    for (const n of KNOWN_CREDENTIALS) assert.ok(names.includes(n), `${n} is gone from the CLI: check what replaced it`);
  });

  it("the reviewed list never shadows a name that is stripped", () => {
    for (const n of Object.keys(REVIEWED_NOT_STRIPPED)) assert.ok(!isAuthEnvName(n), `${n} is stripped; drop it from the reviewed list`);
    for (const n of KNOWN_CREDENTIALS) assert.ok(isAuthEnvName(n), `${n} must be stripped`);
  });
});
