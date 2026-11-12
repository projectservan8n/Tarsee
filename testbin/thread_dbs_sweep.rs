//! Role `thread-dbs-sweep`: runs Tarsee's sweep of a Codex home's thread databases (`lib/codex_thread_dbs.rs`) and
//! dies on the spot, exit code 137 with no clean-up at all, the moment the named database's rebuild (VACUUM) starts:
//! what a server killed mid-sweep leaves behind.
//!
//!   tarsee-testbin <home> <database file name to die at> <now in ms>

use std::path::PathBuf;
use std::sync::Arc;

use tarsee::lib::codex_thread_dbs::{PruneThreadDbsOpts, ThreadDbsDeps, prune_codex_thread_dbs};

pub fn main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(home), Some(die_at), Some(now)) = (args.first(), args.get(1), args.get(2)) else {
        eprintln!("usage: <home> <database> <now ms>");
        return 64;
    };
    let Ok(now) = now.parse::<i64>() else {
        eprintln!("not a time: {now}");
        return 64;
    };
    let die_at = die_at.clone();
    let deps = ThreadDbsDeps {
        before_rebuild: Some(Arc::new(move |name: &str| {
            if name == die_at {
                std::process::exit(137);
            }
        })),
        ..ThreadDbsDeps::default()
    };
    prune_codex_thread_dbs(&PruneThreadDbsOpts {
        homes: vec![PathBuf::from(home)],
        max_age_days: 30.0,
        now,
        deps,
    });
    0
}
