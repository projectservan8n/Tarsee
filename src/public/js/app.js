/**
 * Tarsee App — Main initialization.
 */
const App = {
  async init() {
    // Check auth status
    try {
      const status = await API.authStatus();
      const { authenticated, needsPassword } = status;
      this._auth = status;

      if (!authenticated && needsPassword) {
        this.showLogin();
      } else if (!authenticated && !needsPassword) {
        // No password set — auto-authenticate (dev mode)
        await API.loadApiToken();
        this.showApp();
      } else {
        // Already authenticated (session cookie still valid) — hydrate API token
        // from the session-protected endpoint so WebSocket + external calls work.
        await API.loadApiToken();
        this.showApp();
      }
    } catch (err) {
      console.error("Auth check failed:", err);
      this.showLogin();
    }
  },

  /** After a successful login: first boot shows the app; a re-login after the
   *  session expired mid-use reloads ONCE so every module starts clean. */
  afterLogin() {
    if (this._appShownOnce) { window.location.reload(); return; }
    this.showApp();
  },

  /**
   * POST /api/auth/login, as API.login does, but a refusal keeps its status and Retry-After (in seconds) on the error,
   * which API.login leaves out: the sign-in screen holds a 429 on screen until it runs out (holdRefusal).
   */
  async signIn(password) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "Login failed");
      err.status = res.status;
      err.retryAfter = Number(res.headers.get("Retry-After")) || 0;
      throw err;
    }
    await API.loadApiToken();
    return data;
  },

  /**
   * Signing in refused for a while (429: this place's wait, the tries-a-minute limit, or the pause for everyone): the
   * server's words and the time left stay on the sign-in screen, the desktop form's line and the PIN pad's, until the
   * Retry-After runs out. Trying again before then is refused anyway, so the Sign In button and the PIN keys wait too.
   */
  holdRefusal(message, seconds) {
    clearInterval(this._refusalTimer);
    const until = Date.now() + Math.max(1, Number(seconds) || 30) * 1000;
    this._refusedUntil = until;
    const formLine = document.getElementById("loginError");
    const pinLine = document.getElementById("pinError");
    const waiting = (on) => {
      const button = document.querySelector("#loginForm button[type='submit']");
      if (button) button.disabled = on;
      document.querySelectorAll(".pin-key[data-digit], #pinDelete").forEach((key) => { key.disabled = on; });
    };
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(this._refusalTimer);
        this._refusalTimer = null;
        this._refusedUntil = 0;
        if (formLine) { formLine.textContent = ""; formLine.style.display = "none"; }
        if (pinLine) pinLine.textContent = "";
        waiting(false);
        return;
      }
      const h = Math.floor(left / 3600);
      const m = Math.floor((left % 3600) / 60);
      const s = String(left % 60).padStart(2, "0");
      const text = `${message} (${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${s} left)`;
      if (formLine) { formLine.textContent = text; formLine.style.display = "block"; }
      if (pinLine) pinLine.textContent = text;
    };
    waiting(true);
    tick();
    this._refusalTimer = setInterval(tick, 1000);
  },

  /** Whether signing in is refused for a while still (holdRefusal). */
  refusalHeld() {
    return Date.now() < (this._refusedUntil || 0);
  },

  showLogin() {
    document.getElementById("loginScreen").style.display = "flex";
    document.getElementById("appScreen").style.display = "none";
    // Listeners below must be bound ONCE. showLogin now also runs when a
    // session expires mid-use (tarsee:auth-required), and re-binding would
    // stack handlers and submit the login several times.
    if (this._loginBound) return;
    this._loginBound = true;

    // Desktop: classic form login
    const form = document.getElementById("loginForm");
    const errorEl = document.getElementById("loginError");
    const submitBtn = form.querySelector("button[type='submit']");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (this.refusalHeld()) return;   // refused for a while: the line above says how long
      errorEl.style.display = "none";

      const password = document.getElementById("loginPassword").value;
      // Disable the submit button so a second click can't race the first —
      // and give visible feedback that something is happening.
      const prevLabel = submitBtn?.textContent;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.setAttribute("aria-busy", "true");
        submitBtn.textContent = "Signing in…";
      }
      try {
        await this.signIn(password);
        this.afterLogin();
      } catch (err) {
        if (submitBtn) {
          submitBtn.removeAttribute("aria-busy");
          if (prevLabel) submitBtn.textContent = prevLabel;
        }
        if (err?.status === 429) { this.holdRefusal(err.message, err.retryAfter); return; }
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    document.getElementById("loginPassword").focus();

    // Mobile: PIN pad, with a way out for passwords that aren't 4 digits
    this.initPinPad();
    const usePw = document.getElementById("pinUsePassword");
    if (usePw && !usePw.dataset.bound) {
      usePw.dataset.bound = "1";
      usePw.addEventListener("click", () => {
        document.getElementById("loginScreen")?.classList.add("use-password");
        document.getElementById("loginPassword")?.focus();
      });
    }
  },

  initPinPad() {
    const dots = document.querySelectorAll("#pinDots .pin-dot");
    const pinError = document.getElementById("pinError");
    let pin = "";

    const updateDots = () => {
      dots.forEach((dot, i) => {
        dot.classList.toggle("filled", i < pin.length);
        dot.classList.remove("error");
      });
    };

    // keepMessage: a refusal for a while (holdRefusal) is on the line, counting down; it clears itself.
    const shakeAndClear = (msg, { keepMessage = false } = {}) => {
      if (!keepMessage) pinError.textContent = msg || "Wrong PIN";
      dots.forEach((d) => d.classList.add("error"));
      setTimeout(() => {
        pin = "";
        updateDots();
        if (!keepMessage && !this.refusalHeld()) pinError.textContent = "";
      }, 600);
    };

    const tryLogin = async () => {
      try {
        await this.signIn(pin);
        this.afterLogin();
      } catch (err) {
        // Say what actually happened: a rate limit or lockout is not a wrong PIN.
        const msg = String(err?.message || "");
        if (err?.status === 429) {
          this.holdRefusal(msg, err.retryAfter);
          shakeAndClear(null, { keepMessage: true });
          return;
        }
        shakeAndClear(/too many|locked out|try again/i.test(msg) ? msg : "Wrong PIN");
      }
    };

    // Key buttons
    document.querySelectorAll(".pin-key[data-digit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (pin.length >= 4 || this.refusalHeld()) return;
        pin += btn.dataset.digit;
        updateDots();
        if (pin.length === 4) {
          setTimeout(tryLogin, 150);
        }
      });
    });

    // Delete button
    document.getElementById("pinDelete").addEventListener("click", () => {
      if (pin.length > 0) {
        pin = pin.slice(0, -1);
        updateDots();
      }
    });
  },

  async showApp() {
    this._appShownOnce = true;
    // Check if first-time setup is needed
    try {
      const status = await API.json("/api/settings/setup-status");
      if (status.needsSetup) {
        Setup.show(status);
        return;
      }
      // An AI is ready but there's no personality yet: ask (Setup.askPersonality). Starting the interview here would
      // send its first message to the AI before the owner did anything, on an API key at their cost.
      if (status.needsPersonality && status.hasKey) {
        Setup.askPersonality();
        return;
      }
    } catch {
      // If setup check fails, continue normally
    }

    this.bootApp();
  },

  bootApp() {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("setupWizard").style.display = "none";
    document.getElementById("appScreen").style.display = "grid";

    // Sign out: ends this device's session only (other devices stay in). Asked in our own dialog (js/dialogs.js), and once:
    // a second press while it is signing out does nothing.
    let signingOut = false;
    document.getElementById("signOutBtn")?.addEventListener("click", async () => {
      if (signingOut) return;
      if (!(await TarseeDialog.ask({ title: "Sign out of Tarsee on this device?", yes: "Sign out", no: "Cancel", danger: true }))) return;
      signingOut = true;
      try { await API.logout(); } catch { /* the session may already be gone */ }
      try { localStorage.removeItem("tarsee_api_token"); } catch { /* ignore */ }
      window.location.reload();
    });

    // Signed in: the parts that waited for it (js/brand-icon.js asks for the icon's state) can go on.
    window.dispatchEvent(new Event("tarsee:signed-in"));

    // Initialize modules
    Chat.init();
    Voice.init();   // the composer's microphone (dictation)
    Call.init();    // a voice call with the AI (the topbar's Call button)
    Settings.init();
    FileManager.init();
    Console.init();

    // Mobile menu toggle with overlay
    const menuBtn = document.getElementById("menuBtn");
    const sidebar = document.getElementById("sidebar");

    // Create overlay for sidebar
    const overlay = document.createElement("div");
    overlay.className = "sidebar-overlay";
    overlay.id = "sidebarOverlay";
    document.body.appendChild(overlay);

    const closeSidebar = () => {
      sidebar.classList.remove("open");
      overlay.classList.remove("active");
      menuBtn.setAttribute("aria-expanded", "false");
    };

    // Always bind — CSS .mobile-only hides the button on desktop
    menuBtn.addEventListener("click", () => {
      const isOpen = sidebar.classList.toggle("open");
      overlay.classList.toggle("active", isOpen);
      menuBtn.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) setTimeout(() => document.getElementById("newChatBtn")?.focus({ preventScroll: true }), 50);
    });
    overlay.addEventListener("click", closeSidebar);
    // The drawer closes when a chat is picked (Chat closes it too when it opens one), and on Esc.
    sidebar.addEventListener("click", (e) => {
      if (e.target.closest(".nav-row, .search-result-item, #newChatBtn, #settingsBtn")) closeSidebar();
    });
    sidebar.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sidebar.classList.contains("open")) { closeSidebar(); menuBtn.focus(); }
    });

    // Handle window resize
    window.addEventListener("resize", () => {
      if (window.innerWidth > 768) closeSidebar();
    });

    // QR Code button
    const qrBtn = document.getElementById("qrCodeBtn");
    if (qrBtn) {
      qrBtn.addEventListener("click", () => {
        // Remove existing modal
        document.getElementById("qrModal")?.remove();

        const url = window.location.href;
        const modal = document.createElement("div");
        modal.id = "qrModal";
        modal.className = "delete-modal-overlay qr-modal-overlay";
        // Modal uses flex column centering on the QR holder so the SVG sits
        // dead-center regardless of its rendered width — text-align:center
        // alone doesn't center block-level SVG output from the qrcode lib.
        modal.innerHTML = `
          <div class="delete-modal qr-modal">
            <div class="delete-modal-header qr-modal-header">Scan on Mobile</div>
            <div class="qr-canvas-holder">
              <div id="qrCanvas" class="qr-canvas"></div>
            </div>
            <p class="qr-modal-url">${escapeAttr(url)}</p>
            <div class="delete-modal-actions">
              <button class="btn btn-ghost" id="qrClose">Close</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);

        // Generate QR code
        if (typeof qrcode !== "undefined") {
          const qr = qrcode(0, "M");
          qr.addData(url);
          qr.make();
          // Render at 5px modules — fits a 240px max-width holder cleanly.
          document.getElementById("qrCanvas").innerHTML = qr.createSvgTag(5, 0);
          const svg = document.querySelector("#qrCanvas svg");
          if (svg) {
            // Force the SVG to fill the holder so flex centers it predictably.
            svg.removeAttribute("width");
            svg.removeAttribute("height");
            svg.style.width = "100%";
            svg.style.height = "auto";
            svg.style.display = "block";
          }
        }

        document.getElementById("qrClose").addEventListener("click", () => modal.remove());
        modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
      });
    }

    // Escape HTML attribute values for safe interpolation.
    function escapeAttr(s) {
      return String(s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
      ));
    }

    // Refresh CSRF token periodically (every hour)
    setInterval(() => {
      fetch("/", { credentials: "same-origin" }).catch(() => {});
    }, 60 * 60 * 1000);

    // --- iOS virtual keyboard handling ---
    // Drive the app shell height from visualViewport.height. When the software
    // keyboard opens, visualViewport shrinks — the flex-anchored composer then
    // rides up with the new bottom edge and sits flush with the keyboard,
    // matching Claude's app. (`100dvh` alone doesn't work on iOS because it
    // only tracks URL-bar / orientation changes, not keyboard show/hide.)
    if (typeof window.visualViewport !== "undefined") {
      const vv = window.visualViewport;
      const updateAppHeight = () => {
        document.documentElement.style.setProperty("--app-height", vv.height + "px");
        document.documentElement.classList.toggle(
          "keyboard-open",
          window.innerHeight - vv.height > 80
        );
      };
      vv.addEventListener("resize", updateAppHeight);
      vv.addEventListener("scroll", updateAppHeight);
      window.addEventListener("orientationchange", () => setTimeout(updateAppHeight, 200));
      updateAppHeight();

      const input = document.getElementById("messageInput");
      input?.addEventListener("focus", () => {
        if (window.innerWidth > 768) return;
        setTimeout(() => input.scrollIntoView({ block: "end", behavior: "smooth" }), 280);
      });
    }

    // Offline / online state — surfaced only as a transient toast. No persistent banner.
    window.addEventListener("online", () => this.showToast("Back online", "success"));
    window.addEventListener("offline", () => this.showToast("You're offline: changes will retry when you reconnect", "warning"));

    // Global keyboard shortcuts. Only fire when the user isn't typing into
    // an input field, otherwise `?` would block text entry.
    document.addEventListener("keydown", (e) => {
      const target = e.target;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      // `?` toggles the shortcut overlay. Uses shift-slash on US layout so
      // we also accept "/" with shift — matches the GitHub / Linear muscle memory.
      if (!typing && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
        e.preventDefault();
        this.toggleKbdOverlay();
      }

      // Escape closes the overlay when it's open.
      if (e.key === "Escape" && document.getElementById("kbdOverlay")) {
        document.getElementById("kbdOverlay")?.remove();
      }
    });
  },

  toggleKbdOverlay() {
    const existing = document.getElementById("kbdOverlay");
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement("div");
    overlay.id = "kbdOverlay";
    overlay.className = "kbd-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Keyboard shortcuts");
    overlay.innerHTML = `
      <div class="kbd-overlay-panel">
        <h3>Keyboard shortcuts</h3>
        <div class="kbd-group">
          <div class="kbd-group-title">Navigation</div>
          <span class="kbd-label">Show this help</span>
          <span class="kbd-keys"><span class="kbd-key">?</span></span>
          <span class="kbd-label">Close dialogs / cancel</span>
          <span class="kbd-keys"><span class="kbd-key">Esc</span></span>

          <div class="kbd-group-title">Composer</div>
          <span class="kbd-label">Command palette</span>
          <span class="kbd-keys"><span class="kbd-key">/</span></span>
          <span class="kbd-label">Send message</span>
          <span class="kbd-keys"><span class="kbd-key">Enter</span></span>
          <span class="kbd-label">New line</span>
          <span class="kbd-keys"><span class="kbd-key">Shift</span><span class="kbd-key">Enter</span></span>
          <span class="kbd-label">Max thinking effort for this message</span>
          <span class="kbd-keys"><span class="kbd-key">!!</span></span>

          <div class="kbd-group-title">Call</div>
          <span class="kbd-label">Put the call window away (the call goes on)</span>
          <span class="kbd-keys"><span class="kbd-key">Esc</span></span>
        </div>
        <div style="text-align:right">
          <button class="btn btn-sm" id="kbdClose">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("kbdClose")?.addEventListener("click", () => overlay.remove());
  },

  /**
   * Show a toast notification.
   */
  showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Tiny haptic cue on touch devices — Android honors this, iOS ignores it.
    if (type === "success") this.buzz([8, 40, 8]);
    else if (type === "error") this.buzz([20, 60, 20]);

    setTimeout(() => {
      toast.classList.add("removing");
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  },

  /**
   * Fire a haptic pattern if the device supports it. Ignored silently on iOS
   * and desktop. Keep patterns short — long vibrations feel nagging.
   */
  buzz(pattern) {
    try { navigator.vibrate?.(pattern); } catch { /* noop */ }
  },
};

// A 401 anywhere (session expired) shows the login screen once, no reload storm.
window.addEventListener("tarsee:auth-required", () => App.showLogin());

// Forms that only group password fields (data-no-submit) must never submit.
// This was an inline onsubmit; the CSP now forbids inline script.
document.addEventListener("submit", (e) => {
  if (e.target?.matches?.("form[data-no-submit]")) e.preventDefault();
});

// Boot
document.addEventListener("DOMContentLoaded", () => App.init());
