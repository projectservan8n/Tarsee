// Starts the fake Python (fake-python.mjs) in place of a real one: hand `spawn` to the module under test
// (python-runtime.js __setForTests). A command the scenario doesn't know, and that isn't a file the fake wrote,
// gets a real "not found" (ENOENT), exactly as a missing python would.
import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fake-python.mjs", import.meta.url));

/**
 * dir: a folder for the scenario and log files. scenario: see fake-python.mjs.
 * Returns { spawn, set(patch), calls() } — set() merges into the scenario; calls() lists every run so far.
 */
export function fakePython(dir, scenario = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "fake-python-scenario.json");
  const log = path.join(dir, "fake-python-calls.jsonl");
  let current = { pythons: {}, ...scenario, log };
  const save = () => fs.writeFileSync(file, JSON.stringify(current));
  save();
  const spawn = (cmd, args = [], opts = {}) => {
    const isFile = fs.existsSync(cmd) && fs.statSync(cmd).isFile();
    const py = /^py(\.exe)?$/i.test(path.basename(cmd)) && Object.keys(current.pythons || {}).some((k) => k.startsWith("py "));
    if (!isFile && !py && !current.pythons?.[cmd]) {
      return realSpawn(path.join(dir, "no-such-dir", "no-such-program"), args, opts);
    }
    return realSpawn(process.execPath, [FAKE, cmd, ...args], { ...opts, env: { ...(opts.env || process.env), FAKE_PYTHON_SCENARIO: file } });
  };
  return {
    spawn,
    set(patch) { current = { ...current, ...patch, log }; save(); },
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    clearCalls() { fs.rmSync(log, { force: true }); },
  };
}

/** The bytes of a fake interpreter file (what a test archive puts where python.exe / bin/python3 would be). */
export function fakeInterpreter(version = "3.12.16", extra = {}) {
  return JSON.stringify({ fake: "python", version, venv: true, ...extra });
}
