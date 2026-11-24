(() => {
  const banner = document.getElementById("cookie-banner");
  const reject = document.getElementById("reject-all");
  const accept = document.getElementById("accept-all");
  const privacyState = document.getElementById("privacy-state");
  const toast = document.getElementById("toast");
  const cartButton = document.getElementById("cart-button");
  const cartCount = document.getElementById("cart-count");
  let toastTimer;
  let bag = 0;

  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
  };

  const recordConsent = (choice) => {
    // This is the visible, verifiable outcome the browser agent checks.
    window.__aegisConsent = choice;
    document.documentElement.dataset.consent = choice;
    if (banner) {
      banner.classList.add("is-hidden");
      banner.setAttribute("aria-hidden", "true");
      window.setTimeout(() => { banner.hidden = true; }, 460);
    }
    if (privacyState) privacyState.hidden = false;
    if (choice === "rejected") {
      showToast("Privacy choices saved — essential cookies only.");
    } else {
      showToast("All 847 partners have been notified. Brave choice.");
    }
  };

  if (reject) reject.addEventListener("click", () => recordConsent("rejected"));
  if (accept) accept.addEventListener("click", () => recordConsent("accepted"));

  document.querySelectorAll("[data-manage]").forEach((button) => {
    button.addEventListener("click", () => {
      showToast("The honest button is “Reject all.” This is a demo storefront.");
    });
  });

  document.querySelectorAll("[data-add-to-bag]").forEach((button) => {
    button.addEventListener("click", () => {
      bag += 1;
      if (cartCount) cartCount.textContent = String(bag);
      showToast(`${button.dataset.product} added to your field kit.`);
    });
  });

  if (cartButton) {
    cartButton.addEventListener("click", () => {
      showToast(bag === 0 ? "Your field kit is empty. The trail awaits." : `${bag} item${bag === 1 ? "" : "s"} in your field kit.`);
    });
  }

  // Expose a tiny demo API for the agent's verification step.
  window.__nimbus = {
    get consent() { return window.__aegisConsent || null; },
    get bag() { return bag; },
    get firstProductPrice() {
      return document.querySelector("[data-aegis-price]")?.textContent?.trim() || null;
    }
  };
})();
