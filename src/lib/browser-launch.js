/**
 * How tarsee_browser starts Chromium (lib/tools.js ensureBrowser). The AI chooses the pages, and a page may be an
 * attacker's: a bug in Chromium's page renderer must not hand that page the server.
 *
 * - Chromium's own sandbox is on. Playwright adds --no-sandbox unless chromiumSandbox is exactly true, so every
 *   launch asks for it first. On Linux the sandbox needs either user namespaces that a non-root user may create, or
 *   Chromium's setuid helper (root-owned, mode 4755, found through CHROME_DEVEL_SANDBOX). A container whose runtime
 *   blocks both (Docker's default seccomp profile does, for a user without CAP_SYS_ADMIN), or a server running as root,
 *   can't sandbox: then, and only then, the browser starts without it, and the log says so at each such launch.
 *   "Only then" means: the sandboxed launch failed with an error that says the sandbox can't start (SANDBOX_FAILED_RE),
 *   not because the machine ran out of processes, memory or open files, and no sandboxed launch has worked since this
 *   process started. Any other failure (a timeout, Chromium missing, too many processes, a browser that died) keeps
 *   the sandbox and fails the call; the next call tries the sandbox again. So something that can make a launch fail
 *   (today, anything with a shell as the server's user; with AI isolation, the AI's own user, which still shares the
 *   container's process and memory limits) can't use that to get a browser without the sandbox on a machine that has
 *   one.
 *   Tarsee's Docker image runs the server as node, not root, and Playwright's headless Chromium comes with no setuid
 *   helper, so there the sandbox is on wherever the host lets the container create user namespaces, and off (logged)
 *   where it doesn't.
 * - Site isolation is on (--site-per-process): each site's pages and frames get their own renderer process, so a page
 *   that breaks its renderer still can't read another site's data. This used to be turned off, with
 *   --disable-features=IsolateOrigins,site-per-process, as part of the "stealth" settings that came with the captcha
 *   solver. Nothing needed it: Playwright reaches into a cross-site frame (a captcha's) whether or not that frame runs
 *   in its own process, and a real Chrome runs with site isolation on, so having it on looks more like a real browser.
 * - The browser gets a minimal environment (browserEnv): what it needs to start, find its temp folder, fonts, locale
 *   and display, and reach a proxy. None of Tarsee's secrets, provider keys or the rest of the server's environment.
 *   Chromium's page renderers inherit it, so a sandboxed renderer a page broke into finds nothing there. Without the
 *   sandbox it protects nothing: such a renderer runs as the server's user and can read the server's files, and its
 *   environment in /proc, directly.
 * - One browser at a time (makeBrowserSession): calls that arrive together share one launch, and a browser that's
 *   replaced or closed is closed with every pop-up its pages opened.
 */

export const BROWSER_ARGS = Object.freeze([
  // Pages can't tell the browser is automated (navigator.webdriver, with the init script in lib/tools.js).
  "--disable-blink-features=AutomationControlled",
  "--site-per-process",
]);

// The names the browser gets on Linux and macOS: PATH and HOME, the temp folder, the locale and time zone, the display
// (unused while headless, needed if it ever isn't), fonts, where Chromium's setuid sandbox helper is, and where the
// server finds libraries outside the system folders (a machine that keeps Chromium's libraries there can't start it
// without; the server itself already runs with it, so it adds nothing a page could use).
const UNIX_NAMES = new Set([
  "PATH", "HOME", "TMPDIR", "LANG", "LANGUAGE", "TZ",
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
  "FONTCONFIG_PATH", "FONTCONFIG_FILE", "FONTCONFIG_SYSROOT",
  "CHROME_DEVEL_SANDBOX", "LD_LIBRARY_PATH",
]);
const LOCALE_RE = /^LC_[A-Z]+$/;

// On Windows (names compared in capitals there): the system folders, the user's profile and app-data folders, the
// temp folder, and what describes the machine.
const WINDOWS_NAMES = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "HOME",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "TZ", "LANG",
]);

// Chromium on Linux reads its proxy from these (either case). It ignores a user name and password in them, so they are
// taken out: a proxy's password is a credential the browser has no use for.
const PROXY_RE = /^(HTTPS?|ALL)_PROXY$/i;
const NO_PROXY_RE = /^NO_PROXY$/i;

/**
 * A proxy setting without its user name and password: its scheme (if it had one), host and port, and nothing else,
 * since a proxy address has no path, query or fragment. A value with no '@' has no user name or password and goes in
 * as it is. null (the setting stays out) when it has an '@' and can't be taken apart, or its '@' isn't the one before a
 * host (a malformed value such as http:/user:pw@proxy, whose password would otherwise end up in what's left).
 */
function proxyWithoutCredentials(value) {
  if (!value.includes("@")) return value;
  const hasScheme = value.includes("://");
  let url;
  try { url = new URL(hasScheme ? value : `http://${value}`); } catch { return null; }
  if (!url.host || (!url.username && !url.password)) return null;
  const clean = hasScheme ? `${url.protocol}//${url.host}` : url.host;
  return clean.includes("@") ? null : clean;
}

/** The environment the browser gets: the allowed names of `env`, each spelled as it was there. */
export function browserEnv(env = process.env, platform = process.platform) {
  const windows = platform === "win32";
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const key = windows ? name.toUpperCase() : name;
    if (PROXY_RE.test(name)) {
      const clean = proxyWithoutCredentials(value);
      if (clean !== null) out[name] = clean;
    } else if (NO_PROXY_RE.test(name) || (windows ? WINDOWS_NAMES.has(key) : UNIX_NAMES.has(key) || LOCALE_RE.test(key))) {
      out[name] = value;
    }
  }
  return out;
}

/** Playwright's launch options, the sandbox aside. */
export function browserLaunchOptions({ env = process.env, platform = process.platform } = {}) {
  return { headless: true, args: [...BROWSER_ARGS], env: browserEnv(env, platform) };
}

// What a launch error says when Chromium can't start its sandbox on this machine, the only errors after which the
// browser is started without it:
// - Playwright's own words. It puts "Chromium sandboxing failed!" in place of Chromium's log when that says
//   "No usable sandbox!" (no user namespaces and no setuid helper), crbug.com/638180 (run as root) or crbug.com/357670
//   (a setuid helper that isn't root-owned with mode 4755); playwright-core/lib/server/chromium/chromium.js.
// - Those three in Chromium's own words, for a Playwright that passes the log through as it is.
// - The namespace setup failing: credentials.cc and the other sandbox/linux/services files (a seccomp profile or an
//   AppArmor rule that refuses user namespaces), and the setuid helper's "Failed to move to new namespace".
// Every other error says nothing about the sandbox: a launch without it would only repeat it, or drop the sandbox on a
// machine that has it because something else went wrong at that moment.
const SANDBOX_FAILED_RE = /Chromium sandboxing failed!|No usable sandbox!|crbug\.com\/(638180|357670)|Running as root without --no-sandbox|SUID sandbox helper binary|\b(credentials|namespace_sandbox|namespace_utils)\.cc\b|Failed to move to new namespace/i;

// A sandbox failure whose reason is that the machine ran out of something: processes or threads (EAGAIN), memory or
// open files. That machine can sandbox; it was busy, perhaps made so on purpose.
const RAN_OUT_RE = /Resource temporarily unavailable|Cannot allocate memory|Too many open files|Too many processes|\bE(AGAIN|NOMEM|MFILE|NFILE)\b/i;

const lineCut = (line) => (line.length > 300 ? `${line.slice(0, 300)}...` : line);
const linesOf = (err) => String(err?.message || err || "").split("\n").map((l) => l.trim()).filter(Boolean);

/** The lines of a launch error that say the sandbox can't start (none: the error isn't about the sandbox). */
const sandboxLines = (err) => linesOf(err).filter((l) => SANDBOX_FAILED_RE.test(l));

/** The line of a launch error that says why, for the log. */
function reasonOf(err) {
  const lines = linesOf(err);
  return lineCut(lines.find((l) => SANDBOX_FAILED_RE.test(l)) || lines[0] || "no reason given");
}

/**
 * A function that launches the browser with Playwright's `chromium`: with Chromium's sandbox, else, when that launch
 * failed because the sandbox can't start on this machine, without it (see the top of this file). Each launch tries the
 * sandbox first, and each launch without it is logged. Once a sandboxed launch has worked, this function never
 * launches without the sandbox again: a later sandbox failure is thrown (and logged), and the next call tries the
 * sandbox again. env/platform: read at each launch (default the server's own); log: for tests.
 */
export function makeBrowserLauncher({ log = (message) => console.warn(message), env, platform } = {}) {
  let sandboxWorked = false;
  const refuse = (why, err) => {
    const message = `Chromium's sandbox didn't start ${why}, so tarsee_browser doesn't start the browser without it. ` +
      `Try again: each launch tries the sandbox first. Chromium said: ${reasonOf(err)}`;
    log(`[browser] ${message}`);
    return new Error(message, { cause: err });
  };
  return async function launchBrowser(chromium) {
    const options = browserLaunchOptions({ env: env ?? process.env, platform: platform ?? process.platform });
    let browser;
    try {
      browser = await chromium.launch({ ...options, chromiumSandbox: true });
    } catch (err) {
      const said = sandboxLines(err);
      if (said.length === 0) throw err;
      if (sandboxWorked) throw refuse("this time, though it did earlier in this run of Tarsee", err);
      if (said.some((l) => RAN_OUT_RE.test(l))) throw refuse("because the machine ran out of processes, memory or open files", err);
      const unsandboxed = await chromium.launch({ ...options, chromiumSandbox: false });
      log(
        "[browser] Chromium's sandbox couldn't start on this machine, so tarsee_browser runs without it. A web page " +
        "that exploits a bug in Chromium could then act with this server's own rights. To turn the sandbox on, don't " +
        "run Tarsee as root, and let its user create user namespaces (in Docker, with a seccomp profile that allows " +
        "them), or install Chromium's setuid sandbox helper and set CHROME_DEVEL_SANDBOX to its path. " +
        `Chromium said: ${reasonOf(err)}`,
      );
      return unsandboxed;
    }
    sandboxWorked = true;
    return browser;
  };
}

/** The server's launcher (lib/tools.js), one for the whole process: "earlier in this run" means since Tarsee started. */
export const launchBrowser = makeBrowserLauncher();

/**
 * The one browser tarsee_browser drives (lib/tools.js ensureBrowser). launch() starts a browser; openPage(browser)
 * sets up the page the tool works in.
 * - page(): the open page, else a new browser's. Calls that arrive while a launch is under way wait for that launch,
 *   so there is never more than one browser. A failed launch fails each of them, and the next call tries again.
 * - The browser being replaced (its page closed, or it crashed or disconnected) is closed first, with every pop-up and
 *   page it still has; so is a new browser whose page couldn't be set up. Nothing a page opened outlives its browser.
 * - close(): waits for a launch under way, then closes the browser; the next page() launches a new one.
 */
export function makeBrowserSession({ launch, openPage }) {
  let browser = null;
  let page = null;
  let starting = null;

  const shut = async (b) => { try { await b?.close(); } catch { /* it was already gone */ } };

  async function start() {
    const old = browser;
    browser = null;
    page = null;
    await shut(old);
    const next = await launch();
    let opened;
    try {
      opened = await openPage(next);
    } catch (err) {
      await shut(next);
      throw err;
    }
    browser = next;
    page = opened;
    return opened;
  }

  return {
    page() {
      if (page && !page.isClosed() && browser.isConnected()) return Promise.resolve(page);
      starting ??= start().finally(() => { starting = null; });
      return starting;
    },
    async close() {
      try { await starting; } catch { /* nothing launched */ }
      const b = browser;
      browser = null;
      page = null;
      await b?.close();
    },
  };
}
