(() => {
  const form = document.getElementById("research-form");
  const shell = document.getElementById("form-shell");
  const confirmation = document.getElementById("confirmation");
  const newResponse = document.getElementById("new-response");
  if (!form || !confirmation) return;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value && value.trim() ? value.trim() : "—";
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const price = String(data.price || "").trim();
    const product = String(data.product || "").trim();
    const source = String(data.source || "").trim();

    if (!price) {
      const priceField = document.getElementById("price");
      priceField?.focus();
      priceField?.setAttribute("aria-invalid", "true");
      return;
    }

    setText("receipt-product", product || "First featured product");
    setText("receipt-price", price);
    setText("receipt-source", source || window.location.origin + "/shop/");
    setText("receipt-time", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

    // Verifiable signals for the agent and the dashboard.
    window.__webxFormSubmitted = true;
    document.documentElement.dataset.webxFormSubmitted = "true";
    document.documentElement.dataset.webxPrice = price;

    shell.hidden = true;
    confirmation.hidden = false;
    confirmation.scrollIntoView({ behavior: "smooth", block: "center" });
    confirmation.focus?.();
  });

  newResponse?.addEventListener("click", () => {
    form.reset();
    confirmation.hidden = true;
    shell.hidden = false;
    document.getElementById("price")?.focus();
    window.__webxFormSubmitted = false;
    delete document.documentElement.dataset.webxFormSubmitted;
  });
})();
