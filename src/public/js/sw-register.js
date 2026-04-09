if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js?v=3").catch(() => {});
}
