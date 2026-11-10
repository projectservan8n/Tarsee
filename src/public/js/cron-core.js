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
 *   argsText(args)   a direct action's args as the owner sees them, here and in /cron list (lib/commands.js): JSON, every
 *                    text whole, with what would look blank written as an escape (visible). JSON.parse gives them back.
 *   visible(text)    text exactly as it runs, made safe to show: see BLANK below.
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

  // ------------------------------------------------------------ what a direct action runs, as the owner sees it

  /**
   * Every character that shows as nothing, or as a blank, without being a plain space. It is the chat's own rule (the
   * BLANKS of js/chat-core.js oneLine, which folds them where a diagram shows words): whitespace and line breaks,
   * control, format (the bidi controls among them), private-use and unassigned characters, half characters, the ones
   * Unicode says to draw as nothing (Default_Ignorable_Code_Point: zero-width spaces and joiners, variation selectors,
   * tags), and the few that are blank glyphs: the Khitan filler, the Hangul fillers, Braille blank, the object
   * replacement character, the Egyptian hieroglyph blanks, the null notehead. What a task runs is never folded: each one
   * is written as its escape (backslash, u, four hex digits), so what is shown is what runs, and nothing in it can
   * push text out of sight, look like nothing, or turn the line round.
   */
  const BLANK = /[\u{16FE4}\s\p{C}\p{Default_Ignorable_Code_Point}\u{115F}-\u{1160}\u{2800}\u{3164}\u{FFA0}\u{FFFC}\u{13441}-\u{13442}\u{1D159}]/u;
  /** Nonspacing marks, as Unicode counts them for a run that stacks up (UTS #39: Mn and Me), and the most on a character. */
  const MARK = /[\p{Mn}\p{Me}]/u;
  const MAX_MARKS = 4;
  const SELECTOR = /^[\u{FE0E}\u{FE0F}]$/u;
  const JOINER = "\u{200D}";
  const BACKSLASH = String.fromCharCode(92);

  /** A character as JSON escapes it: backslash, u and four hex digits, twice (its two halves) past U+FFFF. */
  function escaped(ch) {
    let out = "";
    for (let i = 0; i < ch.length; i++) out += `${BACKSLASH}u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    return out;
  }

  /** Whether the blank-looking character at i is an emoji's own, as the chat keeps it: its colour selector, or its joiner to the emoji after. */
  function emojiOwn(chars, i) {
    const ch = chars[i];
    const before = chars[i - 1] || "";
    if (SELECTOR.test(ch)) return /\p{Emoji}/u.test(before);
    if (ch !== JOINER) return false;
    const base = SELECTOR.test(before) ? chars[i - 2] || "" : before;
    return /\p{Emoji}/u.test(base) && /\p{Extended_Pictographic}/u.test(chars[i + 1] || "");
  }

  /**
   * Text exactly as it runs, made safe to show: every BLANK character but a plain space written as its escape, but
   * for an emoji's own joiner and colour selector (as the chat keeps them). Marks can't pile up over the line above
   * or below, as the chat counts them: at most 4 on a character, its own counted as Unicode decomposes it (NFD), and
   * never the same one twice in a row; from the first one past that, every mark of the run is written as its escape.
   * Nothing is taken out or changed, so in JSON (argsText) what is shown parses back to exactly what runs.
   */
  function visible(text) {
    const chars = Array.from(String(text ?? ""));
    let out = "";
    let marks = 0;
    let last = "";
    let piling = false;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch !== " " && BLANK.test(ch) && !emojiOwn(chars, i)) {
        out += escaped(ch);
        marks = 0;
        last = "";
        piling = false;
        continue;
      }
      if (MARK.test(ch)) {
        if (piling || ch === last || marks >= MAX_MARKS) {
          piling = true;
          out += escaped(ch);
        } else {
          out += ch;
          marks += 1;
          last = ch;
        }
        continue;
      }
      out += ch;
      const own = Array.from(ch.normalize("NFD")).filter((c) => MARK.test(c));
      marks = own.length;
      last = own.length ? own[own.length - 1] : "";
      piling = false;
    }
    return out;
  }

  /** A direct action's args as the owner sees them: JSON, every text whole, made visible. */
  function argsText(args) {
    return args === undefined ? "" : visible(JSON.stringify(args));
  }

  /** Whether a direct action's args say anything: shown unless missing or an empty object, whatever their kind. */
  function hasArgs(args) {
    return args !== undefined && !(args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0);
  }

  /** What the server shows of a direct action (lib/cron.js getCronStatus: actionShown), else the action as saved. */
  function shownOf(job) {
    const s = job?.actionShown;
    return s && typeof s === "object" ? s : { tool: job?.action?.tool, args: job?.action?.args, problem: null };
  }

  /**
   * The whole prompt, or the tool a direct-action task runs and what it passes: the args as the server shows them
   * (actionShown: whole, only set_key's value and a mailbox password masked: lib/cron.js shownDirectAction), left to
   * right as they run (bdo), wrapped by the page's style. job.action stays as saved, for seenOf.
   */
  function whatItDoes(job) {
    const action = job?.action;
    if (runsAction(job)) {
      const shown = shownOf(job);
      const args = hasArgs(shown.args) ? ` <code class="cron-args"><bdo dir="ltr">${esc(argsText(shown.args))}</bdo></code>` : "";
      return `<div class="cron-what">Runs <code>${esc(visible(String(action.tool)))}</code> directly, no AI.${args}</div>`;
    }
    return `<div class="cron-prompt">${esc(job?.prompt)}</div>`;
  }

  /** Why a direct action won't run as it is (lib/cron.js checkDirectAction), as the server says it, or "". */
  function problemOf(job) {
    const problem = runsAction(job) ? shownOf(job).problem : null;
    return typeof problem === "string" && problem ? problem : "";
  }

  function jobHtml(job) {
    const state = stateOf(job);
    const id = esc(job?.id);
    const switchOn = state === "waiting" || state === "off";
    const name = job?.name ? ` · ${esc(job.name)}` : "";
    const notes = [];
    if (state === "waiting") notes.push("The AI set this up in a chat. It won't run, or spend anything, until you switch it on.");
    if (job?.autoDisabled) notes.push(`It stopped after 5 failed runs${job.lastError ? ` (${esc(job.lastError)})` : ""}. Pause it, then switch it on, to try again.`);
    if (problemOf(job)) notes.push(`It won't run as it is: ${esc(visible(problemOf(job)))}`);
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

  globalThis.CronCore = Object.freeze({ STATE_WORDS, EMPTY_HTML, stateOf, whoMade, jobHtml, listHtml, seenOf, argsText, visible });
})();
