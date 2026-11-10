// A fake Python interpreter for the installer and speech-to-text tests. Never run directly: test/fakes/fake-python.js
// starts it as `node fake-python.mjs <the command the code ran> <its arguments...>`, so the code under test really
// spawns a process, reads its output line by line and sees its exit code.
//
// Who it is comes from the command: a path to a file it wrote earlier (a venv's python, the standalone Python from a
// test archive: a JSON file describing itself), or a name in the scenario (FAKE_PYTHON_SCENARIO, a JSON file):
//   { "pythons": { "python3": { "version": "3.11.4" }, "py -3.12": {...}, "python": { "store": true } },
//     "pip": { "mode": "ok" | "fail-halfway" | "no-wheel" | "offline", "delayMs": 5 },
//     "worker": { "mode": "ok" | "error" | "crash" | "hang", "text": "..." },
//     "log": "<file: every call is appended as a JSON line>" }
// A python entry: version, venv (false: no venv module), noPip, packages ({ "faster-whisper": "1.2.1" }), store
// (the Microsoft Store shortcut), probeHang (never answers).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_PYTHON_SCENARIO, "utf8"));
let [cmd, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === "win32";

if (scenario.log) fs.appendFileSync(scenario.log, JSON.stringify({ cmd, args }) + "\n");

// ── Who am I ─────────────────────────────────────────────────────────────
let me;
let key = cmd;
if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) {
  me = JSON.parse(fs.readFileSync(cmd, "utf8"));
  me.executable = cmd;
  me.home = me.home || path.dirname(cmd);
} else {
  if (/^py(\.exe)?$/i.test(path.basename(cmd)) && /^-\d(\.\d+)?$/.test(args[0] || "")) key = `py ${args.shift()}`;
  me = scenario.pythons?.[key];
  if (!me) {
    if (key.startsWith("py")) {
      err("No suitable Python runtime found\nPass --list (-0) to see all detected environments on your machine\nor open the Microsoft Store to the requested version.");
      process.exit(103);
    }
    err(`${cmd}: not found`);
    process.exit(127);
  }
  me = { ...me, executable: me.executable || (WIN ? `C:\\Python\\${key.replace(/\W+/g, "")}\\python.exe` : `/usr/bin/${key.replace(/\s+/g, "")}`) };
}

if (me.store) {
  err("Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.");
  process.exit(9009);
}

const version = String(me.version || "3.12.1");
const sitePath = me.home ? path.join(me.home, "fake-site.json") : null;
const packages = () => ({ ...(me.packages || {}), ...(sitePath && fs.existsSync(sitePath) ? JSON.parse(fs.readFileSync(sitePath, "utf8")) : {}) });

// Flags that come before -c / -m / a script.
while (args[0] && /^-[IuEsBq]+$/.test(args[0])) args.shift();

// ── -c ───────────────────────────────────────────────────────────────────
if (args[0] === "-c") {
  const code = args[1] || "";
  if (code.includes("TARSEE-PROBE")) {
    if (me.probeHang) await sleep(600_000);
    out(`TARSEE-PROBE ${JSON.stringify({
      version: version.split(".").map(Number),
      executable: me.executable,
      prefix: me.home || path.dirname(me.executable),
      venv: me.venv !== false,
      fasterWhisper: packages()["faster-whisper"] || null,
    })}`);
    process.exit(0);
  }
  if (code.includes("import faster_whisper")) {
    const v = packages()["faster-whisper"];
    if (!v) { err("ModuleNotFoundError: No module named 'faster_whisper'"); process.exit(1); }
    out(v);
    process.exit(0);
  }
  if (code.includes("import ptts")) {
    if (!packages().ptts) { err("ModuleNotFoundError: No module named 'ptts'"); process.exit(1); }
    process.exit(0);
  }
  process.exit(0);
}

// ── -m venv / pip ────────────────────────────────────────────────────────
if (args[0] === "-m" && args[1] === "venv") {
  const dir = args[args.length - 1];
  if (me.venv === false) {
    err("The virtual environment was not created successfully because ensurepip is not\navailable.  On Debian/Ubuntu systems, you need to install the python3-venv\npackage using the following command.\n\n    apt install python3.11-venv");
    process.exit(1);
  }
  const exe = WIN ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(path.join(dir, "pyvenv.cfg"), `home = ${path.dirname(me.executable)}\nversion = ${version}\n`);
  fs.writeFileSync(exe, JSON.stringify({ fake: "python", version, venv: true, home: dir, base: me.executable }));
  process.exit(0);
}

if (args[0] === "-m" && args[1] === "pip") {
  if (me.noPip) { err(`${me.executable}: No module named pip`); process.exit(1); }
  if (args[2] === "--version" || args.includes("--version")) {
    out(`pip 24.3.1 from ${me.home || "/usr/lib/python3/dist-packages"}/pip (python ${version.split(".").slice(0, 2).join(".")})`);
    process.exit(0);
  }
  if (args.includes("install")) {
    const specs = args.filter((a) => /^[A-Za-z][\w.-]*==[\w.]+$/.test(a));
    const pip = scenario.pip || {};
    const delay = pip.delayMs ?? 2;
    const lines = [
      `Collecting ${specs[0]}`,
      `  Downloading ${specs[0].replace("==", "-").replace(/-/g, "_")}-py3-none-any.whl (1.1 MB)`,
      "Collecting ctranslate2<5,>=4.0 (from faster-whisper==1.2.1)",
      "  Downloading ctranslate2-4.8.5-cp312-cp312-win_amd64.whl (19.4 MB)",
      "Collecting onnxruntime<2,>=1.14 (from faster-whisper==1.2.1)",
      "  Downloading onnxruntime-1.31.1-cp312-cp312-win_amd64.whl (12.6 MB)",
      "Collecting av>=11 (from faster-whisper==1.2.1)",
      "  Downloading av-19.0.2-cp312-abi3-win_amd64.whl (31.2 MB)",
      "Collecting tokenizers<1,>=0.13 (from faster-whisper==1.2.1)",
      "  Downloading tokenizers-0.23.3-cp310-abi3-win_amd64.whl (2.6 MB)",
      "Collecting numpy (from ctranslate2<5,>=4.0->faster-whisper==1.2.1)",
      "  Downloading numpy-2.3.4-cp312-cp312-win_amd64.whl (12.8 MB)",
    ];
    const half = 5;
    for (let i = 0; i < lines.length; i++) {
      if (pip.mode === "fail-halfway" && i === half) {
        err("ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device");
        process.exit(1);
      }
      if (pip.mode === "offline" && i === 0) {
        for (let k = 0; k < 2; k++) {
          out(`WARNING: Retrying (Retry(total=${4 - k}, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object at 0x0000021>: Failed to establish a new connection: [Errno 11001] getaddrinfo failed')': /simple/faster-whisper/`);
          await sleep(delay);
        }
        err(`ERROR: Could not find a version that satisfies the requirement ${specs[0]} (from versions: none)`);
        err(`ERROR: No matching distribution found for ${specs[0]}`);
        process.exit(1);
      }
      if (pip.mode === "no-wheel" && i === 2) {
        err("ERROR: Could not find a version that satisfies the requirement ctranslate2<5,>=4.0 (from faster-whisper) (from versions: none)");
        err("ERROR: No matching distribution found for ctranslate2<5,>=4.0");
        process.exit(1);
      }
      out(lines[i]);
      await sleep(delay);
    }
    out("Installing collected packages: numpy, tokenizers, av, onnxruntime, ctranslate2, faster-whisper");
    await sleep(delay);
    if (sitePath) {
      const now = packages();
      for (const s of specs) { const [n, v] = s.split("=="); now[n] = v; }
      fs.writeFileSync(sitePath, JSON.stringify(now));
    }
    out(`Successfully installed ${specs.map((s) => s.replace("==", "-")).join(" ")} numpy-2.3.4 tokenizers-0.23.3 av-19.0.2 onnxruntime-1.31.1 ctranslate2-4.8.5`);
    process.exit(0);
  }
}

// ── The speech-to-text worker (src/voice/stt_worker.py) ──────────────────
if (args[0] && /stt_worker\.py$/.test(args[0])) {
  const w = scenario.worker || {};
  const fw = packages()["faster-whisper"];
  if (!fw) {
    out(JSON.stringify({ ready: false, error: "ModuleNotFoundError: No module named 'faster_whisper'" }));
    process.exit(1);
  }
  out(JSON.stringify({ ready: true, version: fw }));
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (scenario.log) fs.appendFileSync(scenario.log, JSON.stringify({ worker: req }) + "\n");
    if (w.mode === "crash") process.exit(3);
    if (w.mode === "hang") continue;
    if (w.delayMs) await sleep(w.delayMs);
    if (w.mode === "error") { out(JSON.stringify({ id: req.id, error: "RuntimeError: Unable to open file 'model.bin' in model" })); continue; }
    if (!fs.existsSync(req.audio)) { out(JSON.stringify({ id: req.id, error: `FileNotFoundError: ${req.audio}` })); continue; }
    if (!fs.existsSync(path.join(req.model, "model.bin"))) { out(JSON.stringify({ id: req.id, error: `RuntimeError: Unable to open file 'model.bin' in model '${req.model}'` })); continue; }
    const audio = fs.readFileSync(req.audio);
    out(JSON.stringify({
      id: req.id,
      text: w.text ?? (audio.subarray(0, 4).toString("latin1") === "RIFF" ? "hello from a wav" : "hello from the fake"),
      language: req.language || "en",
      duration: 1.2,
    }));
  }
  process.exit(0);
}

err(`fake python: nothing to do for ${JSON.stringify(args)}`);
process.exit(2);
