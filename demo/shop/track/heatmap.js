/* Fake session-heatmap tracker, intentionally local. AegisWeb should block this. */
(() => {
  window.__nimbusTracker = window.__nimbusTracker || {};
  window.__nimbusTracker.heatmap = { loaded: true, at: Date.now() };
  try {
    document.cookie = "nimbus_heatmap=1; path=/; max-age=31536000";
    localStorage.setItem("nimbus_heatmap", "1");
  } catch (_) {}
})();
