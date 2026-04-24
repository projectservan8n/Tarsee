/**
 * Tarsee App — Main initialization.
 */
const App = {
  async init() {
    // Check auth status
    try {
      const { authenticated, needsPassword } = await API.authStatus();

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

  showLogin() {
    document.getElementById("loginScreen").style.display = "flex";
    document.getElementById("appScreen").style.display = "none";

    // Desktop: classic form login
    const form = document.getElementById("loginForm");
    const errorEl = document.getElementById("loginError");
    const submitBtn = form.querySelector("button[type='submit']");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
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
        await API.login(password);
        this.showApp();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.removeAttribute("aria-busy");
          if (prevLabel) submitBtn.textContent = prevLabel;
        }
      }
    });

    document.getElementById("loginPassword").focus();

    // Mobile: PIN pad
    this.initPinPad();
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

    const shakeAndClear = (msg) => {
      pinError.textContent = msg || "Wrong PIN";
      dots.forEach((d) => d.classList.add("error"));
      setTimeout(() => {
        pin = "";
        updateDots();
        pinError.textContent = "";
      }, 600);
    };

    const tryLogin = async () => {
      try {
        await API.login(pin);
        this.showApp();
      } catch {
        shakeAndClear("Wrong PIN");
      }
    };

    // Key buttons
    document.querySelectorAll(".pin-key[data-digit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (pin.length >= 4) return;
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
    // Check if first-time setup is needed
    try {
      const status = await API.json("/api/settings/setup-status");
      if (status.needsSetup) {
        Setup.show(status);
        return;
      }
      // If provider configured but no personality, start interview
      if (status.needsPersonality && status.hasKey) {
        this.bootApp();
        Setup.startPersonalityInterview();
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

    // Initialize modules
    Chat.init();
    Voice.init();
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
    };

    // Always bind — CSS .mobile-only hides the button on desktop
    menuBtn.addEventListener("click", () => {
      const isOpen = sidebar.classList.toggle("open");
      overlay.classList.toggle("active", isOpen);
    });
    overlay.addEventListener("click", closeSidebar);
    // Close sidebar when a channel is clicked
    sidebar.addEventListener("click", (e) => {
      if (e.target.closest(".channel-item")) closeSidebar();
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
    window.addEventListener("offline", () => this.showToast("You're offline — changes will retry when you reconnect", "warning"));

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

          <div class="kbd-group-title">Voice</div>
          <span class="kbd-label">Hold to talk (when voice panel is open)</span>
          <span class="kbd-keys"><span class="kbd-key">Space</span></span>
          <span class="kbd-label">Cancel recording</span>
          <span class="kbd-keys"><span class="kbd-key">Space</span><span class="kbd-key">C</span></span>
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

// Boot
document.addEventListener("DOMContentLoaded", () => App.init());
