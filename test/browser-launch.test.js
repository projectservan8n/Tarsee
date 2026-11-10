// How tarsee_browser starts Chromium (src/lib/browser-launch.js). The AI picks the pages, and a page may be an
// attacker's, so:
//   - the first launch has Chromium's sandbox on (no --no-sandbox) and site isolation on
//   - the browser gets a minimal environment: none of Tarsee's secrets, provider keys or other credentials
//   - the launch without the sandbox happens only when the sandboxed one fails with an error that says the sandbox
//     can't start, never once a sandboxed launch has worked in this process, and each one is logged
//   - TARSEE_BROWSER_SANDBOX: "auto" (the default) allows that launch; "required" (or any other value) never does, and
//     the browser tool says why and what the owner can do. The first launch logs which is in force; it's read just then
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

// Chromium's own words when it finds no sandbox it can use (no user namespaces, no setuid helper), as a Playwright that
// passes the log through gives them. A full user-namespace count (ENOSPC) gives the same bare words, though the machine
// can sandbox: nothing in them tells the two apart.
const NO_USABLE_SANDBOX = "[FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.";
const noUsableSandbox = () => new Error(`browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n${NO_USABLE_SANDBOX}`);

// Every way Chromium says, in its own words, that its sandbox can't start on this machine.
const CHROMIUM_SANDBOX_WORDS = [
  NO_USABLE_SANDBOX,
  "[FATAL:zygote_host_impl_linux.cc(132)] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.",
  "[FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /opt/chrome/chrome-sandbox is owned by root and has mode 4755. See crbug.com/357670.",
  // The namespace setup failing, as under Docker's default seccomp profile or an AppArmor rule against user namespaces.
  "[FATAL:credentials.cc(127)] Check failed: . : Permission denied (13)",
  "Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
];

// The line the first launch logs to say which TARSEE_BROWSER_SANDBOX mode is in force. logInto(logs, modes) keeps
// those apart from the launcher's other lines.
const MODE_LINE = /^\[browser\] TARSEE_BROWSER_SANDBOX is /;
const logInto = (logs, modes = []) => (m) => (MODE_LINE.test(m) ? modes : logs).push(m);

describe("tarsee_browser's launch: the sandbox and site isolation", () => {
  it("the first launch asks for Chromium's sandbox, with no --no-sandbox", async () => {
    const chromium = fakeChromium();
    const logs = [];
    const browser = await makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" })(chromium);
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

  it("a proxy setting with no user name goes in without its path, query or fragment too", () => {
    const env = browserEnv({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.example:3128/pw-canary",
      https_proxy: "http://proxy.example:3128/?token=pw-canary",
      HTTP_PROXY: "http://proxy.example:3128#pw-canary",
      http_proxy: "proxy.example:3128/pw-canary?token=pw-canary#pw-canary",
      ALL_PROXY: "socks5://proxy.example:1080/pw-canary",
      // The user name and password percent-encoded into what would be the host: no host at all, so it stays out.
      all_proxy: "http://u%3Apw-canary%40proxy.example:3128",
    }, "linux");
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.example:3128",
      https_proxy: "http://proxy.example:3128",
      HTTP_PROXY: "http://proxy.example:3128",
      http_proxy: "proxy.example:3128",
      ALL_PROXY: "socks5://proxy.example:1080",
    });
  });

  it("a proxy's port goes in as it was written, even the scheme's own default", () => {
    // Chromium reads the proxy from these without the scheme, as an http proxy (port 80 when none is given), so
    // https://proxy:443 has to keep its 443.
    for (const [value, expected] of [
      ["https://proxy.example:443", "https://proxy.example:443"],
      ["http://proxy.example:80", "http://proxy.example:80"],
      ["http://proxy.example:0080/", "http://proxy.example:80"],
      ["https://someone:pw-canary@proxy.example:443/", "https://proxy.example:443"],
      ["https://proxy.example", "https://proxy.example"],
      ["http://proxy.example/", "http://proxy.example"],
      ["proxy.example:80", "proxy.example:80"],
      ["proxy.example", "proxy.example"],
      ["socks5://proxy.example", "socks5://proxy.example"],
      ["socks5://proxy.example:1080", "socks5://proxy.example:1080"],
      ["HTTP://Proxy.Example:3128", "http://proxy.example:3128"],
      ["http://[2001:db8::1]:3128", "http://[2001:db8::1]:3128"],
    ]) {
      assert.deepEqual(browserEnv({ HTTPS_PROXY: value }, "linux"), { HTTPS_PROXY: expected }, value);
    }
  });

  it("a proxy setting that doesn't read as a proxy's address stays out", () => {
    for (const value of [
      "", "   ", "not a proxy", "http://", "http://proxy.example:99999", "http://proxy.example:3128:3128",
      // not a proxy's scheme
      "ws://proxy.example:3128", "ftp://proxy.example:21", "file:///etc/passwd", "javascript://proxy.example:3128",
      // a control character inside (the URL parser would quietly drop a tab or a newline and join what's around it)
      "http://pro\nxy.example:3128", "http://proxy.example:3128\u0000", "http://proxy.ex\tample:3128", "ht\ttp://proxy.example:3128",
      // a host no proxy has
      "http://pro,xy.example:3128", "socks5://proxy%2Fexample:1080", "socks5://proxy!example:1080",
    ]) {
      assert.deepEqual(browserEnv({ PATH: "/usr/bin", HTTPS_PROXY: value, all_proxy: value }, "linux"), { PATH: "/usr/bin" }, JSON.stringify(value));
    }
  });

  // Odd proxy values a reviewer tried (with pw-canary for the password): each goes in as its scheme, host and port,
  // or stays out. undefined: it stays out.
  const C = "pw-canary";
  const ODD_PROXIES = [
    [`http://u:${C}@proxy:3128`, "http://proxy:3128"],
    [`http://proxy:3128/${C}`, "http://proxy:3128"],
    [`http://proxy:3128/?token=${C}`, "http://proxy:3128"],
    [`http://proxy:3128#${C}`, "http://proxy:3128"],
    [`http://u:${C}%40x@proxy:3128`, "http://proxy:3128"],
    [`http://u%3A${C}%40proxy:3128`, undefined],
    [`http://u:${C}@proxy:3128@`, undefined],
    [`http://u:${C}@@proxy:3128`, "http://proxy:3128"],
    [`http://u:${C}@proxy:3128/a@b`, undefined], // an '@' after the host: where the password ends is unclear
    [`http:/u:${C}@proxy:3128`, undefined],
    [`http:\\u:${C}@proxy:3128`, undefined],
    [`HTTP://u:${C}@proxy:3128`, "http://proxy:3128"],
    [`http://u:${C}@pro\nxy:3128`, undefined],
    [`http://u:${C}\n@proxy:3128`, undefined],
    [`http://u:${C}\t@proxy:3128`, undefined],
    [` http://u:${C}@proxy:3128`, "http://proxy:3128"],
    [`http://u:${C}@proxy:3128 `, "http://proxy:3128"],
    [`u:${C}@proxy:3128`, "proxy:3128"],
    [`${C}@proxy:3128`, "proxy:3128"],
    [`:${C}@proxy:3128`, "proxy:3128"],
    [`socks5://u:${C}@proxy:1080`, "socks5://proxy:1080"],
    [`socks5:/u:${C}@proxy:1080`, undefined],
    [`socks5:u:${C}@proxy:1080`, "proxy:1080"],
    [`socks5h://u:${C}@[::1]:1080`, "socks5h://[::1]:1080"],
    [`http://[::1]:3128@${C}`, `http://${C}`], // the canary is the host here, by any reading: the proxy's address
    [`http://u:p@${C}.proxy:3128`, `http://${C}.proxy:3128`], // and here
    [`file://u:${C}@proxy/x`, undefined],
    [`http://u:${C}@proxy:3128;x`, undefined],
    [`u:${C}@proxy:3128/x://y`, "proxy:3128"],
    [`//u:${C}@proxy:3128`, "proxy:3128"],
    [`http://u:${C}@proxy:99999`, undefined],
    [`http://u:${C}@1.2.3.4.5`, undefined],
    [`http://u:${C}@%zz`, undefined],
    [`http://u:${C}@xn--a`, undefined],
    [`http://u:${C}@proxy:3128?x`, "http://proxy:3128"],
    [`http://u:${C}@proxy%2F${C}:3128`, undefined],
    [`http://u:${C}@proxy%40${C}:3128`, undefined],
    [`http://u:${C}@pr@oxy:3128`, "http://oxy:3128"],
    [`http://u:${C}@proxy:3128:3128`, undefined],
    [`ws://u:${C}@proxy:3128`, undefined],
    [`http://u:${C}@\u{1F642}.example:3128`, "http://xn--938h.example:3128"],
    [`http://u:${C}@proxy:3128\u0000`, undefined],
    [`http://u:${C}@proxy\u0000${C}:3128`, undefined],
    [`http://u:${C}@proxy:3128 ${C}`, undefined],
    [`"http://u:${C}@proxy:3128"`, undefined],
    [`<http://u:${C}@proxy:3128>`, undefined],
    [`http://u:${C}@proxy:3128,http://v:${C}@p2:3128`, undefined],
  ];
  const ADDRESS_ONLY = /^((https?|socks|socks4a?|socks5h?):\/\/)?(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(:\d{1,5})?$/i;

  it("odd proxy values: each goes in as its scheme, host and port, or stays out, on every platform", () => {
    assert.equal(ODD_PROXIES.length, 47);
    for (const [value, expected] of ODD_PROXIES) {
      const label = JSON.stringify(value);
      for (const platform of ["linux", "darwin", "win32"]) {
        const env = browserEnv({ HTTPS_PROXY: value, http_proxy: value, ALL_PROXY: value, all_proxy: value }, platform);
        const want = expected === undefined ? {} : { HTTPS_PROXY: expected, http_proxy: expected, ALL_PROXY: expected, all_proxy: expected };
        assert.deepEqual(env, want, `${platform}: ${label}`);
      }
      if (expected === undefined) continue;
      assert.match(expected, ADDRESS_ONLY, label);
      if (!value.includes(`@${C}`)) assert.ok(!expected.toLowerCase().includes(C), `${label}: no password`);
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
    const browser = await makeBrowserLauncher({ log: logInto(logs), env: { ...LINUX, ...secretEnv() }, platform: "linux" })(chromium);
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
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
    for (let i = 0; i < 3; i++) assert.equal((await launch(chromium)).sandboxed, false);
    assert.equal(chromium.calls.length, 6, "each launch tries the sandbox first again");
    assert.deepEqual(chromium.calls.map((c) => c.chromiumSandbox), [true, false, true, false, true, false]);
    assert.equal(logs.length, 3);
    for (const line of logs) assert.match(line, /sandbox couldn't start/);
  });

  it("Chromium's own words for a sandbox it can't start lead to the launch without, each of them", async () => {
    // What Chromium says when Playwright passes its log through as it is.
    for (const message of CHROMIUM_SANDBOX_WORDS) {
      const err = new Error(`browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n${message}`);
      const chromium = fakeChromium(err, "ok");
      const logs = [];
      const browser = await makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" })(chromium);
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
      await assert.rejects(makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" })(chromium), (e) => e === err, message);
      assert.equal(chromium.calls.length, 1, `${message}: no launch without the sandbox`);
      assert.deepEqual(logs, [], message);
    }
  });

  it("the reviewer's first sequence: the sandbox works, then a launch fails with spawn EAGAIN: no launch without", async () => {
    const eagain = new Error("browserType.launch: spawn EAGAIN");
    const chromium = fakeChromium("ok", eagain, "ok");
    const logs = [];
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
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
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
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
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
    assert.equal((await launch(chromium)).sandboxed, true);
    await assert.rejects(launch(chromium), (e) => {
      assert.match(e.message, /sandbox/i);
      assert.match(e.message, /has worked in this run/, "it says the sandbox worked before");
      assert.match(e.message, /Chromium sandboxing failed!/, "with Chromium's reason");
      assert.ok(e.cause instanceof Error, "and Playwright's error as the cause");
      return true;
    });
    assert.deepEqual(chromium.calls.map((c) => c.chromiumSandbox), [true, true], "nothing launched without the sandbox");
    assert.equal(logs.length, 1, "the refusal is logged");
    assert.match(logs[0], /has worked in this run/);
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
      await assert.rejects(makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" })(chromium), (e) => {
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
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
    assert.equal((await launch(chromium)).sandboxed, false);
    assert.equal((await launch(chromium)).sandboxed, true);
    assert.equal(chromium.calls.length, 3);
    assert.equal(logs.length, 1);
  });

  it("no fallback when Chromium isn't installed: that error, as it was", async () => {
    const missing = new Error("browserType.launch: Executable doesn't exist at /home/node/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell");
    const chromium = fakeChromium(missing, "ok");
    const logs = [];
    await assert.rejects(makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" })(chromium), (err) => err === missing);
    assert.equal(chromium.calls.length, 1);
    assert.deepEqual(logs, []);
  });

  it("no fallback when the machine lacks Chromium's libraries or a channel isn't installed", async () => {
    for (const message of [
      "browserType.launch: Host system is missing dependencies to run browsers.",
      "browserType.launch: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    ]) {
      const chromium = fakeChromium(new Error(message), "ok");
      await assert.rejects(makeBrowserLauncher({ log: (m) => assert.match(m, MODE_LINE, "nothing to log but the mode in force"), env: LINUX, platform: "linux" })(chromium), { message });
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
    await assert.rejects(makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" })(chromium), (err) => err === timeout);
    assert.equal(chromium.calls.length, 1, "no launch without the sandbox");
    assert.deepEqual(logs, []);
  });

  it("when the launch without the sandbox fails too, its error comes back and nothing claims the browser runs", async () => {
    const second = new Error("browserType.launch: Timeout 180000ms exceeded.");
    const chromium = fakeChromium(sandboxError(), second);
    const logs = [];
    await assert.rejects(makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" })(chromium), (err) => err === second);
    assert.equal(chromium.calls.length, 2);
    assert.deepEqual(logs, []);
  });
});

// --- TARSEE_BROWSER_SANDBOX: "auto" (the default) or "required" -----------------------------------------------------

describe("tarsee_browser's launch: TARSEE_BROWSER_SANDBOX, auto or required", () => {
  /** A launcher whose environment has TARSEE_BROWSER_SANDBOX as `setting` (left out when undefined). */
  const withSetting = (setting) => {
    const logs = [];
    const modes = [];
    const env = setting === undefined ? { ...LINUX } : { ...LINUX, TARSEE_BROWSER_SANDBOX: setting };
    return { logs, modes, env, launch: makeBrowserLauncher({ log: logInto(logs, modes), env, platform: "linux" }) };
  };
  const sandboxes = (chromium) => chromium.calls.map((c) => c.chromiumSandbox);
  // What the refusal under "required" tells the owner: why, that each call tries again, how to turn the sandbox on, and
  // the other way, with what it costs.
  const saysWhatToDo = (e) => {
    assert.match(e.message, /doesn't run the browser without it/);
    assert.match(e.message, /Each call tries the sandbox again/);
    assert.match(e.message, /don't run Tarsee as root/);
    assert.match(e.message, /user namespaces \(in Docker, with a seccomp profile that allows them\)/);
    assert.match(e.message, /CHROME_DEVEL_SANDBOX/);
    assert.match(e.message, /set TARSEE_BROWSER_SANDBOX to auto/);
    assert.match(e.message, /this server's own rights/);
    assert.ok(e.cause instanceof Error, "Playwright's error as the cause");
  };

  it("auto is the default: the first launch says which mode is in force, once", async () => {
    for (const setting of [undefined, "", "   ", "auto", "AUTO", " Auto "]) {
      const label = JSON.stringify(setting);
      const { logs, modes, launch } = withSetting(setting);
      const chromium = fakeChromium();
      assert.equal((await launch(chromium)).sandboxed, true, label);
      assert.equal((await launch(chromium)).sandboxed, true, label);
      assert.equal(modes.length, 1, `${label}: said once, at the first launch`);
      assert.match(modes[0], /^\[browser\] TARSEE_BROWSER_SANDBOX is auto\b/, label);
      assert.match(modes[0], /set it to required/, `${label}: and it names the other mode`);
      assert.deepEqual(logs, [], `${label}: nothing else to say while the sandbox works`);
    }
  });

  it("required: the first launch says so, once, and a sandbox that works is used as always", async () => {
    for (const setting of ["required", "REQUIRED", " Required "]) {
      const { logs, modes, launch } = withSetting(setting);
      const chromium = fakeChromium();
      assert.equal((await launch(chromium)).sandboxed, true);
      assert.equal((await launch(chromium)).sandboxed, true);
      assert.deepEqual(sandboxes(chromium), [true, true]);
      assert.equal(modes.length, 1, setting);
      assert.match(modes[0], /^\[browser\] TARSEE_BROWSER_SANDBOX is required: tarsee_browser never runs Chromium without its sandbox/, setting);
      assert.doesNotMatch(modes[0], /neither/, setting);
      assert.deepEqual(logs, [], setting);
    }
  });

  it("the mode is said before anything else the launch logs", async () => {
    for (const [setting, then] of [[undefined, /runs without it/], ["required", /TARSEE_BROWSER_SANDBOX is required, so/]]) {
      const all = [];
      const env = setting === undefined ? LINUX : { ...LINUX, TARSEE_BROWSER_SANDBOX: setting };
      const chromium = fakeChromium(noUsableSandbox(), "ok");
      await makeBrowserLauncher({ log: (m) => all.push(m), env, platform: "linux" })(chromium).catch(() => {});
      assert.equal(all.length, 2, String(setting));
      assert.match(all[0], MODE_LINE);
      assert.match(all[1], then);
    }
  });

  it("auto: a bare 'No usable sandbox!' before any sandboxed launch has worked still goes on without it, logged, pointing to the setting", async () => {
    for (const [label, err] of [["Chromium's words", noUsableSandbox], ["Playwright's words", sandboxError]]) {
      const { logs, modes, launch } = withSetting(undefined);
      const chromium = fakeChromium(err(), "ok");
      assert.equal((await launch(chromium)).sandboxed, false, label);
      assert.deepEqual(sandboxes(chromium), [true, false], label);
      assert.match(modes[0], /is auto/, label);
      assert.equal(logs.length, 1, label);
      assert.match(logs[0], /^\[browser\] Chromium's sandbox couldn't start on this machine, so tarsee_browser runs without it\./, label);
      assert.match(logs[0], /set TARSEE_BROWSER_SANDBOX to required/, `${label}: the line points to the setting`);
      assert.match(logs[0], /No usable sandbox!|Chromium sandboxing failed!/, `${label}: with Chromium's reason`);
    }
  });

  it("required: a bare 'No usable sandbox!' before any sandboxed launch has worked is refused, saying why and what the owner can do", async () => {
    for (const [label, err] of [["Chromium's words", noUsableSandbox], ["Playwright's words", sandboxError]]) {
      const { logs, modes, launch } = withSetting("required");
      const chromium = fakeChromium(err(), "ok", "ok");
      await assert.rejects(launch(chromium), (e) => {
        assert.match(e.message, /^Chromium's sandbox didn't start, and TARSEE_BROWSER_SANDBOX is required, so tarsee_browser doesn't run the browser without it\./, label);
        saysWhatToDo(e);
        assert.match(e.message, /Chromium said: .*(No usable sandbox!|Chromium sandboxing failed!)/, `${label}: with Chromium's reason`);
        return true;
      });
      assert.deepEqual(sandboxes(chromium), [true], `${label}: nothing launched without the sandbox`);
      assert.equal(modes.length, 1, label);
      assert.equal(logs.length, 1, `${label}: the refusal is logged`);
      assert.match(logs[0], /^\[browser\] Chromium's sandbox didn't start, and TARSEE_BROWSER_SANDBOX is required/, label);
      assert.doesNotMatch(logs[0], /runs without it/, label);
      assert.equal((await launch(chromium)).sandboxed, true, `${label}: the next call tries the sandbox again`);
      assert.deepEqual(sandboxes(chromium), [true, true], label);
    }
  });

  it("required: every way Chromium says the sandbox can't start is refused, never worked around", async () => {
    for (const message of CHROMIUM_SANDBOX_WORDS) {
      const { logs, launch } = withSetting("required");
      const chromium = fakeChromium(new Error(`browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n${message}`), "ok");
      await assert.rejects(launch(chromium), (e) => {
        assert.match(e.message, /TARSEE_BROWSER_SANDBOX is required/, message);
        assert.ok(e.message.includes(message.slice(0, 60)), `Chromium's reason is given: ${message}`);
        return true;
      });
      assert.deepEqual(sandboxes(chromium), [true], message);
      assert.equal(logs.length, 1, message);
    }
  });

  it("required: a sandbox that never starts never leads to a launch without, one call after another or many at once", async () => {
    const { launch } = withSetting("required");
    const chromium = fakeChromium(noUsableSandbox());
    for (let i = 0; i < 5; i++) await assert.rejects(launch(chromium), /TARSEE_BROWSER_SANDBOX is required/);
    assert.deepEqual(sandboxes(chromium), [true, true, true, true, true]);

    const held = heldChromium();
    const at = withSetting("required");
    const calls = [at.launch(held), at.launch(held), at.launch(held)];
    await turn();
    assert.deepEqual(held.sandboxes(), [true, true, true]);
    for (const l of held.launches) l.fail(noUsableSandbox());
    const results = await Promise.allSettled(calls);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected", "rejected"]);
    await turn();
    assert.deepEqual(held.sandboxes(), [true, true, true], "no launch without the sandbox once none is under way either");
  });

  it("required: failures that aren't the sandbox's come back as they were, as under auto", async () => {
    for (const message of ["browserType.launch: spawn EAGAIN", "browserType.launch: Timeout 180000ms exceeded."]) {
      const err = new Error(message);
      const { logs, launch } = withSetting("required");
      const chromium = fakeChromium(err, "ok");
      await assert.rejects(launch(chromium), (e) => e === err, message);
      assert.deepEqual(logs, [], message);
    }
  });

  it("required: once the sandbox has worked, or while a launch with it is under way, the refusal says so", async () => {
    const after = withSetting("required");
    const chromium = fakeChromium("ok", noUsableSandbox());
    await after.launch(chromium);
    await assert.rejects(after.launch(chromium), /has worked in this run/);
    assert.deepEqual(sandboxes(chromium), [true, true]);

    const during = withSetting("required");
    const held = heldChromium();
    const first = during.launch(held);
    const second = during.launch(held);
    await turn();
    held.launches[1].fail(noUsableSandbox());
    await assert.rejects(second, /while another launch with it was under way/);
    held.launches[0].ok();
    assert.equal((await first).sandboxed, true);
    assert.deepEqual(held.sandboxes(), [true, true]);
  });

  it("a value that's neither auto nor required counts as required, and the log says so, as written", async () => {
    for (const setting of ["off", "no", "false", "0", "disabled", "requried", "auto,required", "auto\nrequired", "x".repeat(500)]) {
      const label = JSON.stringify(setting).slice(0, 40);
      const { modes, launch } = withSetting(setting);
      const chromium = fakeChromium(noUsableSandbox(), "ok");
      await assert.rejects(launch(chromium), (e) => {
        assert.match(e.message, /TARSEE_BROWSER_SANDBOX is ".*" \(taken as required\), so tarsee_browser doesn't run the browser without it/, label);
        saysWhatToDo(e);
        return true;
      });
      assert.deepEqual(sandboxes(chromium), [true], `${label}: nothing launched without the sandbox`);
      assert.equal(modes.length, 1, label);
      assert.match(modes[0], /^\[browser\] TARSEE_BROWSER_SANDBOX is ".*", which is neither auto nor required, so it's taken as required: tarsee_browser never runs Chromium without its sandbox/, label);
      assert.ok(!/[\r\n]/.test(modes[0]), `${label}: on one line`);
      assert.ok(modes[0].length < 600, `${label}: the value is cut short`);
    }
    // The value as written, quoted, for the owner to find.
    const { modes, launch } = withSetting("requried");
    await launch(fakeChromium());
    assert.ok(modes[0].includes('"requried"'));
  });

  it("the setting is read once, at the first launch: changing it afterwards changes nothing", async () => {
    // auto, then required in the environment: still auto.
    const auto = withSetting("auto");
    const a = fakeChromium(noUsableSandbox(), "ok", noUsableSandbox(), "ok");
    assert.equal((await auto.launch(a)).sandboxed, false);
    auto.env.TARSEE_BROWSER_SANDBOX = "required";
    assert.equal((await auto.launch(a)).sandboxed, false, "the launch without, as under auto");
    assert.deepEqual(sandboxes(a), [true, false, true, false]);
    assert.equal(auto.modes.length, 1, "the mode is said once");

    // required, then auto (or nothing) in the environment: still required.
    const required = withSetting("required");
    await assert.rejects(required.launch(fakeChromium(noUsableSandbox(), "ok")), /TARSEE_BROWSER_SANDBOX is required/);
    required.env.TARSEE_BROWSER_SANDBOX = "auto";
    await assert.rejects(required.launch(fakeChromium(noUsableSandbox(), "ok")), /TARSEE_BROWSER_SANDBOX is required/);
    delete required.env.TARSEE_BROWSER_SANDBOX;
    const c = fakeChromium(noUsableSandbox(), "ok");
    await assert.rejects(required.launch(c), /TARSEE_BROWSER_SANDBOX is required/);
    assert.deepEqual(sandboxes(c), [true]);
    assert.equal(required.modes.length, 1);
  });

  it("the setting stays out of the browser's environment", async () => {
    const { launch } = withSetting("required");
    const chromium = fakeChromium();
    await launch(chromium);
    assert.deepEqual(chromium.calls[0].env, LINUX);
    assert.deepEqual(browserEnv({ ...WINDOWS, TARSEE_BROWSER_SANDBOX: "required" }, "win32"), WINDOWS);
  });

  it("tarsee_railway never sets it on Tarsee's own service, so the AI can't change it", async () => {
    const { selfServiceRefusal } = await import("../src/lib/railway-admin.js");
    for (const name of ["TARSEE_BROWSER_SANDBOX", "tarsee_browser_sandbox"]) {
      for (const value of ["auto", "required"]) assert.ok(selfServiceRefusal(name, value), `${name}=${value} is refused`);
    }
  });
});

// --- Launches that overlap on one launcher --------------------------------------------------------------------------

/**
 * A stand-in for Playwright's `chromium` whose launches wait until the test settles each one: launches[i].ok() or
 * launches[i].fail(err). Each browser counts its close() calls.
 */
function heldChromium() {
  const launches = [];
  return {
    launches,
    sandboxes: () => launches.map((l) => l.options.chromiumSandbox),
    launch(options) {
      return new Promise((resolve, reject) => {
        const browser = { sandboxed: options.chromiumSandbox === true, closeCalls: 0, async close() { browser.closeCalls++; } };
        launches.push({ options, browser, ok: () => resolve(browser), fail: reject });
      });
    },
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("tarsee_browser's launch: launches that overlap on one launcher", () => {
  it("the reviewer's case: a sandbox failure while a sandboxed launch is under way is thrown, not worked around", async () => {
    const chromium = heldChromium();
    const logs = [];
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
    const first = launch(chromium);
    const second = launch(chromium);
    await turn();
    assert.deepEqual(chromium.sandboxes(), [true, true], "both ask for the sandbox");
    chromium.launches[1].fail(sandboxError());
    const refused = assert.rejects(second, (e) => {
      assert.match(e.message, /while another launch with it was under way/);
      assert.match(e.message, /Chromium sandboxing failed!/, "with Chromium's reason");
      assert.ok(e.cause instanceof Error);
      return true;
    });
    await turn();
    assert.deepEqual(chromium.sandboxes(), [true, true], "nothing launched without the sandbox");
    await refused;
    chromium.launches[0].ok();
    assert.equal((await first).sandboxed, true);
    assert.equal(logs.length, 1, "the refusal is logged");
    assert.doesNotMatch(logs[0], /runs without it/);
  });

  it("the same, with the reviewer's timing: the first launch takes longer and works", async () => {
    let n = 0;
    const chromium = {
      calls: [],
      async launch(options) {
        this.calls.push(options.chromiumSandbox);
        if (++n === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { sandboxed: options.chromiumSandbox === true };
        }
        if (options.chromiumSandbox) throw sandboxError();
        return { sandboxed: false };
      },
    };
    const launch = makeBrowserLauncher({ log: () => {}, env: LINUX, platform: "linux" });
    const results = await Promise.allSettled([launch(chromium), launch(chromium)]);
    assert.deepEqual(results.map((r) => (r.status === "fulfilled" ? (r.value.sandboxed ? "sandbox" : "no sandbox") : "error")), ["sandbox", "error"]);
    assert.deepEqual(chromium.calls, [true, true], "no launch without the sandbox");
  });

  it("once the launch under way fails too, the next sandbox failure may go on without it, as on a machine that can't sandbox", async () => {
    const chromium = heldChromium();
    const logs = [];
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
    const first = launch(chromium);
    const second = launch(chromium);
    await turn();
    chromium.launches[1].fail(sandboxError());
    const refused = assert.rejects(second, /under way/);
    await turn();
    assert.deepEqual(chromium.sandboxes(), [true, true], "no launch without the sandbox while the first is under way");
    await refused;
    chromium.launches[0].fail(sandboxError()); // no other launch under way now, and none has worked
    await turn();
    assert.deepEqual(chromium.sandboxes(), [true, true, false]);
    chromium.launches[2].ok();
    assert.equal((await first).sandboxed, false);
    assert.equal(logs.length, 2);
    assert.match(logs[1], /sandbox couldn't start/);
  });

  it("a browser started without the sandbox while another launch got it working is closed, not handed out", async () => {
    const chromium = heldChromium();
    const logs = [];
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
    const first = launch(chromium);
    await turn();
    chromium.launches[0].fail(sandboxError()); // nothing under way, nothing worked: it goes on without
    await turn();
    assert.deepEqual(chromium.sandboxes(), [true, false]);
    const second = launch(chromium);
    await turn();
    chromium.launches[2].ok(); // the sandbox works for this one
    assert.equal((await second).sandboxed, true);
    chromium.launches[1].ok(); // and the first one's browser without it comes up after that
    await assert.rejects(first, (e) => {
      assert.match(e.message, /has worked in this run/);
      assert.match(e.message, /Chromium sandboxing failed!/);
      return true;
    });
    assert.equal(chromium.launches[1].browser.closeCalls, 1, "the browser without the sandbox is closed");
    assert.equal(logs.length, 1, "the refusal is logged");
    assert.doesNotMatch(logs[0], /runs without it/, "and nothing says the browser runs without it");
  });

  it("a browser started without the sandbox while a sandboxed launch is under way is closed too", async () => {
    const chromium = heldChromium();
    const logs = [];
    const launch = makeBrowserLauncher({ log: logInto(logs), env: LINUX, platform: "linux" });
    const first = launch(chromium);
    await turn();
    chromium.launches[0].fail(sandboxError());
    await turn();
    const second = launch(chromium);
    await turn();
    chromium.launches[1].ok(); // the first one's browser without the sandbox, while the second's launch is under way
    await assert.rejects(first, /while another launch with it was under way/);
    assert.equal(chromium.launches[1].browser.closeCalls, 1);
    chromium.launches[2].fail(sandboxError()); // that one can't sandbox either, and nothing else is under way
    await turn();
    assert.deepEqual(chromium.sandboxes(), [true, false, true, false]);
    chromium.launches[3].ok();
    assert.equal((await second).sandboxed, false);
    assert.equal(chromium.launches[3].browser.closeCalls, 0, "handed out");
    assert.equal(logs.length, 2);
    assert.match(logs[1], /sandbox couldn't start/);
  });

  it("a closed browser that fails to close still isn't handed out", async () => {
    const chromium = heldChromium();
    const launch = makeBrowserLauncher({ log: () => {}, env: LINUX, platform: "linux" });
    const first = launch(chromium);
    await turn();
    chromium.launches[0].fail(sandboxError());
    await turn();
    const second = launch(chromium);
    await turn();
    chromium.launches[2].ok();
    await second;
    chromium.launches[1].browser.close = async () => { throw new Error("already gone"); };
    chromium.launches[1].ok();
    await assert.rejects(first, /has worked in this run/);
  });

  it("every launch that's over stops counting as under way, however it ended", async () => {
    // Each of these ends a sandboxed launch: a failure that isn't the sandbox's, one thrown before any promise, a
    // refusal because the machine ran out, a launch without the sandbox that failed. After each, nothing is under
    // way, so a sandbox failure goes on without it.
    const ranOut = new Error("browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n[FATAL:credentials.cc(127)] Check failed: . : Resource temporarily unavailable (11)");
    for (const [label, before] of [
      ["spawn EAGAIN", [new Error("browserType.launch: spawn EAGAIN")]],
      ["ran out", [ranOut]],
      ["the launch without failed", [sandboxError(), new Error("browserType.launch: Timeout 180000ms exceeded.")]],
    ]) {
      const chromium = fakeChromium(...before, sandboxError(), "ok");
      const launch = makeBrowserLauncher({ log: () => {}, env: LINUX, platform: "linux" });
      await assert.rejects(launch(chromium), label);
      assert.equal((await launch(chromium)).sandboxed, false, `${label}: nothing is under way after it`);
    }
    let thrown = false;
    const sync = {
      launch(options) {
        if (!thrown) { thrown = true; throw new Error("browserType.launch: not a promise"); }
        if (options.chromiumSandbox) throw sandboxError();
        return Promise.resolve({ sandboxed: false });
      },
    };
    const launch = makeBrowserLauncher({ log: () => {}, env: LINUX, platform: "linux" });
    await assert.rejects(launch(sync), /not a promise/);
    assert.equal((await launch(sync)).sandboxed, false, "a launch that threw before any promise isn't under way either");
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
  const warned = [];
  const ctx = {};

  before(async () => {
    ({ chromium } = playwright);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-browser-launch-"));
    process.env.TARSEE_STATE_DIR = tmp;
    process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
    process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
    console.warn = (...args) => { warned.push(args.join(" ")); };
    ({ executeTool } = await import("../src/lib/tools.js"));
  });

  after(async () => {
    delete process.env.TARSEE_BROWSER_SANDBOX;
    await executeTool?.("browser", { action: "close" }, ctx);
    if (chromium) delete chromium.launch;
    console.warn = quiet.warn;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("under TARSEE_BROWSER_SANDBOX=required, a bare 'No usable sandbox!': the browser tool says why and what the owner can do", async () => {
    // The server's own launcher reads the setting once, at its first launch: this one.
    process.env.TARSEE_BROWSER_SANDBOX = "required";
    const sandboxes = [];
    try {
      chromium.launch = async (options) => {
        sandboxes.push(options.chromiumSandbox);
        throw noUsableSandbox();
      };
      for (let i = 0; i < 2; i++) {
        const answer = await executeTool("browser", { action: "get_text" }, ctx);
        assert.match(answer, /^Browser error \(get_text\): Failed to launch browser: Chromium's sandbox didn't start, and TARSEE_BROWSER_SANDBOX is required, so tarsee_browser doesn't run the browser without it\./);
        assert.match(answer, /Each call tries the sandbox again/);
        assert.match(answer, /don't run Tarsee as root, and let its user create user namespaces/);
        assert.match(answer, /set TARSEE_BROWSER_SANDBOX to auto/);
        assert.match(answer, /No usable sandbox!/, "with Chromium's reason");
      }
      assert.deepEqual(sandboxes, [true, true], "nothing launched without the sandbox");
      const modes = warned.filter((m) => MODE_LINE.test(m));
      assert.equal(modes.length, 1, "the server's log says which mode is in force, once");
      assert.match(modes[0], /TARSEE_BROWSER_SANDBOX is required/);
      assert.equal(warned.filter((m) => /TARSEE_BROWSER_SANDBOX is required, so/.test(m)).length, 2, "and each refusal");
      assert.ok(!warned.some((m) => /runs without it/.test(m)));
    } finally {
      delete process.env.TARSEE_BROWSER_SANDBOX;
      delete chromium.launch;
    }
  });

  it("calls at once share one launch; a replaced browser and the close action close it", async () => {
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
    browser = await makeBrowserLauncher({ log: logInto(logs), env: { ...process.env, ...secretEnv(), TARSEE_BROWSER_SANDBOX: "auto" } })(realChromium);

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

  it("under TARSEE_BROWSER_SANDBOX=required: sandboxed where it can, else refused, never without", async () => {
    const said = [];
    const modes = [];
    let sandboxed;
    try {
      sandboxed = await makeBrowserLauncher({ log: logInto(said, modes), env: { ...process.env, TARSEE_BROWSER_SANDBOX: "required" } })(realChromium);
    } catch (err) {
      // A machine that can't sandbox Chromium (run as root, or no user namespaces): refused, saying so.
      assert.match(err.message, /TARSEE_BROWSER_SANDBOX is required, so tarsee_browser doesn't run the browser without it/);
      assert.equal(said.length, 1);
      return;
    }
    try {
      const cdp = await sandboxed.newBrowserCDPSession();
      const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
      assert.ok(!args.includes("--no-sandbox"), "the sandbox is on");
      assert.deepEqual(said, []);
      assert.equal(modes.length, 1);
      assert.match(modes[0], /TARSEE_BROWSER_SANDBOX is required/);
    } finally {
      await sandboxed.close();
    }
  });

  it("a browser that's replaced goes with the pop-ups its page opened", async () => {
    const launch = makeBrowserLauncher({ log: () => {}, env: { ...process.env, TARSEE_BROWSER_SANDBOX: "auto" } });
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
