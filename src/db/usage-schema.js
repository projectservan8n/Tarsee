/**
 * The token usage tables (lib/token-usage.js).
 *
 *   usage_files     each Claude Code transcript read so far, and the byte offset
 *                   the next read starts at (so nothing is read twice)
 *   usage_calls     every model call found in those transcripts: its tokens
 *                   (input, cache read, cache write, output) and its timing
 *   usage_prompts   the prompts typed into each session, used to work out which
 *                   conversation a session belongs to when nothing else says
 *   usage_sessions  Claude Code session id -> Tarsee conversation id
 *   usage_turns     each turn of the agent (from the live timeline) with the sums
 *                   of the calls placed in it
 *   usage_meta      small bookkeeping values (the last timeline event read, ...)
 *
 * Migration 010_token_usage creates them; lib/token-usage.js runs the same SQL
 * when it opens a database, so a database made some other way (a test) has them
 * too. Every statement is IF NOT EXISTS, so running it twice is harmless.
 */
export const USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage_files (
    path TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT,
    offset INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, mtime_ms INTEGER NOT NULL DEFAULT 0, state TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_calls (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, model TEXT, effort TEXT,
    started_at INTEGER, ended_at INTEGER NOT NULL,
    input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    conversation_id TEXT, turn_id TEXT, placed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_usage_calls_end ON usage_calls (ended_at);
  CREATE INDEX IF NOT EXISTS idx_usage_calls_session ON usage_calls (session_id, placed);
  CREATE INDEX IF NOT EXISTS idx_usage_calls_turn ON usage_calls (turn_id);
  CREATE INDEX IF NOT EXISTS idx_usage_calls_conv ON usage_calls (conversation_id, ended_at);
  CREATE TABLE IF NOT EXISTS usage_prompts (
    session_id TEXT NOT NULL, at INTEGER NOT NULL, head TEXT, tail TEXT, PRIMARY KEY (session_id, at)
  );
  CREATE TABLE IF NOT EXISTS usage_sessions (
    session_id TEXT PRIMARY KEY, conversation_id TEXT, how TEXT, checked_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS usage_turns (
    turn_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source TEXT, model TEXT, effort TEXT, prompt TEXT, title TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, stop_reason TEXT, session_id TEXT, message_id TEXT,
    calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
    gen_ms INTEGER NOT NULL DEFAULT 0, gen_out INTEGER NOT NULL DEFAULT 0, gen_tokens INTEGER NOT NULL DEFAULT 0,
    first_call_at INTEGER, last_call_at INTEGER, call_model TEXT, call_effort TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_turns_conv ON usage_turns (conversation_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_usage_turns_start ON usage_turns (started_at);
  CREATE INDEX IF NOT EXISTS idx_usage_turns_msg ON usage_turns (message_id);
  CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT);
`;
