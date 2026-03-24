/**
 * Interactive TUI mode for Tarsee.
 * Simple REPL-style chat in terminal.
 */

import readline from "node:readline";

export async function startInteractive() {
  const port = process.env.PORT || 3000;
  const token = process.env.TARSEE_API_TOKEN || "";

  console.log("\n  Tarsee Interactive Mode");
  console.log("  Type your message and press Enter. Ctrl+C to exit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you > " });
  rl.prompt();

  rl.on("line", async (line) => {
    const msg = line.trim();
    if (!msg) { rl.prompt(); return; }
    if (msg === "/exit" || msg === "/quit") { rl.close(); return; }

    process.stdout.write("ai  > ");
    try {
      const res = await fetch(`http://localhost:${port}/api/chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: msg, channelKey: "cli:interactive" }),
      });
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) process.stdout.write(data.content);
          } catch { /* skip */ }
        }
      }
      console.log("\n");
    } catch (err) {
      console.log(`Error: ${err.message}\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => { console.log("\nGoodbye!"); process.exit(0); });
}
