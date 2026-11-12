//! Port of `src/daemon/service.js`: installs Tarsee as a service that starts with the machine. systemd on Linux,
//! launchd on macOS, a scheduled task at logon on Windows.
//!
//! The program the service runs is this `tarsee` program itself (`tarsee start`); the Node version ran
//! `node src/server.js`. Everything else is as it was.

use std::path::{Path, PathBuf};

use crate::env::Env;

pub const SERVICE_NAME: &str = "tarsee";

/// What the service functions do to the machine. The real one runs commands through the shell (as `execSync` did)
/// and touches real files; the tests use a recording one.
pub trait ServiceSystem {
    /// Runs a command through the shell; fails, with `Command failed: <command>` and its stderr, on a non-zero exit.
    fn run(&mut self, command: &str) -> anyhow::Result<String>;
    fn write(&mut self, path: &Path, content: &str) -> std::io::Result<()>;
    fn remove(&mut self, path: &Path) -> std::io::Result<()>;
    fn exists(&self, path: &Path) -> bool;
}

/// The machine itself.
pub struct RealSystem;

impl ServiceSystem for RealSystem {
    fn run(&mut self, command: &str) -> anyhow::Result<String> {
        let output = if cfg!(windows) {
            std::process::Command::new("cmd")
                .args(["/d", "/s", "/c", command])
                .output()?
        } else {
            std::process::Command::new("/bin/sh").args(["-c", command]).output()?
        };
        if !output.status.success() {
            anyhow::bail!("Command failed: {command}\n{}", String::from_utf8_lossy(&output.stderr));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn write(&mut self, path: &Path, content: &str) -> std::io::Result<()> {
        std::fs::write(path, content)
    }

    fn remove(&mut self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
}

/// The platform as Node named it (`process.platform`): "linux", "darwin", "win32", ...
pub fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// This program.
fn this_program() -> anyhow::Result<PathBuf> {
    Ok(std::env::current_exe()?)
}

/// Installs the service for this machine.
pub fn install(env: &Env) -> anyhow::Result<()> {
    install_with(&mut RealSystem, current_platform(), &this_program()?, env)
}

/// Removes the service.
pub fn uninstall(env: &Env) -> anyhow::Result<()> {
    uninstall_with(&mut RealSystem, current_platform(), env)
}

/// Whether the service is installed.
pub fn is_installed(env: &Env) -> bool {
    is_installed_with(&mut RealSystem, current_platform(), env)
}

pub fn install_with(system: &mut dyn ServiceSystem, platform: &str, program: &Path, env: &Env) -> anyhow::Result<()> {
    let program = program.display().to_string();
    match platform {
        "linux" => install_systemd(system, &program),
        "darwin" => install_launchd(system, &program, env),
        "win32" => install_windows(system, &program),
        other => anyhow::bail!("Unsupported platform: {other}"),
    }
}

pub fn uninstall_with(system: &mut dyn ServiceSystem, platform: &str, env: &Env) -> anyhow::Result<()> {
    match platform {
        "linux" => uninstall_systemd(system),
        "darwin" => uninstall_launchd(system, env),
        "win32" => uninstall_windows(system),
        other => anyhow::bail!("Unsupported platform: {other}"),
    }
}

pub fn is_installed_with(system: &mut dyn ServiceSystem, platform: &str, env: &Env) -> bool {
    match platform {
        "linux" => system.run(&format!("systemctl is-enabled {SERVICE_NAME}")).is_ok(),
        "darwin" => system.exists(Path::new(&plist_path(env))),
        "win32" => system.run(&format!("schtasks /Query /TN {SERVICE_NAME}")).is_ok(),
        _ => false,
    }
}

/// The systemd unit that runs `program`.
pub fn systemd_unit(program: &str) -> String {
    format!(
        "[Unit]
Description=Tarsee AI Assistant
After=network.target

[Service]
Type=simple
ExecStart={program} start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
"
    )
}

fn unit_path() -> String {
    format!("/etc/systemd/system/{SERVICE_NAME}.service")
}

fn install_systemd(system: &mut dyn ServiceSystem, program: &str) -> anyhow::Result<()> {
    let unit_path = unit_path();
    system.write(Path::new(&unit_path), &systemd_unit(program))?;
    system.run("systemctl daemon-reload")?;
    system.run(&format!("systemctl enable {SERVICE_NAME}"))?;
    log::info!("Installed systemd service: {unit_path}");
    log::info!("Start with: sudo systemctl start {SERVICE_NAME}");
    Ok(())
}

fn uninstall_systemd(system: &mut dyn ServiceSystem) -> anyhow::Result<()> {
    system.run(&format!("systemctl stop {SERVICE_NAME}"))?;
    system.run(&format!("systemctl disable {SERVICE_NAME}"))?;
    system.remove(Path::new(&unit_path()))?;
    system.run("systemctl daemon-reload")?;
    log::info!("Systemd service removed.");
    Ok(())
}

/// The launchd agent that runs `program`.
pub fn launchd_plist(program: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>com.tarsee.agent</string>
  <key>ProgramArguments</key><array><string>{program}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
</dict></plist>"
    )
}

/// `${process.env.HOME}/Library/LaunchAgents/com.tarsee.agent.plist`.
fn plist_path(env: &Env) -> String {
    let home = env.get("HOME").unwrap_or_else(|| "undefined".into());
    format!("{home}/Library/LaunchAgents/com.tarsee.agent.plist")
}

fn install_launchd(system: &mut dyn ServiceSystem, program: &str, env: &Env) -> anyhow::Result<()> {
    let plist_path = plist_path(env);
    system.write(Path::new(&plist_path), &launchd_plist(program))?;
    system.run(&format!("launchctl load {plist_path}"))?;
    log::info!("Installed launchd agent: {plist_path}");
    Ok(())
}

fn uninstall_launchd(system: &mut dyn ServiceSystem, env: &Env) -> anyhow::Result<()> {
    let plist_path = plist_path(env);
    system.run(&format!("launchctl unload {plist_path}"))?;
    system.remove(Path::new(&plist_path))?;
    log::info!("Launchd agent removed.");
    Ok(())
}

/// The command that makes the Windows scheduled task running `program` at logon.
pub fn windows_task_command(program: &str) -> String {
    format!("schtasks /Create /SC ONLOGON /TN {SERVICE_NAME} /TR \"\\\"{program}\\\" start\" /RL HIGHEST /F")
}

fn install_windows(system: &mut dyn ServiceSystem, program: &str) -> anyhow::Result<()> {
    system.run(&windows_task_command(program))?;
    log::info!("Installed Windows scheduled task: {SERVICE_NAME}");
    log::info!("Start with: schtasks /Run /TN {SERVICE_NAME}");
    Ok(())
}

fn uninstall_windows(system: &mut dyn ServiceSystem) -> anyhow::Result<()> {
    system.run(&format!("schtasks /Delete /TN {SERVICE_NAME} /F"))?;
    log::info!("Windows scheduled task removed.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::CapturedLogs;
    use std::collections::BTreeSet;

    #[derive(Default)]
    struct Recorder {
        ran: Vec<String>,
        written: Vec<(String, String)>,
        removed: Vec<String>,
        files: BTreeSet<String>,
        fail: Option<&'static str>,
    }

    impl ServiceSystem for Recorder {
        fn run(&mut self, command: &str) -> anyhow::Result<String> {
            self.ran.push(command.to_string());
            if self.fail.is_some_and(|f| command.contains(f)) {
                anyhow::bail!("Command failed: {command}\n");
            }
            Ok(String::new())
        }
        fn write(&mut self, path: &Path, content: &str) -> std::io::Result<()> {
            self.written.push((path.display().to_string(), content.to_string()));
            Ok(())
        }
        fn remove(&mut self, path: &Path) -> std::io::Result<()> {
            self.removed.push(path.display().to_string());
            Ok(())
        }
        fn exists(&self, path: &Path) -> bool {
            self.files.contains(&path.display().to_string())
        }
    }

    const PROGRAM: &str = "/usr/local/bin/tarsee";

    #[test]
    fn linux_gets_a_systemd_unit_that_runs_this_program() {
        let mut system = Recorder::default();
        let logs = CapturedLogs::start();
        install_with(&mut system, "linux", Path::new(PROGRAM), &Env::new()).unwrap();
        assert_eq!(
            system.written,
            [(
                "/etc/systemd/system/tarsee.service".to_string(),
                "[Unit]\nDescription=Tarsee AI Assistant\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/tarsee start\nRestart=on-failure\nRestartSec=5\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=multi-user.target\n".to_string()
            )]
        );
        assert_eq!(system.ran, ["systemctl daemon-reload", "systemctl enable tarsee"]);
        assert_eq!(
            logs.infos(),
            [
                "Installed systemd service: /etc/systemd/system/tarsee.service",
                "Start with: sudo systemctl start tarsee"
            ]
        );
        let mut system = Recorder::default();
        uninstall_with(&mut system, "linux", &Env::new()).unwrap();
        assert_eq!(
            system.ran,
            [
                "systemctl stop tarsee",
                "systemctl disable tarsee",
                "systemctl daemon-reload"
            ]
        );
        assert_eq!(system.removed, ["/etc/systemd/system/tarsee.service"]);
        assert!(is_installed_with(&mut Recorder::default(), "linux", &Env::new()));
        let mut failing = Recorder {
            fail: Some("is-enabled"),
            ..Recorder::default()
        };
        assert!(!is_installed_with(&mut failing, "linux", &Env::new()));
    }

    #[test]
    fn macos_gets_a_launchd_agent_in_the_users_library() {
        let env = Env::from_pairs([("HOME", "/Users/someone")]);
        let mut system = Recorder::default();
        install_with(&mut system, "darwin", Path::new(PROGRAM), &env).unwrap();
        let plist = "/Users/someone/Library/LaunchAgents/com.tarsee.agent.plist";
        assert_eq!(system.written[0].0, plist);
        assert!(system.written[0].1.contains(
            "<key>ProgramArguments</key><array><string>/usr/local/bin/tarsee</string><string>start</string></array>"
        ));
        assert!(
            system.written[0]
                .1
                .starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist")
        );
        assert_eq!(system.ran, [format!("launchctl load {plist}")]);
        let mut system = Recorder::default();
        uninstall_with(&mut system, "darwin", &env).unwrap();
        assert_eq!(system.ran, [format!("launchctl unload {plist}")]);
        assert_eq!(system.removed, [plist]);
        assert!(!is_installed_with(&mut Recorder::default(), "darwin", &env));
        let mut with_file = Recorder::default();
        with_file.files.insert(plist.to_string());
        assert!(is_installed_with(&mut with_file, "darwin", &env));
    }

    #[test]
    fn windows_gets_a_scheduled_task_at_logon() {
        let mut system = Recorder::default();
        install_with(&mut system, "win32", Path::new("C:\\Tools\\tarsee.exe"), &Env::new()).unwrap();
        assert_eq!(
            system.ran,
            ["schtasks /Create /SC ONLOGON /TN tarsee /TR \"\\\"C:\\Tools\\tarsee.exe\\\" start\" /RL HIGHEST /F"]
        );
        let mut system = Recorder::default();
        uninstall_with(&mut system, "win32", &Env::new()).unwrap();
        assert_eq!(system.ran, ["schtasks /Delete /TN tarsee /F"]);
        assert!(is_installed_with(&mut Recorder::default(), "win32", &Env::new()));
    }

    #[test]
    fn other_platforms_are_refused_and_failures_stop_the_install() {
        let mut system = Recorder::default();
        assert_eq!(
            install_with(&mut system, "freebsd", Path::new(PROGRAM), &Env::new())
                .unwrap_err()
                .to_string(),
            "Unsupported platform: freebsd"
        );
        assert_eq!(
            uninstall_with(&mut system, "aix", &Env::new()).unwrap_err().to_string(),
            "Unsupported platform: aix"
        );
        assert!(!is_installed_with(&mut system, "aix", &Env::new()));
        let mut failing = Recorder {
            fail: Some("daemon-reload"),
            ..Recorder::default()
        };
        assert!(install_with(&mut failing, "linux", Path::new(PROGRAM), &Env::new()).is_err());
        assert_eq!(failing.ran, ["systemctl daemon-reload"], "enable is not reached");
        let expected = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        if cfg!(any(windows, target_os = "macos", target_os = "linux")) {
            assert_eq!(current_platform(), expected);
        }
    }

    #[test]
    fn the_real_system_runs_commands_through_the_shell() {
        let mut real = RealSystem;
        assert!(real.run("exit 0").is_ok());
        let err = real.run("exit 3").unwrap_err().to_string();
        assert!(err.starts_with("Command failed: exit 3\n"), "{err}");
    }
}
