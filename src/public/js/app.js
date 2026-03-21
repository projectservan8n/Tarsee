/**
 * OpusClaw App — Main initialization.
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

  showApp() {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appScreen").style.display = "flex";

    // Initialize modules
    Chat.init();
    Voice.init();
    Settings.init();
    Console.init();

    // Mobile menu toggle
    const menuBtn = document.getElementById("menuBtn");
    const sidebar = document.getElementById("sidebar");

    if (window.innerWidth <= 768) {
      menuBtn.style.display = "inline-flex";
      menuBtn.addEventListener("click", () => {
        sidebar.classList.toggle("open");
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
      toast.style.opacity = "0";
      toast.style.transform = "translateX(20px)";
      setTimeout(() => toast.remove(), 200);
    }, 4000);
  },
};

// Boot
document.addEventListener("DOMContentLoaded", () => App.init());
