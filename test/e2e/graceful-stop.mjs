/**
 * test/e2e/graceful-stop.mjs: a preload (node --import) that lets a harness stop a server the way Railway does.
 *
 * Windows has no SIGTERM to send, and process.kill() there ends a process at once, skipping the server's shutdown
 * (stop the cron jobs, flush, close the database). With this preloaded, the line "stop" on the server's stdin emits
 * SIGTERM inside the process, so its own process.on("SIGTERM") handler runs exactly as it does on Railway.
 *
 *   node --import <file URL of this file> src/server.js     (stdin a pipe; write "stop\n" to stop it)
 *
 * It reads nothing else and changes nothing else; stdin is unref'd so it never keeps the process alive.
 */
let buf = "";
try {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    if (!/(^|\n)stop\r?\n/.test(buf)) return;
    buf = "";
    console.log("[graceful-stop] stop asked on stdin: emitting SIGTERM");
    process.emit("SIGTERM", "SIGTERM");
  });
  process.stdin.on("error", () => { /* the harness went away: nothing to do */ });
  process.stdin.unref?.();
} catch { /* no stdin: nothing to listen to */ }
