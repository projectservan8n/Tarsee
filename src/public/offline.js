// Shown by the service worker when a page load fails. That is usually the
// server restarting or the tunnel blipping, not the device being offline,
// so say which one it is and reload as soon as the server answers.
(function () {
  const title = document.getElementById("title");
  const detail = document.getElementById("detail");
  const paint = () => {
    if (navigator.onLine === false) {
      title.textContent = "You're offline";
      detail.textContent = "This device has no connection. Tarsee reconnects when it's back.";
    } else {
      title.textContent = "Can't reach Tarsee";
      detail.textContent = "Your server didn't answer. It may be restarting; this page reconnects by itself.";
    }
  };
  const probe = async () => {
    try {
      const r = await fetch("/api/auth/status", { cache: "no-store", credentials: "same-origin" });
      if (r.ok) location.reload();
    } catch { /* still down */ }
  };
  document.getElementById("retry").addEventListener("click", () => location.reload());
  window.addEventListener("online", () => { paint(); probe(); });
  window.addEventListener("offline", paint);
  paint();
  setInterval(probe, 5000);
})();
