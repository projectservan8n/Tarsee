/**
 * Custom <select> replacement.
 * Native <select> dropdowns can't be styled past their trigger — the popup
 * is OS chrome. This auto-enhances every <select> on the page with a custom
 * dropdown panel that matches the rest of the design system, while keeping
 * the underlying <select> fully functional for forms, programmatic value
 * changes, and assistive tech.
 *
 * Usage: included in index.html. Selects are upgraded automatically on
 * DOMContentLoaded and whenever new ones appear in the DOM. Add
 * `data-no-enhance` to opt out.
 */
(function () {
  "use strict";

  const ENHANCED = "_customSelect";

  class CustomSelect {
    constructor(nativeEl) {
      this.native = nativeEl;
      this.open = false;
      this.activeIndex = -1;
      this._build();
      this._bind();
      this._syncFromNative();
    }

    _build() {
      // Wrap the native select in a positioning container.
      const wrap = document.createElement("div");
      wrap.className = "cs-wrap";
      const parent = this.native.parentNode;
      parent.insertBefore(wrap, this.native);
      wrap.appendChild(this.native);

      // Hide native (visually) but keep it functional + accessible.
      this.native.classList.add("cs-native-hidden");
      this.native.setAttribute("tabindex", "-1");
      this.native.setAttribute("aria-hidden", "true");

      // Trigger button (what the user sees)
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "cs-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      // Mirror the native id pattern so labels still associate.
      const labelText = this._findLabelText();
      if (labelText) trigger.setAttribute("aria-label", labelText);
      trigger.innerHTML =
        '<span class="cs-trigger-label"></span>' +
        '<svg class="cs-trigger-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';
      wrap.appendChild(trigger);
      this.trigger = trigger;
      this.triggerLabel = trigger.querySelector(".cs-trigger-label");

      // Popup panel (lives in body so overflow:hidden ancestors don't clip)
      const panel = document.createElement("div");
      panel.className = "cs-panel";
      panel.setAttribute("role", "listbox");
      panel.style.display = "none";
      document.body.appendChild(panel);
      this.panel = panel;
    }

    _findLabelText() {
      if (this.native.id) {
        const label = document.querySelector(`label[for="${this.native.id}"]`);
        if (label) return label.textContent.trim();
      }
      // Walk up to nearest .form-group and grab its label.
      const group = this.native.closest(".form-group");
      const lbl = group?.querySelector("label");
      return lbl?.textContent.trim() || "";
    }

    _bind() {
      // Hook native .value / .selectedIndex setters so programmatic
      // assignments (e.g. settings.js doing `select.value = "manual"`) keep
      // the trigger label in sync. The native setters don't fire 'change'
      // and don't mutate any observable attribute, so this is the only
      // way to get a notification.
      const valueDescr = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      const idxDescr = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
      const self = this;
      Object.defineProperty(this.native, "value", {
        configurable: true,
        get() { return valueDescr.get.call(this); },
        set(v) {
          valueDescr.set.call(this, v);
          self._syncFromNative();
          if (self.open) self._renderPanel();
        },
      });
      Object.defineProperty(this.native, "selectedIndex", {
        configurable: true,
        get() { return idxDescr.get.call(this); },
        set(v) {
          idxDescr.set.call(this, v);
          self._syncFromNative();
          if (self.open) self._renderPanel();
        },
      });

      // Toggle on trigger click
      this.trigger.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
      });

      // Trigger keyboard
      this.trigger.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!this.open) this.openPanel();
          this._highlight(this.activeIndex < 0 ? 0 : this.activeIndex);
        } else if (e.key === "Escape") {
          if (this.open) { e.preventDefault(); this.closePanel(); }
        }
      });

      // Re-sync when the native select changes value/options programmatically.
      // Programmatic .value assignments don't fire 'change', but appending
      // <option>s does fire MutationObserver. We poll the value cheaply on
      // open + observe child mutations for added options.
      this.native.addEventListener("change", () => this._syncFromNative());
      const opts = { childList: true, subtree: true, attributes: true, attributeFilter: ["selected", "value"] };
      this._mo = new MutationObserver(() => {
        this._syncFromNative();
        if (this.open) this._renderPanel();
      });
      this._mo.observe(this.native, opts);

      // Outside click closes
      this._docClick = (e) => {
        if (!this.open) return;
        if (this.panel.contains(e.target) || this.trigger.contains(e.target)) return;
        this.closePanel();
      };
      document.addEventListener("mousedown", this._docClick);

      // Escape / outside scroll closes
      this._docKey = (e) => {
        if (!this.open) return;
        if (e.key === "Escape") { e.preventDefault(); this.closePanel(); }
        if (e.key === "ArrowDown") { e.preventDefault(); this._highlight(this.activeIndex + 1); }
        if (e.key === "ArrowUp") { e.preventDefault(); this._highlight(this.activeIndex - 1); }
        if (e.key === "Enter") {
          e.preventDefault();
          if (this.activeIndex >= 0) this.selectIndex(this.activeIndex);
        }
        if (e.key === "Tab") this.closePanel();
      };
      document.addEventListener("keydown", this._docKey);

      // Reposition on resize/scroll while open
      this._reposition = () => { if (this.open) this._position(); };
      window.addEventListener("resize", this._reposition);
      window.addEventListener("scroll", this._reposition, true);
    }

    _syncFromNative() {
      const sel = this.native.options[this.native.selectedIndex];
      this.triggerLabel.textContent = sel ? sel.textContent : "";
      // Reflect disabled state visually
      if (this.native.disabled) {
        this.trigger.setAttribute("disabled", "");
      } else {
        this.trigger.removeAttribute("disabled");
      }
    }

    _renderPanel() {
      const sel = this.native.selectedIndex;
      const html = Array.from(this.native.options).map((opt, i) => {
        const isSel = i === sel;
        const isDisabled = opt.disabled;
        // Detect optgroup by walking up from the option
        const group = opt.parentElement;
        const groupLabel = group?.tagName === "OPTGROUP" ? group.label : null;
        const groupHeader = (i === 0 || this.native.options[i - 1]?.parentElement !== group) && groupLabel
          ? `<div class="cs-group-title">${escapeHtml(groupLabel)}</div>`
          : "";
        return `${groupHeader}<div class="cs-item${isSel ? " is-selected" : ""}${isDisabled ? " is-disabled" : ""}" role="option" aria-selected="${isSel}" data-index="${i}">
          <span class="cs-item-label">${escapeHtml(opt.textContent)}</span>
          ${isSel ? '<svg class="cs-item-check" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}
        </div>`;
      }).join("");
      this.panel.innerHTML = html;

      this.panel.querySelectorAll(".cs-item").forEach((el) => {
        el.addEventListener("mouseenter", () => this._highlight(parseInt(el.dataset.index, 10), false));
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();  // keep focus on trigger
          if (el.classList.contains("is-disabled")) return;
          this.selectIndex(parseInt(el.dataset.index, 10));
        });
      });

      this.activeIndex = sel >= 0 ? sel : 0;
      this._highlight(this.activeIndex);
    }

    _highlight(i) {
      const items = this.panel.querySelectorAll(".cs-item");
      if (!items.length) return;
      // Wrap around
      if (i < 0) i = items.length - 1;
      if (i >= items.length) i = 0;
      // Skip disabled items in the direction we're moving
      let safety = items.length;
      while (items[i]?.classList.contains("is-disabled") && safety-- > 0) {
        i = (i + 1) % items.length;
      }
      this.activeIndex = i;
      items.forEach((el, idx) => el.classList.toggle("is-active", idx === i));
      items[i]?.scrollIntoView({ block: "nearest" });
    }

    selectIndex(i) {
      const opt = this.native.options[i];
      if (!opt || opt.disabled) return;
      this.native.selectedIndex = i;
      this.native.dispatchEvent(new Event("input", { bubbles: true }));
      this.native.dispatchEvent(new Event("change", { bubbles: true }));
      this._syncFromNative();
      this.closePanel();
      this.trigger.focus();
    }

    toggle() {
      if (this.open) this.closePanel();
      else this.openPanel();
    }

    openPanel() {
      if (this.native.disabled) return;
      this._renderPanel();
      this.panel.style.display = "block";
      this.open = true;
      this.trigger.setAttribute("aria-expanded", "true");
      this.trigger.classList.add("is-open");
      this._position();
    }

    closePanel() {
      this.panel.style.display = "none";
      this.open = false;
      this.trigger.setAttribute("aria-expanded", "false");
      this.trigger.classList.remove("is-open");
    }

    _position() {
      const r = this.trigger.getBoundingClientRect();
      const margin = 4;
      const panelMaxH = 320;
      this.panel.style.minWidth = r.width + "px";
      this.panel.style.maxWidth = "min(420px, 90vw)";
      this.panel.style.left = r.left + "px";

      const spaceBelow = window.innerHeight - r.bottom - 12;
      const spaceAbove = r.top - 12;
      // Prefer below; flip up if there's substantially more room above.
      if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
        this.panel.style.top = r.bottom + margin + "px";
        this.panel.style.bottom = "";
        this.panel.style.maxHeight = Math.min(panelMaxH, spaceBelow) + "px";
      } else {
        this.panel.style.bottom = (window.innerHeight - r.top) + margin + "px";
        this.panel.style.top = "";
        this.panel.style.maxHeight = Math.min(panelMaxH, spaceAbove) + "px";
      }
    }

    destroy() {
      document.removeEventListener("mousedown", this._docClick);
      document.removeEventListener("keydown", this._docKey);
      window.removeEventListener("resize", this._reposition);
      window.removeEventListener("scroll", this._reposition, true);
      this._mo?.disconnect();
      this.panel.remove();
      // Restore native
      this.native.classList.remove("cs-native-hidden");
      this.native.removeAttribute("tabindex");
      this.native.removeAttribute("aria-hidden");
      const wrap = this.native.parentNode;
      if (wrap?.classList.contains("cs-wrap")) {
        wrap.parentNode.insertBefore(this.native, wrap);
        wrap.remove();
      }
      delete this.native[ENHANCED];
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
    ));
  }

  function enhanceAll(root = document) {
    root.querySelectorAll("select:not([data-no-enhance]):not(.cs-native-hidden)").forEach((sel) => {
      if (!sel[ENHANCED]) {
        sel[ENHANCED] = new CustomSelect(sel);
      }
    });
  }

  // Initial pass
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => enhanceAll());
  } else {
    enhanceAll();
  }

  // Watch for new <select>s appearing later (settings panels render on demand).
  // Debounced so a flurry of mutations doesn't thrash.
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      enhanceAll();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Public API for code that needs to refresh after programmatic value
  // changes (since native value=X assignment doesn't fire change).
  window.CustomSelect = {
    enhance: enhanceAll,
    refresh(selectEl) {
      const cs = selectEl?.[ENHANCED];
      if (cs) cs._syncFromNative();
    },
    refreshAll() {
      document.querySelectorAll("select").forEach((s) => {
        s[ENHANCED]?._syncFromNative();
      });
    },
  };
})();
