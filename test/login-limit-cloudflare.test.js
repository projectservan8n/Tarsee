// Signing in with Cloudflare in front of Tarsee: TARSEE_TRUSTED_PROXY=cloudflare.
//   - The client comes only from the CF-Connecting-IP header Cloudflare sets, never from X-Forwarded-For: a Worker on
//     anyone's Cloudflare account sends requests from Cloudflare's own addresses, and Cloudflare appends to whatever
//     X-Forwarded-For it carries, so a walk back through Cloudflare's ranges would stop at an address the Worker made up.
//   - It is believed from this machine (cloudflared), from Cloudflare's published ranges (built in), and from addresses
//     the owner names alongside (a cloudflared container). From anywhere else it is the connection's own address.
//   - Every request a Worker sends (Cloudflare adds CF-Worker to each) counts as the Worker's own address, one place:
//     to a host outside Cloudflare, a Worker may write any CF-Connecting-IP it likes.
//   - Pseudo IPv4 (Overwrite Headers) puts a Class E address in CF-Connecting-IP; the real IPv6 address is then taken
//     from CF-Connecting-IPv6, so one home's /64s still count as one place.
//   - Cloudflare's ranges in the plain list of X-Forwarded-For proxies are left out, and the boot log points to
//     "cloudflare".
// The real authRouter runs behind server.js's trust proxy setting, over a real database, as in login-limit.test.js.
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-login-cloudflare-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.SETUP_PASSWORD = "4821";
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.TARSEE_TRUSTED_PROXY;
const PIN = process.env.SETUP_PASSWORD;
const WRONG = "0000";

// auth.js's housekeeping timers, caught so they never run on their own here.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => ({ unref() { return this; } });
const auth = await import("../src/middleware/auth.js");
globalThis.setInterval = realSetInterval;
const { authRouter } = await import("../src/routes/auth-routes.js");
const { initDb } = await import("../src/db/sqlite.js");

const db = initDb(path.join(tmp, "data", "tarsee.db"));
auth.initSessionStore(db);

const HOUR = 60 * 60_000;
const ownAddresses = new Set(Object.values(os.networkInterfaces()).flat().map((nic) => nic.address));
const notOwn = (...candidates) => candidates.find((a) => !ownAddresses.has(a));

// Cloudflare's published ranges, https://www.cloudflare.com/ips-v4 and /ips-v6, as of November 2026.
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
// What Cloudflare sets CF-Connecting-IP to on a Worker's request to another account's site; inside 2a06:98c0::/29.
const WORKER = "2a06:98c0:3600::103";
const WORKER_PLACE = "2a06:98c0:3600:0::/64"; // its /64, as signInKey writes one
// One of Cloudflare's edges, connecting to Tarsee's port (162.158.0.0/15), and one over IPv6 (2400:cb00::/32).
const EDGE = "162.158.1.9";
const EDGE6 = "2400:cb00:2049:1::a29f:1a0b";
// A connection from outside Cloudflare, and Docker's bridge gateway.
const OUTSIDE = "203.0.113.50";
const GATEWAY = notOwn("172.17.0.1", "172.18.0.1", "172.19.0.1");
// A cloudflared container on the same Docker network, and one beside it the owner didn't name.
const CLOUDFLARED = notOwn("172.18.0.5", "172.19.0.5", "172.20.0.5");
const NEIGHBOUR = notOwn("172.18.0.6", "172.19.0.6", "172.20.0.6");
// Railway's proxy in front of the container.
const RAILWAY_PROXY = notOwn("100.64.0.20", "10.255.254.20");

// One home's /56 (2001:db8:aa:bb00::/56), a /64 each; and Pseudo IPv4's Class E stand-ins for them.
const inOne56 = (i) => `2001:db8:aa:bb${i.toString(16).padStart(2, "0")}::1`;
const pseudo = (i) => `240.0.${i}.1`;

const app = express();
app.set("trust proxy", auth.trustProxyHop);
app.use(express.json());
app.use(auth.sessionAuth);
app.get("/whoami", (req, res) => res.json({ ip: req.ip, place: auth.signInKey(req) }));
app.use("/api/auth", authRouter);
const local = http.createServer(app);
// Connections from whatever address `peer` names when they open (each request opens its own).
let peer = OUTSIDE;
const direct = http.createServer(app);
direct.on("connection", (socket) => Object.defineProperty(socket, "remoteAddress", { value: peer, configurable: true }));

function send(server, { method = "POST", path: urlPath = "/api/auth/login", password, from, cf, cf6, worker, xff, realIp } = {}) {
  if (from) peer = from;
  return new Promise((resolve, reject) => {
    const body = method === "POST" ? JSON.stringify({ password }) : "";
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (cf) headers["cf-connecting-ip"] = cf;
    if (cf6) headers["cf-connecting-ipv6"] = cf6;
    if (worker) headers["cf-worker"] = worker;
    if (xff) headers["x-forwarded-for"] = xff;
    if (realIp) headers["x-real-ip"] = realIp;
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path: urlPath, method, headers, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const login = (server, password, opts = {}) => send(server, { ...opts, password });
const whoami = async (server, opts = {}) => (await send(server, { ...opts, method: "GET", path: "/whoami" })).json;

/** Status codes of `n` wrong guesses, the i-th sent with opts(i). */
async function guesses(server, n, opts = () => ({})) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await login(server, WRONG, opts(i))).status);
  return out;
}

/** That 30 guesses, each naming a new client, were one place: three free, a wait from the fourth, and no pause. */
async function onePlace(server, opts, owner) {
  const statuses = await guesses(server, 30, opts);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 429], JSON.stringify(statuses));
  assert.equal(statuses.filter((s) => s === 401).length, 4, JSON.stringify(statuses));
  if (owner) assert.equal((await login(server, PIN, owner)).status, 200, "no pause for everyone: the owner signs in");
}

let clock = Date.parse("2026-01-05T09:00:00Z");
function setClock(ms) {
  clock = ms;
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: ms });
}

before(async () => {
  for (const server of [local, direct]) await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(async () => {
  mock.timers.reset();
  for (const server of [local, direct]) await new Promise((r) => server.close(r));
  db.close();
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.TARSEE_TRUSTED_PROXY;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  auth.__resetSignInLimitsForTests();
  delete process.env.RAILWAY_PROJECT_ID;
  process.env.TARSEE_TRUSTED_PROXY = "cloudflare";
  setClock(clock + 2 * 24 * HOUR);
});

describe("TARSEE_TRUSTED_PROXY=cloudflare, with cloudflared on this machine", () => {
  it("limits two clients apart by the CF-Connecting-IP Cloudflare sets, and req.ip is the client", async () => {
    const a = { cf: "203.0.113.5", xff: "203.0.113.5" };
    const b = { cf: "198.51.100.7", xff: "198.51.100.7" };
    assert.deepEqual(await guesses(local, 5, () => a), [401, 401, 401, 401, 429]);
    assert.equal((await login(local, WRONG, b)).status, 401, "the other client isn't held up");
    assert.equal((await login(local, PIN, b)).status, 200, "and signs in");
    assert.deepEqual(await whoami(local, b), { ip: "198.51.100.7", place: "198.51.100.7" });
  });

  it("never walks X-Forwarded-For: a Worker on another Cloudflare account, forging it each guess, is one place", async () => {
    // Cloudflare sets CF-Connecting-IP to the Worker's address and appends that to the X-Forwarded-For the Worker sent.
    await onePlace(local, (i) => ({ cf: WORKER, xff: `198.18.${i}.1, ${WORKER}` }), { cf: "198.51.100.7", xff: "198.51.100.7" });
    assert.equal((await whoami(local, { cf: WORKER, xff: `198.18.99.1, ${WORKER}` })).place, WORKER_PLACE);
  });

  it("the same through nginx on this machine, which appends the edge it heard from", async () => {
    await onePlace(local, (i) => ({ cf: WORKER, xff: `198.18.${i}.1, ${WORKER}, ${EDGE}` }), { cf: "198.51.100.7", xff: `198.51.100.7, ${EDGE}` });
  });

  it("doesn't believe CF-Connecting-IP when the proxy on this machine heard the request from outside Cloudflare", async () => {
    // nginx reachable from anywhere: what it appends last is who it heard from, here not Cloudflare.
    await onePlace(local, (i) => ({ cf: `198.18.${i}.1`, xff: `198.18.${i}.1, ${OUTSIDE}` }), { cf: "198.51.100.7", xff: `198.51.100.7, ${EDGE}` });
    assert.equal((await whoami(local, { cf: "198.18.99.1", xff: `198.18.99.1, ${OUTSIDE}` })).place, "this machine");
  });

  it("counts a request from this machine without CF-Connecting-IP as this machine, whatever X-Forwarded-For says", async () => {
    assert.equal((await whoami(local)).place, "this machine");
    await onePlace(local, (i) => ({ xff: `198.18.${i}.1` }), { cf: "198.51.100.7" });
  });

  it("isn't fooled by a CF-Connecting-IP that names several addresses or none", async () => {
    assert.equal((await whoami(local, { cf: "198.18.0.1, 198.18.0.2" })).place, "this machine");
    assert.equal((await whoami(local, { cf: "nobody" })).place, "this machine");
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare, with Cloudflare's edge connecting to Tarsee's port", () => {
  it("believes CF-Connecting-IP from any of Cloudflare's published ranges, IPv4 and IPv6", async () => {
    for (const [edge, client] of [[EDGE, "203.0.113.5"], [EDGE6, "2001:db8:5:6::1"], ["131.0.72.9", "198.51.100.7"], ["2c0f:f248::1", "192.0.2.4"]]) {
      const me = await whoami(direct, { from: edge, cf: client, xff: client });
      assert.equal(me.ip, client, `through ${edge}`);
    }
    assert.deepEqual(await guesses(direct, 5, () => ({ from: EDGE, cf: "203.0.113.5" })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, PIN, { from: EDGE6, cf: "198.51.100.7" })).status, 200, "another client through another edge");
  });

  it("counts every request a Worker sends as the Worker's own address, whatever CF-Connecting-IP it writes", async () => {
    // To a host outside Cloudflare (Tarsee's own address, say), a Worker may write any CF-Connecting-IP; Cloudflare
    // still adds CF-Worker, the name of the Worker's zone.
    await onePlace(direct, (i) => ({ from: EDGE, worker: `guesser${i}.example`, cf: `198.18.${i}.1`, xff: `198.18.${i}.1` }), { from: EDGE, cf: "198.51.100.7" });
    assert.equal((await whoami(direct, { from: EDGE, worker: "guesser.example", cf: "198.18.99.1" })).place, WORKER_PLACE);
  });

  it("doesn't believe CF-Connecting-IP from a peer outside Cloudflare's ranges", async () => {
    await onePlace(direct, (i) => ({ from: OUTSIDE, cf: `198.18.${i}.1` }), { from: EDGE, cf: "198.51.100.7" });
    assert.deepEqual(await whoami(direct, { from: OUTSIDE, cf: "198.18.99.1" }), { ip: OUTSIDE, place: OUTSIDE });
    assert.deepEqual(await guesses(direct, 5, (i) => ({ from: GATEWAY, cf: `192.0.2.${i + 1}` })), [401, 401, 401, 401, 429], "nor from Docker's gateway");
  });

  it("doesn't take X-Forwarded-For from an edge either", async () => {
    await onePlace(direct, (i) => ({ from: EDGE, xff: `198.18.${i}.1` }), { from: EDGE, cf: "198.51.100.7" });
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare and Pseudo IPv4", () => {
  it("Overwrite Headers: takes the client from CF-Connecting-IPv6, so one home's /64s are still one place", async () => {
    await onePlace(local, (i) => ({ cf: pseudo(i), xff: pseudo(i), cf6: inOne56(i) }), { cf: pseudo(200), xff: pseudo(200), cf6: "2001:db8:dd:ee01::7" });
    assert.equal((await whoami(local, { cf: pseudo(5), cf6: inOne56(5) })).place, "2001:db8:aa:bb05::/64");
  });

  it("counts every Class E address that comes without its IPv6 address as one place", async () => {
    await onePlace(local, (i) => ({ cf: pseudo(i), xff: pseudo(i) }), { cf: "198.51.100.7" });
    assert.equal((await whoami(local, { cf: pseudo(9) })).place, "240.0.0.0/4");
  });

  it("ignores CF-Connecting-IPv6 next to a real CF-Connecting-IP: a client could have written it", async () => {
    await onePlace(local, (i) => ({ cf: "203.0.113.5", cf6: `2001:db8:${i + 1}::1` }), { cf: "198.51.100.7" });
  });

  it("ignores a CF-Connecting-IPv6 that isn't one IPv6 address", async () => {
    assert.equal((await whoami(local, { cf: pseudo(1), cf6: "198.18.0.1" })).place, "240.0.0.0/4");
    assert.equal((await whoami(local, { cf: pseudo(1), cf6: "2001:db8:1::1, 2001:db8:2::1" })).place, "240.0.0.0/4");
  });

  it("with TARSEE_TRUSTED_PROXY=loopback, cloudflared and Overwrite Headers: the same", async () => {
    process.env.TARSEE_TRUSTED_PROXY = "loopback";
    await onePlace(local, (i) => ({ xff: pseudo(i), cf6: inOne56(i) }), { xff: pseudo(200), cf6: "2001:db8:dd:ee01::7" });
    assert.equal((await whoami(local, { xff: pseudo(9) })).place, "240.0.0.0/4", "and without CF-Connecting-IPv6, one place");
  });

  it("never swaps the connection's own address for a header, Class E or not", async () => {
    delete process.env.TARSEE_TRUSTED_PROXY;
    assert.equal((await whoami(direct, { from: "240.1.2.3", cf6: inOne56(1) })).place, "240.1.2.3");
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare with a cloudflared container named alongside", () => {
  beforeEach(() => { process.env.TARSEE_TRUSTED_PROXY = `cloudflare, ${CLOUDFLARED}`; });

  it("believes CF-Connecting-IP from the container, and from no neighbour", async () => {
    assert.deepEqual(await guesses(direct, 5, () => ({ from: CLOUDFLARED, cf: "203.0.113.5" })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, PIN, { from: CLOUDFLARED, cf: "198.51.100.7" })).status, 200, "another client through it");
    assert.equal((await whoami(direct, { from: NEIGHBOUR, cf: "198.51.100.7" })).place, NEIGHBOUR);
    await onePlace(direct, (i) => ({ from: NEIGHBOUR, cf: `198.18.${i}.1` }));
  });

  it("still never walks X-Forwarded-For from it", async () => {
    await onePlace(direct, (i) => ({ from: CLOUDFLARED, xff: `198.18.${i}.1` }), { from: CLOUDFLARED, cf: "198.51.100.7" });
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare on Railway", () => {
  beforeEach(() => { process.env.RAILWAY_PROJECT_ID = "test-project"; });

  it("takes CF-Connecting-IP when the X-Real-IP Railway's edge sets is one of Cloudflare's", async () => {
    assert.deepEqual(await guesses(direct, 5, () => ({ from: RAILWAY_PROXY, realIp: EDGE, cf: "203.0.113.5" })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, WRONG, { from: RAILWAY_PROXY, realIp: EDGE, cf: "198.51.100.7" })).status, 401, "the other client isn't held up");
    assert.equal((await login(direct, PIN, { from: RAILWAY_PROXY, realIp: EDGE, cf: "198.51.100.7" })).status, 200);
  });

  it("doesn't believe it from a client that reached Railway's domain directly, and counts a Worker as one place", async () => {
    await onePlace(direct, (i) => ({ from: RAILWAY_PROXY, realIp: "198.51.100.9", cf: `198.18.${i}.1` }));
    auth.__resetSignInLimitsForTests();
    await onePlace(direct, (i) => ({ from: RAILWAY_PROXY, realIp: EDGE, worker: "guesser.example", cf: `198.18.${i}.1` }), { from: RAILWAY_PROXY, realIp: EDGE, cf: "198.51.100.7" });
  });

  it("is this machine from this machine, whatever it sends", async () => {
    await onePlace(local, (i) => ({ realIp: EDGE, cf: `198.18.${i}.1` }));
  });

  it("without cloudflare, Railway goes by X-Real-IP alone", async () => {
    delete process.env.TARSEE_TRUSTED_PROXY;
    await onePlace(direct, (i) => ({ from: RAILWAY_PROXY, realIp: EDGE, cf: `198.18.${i}.1` }));
  });
});

describe("Cloudflare's ranges in the list of X-Forwarded-For proxies", () => {
  it("has today's list built in", () => {
    assert.deepEqual([...auth.CLOUDFLARE_RANGES], CLOUDFLARE);
  });

  it("are left out, and the boot log points to cloudflare", () => {
    const trust = auth.trustedProxies(`loopback, ${CLOUDFLARE.join(", ")}`);
    assert.deepEqual(trust.names, ["loopback"]);
    assert.deepEqual(trust.refused, CLOUDFLARE);
    const inside = auth.trustedProxies("104.16.5.5, 104.0.0.0/8, 2a06:98c0:3600::/48, 172.16.0.0/12, 100.64.0.0/10, fd00::/8");
    assert.deepEqual(inside.refused, ["104.16.5.5", "104.0.0.0/8", "2a06:98c0:3600::/48"], "an address in one, a range around one, a range in one");
    assert.deepEqual(inside.names, ["172.16.0.0/12", "100.64.0.0/10", "fd00::/8"], "private ranges are kept");
    const notes = auth.signInBootNotes({ password: "correct horse battery", env: { TARSEE_TRUSTED_PROXY: `loopback, ${CLOUDFLARE.join(", ")}` } });
    const warning = notes.find((n) => n.level === "warn" && /Cloudflare/.test(n.text));
    assert.ok(warning, JSON.stringify(notes));
    assert.match(warning.text, /TARSEE_TRUSTED_PROXY=cloudflare/);
    assert.match(warning.text, /Worker/);
  });

  it("so a Worker forging X-Forwarded-For through Cloudflare and nginx is one place (the readme's old example)", async () => {
    process.env.TARSEE_TRUSTED_PROXY = `loopback, ${CLOUDFLARE.join(", ")}`;
    await onePlace(local, (i) => ({ xff: `198.18.${i}.1, ${WORKER}, ${EDGE}` }), { xff: "198.51.100.7, 162.158.9.9" });
  });

  it("with loopback alone and cloudflared, a Worker forging X-Forwarded-For is one place", async () => {
    process.env.TARSEE_TRUSTED_PROXY = "loopback";
    await onePlace(local, (i) => ({ xff: `198.18.${i}.1, ${WORKER}` }), { xff: "198.51.100.7" });
  });
});

describe("what Tarsee says about cloudflare", () => {
  const text = (env) => auth.signInBootNotes({ password: "correct horse battery", env }).map((n) => `${n.level}: ${n.text}`).join("\n");

  it("reads the word, in any case, with addresses beside it", () => {
    const trust = auth.trustedProxies(`Cloudflare, ${CLOUDFLARED}, nginx`);
    assert.equal(trust.cloudflare, true);
    assert.deepEqual(trust.names, ["cloudflare", CLOUDFLARED]);
    assert.deepEqual(trust.skipped, ["nginx"]);
    assert.equal(auth.trustedProxies("loopback").cloudflare, false);
  });

  it("says where it takes the client from, and what it costs", () => {
    const said = text({ TARSEE_TRUSTED_PROXY: "cloudflare" });
    assert.match(said, /log: .*CF-Connecting-IP/);
    assert.match(said, /X-Forwarded-For is never believed/);
    assert.match(said, /Worker/);
    assert.match(said, /cloudflare\.com\/ips/);
    assert.match(said, /warn: .*AI's shell/, "anything on this machine can name a client, as with loopback");
    assert.match(text({ TARSEE_TRUSTED_PROXY: `cloudflare, ${CLOUDFLARED}` }), new RegExp(CLOUDFLARED.replace(/\./g, "\\.")));
  });

  it("on Railway uses cloudflare, and ignores the rest", () => {
    const said = text({ RAILWAY_PROJECT_ID: "p", TARSEE_TRUSTED_PROXY: "cloudflare" });
    assert.match(said, /CF-Connecting-IP/);
    assert.doesNotMatch(said, /ignored/);
    assert.match(text({ RAILWAY_PROJECT_ID: "p", TARSEE_TRUSTED_PROXY: "loopback" }), /ignored on Railway/);
  });

  it("says once when CF-Connecting-IP comes from somewhere it doesn't believe", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await login(direct, WRONG, { from: OUTSIDE, cf: "198.18.0.1" });
    await login(direct, WRONG, { from: OUTSIDE, cf: "198.18.0.2" });
    const said = warn.mock.calls.map((c) => c.arguments.join(" ")).filter((s) => /CF-Connecting-IP/.test(s));
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.match(said[0], new RegExp(OUTSIDE.replace(/\./g, "\\.")));
  });

  it("points to cloudflare when Cloudflare's headers arrive and it isn't set", async (t) => {
    delete process.env.TARSEE_TRUSTED_PROXY;
    const warn = t.mock.method(console, "warn", () => {});
    await login(direct, WRONG, { from: EDGE, cf: "198.18.0.1", xff: "198.18.0.1" });
    const said = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(said, /TARSEE_TRUSTED_PROXY=cloudflare/);
  });
});

describe("the Terminal's place (a WebSocket upgrade, not an Express request)", () => {
  it("comes from CF-Connecting-IP the same way", () => {
    const req = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
    assert.equal(auth.signInKey(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.5" })), "203.0.113.5");
    assert.equal(auth.signInKey(req(EDGE, { "cf-connecting-ip": "203.0.113.5", "cf-worker": "guesser.example" })), WORKER_PLACE);
    assert.equal(auth.signInKey(req(OUTSIDE, { "cf-connecting-ip": "203.0.113.5" })), OUTSIDE);
  });
});
