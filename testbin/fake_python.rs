//! Role `fake-python`: a fake Python interpreter for the installer and speech-to-text tests (the Node tests'
//! `test/fakes/fake-python.mjs`). Never started directly: the tests' spawn hook (`tests/it/fake_python.rs`) starts
//! it as `tarsee-testbin <the command the code ran> <its arguments...>`, so the code under test really starts a
//! process, reads its output line by line and sees its exit code.
//!
//! Who it is comes from the command: a path to a file it wrote earlier (a venv's python, the standalone Python from
//! a test archive: a JSON file describing itself), or a name in the scenario (`FAKE_PYTHON_SCENARIO`, a JSON file):
//!   { "pythons": { "python3": { "version": "3.11.4" }, "py -3.12": {...}, "python": { "store": true } },
//!     "pip": { "mode": "ok" | "fail-halfway" | "no-wheel" | "offline", "delayMs": 5 },
//!     "worker": { "mode": "ok" | "error" | "crash" | "hang", "text": "..." },
//!     "log": "<file: every call is appended as a JSON line>" }
//! A python entry: version, venv (false: no venv module), noPip, packages ({ "faster-whisper": "1.2.1" }), store
//! (the Microsoft Store shortcut), probeHang (never answers).

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

const WIN: bool = cfg!(windows);

fn out(s: &str) {
    let mut o = std::io::stdout();
    let _ = writeln!(o, "{s}");
    let _ = o.flush();
}

fn err(s: &str) {
    let mut e = std::io::stderr();
    let _ = writeln!(e, "{s}");
    let _ = e.flush();
}

/// JavaScript's whitespace (`\s`, `trim()`): U+FEFF is, U+0085 is not.
fn js_space(c: char) -> bool {
    c == '\u{FEFF}' || (c != '\u{0085}' && c.is_whitespace())
}

fn sleep(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

fn append(log: &Option<String>, line: &Value) {
    if let Some(log) = log
        && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log)
    {
        let _ = writeln!(f, "{line}");
    }
}

fn is_py_launcher(cmd: &str) -> bool {
    let base = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd).to_lowercase();
    base == "py" || base == "py.exe"
}

fn is_version_flag(arg: &str) -> bool {
    // /^-\d(\.\d+)?$/
    let Some(rest) = arg.strip_prefix('-') else {
        return false;
    };
    let mut chars = rest.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    let tail: String = chars.collect();
    tail.is_empty() || (tail.starts_with('.') && tail.len() > 1 && tail[1..].chars().all(|c| c.is_ascii_digit()))
}

fn is_flags(arg: &str) -> bool {
    // /^-[IuEsBq]+$/
    arg.len() > 1 && arg.starts_with('-') && arg[1..].chars().all(|c| "IuEsBq".contains(c))
}

fn is_spec(arg: &str) -> bool {
    // /^[A-Za-z][\w.-]*==[\w.]+$/
    let Some((name, version)) = arg.split_once("==") else {
        return false;
    };
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.chars().all(|c| word(c) || c == '.' || c == '-')
        && !version.is_empty()
        && version.chars().all(|c| word(c) || c == '.')
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

pub fn main() -> i32 {
    let scenario: Value = std::env::var("FAKE_PYTHON_SCENARIO")
        .ok()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        err("fake python: no command");
        return 2;
    }
    let cmd = args.remove(0);
    let log = str_of(scenario.get("log"));
    append(&log, &json!({ "cmd": cmd, "args": args }));

    // ── Who am I ─────────────────────────────────────────────────────────
    let mut me: Map<String, Value>;
    let cmd_path = Path::new(&cmd);
    if cmd_path.is_file() {
        let text = std::fs::read_to_string(cmd_path).unwrap_or_default();
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => me = m,
            _ => {
                err(&format!("SyntaxError: Unexpected token in JSON at position 0 ({cmd})"));
                return 1;
            }
        }
        me.insert("executable".into(), json!(cmd));
        if str_of(me.get("home")).is_none_or(|h| h.is_empty()) {
            let home = cmd_path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            me.insert("home".into(), json!(home));
        }
    } else {
        let mut key = cmd.clone();
        if is_py_launcher(&cmd) && args.first().is_some_and(|a| is_version_flag(a)) {
            key = format!("py {}", args.remove(0));
        }
        match scenario
            .get("pythons")
            .and_then(|p| p.get(&key))
            .and_then(Value::as_object)
        {
            Some(m) => me = m.clone(),
            None => {
                if key.starts_with("py") {
                    err(
                        "No suitable Python runtime found\nPass --list (-0) to see all detected environments on your machine\nor open the Microsoft Store to the requested version.",
                    );
                    return 103;
                }
                err(&format!("{cmd}: not found"));
                return 127;
            }
        }
        if str_of(me.get("executable")).is_none_or(|e| e.is_empty()) {
            let exe = if WIN {
                let squashed: String = key.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                format!("C:\\Python\\{squashed}\\python.exe")
            } else {
                let squashed: String = key.chars().filter(|c| !js_space(*c)).collect();
                format!("/usr/bin/{squashed}")
            };
            me.insert("executable".into(), json!(exe));
        }
    }

    if me.get("store").and_then(Value::as_bool).unwrap_or(false) {
        err(
            "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.",
        );
        return 9009;
    }

    let version = str_of(me.get("version"))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "3.12.1".into());
    let executable = str_of(me.get("executable")).unwrap_or_default();
    let home = str_of(me.get("home")).filter(|h| !h.is_empty());
    let site_path = home.as_ref().map(|h| PathBuf::from(h).join("fake-site.json"));
    let packages = || {
        let mut all = me
            .get("packages")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(site) = &site_path
            && let Some(Value::Object(more)) = std::fs::read_to_string(site)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            all.extend(more);
        }
        all
    };

    // Flags that come before -c / -m / a script.
    while args.first().is_some_and(|a| is_flags(a)) {
        args.remove(0);
    }

    // ── -c ───────────────────────────────────────────────────────────────
    if args.first().map(String::as_str) == Some("-c") {
        let code = args.get(1).cloned().unwrap_or_default();
        if code.contains("TARSEE-PROBE") {
            if me.get("probeHang").and_then(Value::as_bool).unwrap_or(false) {
                sleep(600_000);
            }
            let numbers: Vec<Value> = version
                .split('.')
                .map(|p| p.parse::<i64>().map(Value::from).unwrap_or(Value::Null))
                .collect();
            let prefix = home.clone().unwrap_or_else(|| {
                Path::new(&executable)
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            let r = json!({
                "version": numbers,
                "executable": executable,
                "prefix": prefix,
                "venv": me.get("venv") != Some(&Value::Bool(false)),
                "fasterWhisper": packages().get("faster-whisper").cloned().unwrap_or(Value::Null),
            });
            out(&format!("TARSEE-PROBE {r}"));
            return 0;
        }
        if code.contains("import faster_whisper") {
            return match packages().get("faster-whisper").and_then(Value::as_str) {
                Some(v) => {
                    out(v);
                    0
                }
                None => {
                    err("ModuleNotFoundError: No module named 'faster_whisper'");
                    1
                }
            };
        }
        if code.contains("import ptts") {
            if !packages().contains_key("ptts") {
                err("ModuleNotFoundError: No module named 'ptts'");
                return 1;
            }
            return 0;
        }
        return 0;
    }

    // ── -m venv / pip ────────────────────────────────────────────────────
    if args.first().map(String::as_str) == Some("-m") && args.get(1).map(String::as_str) == Some("venv") {
        let dir = PathBuf::from(args.last().cloned().unwrap_or_default());
        if me.get("venv") == Some(&Value::Bool(false)) {
            err(
                "The virtual environment was not created successfully because ensurepip is not\navailable.  On Debian/Ubuntu systems, you need to install the python3-venv\npackage using the following command.\n\n    apt install python3.11-venv",
            );
            return 1;
        }
        let exe = if WIN {
            dir.join("Scripts").join("python.exe")
        } else {
            dir.join("bin").join("python")
        };
        if let Some(parent) = exe.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let exe_dir = Path::new(&executable)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = std::fs::write(
            dir.join("pyvenv.cfg"),
            format!("home = {exe_dir}\nversion = {version}\n"),
        );
        let me_file = json!({
            "fake": "python",
            "version": version,
            "venv": true,
            "home": dir.to_string_lossy(),
            "base": executable,
        });
        let _ = std::fs::write(&exe, me_file.to_string());
        return 0;
    }

    if args.first().map(String::as_str) == Some("-m") && args.get(1).map(String::as_str) == Some("pip") {
        if me.get("noPip").and_then(Value::as_bool).unwrap_or(false) {
            err(&format!("{executable}: No module named pip"));
            return 1;
        }
        if args.iter().any(|a| a == "--version") {
            let short: Vec<&str> = version.split('.').take(2).collect();
            let at = home.clone().unwrap_or_else(|| "/usr/lib/python3/dist-packages".into());
            out(&format!("pip 24.3.1 from {at}/pip (python {})", short.join(".")));
            return 0;
        }
        if args.iter().any(|a| a == "install") {
            return pip_install(&scenario, &args, &site_path, &packages);
        }
    }

    // ── The speech-to-text worker (src/voice/stt_worker.py) ──────────────
    if args.first().is_some_and(|a| a.ends_with("stt_worker.py")) {
        return worker(&scenario, &log, &packages);
    }

    err(&format!("fake python: nothing to do for {}", json!(args)));
    2
}

fn pip_install(
    scenario: &Value,
    args: &[String],
    site_path: &Option<PathBuf>,
    packages: &dyn Fn() -> Map<String, Value>,
) -> i32 {
    let specs: Vec<String> = args.iter().filter(|a| is_spec(a)).cloned().collect();
    let first = specs.first().cloned().unwrap_or_else(|| "undefined".into());
    let pip = scenario.get("pip").cloned().unwrap_or_else(|| json!({}));
    let mode = pip.get("mode").and_then(Value::as_str).unwrap_or("ok").to_string();
    let delay = pip.get("delayMs").and_then(Value::as_u64).unwrap_or(2);
    let wheel = first.replacen("==", "-", 1).replace('-', "_");
    let lines = [
        format!("Collecting {first}"),
        format!("  Downloading {wheel}-py3-none-any.whl (1.1 MB)"),
        "Collecting ctranslate2<5,>=4.0 (from faster-whisper==1.2.1)".to_string(),
        "  Downloading ctranslate2-4.8.5-cp312-cp312-win_amd64.whl (19.4 MB)".to_string(),
        "Collecting onnxruntime<2,>=1.14 (from faster-whisper==1.2.1)".to_string(),
        "  Downloading onnxruntime-1.31.1-cp312-cp312-win_amd64.whl (12.6 MB)".to_string(),
        "Collecting av>=11 (from faster-whisper==1.2.1)".to_string(),
        "  Downloading av-19.0.2-cp312-abi3-win_amd64.whl (31.2 MB)".to_string(),
        "Collecting tokenizers<1,>=0.13 (from faster-whisper==1.2.1)".to_string(),
        "  Downloading tokenizers-0.23.3-cp310-abi3-win_amd64.whl (2.6 MB)".to_string(),
        "Collecting numpy (from ctranslate2<5,>=4.0->faster-whisper==1.2.1)".to_string(),
        "  Downloading numpy-2.3.4-cp312-cp312-win_amd64.whl (12.8 MB)".to_string(),
    ];
    let half = 5;
    for (i, line) in lines.iter().enumerate() {
        if mode == "fail-halfway" && i == half {
            err("ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device");
            return 1;
        }
        if mode == "offline" && i == 0 {
            for k in 0..2 {
                out(&format!(
                    "WARNING: Retrying (Retry(total={}, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object at 0x0000021>: Failed to establish a new connection: [Errno 11001] getaddrinfo failed')': /simple/faster-whisper/",
                    4 - k
                ));
                sleep(delay);
            }
            err(&format!(
                "ERROR: Could not find a version that satisfies the requirement {first} (from versions: none)"
            ));
            err(&format!("ERROR: No matching distribution found for {first}"));
            return 1;
        }
        if mode == "no-wheel" && i == 2 {
            err(
                "ERROR: Could not find a version that satisfies the requirement ctranslate2<5,>=4.0 (from faster-whisper) (from versions: none)",
            );
            err("ERROR: No matching distribution found for ctranslate2<5,>=4.0");
            return 1;
        }
        out(line);
        sleep(delay);
    }
    out("Installing collected packages: numpy, tokenizers, av, onnxruntime, ctranslate2, faster-whisper");
    sleep(delay);
    if let Some(site) = site_path {
        let mut now = packages();
        for s in &specs {
            if let Some((n, v)) = s.split_once("==") {
                now.insert(n.to_string(), json!(v));
            }
        }
        let _ = std::fs::write(site, Value::Object(now).to_string());
    }
    let installed: Vec<String> = specs.iter().map(|s| s.replacen("==", "-", 1)).collect();
    out(&format!(
        "Successfully installed {} numpy-2.3.4 tokenizers-0.23.3 av-19.0.2 onnxruntime-1.31.1 ctranslate2-4.8.5",
        installed.join(" ")
    ));
    0
}

fn worker(scenario: &Value, log: &Option<String>, packages: &dyn Fn() -> Map<String, Value>) -> i32 {
    let w = scenario.get("worker").cloned().unwrap_or_else(|| json!({}));
    let mode = w.get("mode").and_then(Value::as_str).unwrap_or("ok").to_string();
    let Some(fw) = packages().get("faster-whisper").cloned() else {
        out(&json!({ "ready": false, "error": "ModuleNotFoundError: No module named 'faster_whisper'" }).to_string());
        return 1;
    };
    out(&json!({ "ready": true, "version": fw }).to_string());
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.chars().all(js_space) {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        append(log, &json!({ "worker": req }));
        if mode == "crash" {
            return 3;
        }
        if mode == "hang" {
            continue;
        }
        if let Some(ms) = w.get("delayMs").and_then(Value::as_u64) {
            sleep(ms);
        }
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        if mode == "error" {
            out(&json!({ "id": id, "error": "RuntimeError: Unable to open file 'model.bin' in model" }).to_string());
            continue;
        }
        let audio = str_of(req.get("audio")).unwrap_or_default();
        if !Path::new(&audio).exists() {
            out(&json!({ "id": id, "error": format!("FileNotFoundError: {audio}") }).to_string());
            continue;
        }
        let model = str_of(req.get("model")).unwrap_or_default();
        if !Path::new(&model).join("model.bin").exists() {
            out(&json!({ "id": id, "error": format!("RuntimeError: Unable to open file 'model.bin' in model '{model}'") })
                .to_string());
            continue;
        }
        let bytes = std::fs::read(&audio).unwrap_or_default();
        let text = match w.get("text") {
            Some(t) if !t.is_null() => t.clone(),
            _ if bytes.starts_with(b"RIFF") => json!("hello from a wav"),
            _ => json!("hello from the fake"),
        };
        let language = req
            .get("language")
            .filter(|l| l.as_str().is_some_and(|s| !s.is_empty()))
            .cloned()
            .unwrap_or_else(|| json!("en"));
        out(&json!({ "id": id, "text": text, "language": language, "duration": 1.2 }).to_string());
    }
    0
}
