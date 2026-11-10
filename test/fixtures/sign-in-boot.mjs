// One run of Tarsee's sign-in, for test/login-limit-restart.test.js: the real authRouter behind the checks src/server.js
// puts before it, over the database in TARSEE_DATA_DIR, as a fresh process (so nothing is left in memory from a run
// before). The test runs it once, then again, as Tarsee would start after a restart or a redeploy.
//   SIGN_IN_CLOCK  the time it starts at (Date only; ms since 1970)
//   SIGN_IN_STEPS  JSON list, each { from, password } (POST /api/auth/login from the address `from`),
//                  { from, private: true, cookie } (GET a page behind the sign-in), { advance: ms } (move the clock) or
//                  { writes: false | true } (from here tarsee.db refuses every write, as on a full disk, or takes them again)
//   SIGN_IN_WRITES_FAIL  "1": tarsee.db refuses every write from the start of this run, after it is opened (a full disk)
// It prints one line: JSON, each step's { status, retryAfter, error, cookie }.
import http from "node:http";
import { mock } from "node:test";
import express from "express";

mock.timers.enable({ apis: ["Date"], now: Number(process.env.SIGN_IN_CLOCK) || Date.now() });

const { initDb } = await import("../../src/db/sqlite.js");
const config = (await import("../../src/config/env.js")).default;
const auth = await import("../../src/middleware/auth.js");
const { authRouter } = await import("../../src/routes/auth-routes.js");

const db = initDb(config.DB_PATH);
// SQLite's query_only stands in for a full disk: reads work, and every write fails.
const writes = (on) => db.pragma(`query_only = ${on ? "OFF" : "ON"}`);
if (process.env.SIGN_IN_WRITES_FAIL === "1") writes(false);
auth.initSessionStore(db);

const app = express();
app.set("trust proxy", auth.trustProxyHop);
app.use(express.json());
app.use(auth.sessionAuth);
app.get("/private", auth.requireAuth, (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
let from = "203.0.113.1";
const server = http.createServer(app);
server.on("connection", (socket) => Object.defineProperty(socket, "remoteAddress", { value: from, configurable: true }));
await new Promise((r) => server.listen(0, "127.0.0.1", r));

function send(step) {
  from = step.from;
  const body = step.private ? "" : JSON.stringify({ password: step.password });
  const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
  if (step.cookie) headers.cookie = step.cookie;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, agent: false, headers,
      method: step.private ? "GET" : "POST", path: step.private ? "/private" : "/api/auth/login",
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = {};
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({
          status: res.statusCode,
          retryAfter: Number(res.headers["retry-after"]) || 0,
          error: json.error || null,
          cookie: (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ") || null,
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const out = [];
for (const step of JSON.parse(process.env.SIGN_IN_STEPS || "[]")) {
  if (step.advance) { mock.timers.tick(step.advance); out.push(null); continue; }
  if (typeof step.writes === "boolean") { writes(step.writes); out.push(null); continue; }
  out.push(await send(step));
}
await new Promise((r) => server.close(r));
writes(true);
db.close();
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
