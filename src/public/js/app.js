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
        this.showApp();
      } else {
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

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.style.display = "none";

      const password = document.getElementById("loginPassword").value;
      try {
        await API.login(password);
        this.showApp();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
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
        modal.className = "delete-modal-overlay";
        modal.innerHTML = `
          <div class="delete-modal" style="text-align:center;max-width:320px">
            <div class="delete-modal-header">Scan on Mobile</div>
            <div id="qrCanvas" style="margin:16px auto;"></div>
            <p class="text-muted text-sm" style="word-break:break-all">${url}</p>
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
          document.getElementById("qrCanvas").innerHTML = qr.createSvgTag(6, 0);
          // Style the SVG
          const svg = document.querySelector("#qrCanvas svg");
          if (svg) {
            svg.style.borderRadius = "8px";
            svg.style.background = "#fff";
            svg.style.padding = "12px";
          }
        }

        document.getElementById("qrClose").addEventListener("click", () => modal.remove());
        modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
      });
    }

    // Refresh CSRF token periodically (every hour)
    setInterval(() => {
      fetch("/", { credentials: "same-origin" }).catch(() => {});
    }, 60 * 60 * 1000);
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

    setTimeout(() => {
      toast.classList.add("removing");
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  },
};

// Boot
document.addEventListener("DOMContentLoaded", () => App.init());
