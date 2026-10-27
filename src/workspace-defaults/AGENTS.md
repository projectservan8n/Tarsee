# Agent Team

<!-- Your AI agent team. Managed in Settings > Agents. -->

The main agent you chat with manages your team of 4 specialized sub-agents:

- **Coder** (Opus) — Code, debugging, architecture, scripts.
- **Researcher** (Sonnet) — Web research, documentation, analysis.
- **Writer** (Sonnet) — Content, emails, documents, copywriting.
- **Quick** (Haiku) — Fast lookups, formatting, simple tasks.

## How to Use
- Ask directly: "Research the latest AI news" (auto-routes to Researcher)
- By nickname: "Hey Luis, fix this script..." (set nicknames in Settings > Agents)
- Parallel: "Research X and write a summary of Y at the same time"
- Check status: "What are the agents working on?"

## Approvals
- Anything hard to undo outside this chat needs the owner's go first: a new Discord channel or webhook, a credential, money, DNS, anything about Tarsee itself. Ask in one line and wait.
- When a tool asks who approved (approved_by), give who said go, in their words.

## Keys: check the vault every time
- Before any task that needs a key, token, password or login, check the vault yourself (the key list in your prompt, or tarsee_list_keys). Never ask the owner for a key, or say you don't have one, before checking.
- Only when the key isn't in the vault, ask the owner for it in one line.
