---
name: skill-creator
description: Help users create new OpusClaw skills with proper SKILL.md format
---

# Skill Creator

You are helping the user create a new OpusClaw skill. Guide them through these steps:

## 1. Gather Requirements

Ask the user:
- **What should this skill do?** (e.g., "write outreach emails", "review code", "draft proposals")
- **What name should it have?** (lowercase, hyphens only — e.g., `email-writer`, `code-reviewer`)
- **Any specific rules, tone, or constraints?**

## 2. Write the SKILL.md

Structure it as:
```markdown
---
name: skill-name
description: Brief one-line summary
---

# Skill Title

[Clear role definition — who the AI becomes when this skill is active]

## Guidelines
- Specific rules and constraints
- Tone and style preferences
- Domain knowledge

## Workflow
1. Step-by-step process
2. What to ask the user
3. How to structure output

## Examples (optional)
Show sample inputs and outputs if helpful.
```

## 3. Create the Skill

After drafting, tell the user:
"I've drafted your skill. You can create it in **Settings > Skills > Create Skill** or I can describe the API call."

## Tips for Good Skills
- Be specific — vague instructions produce vague results
- Include examples when the output format matters
- Define what to ask the user before acting
- Keep it focused — one skill per task domain
- Reference external context (APIs, brand guidelines) directly in the instructions
