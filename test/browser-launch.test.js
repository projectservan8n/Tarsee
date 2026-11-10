// How tarsee_browser starts Chromium (src/lib/browser-launch.js). The AI picks the pages, and a page may be an
// attacker's, so:
//   - the first launch has Chromium's sandbox on (no --no-sandbox) and site isolation on
//   - the browser gets a minimal environment: none of Tarsee's secrets, provider keys or other credentials
//   - the launch without the sandbox happens only when the sandboxed one fails with an error that says the sandbox
//     can't start, never once a sandboxed launch has worked in this process, and each one is logged
//   - there is one browser at a time: calls at once share one launch, and a browser that's replaced goes, pop-ups and all
// Playwright's launcher is faked for those. Then a real Chromium (Playwright's own, else an installed Chrome or Edge;
// skipped where there is none) is started the same way, to check what it really runs with.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_ARGS, browserEnv, browserLaunchOptions, makeBrowserLauncher, makeBrowserSession } from "../src/lib/browser-launch.js";
import { TARSEE_SECRETS, PROVIDER_KEY_NAMES } from "../src/ai/engine-env.js";

// Every value here is an obvious fake.
const canary = (name) => `sk-test-canary-${name}`;
const SECRET_NAMES = [
  ...TARSEE_SECRETS, ...PROVIDER_KEY_NAMES,
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "TARSEE_MCP_TOKEN", "TARSEE_PROVIDER_KEY",
  "RAILWAY_TOKEN", "RAILWAY_API_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "TELEGRAM_BOT_TOKEN",
  "DISCORD_TOKEN", "SLACK_BOT_TOKEN", "SMTP_PASS", "RESEND_API_KEY", "CAPTCHA_API_KEY", "SOME_SERVICE_SECRET",
  // not secrets, but they change how a program starts, and the browser has no use for them
  "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "TARSEE_DATA_DIR", "PLAYWRIGHT_BROWSERS_PATH",
];
const secretEnv = () => Object.fromEntries(SECRET_NAMES.map((n) => [n, canary(n)]));

const LINUX = {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/node", TMPDIR: "/tmp", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC",
  DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", XDG_CACHE_HOME: "/home/node/.cache",
  FONTCONFIG_PATH: "/etc/fonts", FONTCONFIG_FILE: "/etc/fonts/fonts.conf", CHROME_DEVEL_SANDBOX: "/usr/local/sbin/chrome-devel-sandbox",
  // Where the server finds libraries outside the system folders; Chromium can't start without its own there.
  LD_LIBRARY_PATH: "/opt/browser-libs/usr/lib/x86_64-linux-gnu",
};
// Windows names come in any case (process.env there is case-insensitive); the browser gets each as it was spelled.
const WINDOWS = {
  Path: "C:\\Windows\\system32;C:\\Windows", PATHEXT: ".COM;.EXE;.BAT", SystemRoot: "C:\\Windows", windir: "C:\\Windows",
  SystemDrive: "C:", TEMP: "C:\\Users\\someone\\AppData\\Local\\Temp", TMP: "C:\\Users\\someone\\AppData\\Local\\Temp",
  USERPROFILE: "C:\\Users\\someone", LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local", APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
  ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ComSpec: "C:\\Windows\\system32\\cmd.exe", NUMBER_OF_PROCESSORS: "8", PROCESSOR_ARCHITECTURE: "AMD64", OS: "Windows_NT",
};

const SITE_ISOLATION_OFF = /^--disable-features=.*(IsolateOrigins|site-per-process|SitePerProcess)/i;

/** A stand-in for Playwright's `chromium`: records each launch's options; `results` says what each launch does. */
function fakeChromium(...results) {
  const calls = [];
  return {
    calls,
    async launch(options) {
      calls.push(structuredClone(options));
      const next = results[Math.min(calls.length, results.length) - 1] ?? "ok";
      if (next instanceof Error) throw next;
      return { fake: "browser", sandboxed: options.chromiumSandbox === true };
    },
  };
}

// What Playwright's error says when Chromium can't start its sandbox (a container without user namespaces).
const sandboxError = () => new Error([
  "browserType.launch: Target page, context or browser has been closed",
  "Browser logs:",
  "",
  "Chromium sandboxing failed!",
  "================================",
  "To avoid the sandboxing issue, do either of the following:",
  "  - (preferred): Configure your environment to support sandboxing",
  "  - (alternative): Launch Chromium without sandbox using 'chromiumSandbox: false' option",
  "================================",
].join("\n"));

describe("tarsee_browser's launch: the sandbox and site isolation", () => {
  it("the first launch asks for Chromium's sandbox, with no --no-sandbox", async () => {
    const chromium = fakeChromium();
    const logs = [];
    const browser = await makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" })(chromium);
    assert.equal(browser.sandboxed, true);
    assert.equal(chromium.calls.length, 1, "one launch: the sandboxed one worked");
    const [first] = chromium.calls;
    // Playwright adds --no-sandbox itself unless chromiumSandbox is exactly true.
    assert.equal(first.chromiumSandbox, true);
    assert.ok(!first.args.includes("--no-sandbox"), "no --no-sandbox of our own either");
    assert.equal(first.headless, true);
    assert.deepEqual(logs, [], "nothing to report when the sandbox works");
  });

  it("site isolation is on: asked for, and never turned off", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const { args } = browserLaunchOptions({ env: {}, platform });
      assert.ok(args.includes("--site-per-process"), `${platform}: --site-per-process`);
      assert.equal(args.filter((a) => SITE_ISOLATION_OFF.test(a)).length, 0, `${platform}: nothing turns site isolation off`);
      assert.ok(!args.includes("--disable-site-isolation-trials"), `${platform}: no --disable-site-isolation-trials`);
      assert.ok(!args.includes("--no-sandbox"), `${platform}: no --no-sandbox`);
    }
    assert.ok(BROWSER_ARGS.includes("--disable-blink-features=AutomationControlled"), "pages still don't see an automated browser");
    assert.ok(Object.isFrozen(BROWSER_ARGS));
  });

  it("lib/tools.js starts the browser only through browser-launch.js, with no flags of its own", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("../src/lib/tools.js", import.meta.url)), "utf8");
    // assert.ok, not assert.match: a failure would print all of tools.js.
    assert.ok(/import\(["']\.\/browser-launch\.js["']\)/.test(src), "ensureBrowser imports browser-launch.js");
    assert.ok(/await launchBrowser\(chromium\)/.test(src), "and launches with it");
    assert.ok(/makeBrowserSession\(/.test(src), "through one browser session");
    assert.ok(!/chromium\.launch\(/.test(src), "no launch of its own");
    assert.ok(!/browserInstance|browserPage\b/.test(src), "and no browser or page of its own beside the session's");
    const flags = src.match(/--no-sandbox|IsolateOrigins|site-per-process|chromiumSandbox/g);
    assert.equal(flags, null, "no sandbox or site-isolation flags of its own");
  });
});

describe("tarsee_browser's launch: the browser's environment", () => {
  it("Linux: PATH, HOME, temp, locale, display and font variables, and nothing else", () => {
    const env = browserEnv({ ...LINUX, ...secretEnv(), USER: "node", SHELL: "/bin/bash", PWD: "/app" }, "linux");
    assert.deepEqual(env, LINUX);
  });

  it("macOS: the same names", () => {
    const env = browserEnv({ ...LINUX, ...secretEnv() }, "darwin");
    assert.deepEqual(env, LINUX);
  });

  it("Windows: what Chromium needs to start there, in any case, and nothing else", () => {
    const env = browserEnv({ ...WINDOWS, ...secretEnv(), ...Object.fromEntries(SECRET_NAMES.map((n) => [n.toLowerCase(), canary(n)])) }, "win32");
    assert.deepEqual(env, WINDOWS);
  });

  it("no secret reaches the browser, by name or by value, on any platform", async () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const chromium = fakeChromium();
      await makeBrowserLauncher({ log: () => {}, env: { ...LINUX, ...WINDOWS, ...secretEnv() }, platform })(chromium);
      const passed = chromium.calls[0].env;
      assert.ok(passed && typeof passed === "object", `${platform}: an environment is passed, so Playwright doesn't hand over the server's own`);
      for (const name of SECRET_NAMES) assert.ok(!(name in passed), `${platform}: ${name} stays out`);
      assert.ok(!Object.values(passed).some((v) => String(v).includes("canary")), `${platform}: no secret value`);
    }
  });

  it("the server's own environment is the default source, and its secrets stay out", () => {
    const name = "TARSEE_BROWSER_LAUNCH_TEST_SECRET";
    process.env[name] = canary(name);
    try {
      const env = browserLaunchOptions().env;
      assert.ok(!(name in env));
      assert.ok(Object.keys(env).some((k) => k.toUpperCase() === "PATH"), "PATH comes from the server's environment");
    } finally {
      delete process.env[name];
    }
  });

  it("a proxy setting goes in without its user name and password", () => {
    const env = browserEnv({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxyuser:proxy-password-canary@proxy.example:3128",
      http_proxy: "http://proxy.example:3128",
      ALL_PROXY: "socks5://someone:pw-canary@proxy.example:1080/",
      NO_PROXY: "localhost,127.0.0.1,.internal.example",
      FTP_PROXY: "http://proxy.example:21",
    }, "linux");
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.example:3128",
      http_proxy: "http://proxy.example:3128",
      ALL_PROXY: "socks5://proxy.example:1080",
      NO_PROXY: "localhost,127.0.0.1,.internal.example",
    });
  });

  it("a proxy setting with a password it can't take apart stays out", () => {
    const env = browserEnv({ PATH: "/usr/bin", HTTPS_PROXY: "not a url:pw-canary@[proxy" }, "linux");
    assert.deepEqual(env, { PATH: "/usr/bin" });
  });

  it("a proxy setting goes in without any path, query or fragment, and without a scheme it had none", () => {
    const env = browserEnv({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://someone:pw-canary@proxy.example:3128/some/path?q=pw-canary#pw-canary",
      HTTP_PROXY: "someone:pw-canary@proxy.example:3128",
      ALL_PROXY: "socks5h://:pw-canary@[2001:db8::1]:1080",
    }, "linux");
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.example:3128",
      HTTP_PROXY: "proxy.example:3128",
      ALL_PROXY: "socks5h://[2001:db8::1]:1080",
    });
  });

  it("a malformed proxy setting whose '@' isn't a user name's stays out, password and all", () => {
    for (const value of [
      "http:/user:pw-canary@proxy.example:3128", // one slash
      "http:\\\\user:pw-canary@proxy.example:3128", // backslashes
      "http://proxy.example:3128/user:pw-canary@", // the password in the path
      "http://proxy.example:3128?user:pw-canary@x", // in the query
      "http://proxy.example:3128#user:pw-canary@x", // in the fragment
      "http://@proxy.example:3128", // an '@' with nothing before it
    ]) {
      const env = browserEnv({ PATH: "/usr/bin", HTTPS_PROXY: value, http_proxy: value }, "linux");
      assert.deepEqual(env, { PATH: "/usr/bin" }, value);
    }
  });

  it("only text values go in", () => {
    const env = browserEnv({ PATH: "/usr/bin", HOME: undefined, TMPDIR: 7 }, "linux");
    assert.deepEqual(env, { PATH: "/usr/bin" });
  });
});

describe("tarsee_browser's launch: without the sandbox only when the sandboxed launch fails", () => {
  it("a failed sandboxed launch is followed by one without, which is logged in plain words", async () => {
    const chromium = fakeChromium(sandboxError(), "ok");
    const logs = [];
    const browser = await makeBrowserLauncher({ log: (m) => logs.push(m), env: { ...LINUX, ...secretEnv() }, platform: "linux" })(chromium);
    assert.equal(browser.sandboxed, false);
    assert.equal(chromium.calls.length, 2);
    const [first, second] = chromium.calls;
    assert.equal(first.chromiumSandbox, true);
    assert.equal(second.chromiumSandbox, false);
    assert.deepEqual(second.args, first.args, "the same flags otherwise: site isolation stays on");
    assert.deepEqual(second.env, first.env, "and the same minimal environment");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /sandbox/i);
    assert.match(logs[0], /without/i, "it says the browser runs without the sandbox");
    assert.match(logs[0], /Chromium sandboxing failed!/, "with Chromium's own reason");
    assert.doesNotMatch(logs[0], /canary/);
  });

  it("every launch without the sandbox is logged, not just the first", async () => {
    const chromium = fakeChromium(sandboxError(), "ok", sandboxError(), "ok", sandboxError(), "ok");
    const logs = [];
    const launch = makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" });
    for (let i = 0; i < 3; i++) assert.equal((await launch(chromium)).sandboxed, false);
    assert.equal(chromium.calls.length, 6, "each launch tries the sandbox first again");
    assert.deepEqual(chromium.calls.map((c) => c.chromiumSandbox), [true, false, true, false, true, false]);
    assert.equal(logs.length, 3);
    for (const line of logs) assert.match(line, /sandbox couldn't start/);
  });

  it("Chromium's own words for a sandbox it can't start lead to the launch without, each of them", async () => {
    for (const message of [
      // What Chromium says when Playwright passes its log through as it is.
      "[FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.",
      "[FATAL:zygote_host_impl_linux.cc(132)] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.",
      "[FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /opt/chrome/chrome-sandbox is owned by root and has mode 4755. See crbug.com/357670.",
      // The namespace setup failing, as under Docker's default seccomp profile or an AppArmor rule against user namespaces.
      "[FATAL:credentials.cc(127)] Check failed: . : Permission denied (13)",
      "Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
    ]) {
      const err = new Error(`browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n${message}`);
      const chromium = fakeChromium(err, "ok");
      const logs = [];
      const browser = await makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" })(chromium);
      assert.equal(browser.sandboxed, false, message);
      assert.deepEqual(chromium.calls.map((c) => c.chromiumSandbox), [true, false], message);
      assert.equal(logs.length, 1, message);
      assert.ok(logs[0].includes(message.slice(0, 60)), `the log gives Chromium's reason: ${message}`);
    }
  });

  it("a failure that doesn't name the sandbox is no reason to drop it: that error, no launch without, nothing logged", async () => {
    for (const message of [
      "browserType.launch: spawn EAGAIN",
      "browserType.launch: Target page, context or browser has been closed",
      "browserType.launch: Failed to launch the browser process.\nBrowser logs:\n\n[ERROR:platform_shared_memory_region_posix.cc(217)] Creating shared memory failed: No space left on device (28)",
      "browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n<launching> /opt/chrome/chrome --headless --enable-sandbox-logging",
    ]) {
      const err = new Error(message);
      const chromium = fakeChromium(err, "ok");
      const logs = [];
      await assert.rejects(makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" })(chromium), (e) => e === err, message);
      assert.equal(chromium.calls.length, 1, `${message}: no launch without the sandbox`);
      assert.deepEqual(logs, [], message);
    }
  });

  it("the reviewer's first sequence: the sandbox works, then a launch fails with spawn EAGAIN: no launch without", async () => {
    const eagain = new Error("browserType.launch: spawn EAGAIN");
    const chromium = fakeChromium("ok", eagain, "ok");
    const logs = [];
    const launch = makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" });
    assert.equal((await launch(chromium)).sandboxed, true);
    await assert.rejects(launch(chromium), (e) => e === eagain);
    assert.deepEqual(chromium.calls.map((c) => c.chromiumSandbox), [true, true], "nothing launched without the sandbox");
    assert.deepEqual(logs, [], "and nothing says the sandbox couldn't start");
    assert.equal((await launch(chromium)).sandboxed, true, "the next call tries the sandbox again");
  });

  it("the reviewer's second sequence: once the sandbox has worked, a closed-browser failure never leads to a launch without", async () => {
    const closed = new Error("browserType.launch: Target page, context or browser has been closed");
    const chromium = fakeChromium(sandboxError(), "ok", "ok", closed, "ok");
    const logs = [];
    const launch = makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" });
    assert.equal((await launch(chromium)).sandboxed, false, "no sandbox yet: the launch without, logged");
    assert.equal((await launch(chromium)).sandboxed, true, "the sandbox works now");
    await assert.rejects(launch(chromium), (e) => e === closed);
    assert.equal((await launch(chromium)).sandboxed, true, "and the next call has it again");
    assert.deepEqual(chromium.calls.map((c) => c.chromiumSandbox), [true, false, true, true, true]);
    assert.equal(logs.length, 1, "only the one launch without the sandbox is logged");
  });

  it("once a sandboxed launch has worked in this process, even a sandbox failure is thrown, not worked around", async () => {
    const chromium = fakeChromium("ok", sandboxError(), "ok");
    const logs = [];
    const launch = makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" });
    assert.equal((await launch(chromium)).sandboxed, true);
    await assert.rejects(launch(chromium), (e) => {
      assert.match(e.message, /sandbox/i);
      assert.match(e.message, /earlier/, "it says the sandbox worked before");
      assert.match(e.message, /Chromium sandboxing failed!/, "with Chromium's reason");
      assert.ok(e.cause instanceof Error, "and Playwright's error as the cause");
      return true;
    });
    assert.deepEqual(chromium.calls.map((c) => c.chromiumSandbox), [true, true], "nothing launched without the sandbox");
    assert.equal(logs.length, 1, "the refusal is logged");
    assert.match(logs[0], /earlier/);
    assert.doesNotMatch(logs[0], /runs without it/);
    assert.equal((await launch(chromium)).sandboxed, true, "the next call tries the sandbox again, and has it");
    assert.equal(chromium.calls.length, 3);
  });

  it("a sandbox that failed because the machine ran out of processes, memory or files isn't dropped", async () => {
    for (const reason of [
      "[FATAL:credentials.cc(127)] Check failed: . : Resource temporarily unavailable (11)",
      "Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Cannot allocate memory",
      "[FATAL:credentials.cc(127)] Check failed: . : Too many open files (24)",
    ]) {
      const chromium = fakeChromium(new Error(`browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n${reason}`), "ok");
      const logs = [];
      await assert.rejects(makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" })(chromium), (e) => {
        assert.match(e.message, /ran out/, reason);
        assert.ok(e.message.includes(reason), `${reason}: Chromium's reason is given`);
        return true;
      });
      assert.equal(chromium.calls.length, 1, `${reason}: no launch without the sandbox`);
      assert.equal(logs.length, 1, reason);
    }
  });

  it("a launch with the sandbox after one without needs no fallback and logs nothing", async () => {
    const chromium = fakeChromium(sandboxError(), "ok", "ok");
    const logs = [];
    const launch = makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" });
    assert.equal((await launch(chromium)).sandboxed, false);
    assert.equal((await launch(chromium)).sandboxed, true);
    assert.equal(chromium.calls.length, 3);
    assert.equal(logs.length, 1);
  });

  it("no fallback when Chromium isn't installed: that error, as it was", async () => {
    const missing = new Error("browserType.launch: Executable doesn't exist at /home/node/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell");
    const chromium = fakeChromium(missing, "ok");
    const logs = [];
    await assert.rejects(makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" })(chromium), (err) => err === missing);
    assert.equal(chromium.calls.length, 1);
    assert.deepEqual(logs, []);
  });

  it("no fallback when the machine lacks Chromium's libraries or a channel isn't installed", async () => {
    for (const message of [
      "browserType.launch: Host system is missing dependencies to run browsers.",
      "browserType.launch: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    ]) {
      const chromium = fakeChromium(new Error(message), "ok");
      await assert.rejects(makeBrowserLauncher({ log: () => assert.fail("nothing to log"), env: LINUX, platform: "linux" })(chromium), { message });
      assert.equal(chromium.calls.length, 1, message);
    }
  });

  it("no fallback when the sandboxed launch only ran out of time: a slow machine isn't one that can't sandbox", async () => {
    const timeout = new Error([
      "browserType.launch: Timeout 180000ms exceeded.",
      "Call log:",
      "  - <launching> /home/node/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell --headless",
    ].join("\n"));
    const chromium = fakeChromium(timeout, "ok");
    const logs = [];
    await assert.rejects(makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" })(chromium), (err) => err === timeout);
    assert.equal(chromium.calls.length, 1, "no launch without the sandbox");
    assert.deepEqual(logs, []);
  });

  it("when the launch without the sandbox fails too, its error comes back and nothing claims the browser runs", async () => {
    const second = new Error("browserType.launch: Timeout 180000ms exceeded.");
    const chromium = fakeChromium(sandboxError(), second);
    const logs = [];
    await assert.rejects(makeBrowserLauncher({ log: (m) => logs.push(m), env: LINUX, platform: "linux" })(chromium), (err) => err === second);
    assert.equal(chromium.calls.length, 2);
    assert.deepEqual(logs, []);
  });
});

// --- One browser at a time ------------------------------------------------------------------------------------------

/** A stand-in for a Playwright browser: its pages (the tool's, and any pop-up a page opened) close with it. */
function fakeBrowser(id) {
  const browser = {
    id,
    connected: true,
    closeCalls: 0,
    pages: [],
    isConnected: () => browser.connected,
    async close() {
      browser.closeCalls++;
      browser.connected = false;
      for (const p of browser.pages) p.closed = true;
    },
    async newContext() {
      return {
        async newPage() {
          const page = {
            browser, closed: false,
            isClosed: () => page.closed,
            async addInitScript() {},
            async textContent() { return `the page of browser ${id}`; },
          };
          browser.pages.push(page);
          return page;
        },
      };
    },
    /** What a page's window.open() leaves behind: another page of the same browser. */
    popUp() {
      const popup = { browser, closed: false, isClosed: () => popup.closed };
      browser.pages.push(popup);
      return popup;
    },
  };
  return browser;
}

/** Launches that wait, while held, for releaseAll(), so calls can arrive while one is under way. Held at first. */
function gatedLaunches({ fail = [] } = {}) {
  const browsers = [];
  let open;
  let gate;
  const hold = () => { gate = new Promise((resolve) => { open = resolve; }); };
  hold();
  return {
    browsers,
    hold,
    releaseAll() { open(); gate = null; },
    async launch() {
      const n = browsers.length + 1;
      browsers.push(null);
      if (gate) await gate;
      if (fail.includes(n)) throw new Error(`launch ${n} failed`);
      const b = fakeBrowser(n);
      browsers[n - 1] = b;
      return b;
    },
  };
}

const openPage = async (browser) => (await browser.newContext()).newPage();

describe("tarsee_browser's one browser at a time (makeBrowserSession)", () => {
  it("two calls at once share one launch, and get the same page", async () => {
    const launches = gatedLaunches();
    const session = makeBrowserSession({ launch: launches.launch, openPage });
    const both = Promise.all([session.page(), session.page()]);
    await new Promise((resolve) => setImmediate(resolve));
    const third = session.page(); // and one more while the launch is still under way
    launches.releaseAll();
    const [a, b] = await both;
    assert.equal(a, b);
    assert.equal(await third, a);
    assert.equal(launches.browsers.length, 1, "one launch");
    assert.equal(await session.page(), a, "a page that's open is used as it is");
    assert.equal(launches.browsers.length, 1);
  });

  it("replacing the browser closes the old one first, with every pop-up its pages opened", async () => {
    const launches = gatedLaunches();
    launches.releaseAll();
    const session = makeBrowserSession({ launch: launches.launch, openPage });
    const first = await session.page();
    const popup = first.browser.popUp();
    first.closed = true; // the tool's page is gone; the pop-up isn't
    const second = await session.page();
    assert.notEqual(second, first);
    assert.equal(launches.browsers.length, 2);
    assert.equal(first.browser.closeCalls, 1, "the old browser is closed");
    assert.equal(popup.isClosed(), true, "and its pop-up with it");
    assert.equal(second.browser.connected, true);
  });

  it("a browser that crashed or disconnected is replaced, and closed", async () => {
    const launches = gatedLaunches();
    launches.releaseAll();
    const session = makeBrowserSession({ launch: launches.launch, openPage });
    const first = await session.page();
    first.browser.connected = false;
    const second = await session.page();
    assert.notEqual(second.browser, first.browser);
    assert.equal(first.browser.closeCalls, 1);
  });

  it("two calls at once after the page closed share the one replacement, and the old browser is closed once", async () => {
    const launches = gatedLaunches();
    launches.releaseAll();
    const session = makeBrowserSession({ launch: launches.launch, openPage });
    const first = await session.page();
    first.closed = true;
    launches.hold();
    const both = Promise.all([session.page(), session.page()]);
    await new Promise((resolve) => setImmediate(resolve));
    launches.releaseAll();
    const [a, b] = await both;
    assert.equal(a, b);
    assert.equal(launches.browsers.length, 2);
    assert.equal(first.browser.closeCalls, 1);
  });

  it("a browser whose page can't be set up is closed, and the next call launches again", async () => {
    const launches = gatedLaunches();
    launches.releaseAll();
    let fail = true;
    const session = makeBrowserSession({
      launch: launches.launch,
      openPage: async (browser) => {
        if (fail) throw new Error("newContext failed");
        return openPage(browser);
      },
    });
    await assert.rejects(session.page(), /newContext failed/);
    assert.equal(launches.browsers[0].closeCalls, 1, "not left running");
    fail = false;
    const page = await session.page();
    assert.equal(page.browser.id, 2);
  });

  it("a failed launch fails every call waiting for it, and the next call tries again", async () => {
    const launches = gatedLaunches({ fail: [1] });
    const session = makeBrowserSession({ launch: launches.launch, openPage });
    const both = Promise.allSettled([session.page(), session.page()]);
    await new Promise((resolve) => setImmediate(resolve));
    launches.releaseAll();
    const results = await both;
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
    assert.equal(launches.browsers.length, 1, "one launch for both");
    assert.equal((await session.page()).browser.id, 2);
  });

  it("close() closes the browser, pop-ups and all; the next call launches a new one", async () => {
    const launches = gatedLaunches();
    launches.releaseAll();
    const session = makeBrowserSession({ launch: launches.launch, openPage });
    const first = await session.page();
    const popup = first.browser.popUp();
    await session.close();
    assert.equal(first.browser.closeCalls, 1);
    assert.equal(popup.isClosed(), true);
    await session.close(); // nothing to close
    assert.equal(first.browser.closeCalls, 1);
    assert.equal((await session.page()).browser.id, 2);
  });

  it("close() during a launch closes the browser that launch brings", async () => {
    const launches = gatedLaunches();
    const session = makeBrowserSession({ launch: launches.launch, openPage });
    const pending = session.page();
    await new Promise((resolve) => setImmediate(resolve));
    const closing = session.close();
    launches.releaseAll();
    const page = await pending;
    await closing;
    assert.equal(page.browser.closeCalls, 1, "not left running after the close");
    assert.equal((await session.page()).browser.id, 2, "the next call launches a new one");
  });
});

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  playwright = null;
}

describe("tarsee_browser's one browser: lib/tools.js goes through the session", { skip: playwright ? false : "no Playwright" }, () => {
  // tools.js loads its settings at import: a temporary home for them. Playwright's chromium.launch is replaced with
  // a fake for these, so they run with or without a browser installed.
  let tmp;
  let chromium;
  let launches;
  let executeTool;
  const quiet = { warn: console.warn };
  const ctx = {};

  after(async () => {
    await executeTool?.("browser", { action: "close" }, ctx);
    if (chromium) delete chromium.launch;
    console.warn = quiet.warn;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("calls at once share one launch; a replaced browser and the close action close it", async () => {
    ({ chromium } = playwright);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-browser-launch-"));
    process.env.TARSEE_STATE_DIR = tmp;
    process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
    process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
    console.warn = () => {};
    ({ executeTool } = await import("../src/lib/tools.js"));
    launches = gatedLaunches();
    chromium.launch = async (options) => {
      assert.equal(options.chromiumSandbox, true, "the sandbox, through browser-launch.js");
      return launches.launch();
    };

    const both = Promise.all([
      executeTool("browser", { action: "get_text" }, ctx),
      executeTool("browser", { action: "get_text" }, ctx),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    launches.releaseAll();
    assert.deepEqual(await both, ["the page of browser 1", "the page of browser 1"]);
    assert.equal(launches.browsers.length, 1, "one launch for both");

    const [first] = launches.browsers;
    const popup = first.popUp();
    first.pages[0].closed = true;
    assert.equal(await executeTool("browser", { action: "get_text" }, ctx), "the page of browser 2");
    assert.equal(first.closeCalls, 1, "the replaced browser is closed");
    assert.equal(popup.isClosed(), true, "and the pop-up its page opened with it");

    assert.equal(await executeTool("browser", { action: "close" }, ctx), "Browser closed.");
    assert.equal(launches.browsers[1].closeCalls, 1);
    assert.equal(await executeTool("browser", { action: "get_text" }, ctx), "the page of browser 3");
  });
});

// --- A real Chromium ------------------------------------------------------------------------------------------------

let realChromium = null;
// Playwright's own launch: the tools.js suite above puts a fake in its place while it runs.
const realLaunch = playwright?.chromium.launch.bind(playwright.chromium);
for (const channel of playwright ? [undefined, "chrome", "msedge"] : []) {
  try {
    await (await realLaunch({ channel })).close();
    realChromium = { launch: (options) => realLaunch({ ...options, channel }) };
    break;
  } catch { /* the next one */ }
}
const skip = realChromium ? false : "no Chromium, Chrome or Edge for Playwright";

describe("tarsee_browser's launch in a real Chromium", { skip }, () => {
  let server;
  let browser;
  const logs = [];
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url.startsWith("/frame")) return res.end("<p>inside the frame</p>");
      res.end(`<iframe src="http://localhost:${server.address().port}/frame"></iframe>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  it("runs sandboxed where it can (or says it can't), with site isolation on, under the minimal environment", async () => {
    browser =await makeBrowserLauncher({ log: (m) => logs.push(m), env: { ...process.env, ...secretEnv() } })(realChromium);

    const cdp = await browser.newBrowserCDPSession();
    const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
    if (logs.length === 0) assert.ok(!args.includes("--no-sandbox"), "the sandbox is on");
    else assert.ok(args.includes("--no-sandbox") && logs.length === 1, "it runs without the sandbox only after saying so");
    assert.ok(args.includes("--site-per-process"), "site isolation asked for");
    assert.equal(args.filter((a) => SITE_ISOLATION_OFF.test(a)).length, 0, "and not turned off");

    // A cross-site frame (127.0.0.1 and localhost are different sites) runs in a process of its own, and Playwright
    // still reaches into it.
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const frame = page.frames().find((f) => f.url().includes("/frame"));
    assert.ok(frame, "the frame loaded");
    assert.equal(await frame.textContent("p"), "inside the frame");
    const { targetInfos } = await cdp.send("Target.getTargets");
    assert.ok(targetInfos.some((t) => t.type === "iframe" && t.url.includes("localhost")), "the cross-site frame is out of process");
  });

  it("a browser that's replaced goes with the pop-ups its page opened", async () => {
    const launch = makeBrowserLauncher({ log: () => {} });
    const session = makeBrowserSession({ launch: () => launch(realChromium), openPage });
    try {
      const first = await session.page();
      await first.goto(`http://127.0.0.1:${server.address().port}/`);
      const [popup] = await Promise.all([
        first.waitForEvent("popup"),
        first.evaluate((url) => { globalThis.open(url); }, `http://localhost:${server.address().port}/frame`),
      ]);
      await popup.waitForLoadState();
      const old = first.context().browser();
      await first.close();
      assert.equal(popup.isClosed(), false, "the page is gone and its pop-up still runs");
      const second = await session.page();
      assert.notEqual(second.context().browser(), old);
      assert.equal(old.isConnected(), false, "the old browser is closed");
      assert.equal(popup.isClosed(), true, "and the pop-up with it");
    } finally {
      await session.close();
    }
  });
});
