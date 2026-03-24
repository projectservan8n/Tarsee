/**
 * Tarsee doctor — diagnostic checks.
 */

export async function runDoctor() {
  const checks = [];

  // Node.js version
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1));
  checks.push({ name: "Node.js", status: major >= 18 ? "pass" : "fail", detail: `${nodeVer} (requires >=18)` });

  // SQLite
  try {
    await import("better-sqlite3");
    checks.push({ name: "SQLite", status: "pass", detail: "better-sqlite3 loaded" });
  } catch {
    checks.push({ name: "SQLite", status: "fail", detail: "better-sqlite3 not installed" });
  }

  // Playwright
  try {
    await import("playwright");
    checks.push({ name: "Playwright", status: "pass", detail: "Available" });
  } catch {
    checks.push({ name: "Playwright", status: "warn", detail: "Not installed (browser tool unavailable)" });
  }

  // ffmpeg (for audio processing)
  try {
    const { execSync } = await import("node:child_process");
    execSync("ffmpeg -version", { stdio: "pipe" });
    checks.push({ name: "ffmpeg", status: "pass", detail: "Available" });
  } catch {
    checks.push({ name: "ffmpeg", status: "warn", detail: "Not installed (audio processing limited)" });
  }

  // Disk space
  try {
    const os = await import("node:os");
    const free = os.freemem();
    checks.push({ name: "Memory", status: free > 256 * 1024 * 1024 ? "pass" : "warn", detail: `${Math.round(free / 1024 / 1024)}MB free` });
  } catch {
    checks.push({ name: "Memory", status: "warn", detail: "Could not check" });
  }

  // Environment
  checks.push({ name: "ENCRYPTION_KEY", status: process.env.ENCRYPTION_KEY ? "pass" : "warn", detail: process.env.ENCRYPTION_KEY ? "Set" : "Not set (credentials unencrypted)" });
  checks.push({ name: "SETUP_PASSWORD", status: process.env.SETUP_PASSWORD ? "pass" : "warn", detail: process.env.SETUP_PASSWORD ? "Set" : "Not set (open access)" });

  // Print results
  console.log("\n  Tarsee Doctor\n");
  for (const c of checks) {
    const icon = c.status === "pass" ? "[OK]" : c.status === "warn" ? "[!!]" : "[XX]";
    console.log(`  ${icon} ${c.name.padEnd(18)} ${c.detail}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(`\n  ${checks.length} checks: ${checks.length - fails - warns} passed, ${warns} warnings, ${fails} failures\n`);
}
