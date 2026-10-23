/* Clearpath UI — progressive enhancement only. No frameworks, no network calls. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- disclosure: marketing nav + workspace sidebar ---------- */
  document.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) {
      const target = document.getElementById(toggle.dataset.toggle);
      if (target) {
        const open = target.classList.toggle("open");
        toggle.setAttribute("aria-expanded", String(open));
      }
      return;
    }

    const backdrop = event.target.classList.contains("sidebar") === false && event.target.closest("[data-close-nav]");
    if (backdrop) {
      $$(".sidebar.open").forEach((el) => el.classList.remove("open"));
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $$(".sidebar.open, .site-nav.open").forEach((el) => el.classList.remove("open"));
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      const search = $("[data-quick-search]");
      if (search) {
        event.preventDefault();
        search.focus();
        search.select();
      }
    }
  });

  /* ---------- tabs ---------- */
  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    const group = tab.closest("[data-tabs]");
    if (!group) return;
    $$("[data-tab]", group).forEach((el) => {
      const active = el === tab;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-selected", String(active));
    });
    $$("[data-panel]", group.parentElement ? group.parentElement : document).forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
  });

  /* ---------- dialogs ---------- */
  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open]");
    if (opener) {
      const dialog = document.getElementById(opener.dataset.open);
      if (dialog && typeof dialog.showModal === "function") {
        dialog.showModal();
        const field = dialog.querySelector("input:not([type=hidden]):not([type=file]), select, textarea");
        const first = field || dialog.querySelector("button");
        if (first) setTimeout(() => first.focus(), 30);
      }
      return;
    }
    const closer = event.target.closest("[data-close]");
    if (closer) {
      const dialog = closer.closest("dialog");
      if (dialog) dialog.close();
    }
  });

  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  /* ---------- confirmations ---------- */
  document.addEventListener("submit", (event) => {
    const form = event.target;
    const message = form.dataset.confirm;
    if (message && !window.confirm(message)) {
      event.preventDefault();
      return;
    }
    const button = form.querySelector('[type="submit"]');
    if (button && form.dataset.busy !== "false") {
      button.dataset.label = button.textContent;
      button.textContent = button.dataset.busyLabel || "Working…";
      button.disabled = true;
      setTimeout(() => {
        if (button.isConnected) {
          button.disabled = false;
          if (button.dataset.label) button.textContent = button.dataset.label;
        }
      }, 6000);
    }
  });

  /* ---------- copy buttons ---------- */
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy], [data-copy-from]");
    if (!button) return;
    const source = button.dataset.copyFrom ? document.getElementById(button.dataset.copyFrom) : null;
    const value = button.dataset.copy || (source ? source.value || source.textContent : "");
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = original; }, 1500);
    } catch {
      const input = document.createElement("input");
      input.value = value;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
  });

  /* ---------- password reveal ---------- */
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reveal]");
    if (!button) return;
    const input = document.getElementById(button.dataset.reveal);
    if (!input) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.textContent = showing ? "Show" : "Hide";
    button.setAttribute("aria-pressed", String(!showing));
  });

  /* ---------- filters auto-submit ---------- */
  $$("[data-auto-filter]").forEach((control) => {
    control.addEventListener("change", () => {
      const form = control.closest("form");
      if (form) form.submit();
    });
  });

  /* ---------- file input name ---------- */
  $$("[data-file-input]").forEach((input) => {
    input.addEventListener("change", () => {
      const label = document.querySelector(input.dataset.fileInput);
      if (!label) return;
      label.textContent = input.files && input.files[0]
        ? `${input.files[0].name} · ${(input.files[0].size / 1024).toFixed(0)} KB`
        : "No file selected";
    });
  });

  /* ---------- range readouts ---------- */
  $$("input[type=range][data-range-target]").forEach((range) => {
    const out = document.querySelector(`[data-range-out="${range.dataset.rangeTarget}"]`);
    if (!out) return;
    const sync = () => { out.textContent = range.value; };
    range.addEventListener("input", sync);
    sync();
  });

  /* ---------- flash notices ---------- */
  $$("[data-dismiss]").forEach((button) => {
    button.addEventListener("click", () => {
      const notice = button.closest(".notice");
      if (notice) notice.remove();
    });
  });
})();
