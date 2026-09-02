/**
 * EffortSlider — segmented control for picking Claude thinking effort.
 * Replaces the single cycling button (which is still available as a
 * fallback) with a 6-notch slider: auto / low / medium / high / xhigh / max.
 *
 * Order matters — the notches ascend in cost. `xhigh` sits BETWEEN high and
 * max, so listing max first (as this did) told users the last notch was a
 * step up from maximum when it is a step down.
 *
 * Public API:
 *   window.EffortSlider.open()   — show the panel, focused on current level
 *   window.EffortSlider.close()  — dismiss the panel
 *   window.EffortSlider.set(v)   — programmatic set (also updates Chat state)
 *
 * Writes to Chat.setEffort(value) which owns the on-request effort value.
 * Does NOT persist to the server — per-session effort is a runtime hint.
 */
(function () {
  "use strict";

  const LEVELS = [
    { value: "",       icon: "⚡", label: "Auto",      hint: "Server picks based on message complexity" },
    { value: "low",    icon: "🐇", label: "Quick",     hint: "Minimal thinking, fastest responses" },
    { value: "medium", icon: "⚖️", label: "Balanced",  hint: "Default for typical chat" },
    { value: "high",   icon: "🧠", label: "Deep",      hint: "Thorough reasoning, takes longer" },
    { value: "xhigh",  icon: "🌌", label: "Ultra",     hint: "Sweet spot for coding and agentic work" },
    { value: "max",    icon: "🔮", label: "Maximum",   hint: "Heaviest thinking — when correctness beats cost" },
  ];

  let panelEl = null;
  let currentIdx = 0;

  function build() {
    if (panelEl) return panelEl;
    panelEl = document.createElement("div");
    panelEl.className = "effort-slider-panel";
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-label", "Choose thinking effort");
    panelEl.setAttribute("aria-modal", "true");

    const segments = LEVELS.map((l, i) => `
      <button type="button" class="effort-seg" role="radio" aria-checked="false"
              data-value="${l.value}" data-idx="${i}"
              aria-label="${l.label} — ${l.hint}">
        <span class="effort-seg-icon">${l.icon}</span>
        <span class="effort-seg-label">${l.label}</span>
      </button>
    `).join("");

    panelEl.innerHTML = `
      <div class="effort-slider-card">
        <div class="effort-slider-title">Thinking effort</div>
        <div class="effort-slider-track" role="radiogroup">
          ${segments}
        </div>
        <div class="effort-slider-hint" id="effortSliderHint"></div>
      </div>
    `;
    document.body.appendChild(panelEl);

    panelEl.addEventListener("click", (e) => {
      const seg = e.target.closest(".effort-seg");
      if (seg) {
        const idx = Number(seg.dataset.idx);
        api.set(LEVELS[idx].value);
        return;
      }
      // Click on backdrop closes.
      if (e.target === panelEl) api.close();
    });

    // Keyboard: arrow keys cycle, Esc closes.
    panelEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); api.close(); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        currentIdx = (currentIdx + 1) % LEVELS.length;
        focusSeg(currentIdx);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        currentIdx = (currentIdx - 1 + LEVELS.length) % LEVELS.length;
        focusSeg(currentIdx);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        api.set(LEVELS[currentIdx].value);
      }
    });

    return panelEl;
  }

  function updateActive() {
    if (!panelEl) return;
    const segs = panelEl.querySelectorAll(".effort-seg");
    segs.forEach((seg, i) => {
      const active = i === currentIdx;
      seg.classList.toggle("is-active", active);
      seg.setAttribute("aria-checked", active ? "true" : "false");
    });
    const hintEl = panelEl.querySelector("#effortSliderHint");
    if (hintEl) hintEl.textContent = LEVELS[currentIdx].hint;
  }

  function focusSeg(i) {
    if (!panelEl) return;
    const seg = panelEl.querySelectorAll(".effort-seg")[i];
    seg?.focus();
    updateActive();
  }

  const api = {
    open() {
      build();
      const currentValue = window.Chat?._effortLevel || "";
      currentIdx = LEVELS.findIndex((l) => l.value === currentValue);
      if (currentIdx < 0) currentIdx = 0;
      panelEl.classList.add("is-open");
      updateActive();
      // Delay focus so the transition-in doesn't steal touch rhythm.
      setTimeout(() => focusSeg(currentIdx), 40);
    },
    close() {
      if (!panelEl) return;
      panelEl.classList.remove("is-open");
      document.getElementById("effortToggle")?.focus();
    },
    set(value) {
      if (window.Chat?.setEffort) window.Chat.setEffort(value);
      currentIdx = LEVELS.findIndex((l) => l.value === value);
      if (currentIdx < 0) currentIdx = 0;
      updateActive();
      // Brief delay so the user sees the selection before it closes.
      setTimeout(() => api.close(), 120);
    },
  };

  window.EffortSlider = api;
})();
