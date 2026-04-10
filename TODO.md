# Tarsee Roadmap

Everything below is buildable with the current stack (Node.js, SQLite, Claude Agent SDK, vanilla frontend, Railway). No new paid APIs needed.

---

## UI Audit Fixes

### HIGH
- [x] Tokenize hardcoded overlay alphas — added `--overlay-light/medium/heavy/dense/opaque` tokens
- [x] Tokenize model badge colors — added `--model-opus/sonnet/haiku` tokens
- [x] Fix font sizes outside type scale — added `--text-2xs: 9px`, replaced all 9-11px with tokens

### MEDIUM
- [x] Add `:hover` state to PIN pad keys for desktop
- [x] Fix voice cancel hint — `right: clamp(60px, 20vw, 100px)` responsive
- [x] Increase console toolbar buttons to 44px touch target
- [x] Add iPad breakpoint (769-1024px)

### LOW
- [x] Fix streaming dots gap to `var(--space-1)` (4px grid)
- [x] Add ARIA labels to PIN pad buttons and effort toggle

---

## Conversation Features
- [x] **Conversation search** — FTS5 full-text search across all sessions
- [ ] **Pin/star messages** — bookmark important responses
- [ ] **Conversation tags/folders** — organize sessions by project
- [ ] **Context window indicator** — show how full context is, warn before it degrades
- [ ] **Auto-summarize on clear** — save summary to memory before wiping session
- [ ] **Session presets** — saved personas with custom system prompts

---

## Agent Capabilities
- [x] **QR code to mobile** — scan from desktop to open same session on phone
- [x] **Audit log** — timestamped log of all tool executions, logins, settings changes (Settings > Audit Log)
- [x] **API endpoint** — REST API at `/api/v1/` for iOS Shortcuts, scripts, automations
- [x] **Typing indicator** — cross-device typing indicator via WebSocket
- [x] **Token usage chart** — daily/weekly visual graph (Settings > Usage)
- [ ] **Push notifications** — PWA notifications when cron jobs finish
- [ ] **Clipboard tool** — MCP tool so Claude can copy text to your clipboard
- [ ] **Session timeout** — auto-lock after idle, require PIN again
- [ ] **Share conversation** — generate public read-only link

---

## UX Polish
- [x] **Chat bubble animations** — smooth fadeIn/scaleIn on code blocks and tables
- [x] **Drag-and-drop files** — already supported
- [x] **Multi-file upload** — already supported (file input has `multiple`)

---

## Founder Tools
- [ ] **Smart daily briefing** — pulls emails, calendar, GitHub notifications, pending crons
- [ ] **Decision journal** — `/decide [topic]` logs decision + reasoning + date
- [ ] **Weekly review** — auto-generates "what got done" from conversation history
- [ ] **Contact notes** — `/contact add Name - notes` lightweight CRM in memory
- [ ] **Link/bookmark saver** — send URL, Claude fetches + summarizes + saves with tags
- [ ] **Standup log** — `/standup` logs yesterday/today/blockers
- [ ] **Goal tracker** — set quarterly goals, Claude checks in weekly
- [ ] **Voice memo to action items** — voice note → transcribe → extract tasks

---

*Last updated: 2026-04-10*
