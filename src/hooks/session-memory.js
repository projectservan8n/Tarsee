export default {
  name: "session-memory",
  events: ["session:end"],
  handler: async (data) => {
    try {
      if (data.messageCount > 5) {
        const { appendDailyLog } = await import("../lib/workspace-files.js");
        appendDailyLog(`[session] Ended conversation "${data.title || "untitled"}" (${data.messageCount} messages)`);
      }
    } catch { /* best effort */ }
  },
};
