/* Fake ad-retargeting tracker, intentionally local. AegisWeb should block this. */
(() => {
  window.__nimbusTracker = window.__nimbusTracker || {};
  window.__nimbusTracker.ads = { loaded: true, partners: 847 };
  try {
    const img = new Image();
    img.src = "/shop/track/pixel.gif?retarget=1";
  } catch (_) {}
})();
