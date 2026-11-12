//! Starts the fake Python (the `fake-python` role of `tarsee-testbin`) in place of a real one: hand
//! [`FakePython::hook`] to the code under test (`python_runtime::set_for_tests`). A command the scenario doesn't know,
//! and that isn't a file the fake wrote, gets a real "not found", exactly as a missing python would. The Node tests'
//! `test/fakes/fake-python.js`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tarsee::voice::python_runtime::{Launch, PythonOverrides, PythonRef, SpawnHook};

use crate::support::testbin;

pub struct FakePython {
    dir: PathBuf,
    file: PathBuf,
    log: PathBuf,
    current: Arc<Mutex<Value>>,
}

#[allow(dead_code)]
impl FakePython {
    /// `dir`: a folder for the scenario and log files. `scenario`: see `testbin/fake_python.rs`.
    pub fn new(dir: &Path, scenario: Value) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join("fake-python-scenario.json");
        let log = dir.join("fake-python-calls.jsonl");
        let mut current = json!({ "pythons": {} });
        if let Value::Object(given) = scenario {
            for (k, v) in given {
                current[k] = v;
            }
        }
        current["log"] = json!(log.to_string_lossy());
        let fake = FakePython {
            dir: dir.to_path_buf(),
            file,
            log,
            current: Arc::new(Mutex::new(current)),
        };
        fake.save();
        fake
    }

    fn save(&self) {
        std::fs::write(&self.file, self.current.lock().to_string()).unwrap();
    }

    /// Merges `patch` into the scenario (the log stays).
    pub fn set(&self, patch: Value) {
        {
            let mut current = self.current.lock();
            if let Value::Object(patch) = patch {
                for (k, v) in patch {
                    current[k] = v;
                }
            }
            current["log"] = json!(self.log.to_string_lossy());
        }
        self.save();
    }

    /// The stand-in for starting a program.
    pub fn hook(&self) -> SpawnHook {
        let current = self.current.clone();
        let file = self.file.clone();
        let nowhere = self.dir.join("no-such-dir").join("no-such-program");
        Arc::new(move |launch: Launch| {
            let cmd = launch.program.to_string_lossy().to_string();
            let is_file = launch.program.is_file();
            let scenario = current.lock().clone();
            let pythons = scenario
                .get("pythons")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let base = cmd.rsplit(['/', '\\']).next().unwrap_or(&cmd).to_lowercase();
            let py = (base == "py" || base == "py.exe") && pythons.keys().any(|k| k.starts_with("py "));
            if !is_file && !py && !pythons.contains_key(&cmd) {
                return Launch {
                    program: nowhere.clone(),
                    ..launch
                };
            }
            let mut env = launch.env;
            env.insert("FAKE_PYTHON_SCENARIO".into(), file.to_string_lossy().to_string());
            env.insert("TARSEE_TESTBIN_ROLE".into(), "fake-python".into());
            Launch {
                program: testbin(),
                args: std::iter::once(cmd).chain(launch.args).collect(),
                env,
            }
        })
    }

    /// The overrides that make the code under test use this fake and try exactly these Pythons.
    pub fn overrides(&self, candidates: Vec<PythonRef>) -> PythonOverrides {
        PythonOverrides {
            spawn: Some(self.hook()),
            candidates: Some(candidates),
        }
    }

    /// Every run so far.
    pub fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    pub fn clear_calls(&self) {
        let _ = std::fs::remove_file(&self.log);
    }
}

/// The bytes of a fake interpreter file (what a test archive puts where python.exe / bin/python3 would be).
#[allow(dead_code)]
pub fn fake_interpreter(version: &str, extra: Value) -> String {
    let mut me = json!({ "fake": "python", "version": version, "venv": true });
    if let Value::Object(extra) = extra {
        for (k, v) in extra {
            me[k] = v;
        }
    }
    me.to_string()
}

/// A system Python to try: `{ cmd, args, source: "system", label }`.
#[allow(dead_code)]
pub fn cand(cmd: &str, args: &[&str]) -> PythonRef {
    let label = std::iter::once(cmd)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    PythonRef::new(cmd)
        .args(args.iter().copied())
        .source("system")
        .label(label)
}
