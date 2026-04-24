---
name: fewer-permission-prompts
description: Scan recent tool usage in the audit log and propose an allowlist for Tarsee's security manager so the user stops seeing permission prompts for routine actions.
metadata:
  {
    "tarsee":
      {
        "emoji": "🔓",
        "category": "security",
        "triggers": ["/fewer-prompts", "stop asking me permissions", "too many permission prompts"]
      }
  }
---

# Fewer Permission Prompts

Scan the audit log for recent tool executions, group by tool name, and
propose a targeted allowlist update so the user stops seeing confirmation
prompts for tools they've already approved dozens of times.

## When to use

- User says `/fewer-prompts`
- User complains about too many permission prompts in chat
- After a new skill install that triggers lots of tool calls

## Steps

1. **Check audit log.** Read recent entries from the audit log DB table:
   ```
   sqlite3 /data/tarsee/data/tarsee.db "SELECT action, target, COUNT(*) c FROM audit_log WHERE action LIKE 'tool.%' AND created_at > datetime('now', '-7 days') GROUP BY action, target ORDER BY c DESC LIMIT 50"
   ```
   (If path differs, resolve `config.DB_PATH` first via `/status` output.)

2. **Read current security settings.** Pull the existing tool permission
   map so the proposal only touches tools that aren't already allowed:
   ```
   cat /data/tarsee/data/tarsee.db-settings 2>/dev/null || sqlite3 /data/tarsee/data/tarsee.db "SELECT value FROM settings WHERE key = 'security.toolPermissions'"
   ```

3. **Propose a JSON patch.** Group tools by usage count. Criteria:
   - Tool used ≥ 10 times in the last 7 days → propose `always_allow`
   - Tool used 3–9 times → propose `warn` (confirmation once per session)
   - Tool used < 3 times → leave as-is
   - Any tool marked dangerous (rm/sudo/chmod/dd) → never propose
     `always_allow`, always leave at the current (usually `warn`) level

4. **Show the proposal as a diff-like preview.** Include for each
   proposed change: tool name, current setting, proposed setting, and
   usage count ("you ran this 47 times this week"). Use this format:

   ```
   ## Proposed tool-permission changes

   | Tool | Current | Proposed | Used (7d) |
   |---|---|---|---|
   | Bash(ls) | warn | always_allow | 47 |
   | Read | warn | always_allow | 128 |
   | tarsee_search_memories | warn | always_allow | 22 |
   | Bash(rm) | warn | warn (kept — dangerous) | 3 |
   ```

5. **Ask the user before applying.** NEVER patch the settings without
   explicit confirmation. End with: "Apply these? Reply 'yes' and I'll
   write the JSON patch to settings.security.toolPermissions."

6. **On yes, apply via SettingsStore.** Write the new merged permission
   map to the setting key `security.toolPermissions`:
   ```
   sqlite3 /data/tarsee/data/tarsee.db "UPDATE settings SET value = ? WHERE key = 'security.toolPermissions'" "<new-json>"
   ```
   Or better: use the `/api/admin/tool-permissions` endpoint if the user
   is in a session that can reach the API.

   After applying, confirm with a brief list of what changed.

## Guardrails

- **Never** auto-apply — this changes security posture.
- **Never** propose `always_allow` for a tool whose most recent 3 audit
  entries include error results (might indicate the user was denying
  them on purpose).
- If the audit log is empty (fresh install), bail out politely.
- The user's dangerous-command detection (regex in
  `src/lib/security-manager.js`) stays on regardless — this skill only
  touches the per-tool prompt level, not the dangerous-command filter.
