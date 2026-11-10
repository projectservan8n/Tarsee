/**
 * Settings → Automation → Scheduled tasks, with no page: js/settings.js draws the list from this, and
 * test/scheduled-tasks.test.js checks it in Node.
 *
 *   stateOf(job)     "waiting" (the AI set it up in a chat; it waits for the owner's OK), "running", "on" or "off"
 *   STATE_WORDS      each state as the page says it
 *   whoMade(job)     who made it, in words
 *   jobHtml(job)     one task: its state, schedule and name, its whole prompt (or what it runs), who made it, and its
 *                    Switch on or Pause button and its Delete button
 *   listHtml(jobs)   every task, or EMPTY_HTML
 *   EMPTY_HTML       what the list says with no tasks
 *   seenOf(job)      what its row shows of what the task does: { schedule, prompt }, or { schedule, action } for a task
 *                    that runs a tool directly. Switch on sends it (PATCH /api/settings/cron/:id, seen), so the owner
 *                    switches on the very task they looked at: one that changed since the list was drawn is refused.
 *
 * A job is one of GET /api/settings/cron's jobs. Everything from it is escaped: a prompt the AI wrote is only text.
 * Loaded by index.html as a plain script (window.CronCore) and by the tests as a module (globalThis.CronCore).
 */
(function () {
  "use strict";

  const STATE_WORDS = Object.freeze({ waiting: "Waiting for your OK", running: "Running", on: "On", off: "Off" });

  const EMPTY_HTML = '<div class="hint">No scheduled tasks yet. Add one with the form below, or type <code>/cron add</code> in the chat. A task the AI sets up in a chat waits here, switched off, for your OK.</div>';

  const DELETE_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** The server says the state (GET /api/settings/cron); a job without one gets it from its fields. */
  function stateOf(job) {
    if (job && Object.hasOwn(STATE_WORDS, job.state)) return job.state;
    if (job?.running) return "running";
    if (job?.awaitingOwner) return "waiting";
    return job?.enabled ? "on" : "off";
  }

  function whoMade(job) {
    if (job?.createdBy === "ai") return "Made by the AI in a chat";
    if (job?.createdBy === "owner") return "Made by you";
    return "Made before Tarsee noted who makes each task";
  }

  /** A task that runs a tool directly, with no AI: its row shows the action, not the prompt. */
  function runsAction(job) {
    return !!job?.action?.tool;
  }

  function seenOf(job) {
    return runsAction(job)
      ? { schedule: job.schedule, action: job.action }
      : { schedule: job?.schedule, prompt: job?.prompt ?? "" };
  }

  /**
   * The whole prompt, or the tool a direct-action task runs and what it passes: the args as the server shows them
   * (actionShown, every secret masked: lib/cron.js shownDirectAction). job.action stays as saved, for seenOf.
   */
  function whatItDoes(job) {
    const action = job?.action;
    if (runsAction(job)) {
      const shown = job.actionShown && typeof job.actionShown === "object" ? job.actionShown.args : action.args;
      const hasArgs = shown && typeof shown === "object" && Object.keys(shown).length > 0;
      const args = hasArgs ? ` <code class="cron-args">${esc(JSON.stringify(shown))}</code>` : "";
      return `<div class="cron-what">Runs <code>${esc(action.tool)}</code> directly, no AI.${args}</div>`;
    }
    return `<div class="cron-prompt">${esc(job?.prompt)}</div>`;
  }

  function jobHtml(job) {
    const state = stateOf(job);
    const id = esc(job?.id);
    const switchOn = state === "waiting" || state === "off";
    const name = job?.name ? ` · ${esc(job.name)}` : "";
    const notes = [];
    if (state === "waiting") notes.push("The AI set this up in a chat. It won't run, or spend anything, until you switch it on.");
    if (job?.autoDisabled) notes.push(`It stopped after 5 failed runs${job.lastError ? ` (${esc(job.lastError)})` : ""}. Pause it, then switch it on, to try again.`);
    const button = switchOn
      ? `<button class="btn btn-sm btn-primary cron-toggle" data-cron-toggle="${id}" data-cron-enabled="true" title="Let this task run at its times">Switch on</button>`
      : `<button class="btn btn-sm btn-secondary cron-toggle" data-cron-toggle="${id}" data-cron-enabled="false" title="Stop this task's runs until you switch it on again">Pause</button>`;
    return `<div class="memory-item cron-job" data-cron-row="${id}">`
      + `<span class="memory-badge cron-state cron-state-${state}">${STATE_WORDS[state]}</span>`
      + `<div class="memory-content">`
      + `<div class="cron-when"><code>${esc(job?.schedule)}</code>${name}</div>`
      + whatItDoes(job)
      + `<div class="cron-who">${whoMade(job)} · <code>${id}</code></div>`
      + notes.map((n) => `<div class="cron-note">${n}</div>`).join("")
      + `</div>`
      // The two buttons go as one: a narrow row wraps them together, never Delete on a line of its own.
      + `<span class="cron-actions">${button}`
      + `<button class="memory-delete" data-cron-delete="${id}" title="Delete" aria-label="Delete ${id}">${DELETE_ICON}</button></span>`
      + `</div>`;
  }

  function listHtml(jobs) {
    return Array.isArray(jobs) && jobs.length ? jobs.map(jobHtml).join("") : EMPTY_HTML;
  }

  globalThis.CronCore = Object.freeze({ STATE_WORDS, EMPTY_HTML, stateOf, whoMade, jobHtml, listHtml, seenOf });
})();
