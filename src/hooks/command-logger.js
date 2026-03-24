/**
 * Built-in hook: Logs all tool executions to daily log.
 */
import { appendDailyLog } from "../lib/workspace-files.js";

export default {
  name: "command-logger",
  events: ["tool:after_execute"],
  handler: async (data) => {
    try {
      const preview = typeof data.result === "string" ? data.result.slice(0, 100) : "";
      appendDailyLog(`[tool] ${data.toolName}(${JSON.stringify(data.input).slice(0, 80)}) → ${preview}`);
    } catch { /* best effort */ }
  },
};
