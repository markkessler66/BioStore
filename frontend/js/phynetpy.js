// PhyNetPy analysis workspace. Methods and parameters still come from the
// backend schema; this module only groups and presents them.
const PhyNetPyRunner = (() => {
  const KEY = "◈ PhyNetPy Runner";
  const CONFIG_KEYS = new Set(["strategy", "preset", "opt_bl", "save_as"]);
  const SEARCH_KEYS = new Set(["search"]);

  let methods = [];
  let status = { available: false };

  function open() {
    if (App.hasTab && App.hasTab(KEY)) {
      App.activateTab(KEY);
      return;
    }
    App.openToolTab(KEY, "Analysis", build);
  }

  async function build(pane) {
    pane.innerHTML = "";
    pane.appendChild(UI.el("div", { class: "muted", style: "padding:20px", text: "Loading PhyNetPy methods…" }));
    try {
      status = await API.phynetpyStatus();
      const res = await API.phynetpyMethods();
      methods = res.methods || [];
    } catch (e) {
      pane.innerHTML = "";
      pane.appendChild(UI.el("div", { class: "error-state" }, [
        UI.el("h2", { text: "PhyNetPy could not be loaded" }),
        UI.el("p", { text: e.message || "The method list is unavailable." }),
        UI.el("p", { class: "muted", text: "Check that PhyNetPy is installed in the same Python environment as BioStore." }),
      ]));
      return;
    }
    render(pane);
  }

  function render(pane) {
    pane.innerHTML = "";
    const wrap = UI.el("div", { class: "jobs-wrap" });
    const head = UI.el("div", { class: "workspace-head" });
    const titles = UI.el("div", { class: "workspace-titles" });
    const title = UI.el("h1", { class: "workspace-title", text: "Analysis" });
    const desc = UI.el("p", { class: "workspace-desc" });
    titles.append(title, desc);

    const actions = UI.el("div", { class: "workspace-actions" });
    const methodSel = UI.el("select", { class: "method-select", "aria-label": "Method" });
    methods.forEach((m) => methodSel.appendChild(UI.el("option", { value: m.id, text: m.name })));
    const runBtn = UI.el("button", {
      class: "primary",
      type: "button",
      text: "Run Analysis",
      disabled: status.available ? null : "disabled",
    });
    actions.append(methodSel, runBtn);
    head.append(titles, actions);

    const body = UI.el("div", { class: "analysis-body" });
    if (!status.available) {
      body.appendChild(UI.el("p", {
        class: "error-state",
        text: "PhyNetPy is not available" + (status.error ? ": " + status.error : "."),
      }));
    }
    wrap.append(head, body);
    pane.appendChild(wrap);

    const state = { method: methods[0] || null, inputs: {}, params: {} };

    function controlFor(p) {
      const row = UI.el("div", { class: "field" });
      if (p.type !== "checkbox") {
        row.appendChild(UI.el("label", { class: "field-label", text: p.label || p.key }));
      }
      if (p.type === "select") {
        const control = UI.el("select", { class: "runner-select" });
        (p.options || []).forEach((o) =>
          control.appendChild(UI.el("option", {
            value: o,
            text: o,
            selected: String(state.params[p.key] ?? p.default) === String(o) ? "selected" : null,
          }))
        );
        if (state.params[p.key] == null) state.params[p.key] = p.default;
        control.addEventListener("change", () => { state.params[p.key] = control.value; });
        row.appendChild(control);
      } else if (p.type === "checkbox") {
        const control = UI.el("input", { type: "checkbox" });
        const checked = state.params[p.key] != null ? !!state.params[p.key] : !!p.default;
        control.checked = checked;
        state.params[p.key] = checked;
        control.addEventListener("change", () => { state.params[p.key] = control.checked; });
        row.appendChild(UI.el("label", { class: "check-row" }, [
          control,
          document.createTextNode(p.label || p.key),
        ]));
      } else if (p.type === "textarea") {
        const control = UI.el("textarea", {
          class: "runner-textarea",
          rows: "5",
          spellcheck: "false",
          placeholder: p.placeholder || '{ "A": ["A1", "A2"] }',
        });
        control.value = state.params[p.key] != null ? state.params[p.key] : (p.default || "");
        state.params[p.key] = control.value;
        control.addEventListener("input", () => { state.params[p.key] = control.value; });
        row.appendChild(control);
      } else if (p.key === "save_as" || /path|file/i.test(p.key)) {
        const control = UI.el("input", {
          type: "text",
          class: "runner-input",
          value: state.params[p.key] != null ? String(state.params[p.key]) : (p.default || ""),
          placeholder: "results/inferred_network.nwk",
        });
        state.params[p.key] = control.value;
        control.addEventListener("input", () => { state.params[p.key] = control.value; });
        row.appendChild(control);
      } else {
        const control = UI.el("input", {
          type: p.type === "number" ? "number" : "text",
          class: "runner-input",
          value: state.params[p.key] != null ? String(state.params[p.key]) : (p.default != null ? String(p.default) : ""),
        });
        if (state.params[p.key] == null) state.params[p.key] = p.default;
        control.addEventListener("input", () => {
          state.params[p.key] = control.type === "number"
            ? (control.value === "" ? "" : Number(control.value))
            : control.value;
        });
        row.appendChild(control);
      }
      return row;
    }

    function fileField(key, required) {
      const row = UI.el("div", { class: "field" });
      row.appendChild(UI.el("label", { class: "field-label", text: key.replace(/_/g, " ") + (required ? "" : " (optional)") }));
      const box = UI.el("div", { class: "file-picker" });
      const empty = UI.el("div", { class: "file-picker-empty", text: "Drop a file here, or browse" });
      const name = UI.el("span", { class: "file-picker-name hidden" });
      const remove = UI.el("button", { class: "icon-btn", type: "button", title: "Remove file", "aria-label": "Remove file" });
      remove.appendChild(Icons.el("close"));
      remove.classList.add("hidden");
      const browse = UI.el("button", { class: "ghost", type: "button", text: "Browse" });

      function show(path) {
        state.inputs[key] = path || "";
        const has = !!path;
        empty.classList.toggle("hidden", has);
        name.classList.toggle("hidden", !has);
        remove.classList.toggle("hidden", !has);
        name.textContent = path ? UI.basename(path) : "";
        name.title = path || "";
      }
      show(state.inputs[key] || "");
      remove.addEventListener("click", () => show(""));
      browse.addEventListener("click", async () => {
        const path = await UI.pickStoreFile({
          title: "Select " + key.replace(/_/g, " "),
          acceptKinds: ["network", "alignment", "file"],
        });
        if (path) show(path);
      });
      UI.bindStoreDrop(box, show);
      box.append(empty, name, remove, browse);
      row.appendChild(box);
      return row;
    }

    function section(heading, nodes) {
      if (!nodes.length) return null;
      const sec = UI.el("section", { class: "form-section" });
      sec.appendChild(UI.el("h2", { class: "section-heading", text: heading }));
      nodes.forEach((n) => sec.appendChild(n));
      return sec;
    }

    function rebuildForm() {
      const m = methods.find((x) => x.id === methodSel.value) || methods[0];
      state.method = m;
      body.querySelectorAll(".form-section, .disclosure").forEach((n) => n.remove());
      if (!m) return;
      title.textContent = m.name || "Analysis";
      desc.textContent = m.description || "";

      const inputs = [];
      (m.inputs || []).forEach((key) => inputs.push(fileField(key, true)));
      (m.optional_inputs || []).forEach((key) => inputs.push(fileField(key, false)));

      const config = [];
      const search = [];
      const advanced = [];
      (m.params || []).forEach((p) => {
        const node = controlFor(p);
        if (CONFIG_KEYS.has(p.key)) config.push(node);
        else if (SEARCH_KEYS.has(p.key)) search.push(node);
        else advanced.push(node);
      });

      const advancedBody = UI.el("div");
      advanced.forEach((n) => advancedBody.appendChild(n));
      const advancedSec = advanced.length
        ? UI.disclosure("Advanced Options", advancedBody)
        : null;

      [section("Inputs", inputs), section("Configuration", config), section("Search", search), advancedSec]
        .filter(Boolean)
        .forEach((n) => body.appendChild(n));
    }

    methodSel.addEventListener("change", rebuildForm);
    rebuildForm();

    runBtn.addEventListener("click", async () => {
      const m = state.method;
      if (!m) return;
      for (const key of m.inputs || []) {
        if (!state.inputs[key]) {
          UI.toast("Choose " + key.replace(/_/g, " "), "error");
          return;
        }
      }
      runBtn.disabled = true;
      try {
        const params = {};
        (m.params || []).forEach((p) => { params[p.key] = state.params[p.key]; });
        const inputs = {};
        [...(m.inputs || []), ...(m.optional_inputs || [])].forEach((key) => {
          if (state.inputs[key]) inputs[key] = state.inputs[key];
        });
        const job = await API.phynetpyRun({ method: m.id, inputs, params });
        UI.toast("Analysis started", "success");
        if (App.onJobStarted) App.onJobStarted(job);
      } catch (e) {
        UI.toast(e.message, "error");
      } finally {
        runBtn.disabled = !status.available;
      }
    });
  }

  return { open, build, KEY };
})();
