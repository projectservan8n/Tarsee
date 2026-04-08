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

    if (window.innerWidth <= 768) {
      menuBtn.addEventListener("click", () => {
        const isOpen = sidebar.classList.toggle("open");
        overlay.classList.toggle("active", isOpen);
      });
      overlay.addEventListener("click", closeSidebar);
      // Close sidebar when a channel is clicked
      sidebar.addEventListener("click", (e) => {
        if (e.target.closest(".channel-item")) closeSidebar();
      });
    }

    // Handle window resize
    window.addEventListener("resize", () => {
      if (window.innerWidth > 768) closeSidebar();
    });

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
      toast.style.opacity = "0";
      toast.style.transform = "translateX(20px)";
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  },
};

// Boot
document.addEventListener("DOMContentLoaded", () => App.init());
