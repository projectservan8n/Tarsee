import { runTurn } from "./turn.js";

/**
 * Every channel's turn: the engine-neutral turn layer itself (ai/turn.js runTurn), so every option a caller passes
 * reaches it as given (thinkingSummaries, queuedNote, liveTurnId and the rest). It picks the provider, model and
 * effort, runs the engine and yields Tarsee's events: route, text, thinking, tool_use, tool_result, usage, error and
 * exactly one done.
 *
 * The old generic options (apiKey, baseUrl, tools, executeTool) are ignored: the engines run their own tools, and a
 * provider's key and host are never taken from a caller.
 *
 * @type {typeof runTurn}
 */
export const chatStream = runTurn;
