//! The `tarsee` program. Everything it does is in the library; this only hands over the real environment and
//! arguments, the one place they are read.

fn main() -> std::process::ExitCode {
    tarsee::cli::main(tarsee::Env::from_process(), std::env::args().collect())
}
