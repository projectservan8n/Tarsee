---
name: ultrareview
description: Multi-agent code review on the current git branch — spawns three parallel sub-reviews (correctness, architecture, UX/a11y) and aggregates a single structured report.
metadata:
  {
    "tarsee":
      {
        "emoji": "🔬",
        "category": "review",
        "triggers": ["/ultrareview", "ultrareview", "do a deep code review"]
      }
  }
---

# UltraReview

Parallel multi-agent code review for the CURRENT git branch vs `main`.
Uses Tarsee's agent registry (Coder, Researcher, Writer) to run three
independent review passes simultaneously, then aggregates.

## When to use

- User says `/ultrareview`
- User asks for a "deep review", "thorough code review", or "multi-lens
  review" on the current branch
- About to merge a PR and wants a final look

## Steps

1. **Scope check (run once, synchronous).** Before spawning sub-agents:
   - `git rev-parse --abbrev-ref HEAD` → confirm branch name
   - `git log --oneline main..HEAD` → confirm this is a feature branch
     with actual commits (not empty or equal-to-main)
   - `git diff --stat main..HEAD` → summarize scope before the review
   - If branch equals main or has zero diff: **stop and tell the user**,
     don't waste tool calls on a no-op review.

2. **Spawn three parallel sub-agents via the Task tool.** Kick them off
   in ONE message (single assistant turn with three `Task` tool calls)
   so they run concurrently, not serially.

   **Agent A — Correctness (Coder):**
   Prompt: "Review the diff `main..HEAD` strictly for correctness: bugs,
   logic errors, null-handling, race conditions, off-by-ones, error paths
   that swallow exceptions, edge cases not covered. Cite file:line.
   Ignore style, naming, and architecture — those are other agents'
   jobs. Return: ranked findings CRIT/HIGH/MED/LOW, under 400 words."

   **Agent B — Architecture & Consistency (Researcher):**
   Prompt: "Review the diff `main..HEAD` for architectural fit: does
   this match existing patterns in the codebase? Are there duplicate
   implementations when a helper already exists? Does it break a
   layering invariant? Are new abstractions justified by >= 3 call
   sites? Return: ranked findings with existing-alternatives cited by
   file:line, under 400 words."

   **Agent C — UX / A11y / Copy (Writer):**
   Prompt: "Review the diff `main..HEAD` for user-facing quality: any
   UI text changes that read awkwardly, any a11y regressions (missing
   aria labels, focus ring loss, touch targets <44px), any breaking
   visual changes without theme/token usage, any docs/error messages
   that don't match existing voice. Return: ranked findings, under 400
   words. If no UI changes in diff, say so in one line."

3. **Aggregate results.** Once all three Task results arrive, combine
   into one report with this structure:

   ```
   # UltraReview — <branch name>
   **Scope:** N files, +X −Y lines

   ## 🔴 Critical
   <union of CRIT findings from all three agents, deduped>

   ## 🟠 High
   <union of HIGH findings>

   ## 🟡 Medium
   <union of MED findings, grouped by agent>

   ## 🟢 Low / style
   <union of LOW findings, bulleted>

   ## Recommendation
   <one paragraph: ship as-is / ship with minor fixes / block on X>
   ```

4. **Don't implement fixes unless asked.** This is a review skill, not
   a fix skill. End with: "Want me to apply any of these? Tell me which
   sections."

## Notes

- If the user asks to review a SPECIFIC file or range, use a single
  agent (Coder) rather than three — parallel review is only valuable
  against a full branch diff.
- If `main` isn't the default branch, use `origin/HEAD` to resolve.
- Respect timing: each Task agent has its own context budget. Keep
  prompts tight — don't pass the entire diff, let each agent read what
  it needs via Bash+git.
