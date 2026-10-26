// Apply the saved theme before first paint (no flash). Loaded synchronously
// in <head>; a file rather than an inline script so the CSP can forbid
// inline script entirely.
(function () {
  try {
    var t = localStorage.getItem("tarsee_theme");
    // Alias the old hardcoded "dark" value (was in HTML pre-theme-switcher).
    if (t === "dark") t = "warm-charcoal";
    if (t) document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* localStorage blocked — keep default */ }
})();
