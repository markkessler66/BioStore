// History of PhyNetPy runs for the signed-in display name.
const JobsView = (() => {
  const KEY = "◈ Jobs";
  let paneEl = null;
  let selectedId = null;
  let lastJobs = [];

  function open() {
    if (App.hasTab && App.hasTab(KEY)) {
      App.activateTab(KEY);
      return;
    }
    App.openToolTab(KEY, "Jobs", build);
  }

  function build(pane) {
    paneEl = pane;
    pane.innerHTML = "";
    const wrap = UI.el("div", { class: "jobs-wrap" });
    const head = UI.el("div", { class: "workspace-head" });
    head.appendChild(UI.el("div", { class: "workspace-titles" }, [
      UI.el("h1", { class: "workspace-title", text: "Jobs" }),
      UI.el("p", { class: "workspace-desc", text: "Analyses run under " + (API.getDisplayName() || "this display name") }),
    ]));
    const tableWrap = UI.el("div", { class: "jobs-table-wrap" });
    wrap.append(head, tableWrap);
    pane.appendChild(wrap);
    tableWrap.appendChild(UI.el("p", { class: "muted", style: "padding:16px", text: "Loading…" }));
    if (App.requestJobs) App.requestJobs();
  }

  function renderList(jobs) {
    lastJobs = jobs || [];
    if (!paneEl || !paneEl.isConnected) return;
    const tableWrap = paneEl.querySelector(".jobs-table-wrap");
    if (!tableWrap) return;
    tableWrap.innerHTML = "";
    if (!lastJobs.length) {
      tableWrap.appendChild(UI.emptyState(
        "No analyses yet",
        "Run an analysis to see its progress and results here."
      ));
      const btn = UI.el("button", { class: "primary", type: "button", text: "Run Analysis" });
      btn.addEventListener("click", () => PhyNetPyRunner.open());
      tableWrap.querySelector(".empty-state").appendChild(btn);
      return;
    }
    const table = UI.el("table", { class: "jobs-table" });
    const thead = UI.el("thead");
    const hr = UI.el("tr");
    ["Method", "Status", "When", "Elapsed", "Score", "Saved"].forEach((h) =>
      hr.appendChild(UI.el("th", { text: h }))
    );
    thead.appendChild(hr);
    const tbody = UI.el("tbody");
    for (const j of lastJobs) {
      const tr = UI.el("tr", { class: j.id === selectedId ? "selected" : "" });
      const score = j.result && j.result.score != null ? String(j.result.score) : "—";
      const saved = (j.result && j.result.saved_as) || "—";
      const elapsed = UI.formatDuration(j.elapsed_sec);
      tr.append(
        UI.el("td", { text: j.method_name || j.method }),
        UI.el("td", {}, [UI.el("span", { class: "status-pill " + j.status, text: j.status })]),
        UI.el("td", { text: UI.formatWhen(j.created_at) }),
        UI.el("td", { text: elapsed }),
        UI.el("td", { text: score }),
        UI.el("td", { class: "clip", text: saved, title: saved })
      );
      tr.addEventListener("click", () => {
        selectedId = j.id;
        renderList(lastJobs);
        if (App.inspectJob) App.inspectJob(j);
      });
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    tableWrap.appendChild(table);
  }

  return { open, build, renderList, KEY };
})();
