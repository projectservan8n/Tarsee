---
name: diagram
description: Render clickable flowcharts and diagrams for processes, decisions, and architecture
---

# Diagrams

You have a `tarsee_create_diagram` tool that renders a clickable flowchart inline in chat. The user can click any node to ask a follow-up question about it. Use this instead of ASCII art or long prose when explaining anything that's naturally a flow.

**Important:** the tool is named `tarsee_create_diagram`, not `create_diagram`. If you try to `Bash` your way to a `create_diagram` command it won't exist — always call the MCP tool directly.

## When to use

**Prefer a diagram when the answer involves:**
- A multi-step process or workflow (≥3 steps)
- A decision tree with branches (if/else, yes/no)
- System architecture or data flow between components
- A before/after or sequence the user can interact with

**Do not use a diagram for:**
- A simple list (use a bulleted list)
- A single-step answer
- Conceptual explanations without a flow
- Code snippets

## Node kinds (colors)

| Kind         | Use for                                              |
|--------------|------------------------------------------------------|
| `trigger`    | Data sources, storage, starting events (grey)        |
| `processing` | Active work — parsing, computing, transforming (purple) |
| `decision`   | Branches — yes/no, conditions (amber)                |
| `output`     | Final results — emails sent, rows logged (teal)      |
| `note`       | Annotations, quotes, callouts (not clickable)        |

## Tips for good diagrams

- Keep node labels short (2–5 words). Use `sublabel` for the brief explanation.
- Add edge labels like `"Yes"`, `"No"`, `"fails"` on branching edges.
- Include a `legend` only if you use 3+ different kinds.
- Give each clickable node a custom `question` when the default "Tell me more about: X" would be vague.
- Start from a single trigger node when possible — the auto-layout stacks depth-first.

## Example

For a question like *"How does a webhook-triggered alert flow work?"*, call:

```json
{
  "title": "Webhook-triggered alert flow",
  "nodes": [
    {"id": "hook",   "kind": "trigger",    "label": "Webhook fires",         "sublabel": "Incoming HTTP POST with payload"},
    {"id": "parse",  "kind": "processing", "label": "Parse payload",         "sublabel": "Validate shape, extract fields"},
    {"id": "check",  "kind": "decision",   "label": "Matches alert rules?",  "sublabel": "Compare against configured thresholds"},
    {"id": "skip",   "kind": "trigger",    "label": "Ignore",                "sublabel": "Log and drop"},
    {"id": "compose","kind": "processing", "label": "Compose message",       "sublabel": "Summary, severity, link to dashboard"},
    {"id": "send",   "kind": "output",     "label": "Notify user",           "sublabel": "Push, email, or chat message"},
    {"id": "log",    "kind": "output",     "label": "Record event",          "sublabel": "Write to audit log"}
  ],
  "edges": [
    {"from": "hook",    "to": "parse"},
    {"from": "parse",   "to": "check"},
    {"from": "check",   "to": "skip",    "label": "No"},
    {"from": "check",   "to": "compose", "label": "Yes"},
    {"from": "compose", "to": "send"},
    {"from": "send",    "to": "log"}
  ],
  "legend": [
    {"kind": "trigger"}, {"kind": "processing"},
    {"kind": "decision"}, {"kind": "output"}
  ]
}
```

After calling the tool, briefly offer context in text (1–3 sentences) and invite the user to click a node for details.
