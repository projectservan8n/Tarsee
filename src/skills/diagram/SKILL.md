---
name: diagram
description: Render clickable flowcharts and diagrams for processes, decisions, and architecture
---

# Diagrams

You have a `create_diagram` tool that renders a clickable flowchart inline in chat. The user can click any node to ask a follow-up question about it. Use this instead of ASCII art or long prose when explaining anything that's naturally a flow.

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

For a question like *"How does our order-status notification flow work?"*, call:

```json
{
  "title": "Order status notification",
  "nodes": [
    {"id": "src",    "kind": "trigger",    "label": "Xylem drops AS400 spreadsheet", "sublabel": "Order status file — no ERP needed"},
    {"id": "parse",  "kind": "processing", "label": "Parse order rows",              "sublabel": "Read kit code, ETA, status, account"},
    {"id": "check",  "kind": "decision",   "label": "Backorder or ETA changed?",     "sublabel": "Compare against previous file"},
    {"id": "skip",   "kind": "trigger",    "label": "No change",                     "sublabel": "Skip row"},
    {"id": "compose","kind": "processing", "label": "Compose notification",          "sublabel": "Account name, kit code, new ETA, reason"},
    {"id": "send",   "kind": "output",     "label": "Send proactive update",         "sublabel": "Email to distributor"},
    {"id": "log",    "kind": "output",     "label": "Log to Google Sheets",          "sublabel": "Account, kit code, ETA, timestamp, sent"}
  ],
  "edges": [
    {"from": "src", "to": "parse", "label": "n8n watches folder"},
    {"from": "parse", "to": "check"},
    {"from": "check", "to": "skip", "label": "No"},
    {"from": "check", "to": "compose", "label": "Yes"},
    {"from": "compose", "to": "send"},
    {"from": "send", "to": "log"}
  ],
  "legend": [
    {"kind": "trigger"}, {"kind": "processing"},
    {"kind": "decision"}, {"kind": "output"}
  ]
}
```

After calling the tool, briefly offer context in text (1–3 sentences) and invite the user to click a node for details.
