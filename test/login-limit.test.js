// Signing in at the dashboard (POST /api/auth/login) is limited so the password, which may be a short PIN, can't be
// guessed:
//   - each place a sign-in comes from has its own budget: three wrong guesses, then waits that grow to an hour, and
//     its wrong guesses are remembered for a day. An IPv6 client counts against its /64, its /56 and its /48 (one
//     server, one home, one tunnel), each with a place's budget, and adds at most 8 to the count for everyone;
//   - the place is the connection's own address. X-Forwarded-For is believed only from a proxy the owner names in
//     TARSEE_TRUSTED_PROXY ("loopback" for one on this machine, or addresses and ranges), so a client that reaches
//     Tarsee directly, or through Docker's bridge gateway, can't name a new client in each guess. On Railway the
//     place is the X-Real-IP Railway's edge sets, and the setting is ignored;
//   - a request from this machine itself (its loopback addresses or its own network addresses) is one place,
//     whatever headers it carries, unless TARSEE_TRUSTED_PROXY is "loopback": the AI's shell runs here;
//   - all places together get 30 wrong guesses in 10 minutes. Then signing in pauses for everyone for 15 minutes, and
//     each pause within a day of the last is twice as long, up to 4 hours. Anyone already signed in stays signed in.
// The counts are kept in tarsee.db too: test/login-limit-restart.test.js restarts Tarsee between guesses. Each try is
// counted, and saved, before its password is checked; while tarsee.db can't be written (a full disk, a lock), sign-ins
// are turned away unchecked, and anyone already signed in stays signed in.
// The real authRouter runs behind the trust proxy setting server.js uses, over a real database. Other servers stand in
// for a proxy or a client: their connections look as if they come from the address the test gives.
import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-login-limit-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.SETUP_PASSWORD = "4821";
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.TARSEE_TRUSTED_PROXY;
const PIN = process.env.SETUP_PASSWORD;
const WRONG = "0000";

// auth.js's housekeeping timers, caught instead of waiting for them (as auth-timers.test.js does): the 5-minute one
// forgets addresses that have stopped guessing.
const timers = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return { unref() { return this; } };
};
const auth = await import("../src/middleware/auth.js");
globalThis.setInterval = realSetInterval;
const { authRouter } = await import("../src/routes/auth-routes.js");
const { initDb } = await import("../src/db/sqlite.js");
const sweep = () => timers.find((t) => t.ms === 5 * 60_000).fn();

const db = initDb(path.join(tmp, "data", "tarsee.db"));
auth.initSessionStore(db);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Addresses that stand in for others: never one of this computer's own.
const ownAddresses = new Set(Object.values(os.networkInterfaces()).flat().map((nic) => nic.address));
const notOwn = (...candidates) => candidates.find((a) => !ownAddresses.has(a));
// A proxy in front, at a private address.
const EDGE = notOwn("100.64.0.9", "10.255.254.9", "172.31.254.9");
// Docker's bridge gateway: what the container sees when anything (the AI's shell included) comes back in through the
// published port, and what every client looks like on Docker Desktop.
const GATEWAY = notOwn("172.17.0.1", "172.18.0.1", "172.19.0.1");
// Cloudflare's published ranges (https://www.cloudflare.com/ips/, November 2026), as the readme's example names them.
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
].join(", ");

const app = express();
app.set("trust proxy", auth.trustProxyHop);
app.use(express.json());
app.use(auth.sessionAuth);
app.get("/whoami", (req, res) => res.json({ ip: req.ip, place: auth.signInKey(req) }));
app.get("/private", auth.requireAuth, (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
const local = http.createServer(app);
const edge = http.createServer(app);
edge.on("connection", (socket) => Object.defineProperty(socket, "remoteAddress", { value: EDGE, configurable: true }));
// Connections from whatever address `peer` names when they open (each request opens its own).
let peer = "203.0.113.50";
const direct = http.createServer(app);
direct.on("connection", (socket) => Object.defineProperty(socket, "remoteAddress", { value: peer, configurable: true }));

function send(server, { method = "POST", path: urlPath = "/api/auth/login", password, xff, realIp, cookie, localAddress, from } = {}) {
  if (from) peer = from;
  return new Promise((resolve, reject) => {
    const body = method === "POST" ? JSON.stringify({ password }) : "";
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (xff) headers["x-forwarded-for"] = xff;
    if (realIp) headers["x-real-ip"] = realIp;
    if (cookie) headers.cookie = cookie;
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path: urlPath, method, headers, localAddress, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({
            status: res.statusCode,
            retryAfter: Number(res.headers["retry-after"]) || 0,
            cookie: (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; "),
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const login = (server, password, opts = {}) => send(server, { ...opts, password });
const whoami = (server, opts = {}) => send(server, { ...opts, method: "GET", path: "/whoami" });

/** Status codes of `n` wrong guesses, the i-th sent with opts(i). */
async function guesses(server, n, opts = () => ({})) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await login(server, WRONG, opts(i))).status);
  return out;
}

// The clock: frozen, and moved on by hand.
let clock = Date.parse("2026-01-05T09:00:00Z");
function setClock(ms) {
  clock = ms;
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: ms });
}
const later = (ms) => setClock(clock + ms);

/** Whether this computer lets a client use 127.0.0.2 as its address (Linux and Windows do; macOS doesn't by default). */
function canUseLoopback(address) {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.destroy());
    server.listen(0, "127.0.0.1", () => {
      const socket = net.connect({ host: "127.0.0.1", port: server.address().port, localAddress: address });
      socket.on("connect", () => { socket.destroy(); server.close(); resolve(true); });
      socket.on("error", () => { server.close(); resolve(false); });
    });
  });
}

before(async () => {
  for (const server of [local, edge, direct]) await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(async () => {
  mock.timers.reset();
  for (const server of [local, edge, direct]) await new Promise((r) => server.close(r));
  db.close();
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.TARSEE_TRUSTED_PROXY;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  auth.__resetSignInLimitsForTests();
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.TARSEE_TRUSTED_PROXY;
  setClock(clock + 2 * 24 * HOUR);
});

describe("sign-in from this machine", () => {
  it("is limited however each guess names its client in X-Forwarded-For", async () => {
    const statuses = await guesses(local, 6, (i) => ({ xff: `203.0.113.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429], "three free guesses, then the fourth starts a wait");
    const right = await login(local, PIN, { xff: "198.51.100.77" });
    assert.equal(right.status, 429, "during the wait even the right password is turned away, so a guess learns nothing");
    assert.ok(right.retryAfter > 0 && right.retryAfter <= 30, `Retry-After ${right.retryAfter}`);
  });

  it("is limited however each guess names its client in X-Real-IP, also on Railway", async () => {
    process.env.RAILWAY_PROJECT_ID = "test-project";
    const statuses = await guesses(local, 5, (i) => ({ realIp: `203.0.113.${i + 1}`, xff: `198.51.100.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  });

  it("is one client from any of its loopback addresses", async (t) => {
    if (!(await canUseLoopback("127.0.0.2"))) return t.skip("this computer has only 127.0.0.1 for loopback");
    const statuses = await guesses(local, 5, (i) => ({ localAddress: `127.0.0.${i + 1}`, xff: `203.0.113.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  });

  it("is not named by X-Forwarded-For anywhere else either (req.ip is this machine)", async () => {
    const me = await whoami(local, { xff: "203.0.113.5" });
    assert.ok(net.isIP(me.json.ip) && me.json.ip !== "203.0.113.5", `req.ip ${me.json.ip}`);
    assert.equal(me.json.place, "this machine");
  });

  it("is one client when TARSEE_TRUSTED_PROXY names loopback's addresses but not the word loopback", async () => {
    process.env.TARSEE_TRUSTED_PROXY = "127.0.0.0/8, ::1";
    const statuses = await guesses(local, 5, (i) => ({ xff: `203.0.113.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429], "a list of addresses never covers this machine itself");
  });

  it("signs the right password in once the wait is over", async () => {
    await guesses(local, 4, (i) => ({ xff: `203.0.113.${i + 1}` }));
    assert.equal((await login(local, PIN)).status, 429);
    later(31_000);
    const right = await login(local, PIN, { xff: "203.0.113.200" });
    assert.equal(right.status, 200);
    assert.match(right.cookie, /tarsee_session=/);
  });
});

describe("TARSEE_TRUSTED_PROXY not set, off Railway: each connection is its own client", () => {
  it("counts Docker's bridge gateway as one place, whatever new X-Forwarded-For each guess sends", async () => {
    const statuses = await guesses(direct, 6, (i) => ({ from: GATEWAY, xff: `203.0.113.${i + 1}`, realIp: `198.51.100.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
    const me = await whoami(direct, { from: GATEWAY, xff: "203.0.113.99" });
    assert.equal(me.json.ip, GATEWAY, "req.ip is the gateway too");
    assert.equal(me.json.place, GATEWAY);
  });

  it("doesn't believe a proxy at a private address that it wasn't told about", async () => {
    const statuses = await guesses(edge, 5, (i) => ({ xff: `203.0.113.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  });

  it("never lets one client that forges headers pause signing in for everyone", async () => {
    const heard = [];
    for (let i = 0; i < 60; i++) {
      heard.push((await login(direct, WRONG, { from: "203.0.113.50", xff: `198.51.100.${i + 1}`, realIp: `192.0.2.${i + 1}` })).status);
      later(30 * 1000);
    }
    assert.ok(heard.filter((s) => s === 401).length < 30, `wrong guesses heard: ${heard.filter((s) => s === 401).length}`);
    const other = await login(direct, PIN, { from: "198.51.100.7" });
    assert.equal(other.status, 200, "everyone else still signs in");
  });

  it("limits two clients reaching Tarsee directly separately", async () => {
    assert.deepEqual(await guesses(direct, 5, () => ({ from: "203.0.113.50" })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, WRONG, { from: "198.51.100.7" })).status, 401, "the other client isn't held up");
    assert.equal((await login(direct, PIN, { from: "198.51.100.7" })).status, 200, "and signs in");
  });
});

describe("TARSEE_TRUSTED_PROXY=loopback: a proxy on this machine (nginx, Caddy, cloudflared, Tailscale)", () => {
  beforeEach(() => { process.env.TARSEE_TRUSTED_PROXY = "loopback"; });

  it("limits two clients behind it separately", async () => {
    assert.deepEqual(await guesses(local, 5, () => ({ xff: "203.0.113.5" })), [401, 401, 401, 401, 429]);
    assert.equal((await login(local, WRONG, { xff: "198.51.100.7" })).status, 401, "the other client isn't held up");
    const right = await login(local, PIN, { xff: "198.51.100.7" });
    assert.equal(right.status, 200, "and signs in");
    assert.equal((await whoami(local, { xff: "198.51.100.7" })).json.ip, "198.51.100.7", "req.ip is the client");
  });

  it("counts a request from this machine with no X-Forwarded-For as this machine", async () => {
    assert.equal((await whoami(local)).json.place, "this machine");
  });

  it("still holds the AI's shell, which can name a new client in each guess, with the limit for all places", async () => {
    const statuses = await guesses(local, 30, (i) => ({ xff: `203.0.113.${i + 1}` }));
    assert.deepEqual(statuses, Array(30).fill(401), "each guess passes as a new client: what trusting loopback costs");
    const after30 = await login(local, PIN, { xff: "198.51.100.200" });
    assert.equal(after30.status, 429, "then signing in pauses for everyone");
    assert.match(after30.json.error, /everyone/);
    assert.equal((await login(direct, PIN, { from: "198.51.100.7" })).status, 429, "from anywhere");
  });

  it("doesn't believe X-Forwarded-For from anywhere else", async () => {
    assert.deepEqual(await guesses(direct, 5, (i) => ({ from: GATEWAY, xff: `203.0.113.${i + 1}` })), [401, 401, 401, 401, 429]);
  });
});

describe("TARSEE_TRUSTED_PROXY as addresses and ranges", () => {
  it("believes a proxy in a named range, and nothing outside it", async () => {
    process.env.TARSEE_TRUSTED_PROXY = `${EDGE.split(".").slice(0, 3).join(".")}.0/24`;
    assert.deepEqual(await guesses(edge, 5, () => ({ xff: "203.0.113.5" })), [401, 401, 401, 401, 429]);
    assert.equal((await login(edge, WRONG, { xff: "198.51.100.7" })).status, 401, "a second client behind it isn't held up");
    assert.deepEqual(await guesses(direct, 5, (i) => ({ from: GATEWAY, xff: `192.0.2.${i + 1}` })), [401, 401, 401, 401, 429]);
  });

  it("walks back through each named proxy to the client", () => {
    process.env.TARSEE_TRUSTED_PROXY = "loopback, 198.18.0.7";
    const req = (xff, from = "127.0.0.1") => ({ socket: { remoteAddress: from }, headers: { "x-forwarded-for": xff } });
    assert.equal(auth.clientAddress(req("203.0.113.5, 198.18.0.7")), "203.0.113.5");
    assert.equal(auth.clientAddress(req("203.0.113.5, 198.18.0.8")), "198.18.0.8", "stops at the first it doesn't know");
    assert.equal(auth.clientAddress(req("203.0.113.5, not-an-address")), "127.0.0.1", "or at what isn't an address");
    assert.equal(auth.clientAddress(req("203.0.113.5", "198.51.100.1")), "198.51.100.1", "a peer it doesn't know is the client");
    assert.equal(auth.clientAddress(req("2001:db8:5:6::1", "::ffff:127.0.0.1")), "2001:db8:5:6::1");
  });

  it("takes all of Cloudflare's published ranges (cloudflare.com/ips), and walks back through any of its edges", () => {
    process.env.TARSEE_TRUSTED_PROXY = `loopback, ${CLOUDFLARE}`;
    const trust = auth.trustedProxies();
    assert.deepEqual(trust.skipped, []);
    assert.equal(trust.names.length, 1 + 15 + 7, "loopback, 15 IPv4 ranges and 7 IPv6 ranges");
    // Cloudflare in front of nginx on this machine: nginx adds the Cloudflare edge it saw after the client.
    const req = (xff) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": xff } });
    assert.equal(auth.clientAddress(req("203.0.113.5, 173.245.48.9")), "203.0.113.5", "an edge in the first range");
    assert.equal(auth.clientAddress(req("203.0.113.5, 131.0.72.9")), "203.0.113.5", "an edge in the last IPv4 range");
    assert.equal(auth.clientAddress(req("2001:db8:aa:bb01::1, 2a06:98c7::5")), "2001:db8:aa:bb01::1", "an IPv6 edge");
    assert.equal(auth.clientAddress(req("203.0.113.5, 198.51.100.4")), "198.51.100.4", "not Cloudflare's: it is the client");
  });

  it("reads loopback, addresses and ranges, and skips the rest", () => {
    const trust = auth.trustedProxies("Loopback, nginx 10.1.2.3,fd00::/8 10.0.0.0/33 0.0.0.0/0 none 172.18.0.0/16/2");
    assert.equal(trust.loopback, true);
    assert.deepEqual(trust.names, ["loopback", "10.1.2.3", "fd00::/8"]);
    assert.deepEqual(trust.skipped, ["nginx", "10.0.0.0/33", "0.0.0.0/0", "172.18.0.0/16/2"]);
    assert.equal(auth.trustedProxies("").loopback, false);
    assert.deepEqual(auth.trustedProxies("none").names, []);
  });
});

describe("sign-in through a proxy in front", () => {
  beforeEach(() => { process.env.TARSEE_TRUSTED_PROXY = EDGE; });

  it("limits two clients behind it separately, by the address the proxy adds to X-Forwarded-For", async () => {
    assert.deepEqual(await guesses(edge, 5, () => ({ xff: "203.0.113.5" })), [401, 401, 401, 401, 429]);
    // The proxy adds the address it sees at the end: what the client wrote before it is the client's own claim.
    assert.equal((await login(edge, WRONG, { xff: "198.51.100.7, 203.0.113.5" })).status, 429, "can't pass as another");
    assert.equal((await login(edge, WRONG, { xff: "198.51.100.7" })).status, 401, "the other client isn't held up");
    const right = await login(edge, PIN, { xff: "198.51.100.7" });
    assert.equal(right.status, 200, "and signs in");
    assert.match(right.cookie, /tarsee_session=/);
    assert.equal((await whoami(edge, { xff: "198.51.100.7" })).json.ip, "198.51.100.7", "req.ip is the client");
  });

  it("on Railway limits two clients separately by the X-Real-IP Railway's edge sets", async () => {
    delete process.env.TARSEE_TRUSTED_PROXY;
    process.env.RAILWAY_PROJECT_ID = "test-project";
    // Railway's edge can pass X-Forwarded-For as "client, an address of Railway's own network", a last hop many
    // clients share.
    const a = { realIp: "203.0.113.5", xff: "203.0.113.5, 100.64.0.20" };
    const b = { realIp: "198.51.100.7", xff: "198.51.100.7, 100.64.0.20" };
    assert.deepEqual(await guesses(edge, 5, () => a), [401, 401, 401, 401, 429]);
    assert.equal((await login(edge, WRONG, b)).status, 401, "the other client isn't held up");
    assert.equal((await login(edge, PIN, b)).status, 200, "and signs in");
  });

  it("on Railway ignores TARSEE_TRUSTED_PROXY: this machine is still one place", async () => {
    process.env.RAILWAY_PROJECT_ID = "test-project";
    process.env.TARSEE_TRUSTED_PROXY = "loopback";
    const statuses = await guesses(local, 5, (i) => ({ realIp: `203.0.113.${i + 1}`, xff: `198.51.100.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  });

  it("off Railway doesn't believe an X-Real-IP the client wrote itself", async () => {
    const statuses = await guesses(edge, 5, (i) => ({ xff: "203.0.113.5", realIp: `198.51.100.${i + 1}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  });

  it("counts an IPv6 client as its /64, its /56 and its /48, so new addresses from one network don't make new budgets", async () => {
    const statuses = await guesses(edge, 5, (i) => ({ xff: `2001:db8:5:6::${(i + 1).toString(16)}` }));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
    assert.equal((await login(edge, WRONG, { xff: "2001:db8:5:6:ffff:1:2:3" })).status, 429, "same /64");
    const sameHome = await login(edge, WRONG, { xff: "2001:db8:5:7::1" });
    assert.equal(sameHome.status, 429, "another /64 of the same /56 and /48");
    assert.match(sameHome.json.error, /from your network/);
    assert.equal((await login(edge, WRONG, { xff: "2001:db8:6:7::1" })).status, 401, "another /48");
  });

  it("remembers a client's wrong guesses when it pauses between them", async () => {
    assert.deepEqual(await guesses(edge, 3, () => ({ xff: "203.0.113.5" })), [401, 401, 401]);
    later(6 * MINUTE);
    sweep();
    assert.deepEqual(await guesses(edge, 2, () => ({ xff: "203.0.113.5" })), [401, 429], "the fourth wrong guess still starts a wait");
    later(25 * HOUR); // a day with no wrong guess
    sweep();
    assert.equal((await login(edge, PIN, { xff: "203.0.113.5" })).status, 200);
  });
});

describe("all clients together", () => {
  beforeEach(() => { process.env.TARSEE_TRUSTED_PROXY = EDGE; });

  it("get 30 wrong guesses in 10 minutes, then signing in pauses for everyone", async () => {
    const statuses = await guesses(edge, 30, (i) => ({ xff: `203.0.113.${i + 1}` }));
    assert.deepEqual(statuses, Array(30).fill(401), "each address is on its first wrong guess");
    const fresh = await login(edge, PIN, { xff: "198.51.100.200" });
    assert.equal(fresh.status, 429, "a client that has guessed nothing waits too, with the right password");
    assert.equal(fresh.retryAfter, 15 * 60);
    assert.match(fresh.json.error, /everyone/);
    assert.equal((await login(local, PIN)).status, 429, "so does this machine");
  });

  it("keep anyone already signed in signed in during a pause", async () => {
    const signedIn = await login(edge, PIN, { xff: "198.51.100.9" });
    assert.equal(signedIn.status, 200);
    await guesses(edge, 30, (i) => ({ xff: `203.0.113.${i + 1}` }));
    assert.equal((await login(edge, PIN, { xff: "198.51.100.9" })).status, 429, "paused");
    assert.equal((await send(edge, { method: "GET", path: "/private", cookie: signedIn.cookie, xff: "198.51.100.9" })).status, 200);
    assert.equal((await send(edge, { method: "GET", path: "/private", xff: "198.51.100.9" })).status, 401, "without the sign-in, no");
  });

  it("are read back as an earlier Tarsee kept them, with only each wrong guess's time", async () => {
    db.prepare("INSERT OR REPLACE INTO sign_in_pause (id, wrong, paused_until, pauses) VALUES (1, ?, 0, 0)").run(JSON.stringify(Array(29).fill(Date.now() - 1000)));
    auth.initSessionStore(db); // the next start
    assert.equal((await login(edge, WRONG, { xff: "203.0.113.5" })).status, 401);
    assert.equal((await login(edge, PIN, { xff: "198.51.100.7" })).status, 429, "the 30th started the pause");
  });

  it("don't pause for wrong guesses spread out over more than 10 minutes", async () => {
    await guesses(edge, 29, (i) => ({ xff: `203.0.113.${i + 1}` }));
    later(10 * MINUTE + 1000);
    assert.deepEqual(await guesses(edge, 2, (i) => ({ xff: `198.51.100.${i + 1}` })), [401, 401]);
    assert.equal((await login(edge, PIN, { xff: "198.51.100.200" })).status, 200);
  });

  it("can sign in with the right password once the pause is over, and a second pause that day is longer", async () => {
    await guesses(edge, 30, (i) => ({ xff: `203.0.113.${i + 1}` }));
    later(14 * MINUTE);
    assert.equal((await login(edge, PIN, { xff: "198.51.100.200" })).status, 429, "still paused");
    later(1 * MINUTE + 1000);
    const right = await login(edge, PIN, { xff: "198.51.100.200" });
    assert.equal(right.status, 200, "the pause is over");
    assert.match(right.cookie, /tarsee_session=/);

    await guesses(edge, 30, (i) => ({ xff: `203.0.113.${i + 101}` }));
    const again = await login(edge, PIN, { xff: "198.51.100.201" });
    assert.equal(again.status, 429);
    assert.equal(again.retryAfter, 30 * 60, "twice as long the second time");
  });

  it("are not paused by one client, which its own waits hold to a few guesses", async () => {
    const statuses = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await login(edge, WRONG, { xff: "203.0.113.5" })).status);
      later(30 * 1000);
    }
    assert.ok(statuses.filter((s) => s === 401).length < 30, `wrong guesses heard: ${statuses.filter((s) => s === 401).length}`);
    assert.equal((await login(edge, PIN, { xff: "198.51.100.7" })).status, 200, "everyone else still signs in");
  });
});

describe("IPv6: one home's or one tunnel's network gets one place's share", () => {
  // A home is commonly given a /56 (256 /64s), and a free tunnel a /48 (65,536 /64s). They reach Tarsee directly here,
  // with no headers at all.
  const inOne56 = (i) => `2001:db8:aa:bb${i.toString(16).padStart(2, "0")}::1`; // 2001:db8:aa:bb00::/56
  const inOne48 = (i) => `2001:db8:cc:${i.toString(16).padStart(2, "0")}00::1`; // 2001:db8:cc::/48, each in its own /56

  it("counts 30 /64s of one /56 as one place: it can't pause everyone", async () => {
    const statuses = await guesses(direct, 30, (i) => ({ from: inOne56(i) }));
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 429], "three free guesses, then the fourth starts the home's wait");
    assert.equal(statuses.filter((s) => s === 401).length, 4, JSON.stringify(statuses));
    const refused = await login(direct, WRONG, { from: inOne56(200) });
    assert.match(refused.json.error, /Too many wrong passwords from your network/);
    assert.equal((await login(direct, PIN, { from: "192.0.2.77" })).status, 200, "everyone else still signs in");
  });

  it("counts 30 /64s of one /48, each in its own /56, as one place", async () => {
    const statuses = await guesses(direct, 30, (i) => ({ from: inOne48(i) }));
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 429]);
    assert.equal(statuses.filter((s) => s === 401).length, 4, JSON.stringify(statuses));
    assert.equal((await login(direct, PIN, { from: "192.0.2.77" })).status, 200);
  });

  it("holds one /48 to one place's waits however long it keeps at it", async () => {
    const heard = [];
    for (let i = 0; i < 120; i++) {
      heard.push((await login(direct, WRONG, { from: inOne48(i) })).status);
      later(30 * 1000); // an hour in all
    }
    assert.ok(heard.filter((s) => s === 401).length <= 10, `wrong guesses heard: ${heard.filter((s) => s === 401).length}`);
    assert.equal((await login(direct, PIN, { from: "2001:db8:dd:ee01::7" })).status, 200, "a home elsewhere signs in");
  });

  it("keeps two unrelated homes apart", async () => {
    assert.deepEqual(await guesses(direct, 5, (i) => ({ from: inOne56(i) })), [401, 401, 401, 401, 429]);
    const elsewhere = "2001:db8:dd:ee01::7"; // another /48
    assert.equal((await login(direct, WRONG, { from: elsewhere })).status, 401, "the other home isn't held up");
    assert.equal((await login(direct, PIN, { from: elsewhere })).status, 200, "and signs in");
  });

  it("lets one /48 add at most what one place can (8 in 10 minutes) to the pause for everyone", async () => {
    // A right password clears a network's waits, so one that has it could otherwise add many wrong guesses in 10
    // minutes: here 12, three at a time.
    for (let round = 0; round < 4; round++) {
      assert.deepEqual(await guesses(direct, 3, (i) => ({ from: inOne48(round * 3 + i) })), [401, 401, 401]);
      assert.equal((await login(direct, PIN, { from: inOne48(round * 3) })).status, 200);
      later(MINUTE);
    }
    assert.deepEqual(await guesses(direct, 21, (i) => ({ from: `203.0.113.${i + 1}` })), Array(21).fill(401));
    assert.equal((await login(direct, PIN, { from: "198.51.100.200" })).status, 200, "8 + 21 is under 30: no pause");
    assert.equal((await login(direct, WRONG, { from: "198.51.100.201" })).status, 401);
    const paused = await login(direct, PIN, { from: "198.51.100.202" });
    assert.equal(paused.status, 429, "the 30th starts the pause");
    assert.match(paused.json.error, /everyone/);
  });
});

describe("when the counts can't be written (a full disk, a locked database)", () => {
  // A database that refuses every write, as a full disk does: SQLite's query_only.
  const writes = (on, which = db) => which.pragma(`query_only = ${on ? "OFF" : "ON"}`);
  const stored = (place) => db.prepare("SELECT failures FROM sign_in_places WHERE place = ?").get(place);
  afterEach(() => writes(true));

  it("turns new sign-ins away unchecked, keeps anyone signed in, and opens again by itself once a write works", async () => {
    const signedIn = await login(direct, PIN, { from: "198.51.100.9" });
    assert.equal(signedIn.status, 200);
    writes(false);
    const wrong = await login(direct, WRONG, { from: "203.0.113.5" });
    assert.equal(wrong.status, 429);
    assert.equal(wrong.retryAfter, 60);
    assert.match(wrong.json.error, /can't record sign-in attempts right now \(is the disk full\?\), so new sign-ins are paused/);
    assert.match(wrong.json.error, /already signed in stays signed in/);
    const right = await login(direct, PIN, { from: "198.51.100.10" });
    assert.equal(right.status, 429, "the right password too: a try that can't be counted isn't checked");
    assert.equal(right.cookie, "", "nobody is signed in");
    assert.deepEqual(await guesses(direct, 30, (i) => ({ from: `192.0.2.${i + 1}` })), Array(30).fill(429), "nothing is checked");
    assert.equal((await send(direct, { method: "GET", path: "/private", cookie: signedIn.cookie, from: "198.51.100.9" })).status, 200, "the sign-in still works");

    writes(true);
    assert.equal((await login(direct, WRONG, { from: "203.0.113.5" })).status, 401, "the next try is counted, then checked");
    assert.equal(stored("203.0.113.5")?.failures, 1, "the tries turned away weren't counted");
    assert.equal((await login(direct, PIN, { from: "198.51.100.10" })).status, 200);
  });

  it("turns sign-ins away while another program holds tarsee.db's write lock", async () => {
    const holder = new Database(path.join(tmp, "data", "tarsee.db"));
    db.pragma("busy_timeout = 50"); // Tarsee waits 5 s for a lock (src/db/sqlite.js); not this test
    try {
      holder.exec("BEGIN IMMEDIATE");
      const locked = await login(direct, PIN, { from: "198.51.100.10" });
      assert.equal(locked.status, 429);
      assert.match(locked.json.error, /can't record sign-in attempts/);
      holder.exec("ROLLBACK");
      assert.equal((await login(direct, PIN, { from: "198.51.100.10" })).status, 200, "and opens once the lock is let go");
    } finally {
      if (holder.inTransaction) holder.exec("ROLLBACK");
      holder.close();
      db.pragma("busy_timeout = 5000");
    }
  });

  it("writes, at the next sweep, a right password's clear that couldn't be written", async () => {
    await guesses(direct, 2, () => ({ from: "203.0.113.5" }));
    db.exec("CREATE TRIGGER keep_places BEFORE DELETE ON sign_in_places BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    try {
      const right = await login(direct, PIN, { from: "203.0.113.5" });
      assert.equal(right.status, 200, "the try was counted before the password was checked, so it signs in");
      assert.equal(stored("203.0.113.5")?.failures, 3, "the database still has it as a wrong password: one more, never fewer");
    } finally {
      db.exec("DROP TRIGGER keep_places");
    }
    sweep();
    assert.equal(stored("203.0.113.5"), undefined, "cleared");
    const pause = db.prepare("SELECT wrong FROM sign_in_pause WHERE id = 1").get();
    assert.equal(JSON.parse(pause.wrong).length, 2, "and the count for everyone has the two wrong passwords, not three");
  });

  it("turns sign-ins away while it can't read the counts back, and reads them once it can", async () => {
    const other = initDb(path.join(tmp, "data", "unreadable.db"));
    try {
      auth.initSessionStore(other);
      other.exec("DROP TABLE sign_in_places; DROP TABLE sign_in_pause;");
      writes(false, other);
      auth.initSessionStore(other); // a boot that can't make its tables
      const refused = await login(direct, PIN, { from: "198.51.100.10" });
      assert.equal(refused.status, 429);
      assert.match(refused.json.error, /can't record sign-in attempts/);
      writes(true, other);
      assert.equal((await login(direct, WRONG, { from: "198.51.100.10" })).status, 401, "opens by itself");
      assert.equal((await login(direct, PIN, { from: "198.51.100.10" })).status, 200);
    } finally {
      writes(true, other);
      auth.initSessionStore(db);
      other.close();
    }
  });
});

describe("what Tarsee says at boot about signing in", () => {
  const notes = (password, env = {}) => auth.signInBootNotes({ password, env });
  const shortWarning = (list) => list.find((n) => /SETUP_PASSWORD/.test(n.text));

  it("warns when SETUP_PASSWORD is shorter than 12 characters", () => {
    for (const pw of ["4821", "12345678901", "pässwörd12"]) {
      const warning = shortWarning(notes(pw));
      assert.ok(warning, `no warning for a ${pw.length}-character password`);
      assert.equal(warning.level, "warn");
      assert.match(warning.text, new RegExp(`only ${[...pw].length} characters`));
      assert.match(warning.text, /12 or more/);
      assert.ok(!warning.text.includes(pw), "never says the password");
    }
    assert.equal(shortWarning(notes("correct horse battery")), undefined);
    assert.equal(shortWarning(notes("123456789012")), undefined, "12 is enough");
    assert.equal(shortWarning(notes(null)), undefined, "no password is said elsewhere (server.js stops in production)");
  });

  it("says which proxy it believes, what loopback costs, and what it skipped", () => {
    assert.match(notes("correct horse battery").map((n) => n.text).join("\n"), /each connection's own address.*TARSEE_TRUSTED_PROXY/s);
    const loop = notes("correct horse battery", { TARSEE_TRUSTED_PROXY: "loopback" }).map((n) => n.text).join("\n");
    assert.match(loop, /this machine/);
    assert.match(loop, /AI's shell/);
    const skipped = notes("correct horse battery", { TARSEE_TRUSTED_PROXY: "10.0.0.2, nginx" });
    assert.ok(skipped.some((n) => n.level === "warn" && /nginx/.test(n.text)), JSON.stringify(skipped));
    assert.ok(skipped.some((n) => /10\.0\.0\.2/.test(n.text)), JSON.stringify(skipped));
    const railway = notes("correct horse battery", { RAILWAY_PROJECT_ID: "p", TARSEE_TRUSTED_PROXY: "loopback" }).map((n) => n.text).join("\n");
    assert.match(railway, /ignored on Railway/);
  });
});

describe("server.js", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  it("sets the trust proxy the tests above use", () => {
    assert.match(src, /app\.set\("trust proxy", trustProxyHop\)/);
  });
  it("logs the sign-in notes at boot", () => {
    assert.match(src, /^for \(const note of signInBootNotes\(\)\) console\[note\.level\]\(note\.text\);/m);
  });
});
