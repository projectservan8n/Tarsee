//! Port of `src/cli/index.js`: the `tarsee` command line. Not ported yet: work package Z1 (docs/rust-port/PLAN.md).

pub mod doctor;
pub mod interactive;

use std::process::ExitCode;

use crate::env::Env;

/// Runs the command line: `args` as the program got them (the program's own name first), `env` the environment.
pub fn main(_env: Env, _args: Vec<String>) -> ExitCode {
    eprintln!("tarsee {}: the command line is not ported yet", crate::VERSION);
    ExitCode::from(2)
}
