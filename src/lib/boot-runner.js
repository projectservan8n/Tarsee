import { getBootContext, hasBootstrapFile, appendDailyLog } from "./workspace-files.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { chatStream } from "../ai/router.js";

/**
 * Boot runner — executes BOOT.md as a one-shot AI task on every server restart.
 * Skips if BOOT.md is empty or no AI provider is configured.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {import('../db/settings.js').SettingsStore} opts.settingsStore
 * @returns {Promise<{skipped: boolean, response?: string, error?: string}>}
 */
export async function runBootChecklist({ db, settingsStore }) {
  const bootContent = getBootContext();

  if (!bootContent) {
    console.log("[boot] BOOT.md is empty, skipping boot checklist");
    return { skipped: true, reason: "BOOT.md is empty" };
  }

  const activeProvider = settingsStore.getActiveProvider();
  if (!activeProvider?.ready || !activeProvider?.provider) {
    console.log("[boot] No AI provider configured, skipping boot checklist");
    return { skipped: true, reason: "No AI provider configured" };
  }

  console.log("[boot] Running boot checklist...");

  const systemPrompt = buildSystemPrompt({
    settingsStore,
    db,
    conversationId: null,
    messageCount: 0,
    conversationPrompt: null,
    channelHint: "This is a server boot checklist. The server just restarted. Execute the tasks in BOOT.md and report results.",
  });

  const now = new Date().toISOString();
  const messages = [
    {
      role: "user",
      content: `[Server Boot — ${now}]\n\n${bootContent}`,
    },
  ];

  try {
    let fullResponse = "";
    const stream = chatStream({
      provider: activeProvider.provider,
      model: activeProvider.model,
      apiKey: activeProvider.apiKey,
      baseUrl: activeProvider.baseUrl,
      messages,
      systemPrompt,
    });

    for await (const event of stream) {
      if (event.type === "text") {
        fullResponse += event.content;
      } else if (event.type === "done") {
        break;
      }
    }

    appendDailyLog(`[boot] ${fullResponse.slice(0, 200)}`);
    console.log(`[boot] Completed: ${fullResponse.slice(0, 200)}`);
    return { skipped: false, response: fullResponse };
  } catch (err) {
    console.error("[boot] Error:", err.message);
    return { skipped: false, error: err.message };
  }
}

/**
 * Check if this is a first-run scenario (BOOTSTRAP.md exists).
 * Used by the frontend to decide whether to run bootstrap interview.
 */
export function isFirstRun() {
  return hasBootstrapFile();
}
