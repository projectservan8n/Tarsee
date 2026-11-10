// The sign-in limits (test/login-limit.test.js) last through a restart. A restart or a redeploy used to give every
// place a fresh start, and the AI can cause one (the Railway tool redeploys Tarsee, and today its shell can stop the
// server), so guessers working together could make 29 wrong guesses, have Tarsee restarted, and go again. Now each
// place's wrong guesses, when the last one was, how long it must wait, and the pause for everyone (the recent wrong
// guesses' times, until when, and how many pauses) are kept in tarsee.db and read back at boot.
// Each "boot" here is a new node process (test/fixtures/sign-in-boot.mjs) running the real sign-in route over the same
// database file, at a clock the test sets, so nothing is carried over in memory.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./fixtures/sign-in-boot.mjs", import.meta.url));
const PIN = "4821";
const WRONG = "0000";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.parse("2026-01-05T09:00:00Z");

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * A Tarsee of its own: a new state folder and database. Returns boot(clock, steps, { writesFail }), one run of it;
 * writesFail: tarsee.db refuses every write in that run, as on a full disk.
 */
function install() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-login-restart-"));
  dirs.push(dir);
  const env = { ...process.env };
  for (const name of ["RAILWAY_PROJECT_ID", "TARSEE_TRUSTED_PROXY", "TARSEE_API_TOKEN", "NODE_OPTIONS"]) delete env[name];
  Object.assign(env, {
    TARSEE_STATE_DIR: dir,
    TARSEE_WORKSPACE_DIR: path.join(dir, "workspace"),
    TARSEE_DATA_DIR: path.join(dir, "data"),
    SETUP_PASSWORD: PIN,
  });
  return (clock, steps, { writesFail = false } = {}) => {
    const out = execFileSync(process.execPath, [CHILD], {
      env: { ...env, SIGN_IN_CLOCK: String(clock), SIGN_IN_STEPS: JSON.stringify(steps), SIGN_IN_WRITES_FAIL: writesFail ? "1" : "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    return JSON.parse(out.trim().split(/\r?\n/).pop());
  };
}

const wrong = (from) => ({ from, password: WRONG });
const right = (from) => ({ from, password: PIN });
/** n wrong guesses, each from its own address. */
const spread = (n, block) => Array.from({ length: n }, (_, i) => wrong(`${block}.${i + 1}`));
const statuses = (answers) => answers.filter(Boolean).map((a) => a.status);

describe("a place's count, after a restart", () => {
  it("still has its wrong guesses: the fourth starts a wait", () => {
    const boot = install();
    assert.deepEqual(statuses(boot(T, [wrong("203.0.113.5"), wrong("203.0.113.5"), wrong("203.0.113.5")])), [401, 401, 401]);
    assert.deepEqual(statuses(boot(T + MINUTE, [wrong("203.0.113.5"), wrong("203.0.113.5")])), [401, 429]);
  });

  it("still has its wait, and then signs the right password in", () => {
    const boot = install();
    boot(T, Array(4).fill(wrong("203.0.113.5")));
    const [waiting] = boot(T + 10_000, [right("203.0.113.5")]);
    assert.equal(waiting.status, 429);
    assert.equal(waiting.retryAfter, 20, "the 30-second wait has 20 seconds left");
    assert.match(waiting.error, /from here/);
    assert.equal(boot(T + 31_000, [right("203.0.113.5")])[0].status, 200);
  });

  it("is still cleared by a right password", () => {
    const boot = install();
    assert.deepEqual(statuses(boot(T, [...Array(3).fill(wrong("203.0.113.5")), right("203.0.113.5")])), [401, 401, 401, 200]);
    assert.deepEqual(statuses(boot(T + MINUTE, Array(5).fill(wrong("203.0.113.5")))), [401, 401, 401, 401, 429]);
  });

  it("is forgotten a day after its last wrong guess, restart or not", () => {
    const boot = install();
    boot(T, Array(3).fill(wrong("203.0.113.5")));
    assert.deepEqual(statuses(boot(T + 25 * HOUR, Array(4).fill(wrong("203.0.113.5")))), [401, 401, 401, 401]);
  });

  it("is kept for each place on its own", () => {
    const boot = install();
    boot(T, Array(4).fill(wrong("203.0.113.5")));
    assert.equal(boot(T + 1000, [right("198.51.100.7")])[0].status, 200, "another place isn't waiting");
  });
});

describe("the pause for everyone, after a restart", () => {
  it("is still on", () => {
    const boot = install();
    assert.deepEqual(statuses(boot(T, spread(30, "203.0.113"))), Array(30).fill(401));
    const [paused] = boot(T + MINUTE, [right("198.51.100.200")]);
    assert.equal(paused.status, 429);
    assert.equal(paused.retryAfter, 14 * 60);
    assert.match(paused.error, /everyone/);
    assert.equal(boot(T + 15 * MINUTE + 1000, [right("198.51.100.200")])[0].status, 200, "and ends when it should");
  });

  it("still counts the recent wrong guesses toward one", () => {
    const boot = install();
    boot(T, spread(29, "203.0.113"));
    const answers = boot(T + MINUTE, [wrong("198.51.100.1"), right("198.51.100.2")]);
    assert.deepEqual(statuses(answers), [401, 429], "the 30th wrong guess, after the restart, starts the pause");
    assert.match(answers[1].error, /everyone/);
  });

  it("still knows how many pauses there have been: the second that day is twice as long", () => {
    const boot = install();
    boot(T, spread(30, "203.0.113"));
    const answers = boot(T + 16 * MINUTE, [...spread(30, "198.51.100"), right("192.0.2.1")]);
    assert.equal(answers.at(-1).status, 429);
    assert.equal(answers.at(-1).retryAfter, 30 * 60);
  });

  it("keeps anyone already signed in signed in, through the pause and the restart", () => {
    const boot = install();
    const first = boot(T, [right("198.51.100.9"), ...spread(30, "203.0.113")]);
    const cookie = first[0].cookie;
    assert.match(cookie, /^tarsee_session=/);
    const answers = boot(T + MINUTE, [
      { from: "198.51.100.9", private: true, cookie },
      right("198.51.100.9"),
      { from: "198.51.100.9", private: true },
    ]);
    assert.deepEqual(statuses(answers), [200, 429, 401], "the sign-in works; a new one waits; no sign-in, no");
  });
});

describe("when tarsee.db can't be written (a full disk), and then a restart", () => {
  // The AI shares the volume with tarsee.db, so it could fill it. A guess whose count can't be saved used to be checked
  // anyway and counted in memory only: fill the disk, guess, free the disk, have Tarsee restarted, and every count
  // started fresh. Now a try is counted, and saved, before its password is checked, and turned away when it can't be.
  it("turns every new sign-in away unchecked, so the next start has forgotten nothing", () => {
    const boot = install();
    const first = boot(T, [right("198.51.100.9"), ...Array(3).fill(wrong("203.0.113.5"))]);
    assert.deepEqual(statuses(first), [200, 401, 401, 401]);
    const cookie = first[0].cookie;
    const full = boot(T + MINUTE, [
      ...Array(4).fill(wrong("203.0.113.5")),
      ...spread(30, "192.0.2"),
      right("198.51.100.10"),
      { from: "198.51.100.9", private: true, cookie },
    ], { writesFail: true });
    assert.deepEqual(statuses(full), [...Array(35).fill(429), 200], "nothing checked; the sign-in made before still works");
    assert.match(full[0].error, /can't record sign-in attempts right now \(is the disk full\?\), so new sign-ins are paused/);
    assert.equal(full[0].retryAfter, 60);
    assert.equal(full[34].cookie, null, "the right password signs nobody in");
    // Space is freed and Tarsee starts again: the place still has its three wrong passwords, and nobody else is held.
    assert.deepEqual(statuses(boot(T + 2 * MINUTE, [wrong("203.0.113.5"), wrong("203.0.113.5"), right("198.51.100.10")])), [401, 429, 200]);
  });

  it("opens again by itself once a write works, with no restart", () => {
    const boot = install();
    boot(T, []);
    const answers = boot(T + MINUTE, [{ writes: false }, wrong("203.0.113.5"), right("198.51.100.10"), { writes: true }, wrong("203.0.113.5"), right("198.51.100.10")]);
    assert.deepEqual(statuses(answers), [429, 429, 401, 200]);
  });
});
