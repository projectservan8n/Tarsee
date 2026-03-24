/**
 * Cross-platform daemon/service management for Tarsee.
 * Supports systemd (Linux), launchd (macOS), and schtasks (Windows).
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const SERVICE_NAME = "tarsee";

export function install() {
  const platform = process.platform;
  const nodePath = process.execPath;
  const serverPath = path.resolve(new URL("../server.js", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));

  if (platform === "linux") return installSystemd(nodePath, serverPath);
  if (platform === "darwin") return installLaunchd(nodePath, serverPath);
  if (platform === "win32") return installWindows(nodePath, serverPath);
  throw new Error(`Unsupported platform: ${platform}`);
}

export function uninstall() {
  const platform = process.platform;
  if (platform === "linux") return uninstallSystemd();
  if (platform === "darwin") return uninstallLaunchd();
  if (platform === "win32") return uninstallWindows();
  throw new Error(`Unsupported platform: ${platform}`);
}

export function isInstalled() {
  try {
    if (process.platform === "linux") {
      execSync(`systemctl is-enabled ${SERVICE_NAME}`, { stdio: "pipe" });
      return true;
    }
    if (process.platform === "darwin") {
      return fs.existsSync(`${process.env.HOME}/Library/LaunchAgents/com.tarsee.agent.plist`);
    }
    if (process.platform === "win32") {
      execSync(`schtasks /Query /TN ${SERVICE_NAME}`, { stdio: "pipe" });
      return true;
    }
  } catch { return false; }
  return false;
}

function installSystemd(nodePath, serverPath) {
  const unit = `[Unit]
Description=Tarsee AI Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${serverPath}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
  const unitPath = `/etc/systemd/system/${SERVICE_NAME}.service`;
  fs.writeFileSync(unitPath, unit);
  execSync("systemctl daemon-reload");
  execSync(`systemctl enable ${SERVICE_NAME}`);
  console.log(`Installed systemd service: ${unitPath}`);
  console.log(`Start with: sudo systemctl start ${SERVICE_NAME}`);
}

function uninstallSystemd() {
  execSync(`systemctl stop ${SERVICE_NAME}`, { stdio: "pipe" }).toString();
  execSync(`systemctl disable ${SERVICE_NAME}`, { stdio: "pipe" });
  fs.unlinkSync(`/etc/systemd/system/${SERVICE_NAME}.service`);
  execSync("systemctl daemon-reload");
  console.log("Systemd service removed.");
}

function installLaunchd(nodePath, serverPath) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tarsee.agent</string>
  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${serverPath}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
</dict></plist>`;
  const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.tarsee.agent.plist`;
  fs.writeFileSync(plistPath, plist);
  execSync(`launchctl load ${plistPath}`);
  console.log(`Installed launchd agent: ${plistPath}`);
}

function uninstallLaunchd() {
  const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.tarsee.agent.plist`;
  execSync(`launchctl unload ${plistPath}`, { stdio: "pipe" });
  fs.unlinkSync(plistPath);
  console.log("Launchd agent removed.");
}

function installWindows(nodePath, serverPath) {
  execSync(`schtasks /Create /SC ONLOGON /TN ${SERVICE_NAME} /TR "\\"${nodePath}\\" \\"${serverPath}\\"" /RL HIGHEST /F`, { stdio: "pipe" });
  console.log(`Installed Windows scheduled task: ${SERVICE_NAME}`);
  console.log(`Start with: schtasks /Run /TN ${SERVICE_NAME}`);
}

function uninstallWindows() {
  execSync(`schtasks /Delete /TN ${SERVICE_NAME} /F`, { stdio: "pipe" });
  console.log("Windows scheduled task removed.");
}
