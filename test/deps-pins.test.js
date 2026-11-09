// The dependency pins the multi-provider design rests on (docs/superpowers/specs/2026-11-09-multi-provider-design.md,
// sections 4.1 and 4.16, Phase 0):
// - the Codex SDK at one exact version, the Codex CLI it drives at that same version, and the CLI's build for every
//   platform in the lockfile. The image runs `npm ci` on linux-x64 and the lockfile may be made on any machine, so a
//   lockfile that only knows the build for the machine it was made on breaks the deploy.
// - the MCP SDK as a runtime dependency (the image installs with --omit=dev) at the Agent SDK's own range, in one copy
//   that the Agent SDK resolves too.
// - the Claude Agent SDK where it stood before Phase 0. It moves on purpose in a later phase (an exact pin), and this
//   test moves with it.
// Reads package.json, package-lock.json and node_modules only. Run after `npm install` or `npm ci`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NODE_MODULES = path.join(ROOT, "node_modules");
const json = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
const pkg = json("package.json");
const lock = json("package-lock.json");
const installed = (name) => json(path.join("node_modules", name, "package.json"));

const CODEX_SDK = "@openai/codex-sdk";
const CODEX_CLI = "@openai/codex";
const CODEX_VERSION = "0.167.0";
const MCP = "@modelcontextprotocol/sdk";
const MCP_RANGE = "^1.29.0";
const AGENT_SDK = "@anthropic-ai/claude-agent-sdk";
// As package.json and the lockfile had it before the Codex SDK came in.
const AGENT_SDK_BEFORE = { range: "^0.3.142", version: "0.3.142" };

/** Every lockfile entry installed under this package name, at any depth. */
function lockCopies(name) {
  return Object.keys(lock.packages).filter((key) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`));
}

/** Every folder in a node_modules tree, at any depth, that holds this package. */
function installedCopies(name, dir = NODE_MODULES, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const packages = entry.name.startsWith("@")
      ? readdirSync(path.join(dir, entry.name), { withFileTypes: true })
        .filter((scoped) => scoped.isDirectory())
        .map((scoped) => `${entry.name}/${scoped.name}`)
      : [entry.name];
    for (const pkgName of packages) {
      const pkgDir = path.join(dir, ...pkgName.split("/"));
      if (pkgName === name) found.push(pkgDir);
      installedCopies(name, path.join(pkgDir, "node_modules"), found);
    }
  }
  return found;
}

describe("@openai/codex-sdk", () => {
  it("is a runtime dependency pinned to exactly 0.167.0", () => {
    assert.equal(pkg.dependencies[CODEX_SDK], CODEX_VERSION);
    assert.equal(pkg.devDependencies?.[CODEX_SDK], undefined);
    assert.equal(lock.packages[""].dependencies[CODEX_SDK], CODEX_VERSION);
  });

  it("the lockfile and node_modules hold that version, and the Codex CLI at the same one", () => {
    assert.equal(lock.packages[`node_modules/${CODEX_SDK}`]?.version, CODEX_VERSION);
    assert.equal(installed(CODEX_SDK).version, CODEX_VERSION);
    assert.equal(installed(CODEX_SDK).dependencies[CODEX_CLI], CODEX_VERSION, "the SDK pins its CLI exactly");
    assert.deepEqual(lockCopies(CODEX_CLI), [`node_modules/${CODEX_CLI}`]);
    assert.equal(lock.packages[`node_modules/${CODEX_CLI}`].version, CODEX_VERSION);
    assert.equal(installed(CODEX_CLI).version, pkg.dependencies[CODEX_SDK]);
    for (const name of [CODEX_SDK, CODEX_CLI]) {
      assert.notEqual(lock.packages[`node_modules/${name}`].dev, true, `${name} is not dev-only in the lockfile`);
    }
  });

  it("the lockfile has the CLI's build for every platform, linux-x64 (the image) among them", () => {
    const builds = Object.entries(installed(CODEX_CLI).optionalDependencies ?? {});
    assert.ok(builds.length >= 6, "the CLI names a build per platform");
    for (const [alias, spec] of builds) {
      const entry = lock.packages[`node_modules/${alias}`];
      assert.ok(entry, `${alias} is in the lockfile`);
      assert.equal(entry.optional, true, `${alias} is optional`);
      assert.equal(`npm:${entry.name}@${entry.version}`, spec, `${alias} is the build the CLI names`);
      assert.ok(entry.resolved && entry.integrity, `${alias} has a tarball and its integrity`);
    }
    const linux = lock.packages[`node_modules/${CODEX_CLI}-linux-x64`];
    assert.ok(linux, "the linux-x64 build is in the lockfile");
    assert.equal(linux.version, `${CODEX_VERSION}-linux-x64`);
    assert.deepEqual(linux.os, ["linux"]);
    assert.deepEqual(linux.cpu, ["x64"]);
  });
});

describe("@modelcontextprotocol/sdk", () => {
  it("is a runtime dependency at ^1.29.0, the Agent SDK's own range", () => {
    assert.equal(pkg.dependencies[MCP], MCP_RANGE);
    assert.equal(pkg.devDependencies?.[MCP], undefined);
    assert.equal(lock.packages[""].dependencies[MCP], MCP_RANGE);
    assert.equal(lock.packages[""].devDependencies?.[MCP], undefined);
    assert.equal(installed(AGENT_SDK).dependencies[MCP], pkg.dependencies[MCP]);
  });

  it("only one copy is installed, and the Agent SDK resolves that one", () => {
    assert.deepEqual(lockCopies(MCP), [`node_modules/${MCP}`]);
    assert.notEqual(lock.packages[`node_modules/${MCP}`].dev, true);
    const root = path.join(NODE_MODULES, ...MCP.split("/"));
    assert.deepEqual(installedCopies(MCP), [root]);
    const fromAgentSdk = createRequire(path.join(NODE_MODULES, AGENT_SDK, "package.json")).resolve(`${MCP}/server/mcp.js`);
    assert.ok(fromAgentSdk.startsWith(root + path.sep), `the Agent SDK resolves ${fromAgentSdk}`);
  });
});

describe("@anthropic-ai/claude-agent-sdk", () => {
  it("is unchanged by Phase 0", () => {
    assert.equal(pkg.dependencies[AGENT_SDK], AGENT_SDK_BEFORE.range);
    assert.equal(lock.packages[`node_modules/${AGENT_SDK}`].version, AGENT_SDK_BEFORE.version);
    assert.equal(installed(AGENT_SDK).version, AGENT_SDK_BEFORE.version);
  });

  it("the lockfile still has its build for every platform", () => {
    const builds = Object.keys(installed(AGENT_SDK).optionalDependencies ?? {});
    assert.ok(builds.includes(`${AGENT_SDK}-linux-x64`));
    for (const name of builds) {
      assert.equal(lock.packages[`node_modules/${name}`]?.version, AGENT_SDK_BEFORE.version, `${name} is in the lockfile`);
    }
  });
});
