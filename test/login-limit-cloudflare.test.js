// Signing in with Cloudflare in front of Tarsee: TARSEE_TRUSTED_PROXY=cloudflare.
//   - One rule finds the client: start at the connection's address; while that is a proxy the owner named beside
//     cloudflare ("loopback" for cloudflared or nginx on this machine, or a container's address), step back one address
//     in X-Forwarded-For, the address that proxy heard from (from cloudflared, the client Cloudflare's edge put last).
//     Where that ends on one of Cloudflare's published addresses, the client is the CF-Connecting-IP header Cloudflare
//     sets, but only on a request that carries the X-Tarsee-Cloudflare header the owner's own Cloudflare zone adds
//     (TARSEE_CLOUDFLARE_SECRET). Without it, the client is that Cloudflare address.
//   - Why the header: anyone with a Cloudflare account can point their own zone at Tarsee's port or Railway domain, and
//     a Snippet or a Spectrum app there sends from Cloudflare's addresses with a CF-Connecting-IP of their choosing.
//     Only a value the owner's zone adds tells the owner's own requests apart.
//   - "cloudflare" alone believes nothing from this machine: the AI's shell runs here.
//   - Pseudo IPv4 (Overwrite Headers) puts a Class E address in CF-Connecting-IP and X-Forwarded-For; the client is
//     then CF-Connecting-IPv6, so one home's /64s still count as one place.
//   - Cloudflare's ranges in the plain list of X-Forwarded-For proxies are left out, and the boot log points to
//     "cloudflare".
// The real authRouter runs behind server.js's trust proxy setting, over a real database, as in login-limit.test.js.
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-login-cloudflare-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
process.env.SETUP_PASSWORD = "4821";
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.TARSEE_TRUSTED_PROXY;
delete process.env.TARSEE_CLOUDFLARE_SECRET;
const PIN = process.env.SETUP_PASSWORD;
const WRONG = "0000";
// The value the owner's Transform Rule sets, and Tarsee's TARSEE_CLOUDFLARE_SECRET. Made from words, for the test.
const SECRET = ["owner", "zone", "adds", "this", "value", "only"].join("-");

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
// Cloudflare's edges, connecting to Tarsee's port (162.158.0.0/15 and 172.64.0.0/13), and one over IPv6 (2400:cb00::/32).
const EDGE = "162.158.1.9";
const EDGE2 = "172.70.4.4";
const EDGE6 = "2400:cb00:2049:1::a29f:1a0b";
// Two clients, the owner among them, and someone guessing from their own address outside Cloudflare.
const OWNER = "198.51.100.7";
const CLIENT = "203.0.113.5";
const ATTACKER = "203.0.113.77";
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

/** proof: true sends the owner's X-Tarsee-Cloudflare value, a string sends that string instead. */
function send(server, { method = "POST", path: urlPath = "/api/auth/login", password, from, cf, cf6, worker, xff, realIp, proof } = {}) {
  if (from) peer = from;
  return new Promise((resolve, reject) => {
    const body = method === "POST" ? JSON.stringify({ password }) : "";
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (cf) headers["cf-connecting-ip"] = cf;
    if (cf6) headers["cf-connecting-ipv6"] = cf6;
    if (worker) headers["cf-worker"] = worker;
    if (xff) headers["x-forwarded-for"] = xff;
    if (realIp) headers["x-real-ip"] = realIp;
    if (proof) headers["x-tarsee-cloudflare"] = proof === true ? SECRET : proof;
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
async function onePlace(server, opts) {
  const statuses = await guesses(server, 30, opts);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 429], JSON.stringify(statuses));
  assert.equal(statuses.filter((s) => s === 401).length, 4, JSON.stringify(statuses));
}

// The owner signing in through Cloudflare's edge, from their own zone: Cloudflare sets CF-Connecting-IP, and the
// owner's Transform Rule adds X-Tarsee-Cloudflare.
const ownerThroughEdge = { from: EDGE, cf: OWNER, xff: OWNER, proof: true };
async function ownerSignsIn(why) {
  assert.equal((await login(direct, PIN, ownerThroughEdge)).status, 200, why);
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
  delete process.env.TARSEE_CLOUDFLARE_SECRET;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  auth.__resetSignInLimitsForTests();
  delete process.env.RAILWAY_PROJECT_ID;
  process.env.TARSEE_TRUSTED_PROXY = "cloudflare";
  process.env.TARSEE_CLOUDFLARE_SECRET = SECRET;
  setClock(clock + 2 * 24 * HOUR);
});

describe("TARSEE_TRUSTED_PROXY=cloudflare: Cloudflare's edge connecting to Tarsee's port", () => {
  it("believes CF-Connecting-IP from Cloudflare's ranges, IPv4 and IPv6, with the header the owner's zone adds", async () => {
    for (const [edge, client] of [[EDGE, CLIENT], [EDGE6, "2001:db8:5:6::1"], ["131.0.72.9", OWNER], ["2c0f:f248::1", "192.0.2.4"]]) {
      const me = await whoami(direct, { from: edge, cf: client, xff: client, proof: true });
      assert.equal(me.ip, client, `through ${edge}`);
    }
    assert.deepEqual(await guesses(direct, 5, () => ({ from: EDGE, cf: CLIENT, proof: true })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, PIN, { from: EDGE6, cf: OWNER, proof: true })).status, 200, "another client through another edge");
  });

  it("without that header, a request from Cloudflare's edge is that edge's own address, whatever CF-Connecting-IP says", async () => {
    // Another account's zone pointed at Tarsee's port: a Snippet there sets x-real-ip (so CF-Connecting-IP) on its
    // request, or a Spectrum app sends raw TCP, from Cloudflare's addresses and with no CF-Worker.
    await onePlace(direct, (i) => ({ from: EDGE, cf: `198.18.${i}.1`, xff: `198.18.${i}.1` }));
    await ownerSignsIn("no pause for everyone, and the owner's place is the owner's own");
    assert.deepEqual(await whoami(direct, { from: EDGE, cf: "198.18.99.1" }), { ip: EDGE, place: EDGE });
  });

  it("a wrong value, or the right one sent twice, is no header", async () => {
    await onePlace(direct, (i) => ({ from: EDGE, cf: `198.18.${i}.1`, proof: `${SECRET.slice(0, -1)}${i % 10}` }));
    assert.equal((await whoami(direct, { from: EDGE, cf: "198.18.99.1", proof: `${SECRET}, ${SECRET}` })).place, EDGE);
    assert.equal((await whoami(direct, { from: EDGE, cf: "198.18.99.1", proof: ` ${SECRET}x` })).place, EDGE);
  });

  it("naming the owner's address without the header doesn't make the owner wait", async () => {
    assert.deepEqual(await guesses(direct, 8, () => ({ from: EDGE2, cf: OWNER, xff: OWNER })), [401, 401, 401, 401, 429, 429, 429, 429]);
    await ownerSignsIn("the guesses counted against the edge they came from, not against the owner");
  });

  it("counts a Worker on another account as its one address, and the owner's own Worker by its client", async () => {
    // Into the owner's zone, Cloudflare sets CF-Connecting-IP to the Worker's address and appends that to the
    // X-Forwarded-For the Worker sent; the owner's Transform Rule still adds its header.
    await onePlace(direct, (i) => ({ from: EDGE, worker: "guesser.example", cf: WORKER, xff: `198.18.${i}.1, ${WORKER}`, proof: true }));
    assert.equal((await whoami(direct, { from: EDGE, worker: "guesser.example", cf: WORKER, proof: true })).place, WORKER_PLACE);
    // The owner's own Worker in front passes the client's address on; CF-Worker is the owner's own zone.
    assert.equal((await whoami(direct, { from: EDGE, worker: "owner.example", cf: CLIENT, proof: true })).place, CLIENT);
  });

  it("never believes CF-Connecting-IP from this machine: the AI's shell is one place, header or not", async () => {
    // The reviewer's attack: 30 guesses from 127.0.0.1, each naming a new client, with or without X-Forwarded-For.
    await onePlace(local, (i) => ({ cf: `198.18.${i}.1`, xff: `198.18.${i}.1`, proof: true }));
    await ownerSignsIn("no pause for everyone");
    auth.__resetSignInLimitsForTests();
    await onePlace(local, (i) => ({ cf: `198.18.${i}.1`, cf6: ATTACKER, xff: ATTACKER }));
    await ownerSignsIn("no pause for everyone");
    assert.equal((await whoami(local, { cf: OWNER, proof: true })).place, "this machine");
  });

  it("doesn't believe CF-Connecting-IP from a peer outside Cloudflare's ranges, header or not", async () => {
    await onePlace(direct, (i) => ({ from: OUTSIDE, cf: `198.18.${i}.1`, proof: true }));
    assert.deepEqual(await whoami(direct, { from: OUTSIDE, cf: "198.18.99.1", proof: true }), { ip: OUTSIDE, place: OUTSIDE });
    assert.deepEqual(await guesses(direct, 5, (i) => ({ from: GATEWAY, cf: `192.0.2.${i + 1}`, proof: true })), [401, 401, 401, 401, 429], "nor from Docker's gateway");
  });

  it("doesn't take X-Forwarded-For from an edge", async () => {
    await onePlace(direct, (i) => ({ from: EDGE, xff: `198.18.${i}.1`, proof: true }));
  });

  it("uses no TARSEE_CLOUDFLARE_SECRET shorter than 16 characters", async () => {
    process.env.TARSEE_CLOUDFLARE_SECRET = "short-one";
    await onePlace(direct, (i) => ({ from: EDGE, cf: `198.18.${i}.1`, proof: "short-one" }));
  });

  it("without TARSEE_CLOUDFLARE_SECRET, every request from an edge is that edge's address", async () => {
    auth.__resetSignInLimitsForTests();
    delete process.env.TARSEE_CLOUDFLARE_SECRET;
    assert.equal((await whoami(direct, { from: EDGE, cf: CLIENT, proof: "" })).place, EDGE);
    assert.equal((await whoami(direct, { from: EDGE, cf: CLIENT, proof: "undefined" })).place, EDGE);
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare and Pseudo IPv4, through the edge", () => {
  it("Overwrite Headers: takes the client from CF-Connecting-IPv6, so one home's /64s are still one place", async () => {
    await onePlace(direct, (i) => ({ from: EDGE, cf: pseudo(i), xff: pseudo(i), cf6: inOne56(i), proof: true }));
    assert.equal((await whoami(direct, { from: EDGE, cf: pseudo(5), cf6: inOne56(5), proof: true })).place, "2001:db8:aa:bb05::/64");
    assert.equal((await login(direct, PIN, { from: EDGE, cf: pseudo(200), cf6: "2001:db8:dd:ee01::7", proof: true })).status, 200);
  });

  it("counts every Class E address that comes without its IPv6 address as one place", async () => {
    await onePlace(direct, (i) => ({ from: EDGE, cf: pseudo(i), xff: pseudo(i), proof: true }));
    assert.equal((await whoami(direct, { from: EDGE, cf: pseudo(9), proof: true })).place, "240.0.0.0/4");
  });

  it("ignores CF-Connecting-IPv6 next to a real CF-Connecting-IP: a client could have written it", async () => {
    await onePlace(direct, (i) => ({ from: EDGE, cf: CLIENT, cf6: `2001:db8:${i + 1}::1`, proof: true }));
  });

  it("ignores a CF-Connecting-IPv6 that isn't one IPv6 address", async () => {
    assert.equal((await whoami(direct, { from: EDGE, cf: pseudo(1), cf6: "198.18.0.1", proof: true })).place, "240.0.0.0/4");
    assert.equal((await whoami(direct, { from: EDGE, cf: pseudo(1), cf6: "2001:db8:1::1, 2001:db8:2::1", proof: true })).place, "240.0.0.0/4");
  });

  it("never swaps the connection's own address for a header, Class E or not", async () => {
    delete process.env.TARSEE_TRUSTED_PROXY;
    assert.equal((await whoami(direct, { from: "240.1.2.3", cf6: inOne56(1) })).place, "240.1.2.3");
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare, loopback: cloudflared on this machine", () => {
  // cloudflared passes on the X-Forwarded-For Cloudflare's edge sent, adding nothing: the edge put the client last.
  // A tunnel proves the request came through the owner's own zone, so no header is needed.
  beforeEach(() => {
    process.env.TARSEE_TRUSTED_PROXY = "cloudflare, loopback";
    delete process.env.TARSEE_CLOUDFLARE_SECRET;
  });

  it("limits two clients apart by the address the edge put last in X-Forwarded-For, and req.ip is the client", async () => {
    assert.deepEqual(await guesses(local, 5, () => ({ cf: CLIENT, xff: CLIENT })), [401, 401, 401, 401, 429]);
    assert.equal((await login(local, WRONG, { cf: OWNER, xff: OWNER })).status, 401, "the other client isn't held up");
    assert.equal((await login(local, PIN, { cf: OWNER, xff: OWNER })).status, 200, "and signs in");
    assert.deepEqual(await whoami(local, { cf: OWNER, xff: OWNER }), { ip: OWNER, place: OWNER });
  });

  it("a client's own X-Forwarded-For, before the address the edge appended, changes nothing", async () => {
    await onePlace(local, (i) => ({ cf: CLIENT, xff: `198.18.${i}.1, ${CLIENT}` }));
    assert.equal((await login(local, PIN, { cf: OWNER, xff: `198.18.0.1, ${OWNER}` })).status, 200);
  });

  it("a Worker on another account, through the tunnel, is its one address", async () => {
    await onePlace(local, (i) => ({ cf: WORKER, worker: "guesser.example", xff: `198.18.${i}.1, ${WORKER}` }));
    assert.equal((await whoami(local, { cf: WORKER, xff: `198.18.99.1, ${WORKER}` })).place, WORKER_PLACE);
  });

  it("a request from this machine without X-Forwarded-For is this machine, whatever CF-Connecting-IP says", async () => {
    await onePlace(local, (i) => ({ cf: `198.18.${i}.1` }));
    assert.equal((await whoami(local, { cf: OWNER })).place, "this machine");
  });

  it("holds the AI's shell, which can name a new client in each guess, only with the limit for all places", async () => {
    // What naming loopback costs until the AI runs as its own user: anything on this machine can write the headers.
    const statuses = await guesses(local, 30, (i) => ({ cf: `198.18.${i}.1`, xff: `198.18.${i}.1` }));
    assert.deepEqual(statuses, Array(30).fill(401));
    const after30 = await login(direct, PIN, ownerThroughEdge);
    assert.equal(after30.status, 429, "then signing in pauses for everyone");
    assert.match(after30.json.error, /everyone/);
  });

  it("Overwrite Headers: the Class E address the edge put last is undone with CF-Connecting-IPv6", async () => {
    await onePlace(local, (i) => ({ cf: pseudo(i), xff: pseudo(i), cf6: inOne56(i) }));
    assert.equal((await whoami(local, { cf: pseudo(5), xff: pseudo(5), cf6: inOne56(5) })).place, "2001:db8:aa:bb05::/64");
    assert.equal((await whoami(local, { cf: pseudo(9), xff: pseudo(9) })).place, "240.0.0.0/4", "without CF-Connecting-IPv6, one place");
  });

  it("ignores CF-Connecting-IPv6 next to a real address", async () => {
    await onePlace(local, (i) => ({ cf: CLIENT, xff: CLIENT, cf6: `2001:db8:${i + 1}::1` }));
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare, loopback: nginx on this machine, adding who it heard from", () => {
  // nginx's proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for: the last address is the one nginx heard from.
  beforeEach(() => { process.env.TARSEE_TRUSTED_PROXY = "cloudflare, loopback"; });

  it("heard from Cloudflare's edge, with the owner's header: the client is CF-Connecting-IP", async () => {
    assert.deepEqual(await guesses(local, 5, () => ({ cf: CLIENT, xff: `${CLIENT}, ${EDGE}`, proof: true })), [401, 401, 401, 401, 429]);
    assert.equal((await login(local, PIN, { cf: OWNER, xff: `${OWNER}, ${EDGE}`, proof: true })).status, 200, "the other client signs in");
    assert.deepEqual(await whoami(local, { cf: OWNER, xff: `${OWNER}, ${EDGE6}`, proof: true }), { ip: OWNER, place: OWNER });
  });

  it("a Worker forging X-Forwarded-For through Cloudflare and nginx is one place", async () => {
    await onePlace(local, (i) => ({ cf: WORKER, xff: `198.18.${i}.1, ${WORKER}, ${EDGE}`, proof: true }));
  });

  it("heard from Cloudflare's edge without the owner's header: that edge's address", async () => {
    await onePlace(local, (i) => ({ cf: `198.18.${i}.1`, xff: `198.18.${i}.1, ${EDGE}` }));
    assert.equal((await whoami(local, { cf: OWNER, xff: `${OWNER}, ${EDGE}` })).place, EDGE);
  });

  it("heard from outside Cloudflare: that address, whatever CF-Connecting-IP and CF-Connecting-IPv6 say", async () => {
    // The reviewer's attack: nginx reachable from anywhere appends the guesser's own address. CF-Connecting-IPv6 is
    // that same address, CF-Connecting-IP a new one each guess, and a guess at the owner's header.
    await onePlace(local, (i) => ({ xff: ATTACKER, cf: `198.18.${i}.1`, cf6: ATTACKER, proof: `guess-${i}-at-the-owner-header` }));
    assert.equal((await login(local, PIN, { cf: OWNER, xff: `${OWNER}, ${EDGE}`, proof: true })).status, 200, "no pause for everyone");
    assert.deepEqual(await whoami(local, { xff: ATTACKER, cf: "198.18.99.1", cf6: ATTACKER }), { ip: ATTACKER, place: ATTACKER });
    // A Class E CF-Connecting-IP doesn't open CF-Connecting-IPv6 either: the address nginx heard from isn't Class E.
    auth.__resetSignInLimitsForTests();
    await onePlace(local, (i) => ({ xff: ATTACKER, cf: pseudo(i), cf6: `2001:db8:${i + 1}::1` }));
  });

  it("naming the owner's address from outside Cloudflare doesn't make the owner wait", async () => {
    assert.deepEqual(await guesses(local, 5, () => ({ xff: ATTACKER, cf: OWNER, cf6: ATTACKER })), [401, 401, 401, 401, 429]);
    assert.equal((await login(local, PIN, { cf: OWNER, xff: `${OWNER}, ${EDGE}`, proof: true })).status, 200);
    assert.equal((await login(direct, PIN, ownerThroughEdge)).status, 200, "nor through the edge straight to the port");
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare with a cloudflared container named beside it", () => {
  beforeEach(() => { process.env.TARSEE_TRUSTED_PROXY = `cloudflare, ${CLOUDFLARED}`; });

  it("takes the client the edge put last, from the container only", async () => {
    assert.deepEqual(await guesses(direct, 5, () => ({ from: CLOUDFLARED, cf: CLIENT, xff: CLIENT })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, PIN, { from: CLOUDFLARED, cf: OWNER, xff: OWNER })).status, 200, "another client through it");
    assert.equal((await whoami(direct, { from: NEIGHBOUR, cf: OWNER, xff: OWNER })).place, NEIGHBOUR);
    await onePlace(direct, (i) => ({ from: NEIGHBOUR, cf: `198.18.${i}.1`, xff: `198.18.${i}.1`, proof: true }));
  });

  it("doesn't believe this machine, which wasn't named", async () => {
    await onePlace(local, (i) => ({ cf: `198.18.${i}.1`, xff: `198.18.${i}.1` }));
  });
});

describe("TARSEE_TRUSTED_PROXY=cloudflare on Railway", () => {
  beforeEach(() => { process.env.RAILWAY_PROJECT_ID = "test-project"; });

  it("takes CF-Connecting-IP when the X-Real-IP Railway's edge sets is Cloudflare's and the owner's header is there", async () => {
    assert.deepEqual(await guesses(direct, 5, () => ({ from: RAILWAY_PROXY, realIp: EDGE, cf: CLIENT, proof: true })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, WRONG, { from: RAILWAY_PROXY, realIp: EDGE, cf: OWNER, proof: true })).status, 401, "the other client isn't held up");
    assert.equal((await login(direct, PIN, { from: RAILWAY_PROXY, realIp: EDGE, cf: OWNER, proof: true })).status, 200);
  });

  it("without it, X-Real-IP is the place: another account's zone pointed at the owner's Railway domain", async () => {
    await onePlace(direct, (i) => ({ from: RAILWAY_PROXY, realIp: EDGE, cf: `198.18.${i}.1` }));
    assert.deepEqual(await guesses(direct, 5, () => ({ from: RAILWAY_PROXY, realIp: EDGE2, cf: OWNER })), [401, 401, 401, 401, 429]);
    assert.equal((await login(direct, PIN, { from: RAILWAY_PROXY, realIp: EDGE, cf: OWNER, proof: true })).status, 200, "the owner doesn't wait");
  });

  it("doesn't believe it from a client that reached Railway's domain directly", async () => {
    await onePlace(direct, (i) => ({ from: RAILWAY_PROXY, realIp: "198.51.100.9", cf: `198.18.${i}.1`, proof: true }));
  });

  it("is this machine from this machine, whatever it sends", async () => {
    await onePlace(local, (i) => ({ realIp: EDGE, cf: `198.18.${i}.1`, proof: true }));
  });

  it("without cloudflare, Railway goes by X-Real-IP alone", async () => {
    delete process.env.TARSEE_TRUSTED_PROXY;
    await onePlace(direct, (i) => ({ from: RAILWAY_PROXY, realIp: EDGE, cf: `198.18.${i}.1`, proof: true }));
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

  it("are never walked past beside cloudflare either", () => {
    const trust = auth.trustedProxies(`cloudflare, loopback, ${CLOUDFLARE.slice(0, 3).join(", ")}, 104.0.0.0/8`);
    assert.deepEqual(trust.names, ["cloudflare", "loopback"]);
    const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": `198.18.0.1, ${EDGE}` } };
    process.env.TARSEE_TRUSTED_PROXY = `cloudflare, loopback, 104.0.0.0/8, 162.158.0.0/15`;
    assert.equal(auth.clientAddress(req), EDGE);
  });

  it("so a Worker forging X-Forwarded-For through Cloudflare and nginx is one place (the readme's old example)", async () => {
    process.env.TARSEE_TRUSTED_PROXY = `loopback, ${CLOUDFLARE.join(", ")}`;
    await onePlace(local, (i) => ({ xff: `198.18.${i}.1, ${WORKER}, ${EDGE}` }));
  });

  it("with loopback alone and cloudflared, a Worker forging X-Forwarded-For is one place", async () => {
    process.env.TARSEE_TRUSTED_PROXY = "loopback";
    await onePlace(local, (i) => ({ xff: `198.18.${i}.1, ${WORKER}` }));
  });
});

describe("TARSEE_CLOUDFLARE_SECRET stays out of every program Tarsee starts", () => {
  it("is taken out of Tarsee's environment as auth.js loads, and still used", () => {
    const authUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "middleware", "auth.js")).href;
    const script = [
      `const auth = await import(${JSON.stringify(authUrl)});`,
      "const req = { socket: { remoteAddress: '162.158.1.9' }, headers: { 'cf-connecting-ip': '203.0.113.5', 'x-tarsee-cloudflare': process.argv[1] } };",
      "console.log(JSON.stringify({ inEnv: 'TARSEE_CLOUDFLARE_SECRET' in process.env, place: auth.signInKey(req) }));",
      "process.exit(0);",
    ].join("\n");
    const child = path.join(tmp, "child");
    const env = { ...process.env, TARSEE_CLOUDFLARE_SECRET: SECRET, TARSEE_TRUSTED_PROXY: "cloudflare", TARSEE_STATE_DIR: child, TARSEE_WORKSPACE_DIR: path.join(child, "workspace"), TARSEE_DATA_DIR: path.join(child, "data") };
    delete env.RAILWAY_PROJECT_ID;
    delete env.NODE_OPTIONS;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, SECRET], { env, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), { inEnv: false, place: CLIENT });
  });

  it("a value set later is taken out too", async () => {
    process.env.TARSEE_CLOUDFLARE_SECRET = SECRET;
    assert.equal((await whoami(direct, { from: EDGE, cf: CLIENT, proof: true })).place, CLIENT);
    assert.equal("TARSEE_CLOUDFLARE_SECRET" in process.env, false);
  });
});

describe("what Tarsee says about cloudflare", () => {
  const text = (env) => auth.signInBootNotes({ password: "correct horse battery", env }).map((n) => `${n.level}: ${n.text}`).join("\n");

  it("reads the word, in any case, with loopback and addresses beside it", () => {
    const trust = auth.trustedProxies(`Cloudflare, ${CLOUDFLARED}, loopback, nginx`);
    assert.equal(trust.cloudflare, true);
    assert.equal(trust.loopback, true);
    assert.deepEqual(trust.names, ["cloudflare", CLOUDFLARED, "loopback"]);
    assert.deepEqual(trust.skipped, ["nginx"]);
    assert.equal(auth.trustedProxies("loopback").cloudflare, false);
  });

  it("says where it takes the client from, and never the secret", () => {
    const said = text({ TARSEE_TRUSTED_PROXY: "cloudflare", TARSEE_CLOUDFLARE_SECRET: SECRET });
    assert.match(said, /log: .*CF-Connecting-IP/);
    assert.match(said, /X-Tarsee-Cloudflare/);
    assert.match(said, /cloudflare\.com\/ips/);
    assert.doesNotMatch(said, /warn:/, "nothing on this machine is believed, and the secret is set");
    assert.ok(!said.includes(SECRET));
  });

  it("warns when TARSEE_CLOUDFLARE_SECRET is missing or short, and says how to set it", () => {
    for (const secret of [undefined, "short-one"]) {
      const said = text({ TARSEE_TRUSTED_PROXY: "cloudflare", TARSEE_CLOUDFLARE_SECRET: secret });
      assert.match(said, /warn: .*TARSEE_CLOUDFLARE_SECRET/);
      assert.match(said, /Transform Rule/);
      assert.ok(!said.includes("short-one"));
    }
  });

  it("with loopback beside it, says what that costs", () => {
    const said = text({ TARSEE_TRUSTED_PROXY: "cloudflare, loopback", TARSEE_CLOUDFLARE_SECRET: SECRET });
    assert.match(said, /log: .*X-Forwarded-For .*loopback/);
    assert.match(said, /warn: .*AI's shell/);
    assert.match(text({ TARSEE_TRUSTED_PROXY: `cloudflare, ${CLOUDFLARED}`, TARSEE_CLOUDFLARE_SECRET: SECRET }), new RegExp(CLOUDFLARED.replace(/\./g, "\\.")));
  });

  it("on Railway uses cloudflare and its header, and ignores the rest", () => {
    const said = text({ RAILWAY_PROJECT_ID: "p", TARSEE_TRUSTED_PROXY: "cloudflare", TARSEE_CLOUDFLARE_SECRET: SECRET });
    assert.match(said, /CF-Connecting-IP/);
    assert.match(said, /X-Tarsee-Cloudflare/);
    assert.doesNotMatch(said, /ignored|warn:/);
    assert.match(text({ RAILWAY_PROJECT_ID: "p", TARSEE_TRUSTED_PROXY: "cloudflare" }), /warn: .*TARSEE_CLOUDFLARE_SECRET/);
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

  it("from this machine, points to naming loopback", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await login(local, WRONG, { cf: "198.18.0.1", xff: "198.18.0.1" });
    const said = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(said, /TARSEE_TRUSTED_PROXY=cloudflare, loopback/);
  });

  it("from an edge without the owner's header, says so once", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await login(direct, WRONG, { from: EDGE, cf: "198.18.0.1" });
    await login(direct, WRONG, { from: EDGE, cf: "198.18.0.2", proof: "wrong value here!!" });
    const said = warn.mock.calls.map((c) => c.arguments.join(" ")).filter((s) => /X-Tarsee-Cloudflare/.test(s));
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.ok(!said[0].includes(SECRET) && !said[0].includes("wrong value here"));
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
    assert.equal(auth.signInKey(req(EDGE, { "cf-connecting-ip": CLIENT, "x-tarsee-cloudflare": SECRET })), CLIENT);
    assert.equal(auth.signInKey(req(EDGE, { "cf-connecting-ip": CLIENT })), EDGE);
    assert.equal(auth.signInKey(req("127.0.0.1", { "cf-connecting-ip": CLIENT, "x-tarsee-cloudflare": SECRET })), "this machine");
    assert.equal(auth.signInKey(req(OUTSIDE, { "cf-connecting-ip": CLIENT, "x-tarsee-cloudflare": SECRET })), OUTSIDE);
    process.env.TARSEE_TRUSTED_PROXY = "cloudflare, loopback";
    assert.equal(auth.signInKey(req("127.0.0.1", { "cf-connecting-ip": CLIENT, "x-forwarded-for": CLIENT })), CLIENT);
  });
});
