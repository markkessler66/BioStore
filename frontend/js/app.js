// Main orchestrator: auth, tabs, locks, search, upload, dashboards.
const App = (() => {
  const tabs = new Map(); // path -> {tab, pane, dirty, kind, locked}
  let activePath = null;
  let tabsEl, panesEl, welcomeEl;
  let heartbeatTimer = null;
  let heartbeatSeconds = 15;
  let appReady = false;

  function isRealFile(path) {
    return path && !path.startsWith("◈ ");
  }

  async function boot() {
    const loginScreen = document.getElementById("login-screen");
    const appShell = document.getElementById("app-shell");
    const form = document.getElementById("login-form");
    const errEl = document.getElementById("login-error");
    const hintEl = document.getElementById("login-hint");

    let status = { auth_required: false, lock_heartbeat_seconds: 15 };
    try {
      status = await API.authStatus();
      heartbeatSeconds = status.lock_heartbeat_seconds || 15;
    } catch {}

    if (!status.auth_required) {
      hintEl.textContent = "No lab password is set on the server — any password works. Set BIOSTORE_PASSWORD for shared hosting.";
    } else {
      hintEl.textContent = "Use the shared lab password. Your display name is shown on file locks.";
    }

    // Resume existing session if still valid.
    if (API.getToken()) {
      try {
        const me = await API.me();
        API.setSession(API.getToken(), me.display_name);
        showApp();
        return;
      } catch {
        API.clearSession();
      }
    }

    loginScreen.classList.remove("hidden");
    appShell.classList.add("hidden");
    const nameInput = document.getElementById("login-name");
    const savedName = localStorage.getItem("biostore_preferred_name") || "";
    if (savedName) nameInput.value = savedName;
    nameInput.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.classList.add("hidden");
      const display_name = nameInput.value.trim();
      const password = document.getElementById("login-password").value;
      try {
        const res = await API.login(password, display_name);
        API.setSession(res.token, res.display_name);
        localStorage.setItem("biostore_preferred_name", res.display_name);
        showApp();
      } catch (err) {
        errEl.textContent = err.message || "Login failed";
        errEl.classList.remove("hidden");
      }
    });
  }

  function showApp() {
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");
    const badge = document.getElementById("status-user");
    if (badge) badge.textContent = API.getDisplayName();
    if (!appReady) {
      init();
      appReady = true;
    } else {
      FileTree.refresh();
      startHeartbeat();
    }
  }

  function init() {
    tabsEl = document.getElementById("tabs");
    panesEl = document.getElementById("panes");
    welcomeEl = document.getElementById("welcome");

    FileTree.init(document.getElementById("tree"), openNode);
    mountIcons();
    setupChrome();

    document.getElementById("btn-refresh").addEventListener("click", () => FileTree.refresh());
    // A plain <input type=file> can't select folders, so Upload offers both
    // pickers; the folder one carries webkitdirectory.
    document.getElementById("btn-upload").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      UI.contextMenu(
        [
          { label: "Upload files…", fn: () => document.getElementById("file-input").click() },
          { label: "Upload folder…", fn: () => document.getElementById("folder-input").click() },
        ],
        r.left,
        r.bottom + 4
      );
    });
    document.getElementById("file-input").addEventListener("change", async (e) => {
      const files = snapshotInputFiles(e.target);
      try {
        await uploadFiles("", files);
      } finally {
        e.target.value = "";
      }
    });
    document.getElementById("folder-input").addEventListener("change", async (e) => {
      const files = snapshotInputFiles(e.target);
      try {
        await uploadFiles("", files);
      } finally {
        e.target.value = "";
      }
    });
    document.getElementById("btn-new-file").addEventListener("click", () => newFile(""));

    setupSearch();
    setupDragDrop();
    loadDataRoot();
    startHeartbeat();
    startJobPoll();

    window.addEventListener("beforeunload", (e) => {
      releaseAllLocksBeacon();
      if ([...tabs.values()].some((t) => t.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  async function logout() {
    const paths = [...tabs.keys()].filter(isRealFile);
    for (const p of paths) {
      try { await API.releaseLock(p); } catch {}
    }
    try { await API.logout(); } catch {}
    API.clearSession();
    stopHeartbeat();
    for (const [, e] of tabs) {
      e.tab.remove();
      e.pane.remove();
    }
    tabs.clear();
    activePath = null;
    location.reload();
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(async () => {
      const paths = [...tabs.keys()].filter(isRealFile);
      if (!paths.length) return;
      try {
        await API.heartbeatLocks(paths);
      } catch (e) {
        if (e.status === 401) {
          UI.toast("Session expired — please log in again", "error");
          API.clearSession();
          location.reload();
        }
      }
    }, Math.max(5, heartbeatSeconds) * 1000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function releaseAllLocksBeacon() {
    const paths = [...tabs.keys()].filter(isRealFile);
    const token = API.getToken();
    if (!paths.length || !token) return;
    for (const path of paths) {
      try {
        fetch("/api/locks/release", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ path }),
          keepalive: true,
        });
      } catch {}
    }
  }

  async function loadDataRoot() {
    try {
      const s = await API.stats();
      document.getElementById("data-root").textContent = s.data_root;
    } catch {}
  }

  function mountIcons() {
    const put = (id, name) => {
      const node = document.getElementById(id);
      if (node && !node.dataset.icon) {
        node.appendChild(Icons.el(name));
        node.dataset.icon = name;
      }
    };
    put("btn-sidebar-toggle", "sidebar");
    put("btn-overflow", "more");
    put("btn-refresh", "refresh");
    put("btn-inspector-close", "close");
    const searchIcon = document.querySelector(".search-icon");
    if (searchIcon && !searchIcon.childElementCount) searchIcon.appendChild(Icons.el("search"));
    document.querySelectorAll(".nav-item").forEach((btn) => {
      if (btn.dataset.iconDone) return;
      const name = btn.dataset.nav === "jobs" ? "jobs" : btn.dataset.nav === "analyses" ? "play" : "folder";
      btn.prepend(Icons.el(name));
      btn.dataset.iconDone = "1";
    });
    updateThemeLabel();
  }

  function updateThemeLabel() {
    const btn = document.getElementById("btn-theme");
    if (!btn) return;
    const light = document.documentElement.dataset.theme === "light";
    btn.textContent = light ? "Use dark theme" : "Use light theme";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("biostore-theme", next);
    updateThemeLabel();
  }

  function setNav(which) {
    document.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.nav === which);
    });
  }

  function setupChrome() {
    const shell = document.getElementById("app-shell");
    if (window.innerWidth < 900) shell.classList.add("sidebar-collapsed");

    document.getElementById("btn-sidebar-toggle").addEventListener("click", () => {
      shell.classList.toggle("sidebar-collapsed");
    });
    document.getElementById("nav-library").addEventListener("click", () => {
      shell.classList.remove("sidebar-collapsed");
      setNav("library");
      const tree = document.getElementById("tree");
      if (tree) tree.focus();
    });
    document.getElementById("nav-jobs").addEventListener("click", () => {
      setNav("jobs");
      JobsView.open();
    });
    document.getElementById("nav-analyses").addEventListener("click", () => {
      setNav("analyses");
      PhyNetPyRunner.open();
    });

    const overflowBtn = document.getElementById("btn-overflow");
    const overflow = document.getElementById("overflow-menu");
    overflowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = overflow.classList.toggle("hidden") === false;
      overflowBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    overflow.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      overflow.classList.add("hidden");
      overflowBtn.setAttribute("aria-expanded", "false");
      runAction(action);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".toolbar-actions")) overflow.classList.add("hidden");
    });

    setupResizer("sidebar-resizer", "sidebar", "biostore-sidebar-width", false);
    setupResizer("inspector-resizer", "inspector", "biostore-inspector-width", true);
    document.getElementById("btn-inspector-close").addEventListener("click", closeInspector);
    document.getElementById("status-activity").addEventListener("click", () => {
      setNav("jobs");
      JobsView.open();
    });
    setupShortcuts();
    setupPalette();
  }

  function runAction(action) {
    if (action === "new-file") newFile("");
    else if (action === "new-folder") newFolder("");
    else if (action === "upload") document.getElementById("file-input").click();
    else if (action === "upload-folder") document.getElementById("folder-input").click();
    else if (action === "jobs") { setNav("jobs"); JobsView.open(); }
    else if (action === "analysis") { setNav("analyses"); PhyNetPyRunner.open(); }
    else if (action === "stats") showStats();
    else if (action === "inspector") toggleInspector();
    else if (action === "theme") toggleTheme();
    else if (action === "logout") logout();
    else if (action === "search") document.getElementById("search-input").focus();
  }

  function setupResizer(handleId, panelId, storageKey, fromRight) {
    const handle = document.getElementById(handleId);
    const panel = document.getElementById(panelId);
    if (!handle || !panel) return;
    const saved = localStorage.getItem(storageKey);
    if (saved && !panel.classList.contains("is-collapsed")) panel.style.width = saved + "px";
    handle.addEventListener("mousedown", (e) => {
      if (handle.classList.contains("is-collapsed")) return;
      e.preventDefault();
      handle.classList.add("is-dragging");
      const move = (ev) => {
        const rect = panel.getBoundingClientRect();
        const w = fromRight ? rect.right - ev.clientX : ev.clientX - rect.left;
        const clamped = Math.min(fromRight ? 480 : 420, Math.max(fromRight ? 220 : 200, w));
        panel.style.width = clamped + "px";
      };
      const up = () => {
        handle.classList.remove("is-dragging");
        localStorage.setItem(storageKey, String(parseInt(panel.style.width, 10) || ""));
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  function openInspector() {
    document.getElementById("inspector").classList.remove("is-collapsed");
    document.getElementById("inspector-resizer").classList.remove("is-collapsed");
  }
  function closeInspector() {
    document.getElementById("inspector").classList.add("is-collapsed");
    document.getElementById("inspector-resizer").classList.add("is-collapsed");
    inspectorMode = null;
  }
  function toggleInspector() {
    const el = document.getElementById("inspector");
    if (el.classList.contains("is-collapsed")) openInspector();
    else closeInspector();
  }

  let inspectorMode = null;

  let inspectedJobId = null;
  let inspectedSnap = "";

  function inspectJob(job, fromPoll) {
    const snap = [job.id, job.status, job.progress && job.progress.iteration, job.result && job.result.score, job.error ? 1 : 0].join("|");
    if (fromPoll && snap === inspectedSnap) return;
    inspectedSnap = snap;
    inspectedJobId = job.id;
    inspectorMode = "job";
    openInspector();
    document.getElementById("inspector-title").textContent = "Job";
    const body = document.getElementById("inspector-body");
    body.innerHTML = "";
    const progress = job.progress || {};
    const bits = [
      ["Method", job.method_name || job.method],
      ["Status", job.status],
      ["Started", UI.formatWhen(job.started_at || job.created_at)],
      ["Elapsed", UI.formatDuration(job.elapsed_sec)],
    ];
    if (progress.iteration && progress.num_iter) {
      bits.push(["Iteration", progress.iteration + " / " + progress.num_iter]);
    }
    if (progress.score != null) bits.push(["Score", String(progress.score)]);
    if (job.result && job.result.score != null) bits.push(["Final score", String(job.result.score)]);
    if (job.eta_sec) bits.push(["Remaining", UI.formatDuration(job.eta_sec)]);
    const dl = UI.el("dl", { class: "kv" });
    bits.forEach(([k, v]) => {
      dl.append(UI.el("dt", { text: k }), UI.el("dd", { text: v }));
    });
    body.append(UI.el("h3", { text: job.method_name || job.method }), dl);

    const inputs = job.inputs || {};
    if (Object.keys(inputs).length) {
      const list = UI.el("dl", { class: "kv" });
      Object.entries(inputs).forEach(([k, v]) => list.append(UI.el("dt", { text: k }), UI.el("dd", { text: String(v) })));
      body.append(UI.el("h3", { text: "Inputs" }), list);
    }
    const params = job.params || {};
    const shown = Object.entries(params).filter(([, v]) => v !== "" && v != null);
    if (shown.length) {
      const list = UI.el("dl", { class: "kv" });
      shown.forEach(([k, v]) => list.append(UI.el("dt", { text: k }), UI.el("dd", { text: typeof v === "string" && v.length > 180 ? v.slice(0, 180) + "…" : String(v) })));
      body.append(UI.el("h3", { text: "Parameters" }), list);
    }
    if (job.result && job.result.network_newick) {
      body.append(UI.el("h3", { text: "Network" }), UI.el("pre", { class: "job-newick", text: job.result.network_newick }));
    }
    if (job.error) {
      const first = String(job.error).split("\n").filter(Boolean)[0] || "The analysis failed.";
      body.append(
        UI.el("h3", { text: "What happened" }),
        UI.el("p", { text: first + " The run did not produce a result. Check the inputs and try again." }),
        UI.disclosure("Technical details", UI.el("pre", { class: "job-error", text: job.error }))
      );
    }
    if (job.log && job.log.length) {
      body.append(UI.disclosure("Log", UI.el("pre", { class: "job-newick", text: job.log.join("\n") })));
    }
    const actions = UI.el("div", { class: "inspector-actions" });
    if (job.result && job.result.saved_as) {
      const open = UI.el("button", { class: "primary", type: "button", text: "Open saved network" });
      open.addEventListener("click", () => {
        FileTree.expandTo(job.result.saved_as);
        FileTree.refresh();
        openNode({ path: job.result.saved_as, name: UI.basename(job.result.saved_as), kind: "network" });
      });
      actions.appendChild(open);
    }
    if (job.result && job.result.network_newick) {
      const copy = UI.el("button", { class: "ghost", type: "button", text: "Copy newick" });
      copy.addEventListener("click", () => UI.copyText(job.result.network_newick));
      actions.appendChild(copy);
    }
    if (job.status !== "running" && job.status !== "queued") {
      const del = UI.el("button", { class: "ghost", type: "button", text: "Delete job" });
      del.addEventListener("click", async () => {
        try {
          await API.phynetpyDeleteJob(job.id);
          UI.toast("Job removed", "success");
          closeInspector();
          requestJobs();
        } catch (e) { UI.toast(e.message, "error"); }
      });
      actions.appendChild(del);
    }
    body.appendChild(actions);
  }

  function inspectFile(path, entry) {
    if (inspectorMode === "job") return;
    if (document.getElementById("inspector").classList.contains("is-collapsed")) return;
    inspectorMode = "file";
    document.getElementById("inspector-title").textContent = "File";
    const body = document.getElementById("inspector-body");
    body.innerHTML = "";
    const dl = UI.el("dl", { class: "kv" });
    [["Name", entry?.name || UI.basename(path)], ["Path", path], ["View", entry?.view || entry?.kind || "file"]].forEach(([k, v]) => {
      dl.append(UI.el("dt", { text: k }), UI.el("dd", { text: v }));
    });
    body.appendChild(dl);
  }

  // ---------------- jobs poll ----------------
  const knownJobStatus = new Map();
  let jobPollTimer = null;
  let pollGen = 0;

  function activityLine(job) {
    if (!job) return "Ready";
    const strategy = (job.params && job.params.strategy) || job.progress?.phase || job.method_name || job.method;
    const elapsed = UI.formatDuration(job.elapsed_sec);
    const p = job.progress || {};
    if (p.iteration && p.num_iter) {
      let line = strategy + " — Iteration " + p.iteration + " / " + p.num_iter + " — Elapsed " + elapsed;
      if (job.eta_sec) line += " — Estimated " + UI.formatDuration(job.eta_sec) + " remaining";
      return line;
    }
    return strategy + " — " + (p.phase || job.status) + " — Elapsed " + elapsed;
  }

  function startJobPoll() {
    const gen = ++pollGen;
    if (jobPollTimer) clearTimeout(jobPollTimer);
    const tick = async () => {
      if (gen !== pollGen) return;
      let delay = 4000;
      try {
        const { jobs } = await API.phynetpyJobs({ limit: 100 });
        const active = (jobs || []).filter((j) => j.status === "running" || j.status === "queued");
        const btn = document.getElementById("status-activity");
        if (btn) {
          btn.textContent = active.length ? activityLine(active[0]) : "Ready";
          btn.classList.toggle("is-running", active.length > 0);
        }
        if (JobsView.renderList) JobsView.renderList(jobs || []);
        for (const j of jobs || []) {
          const prev = knownJobStatus.get(j.id);
          if (prev && prev !== j.status) {
            if (j.status === "done") {
              UI.toast("Analysis finished", "success");
              FileTree.refresh();
            } else if (j.status === "error") {
              UI.toast("Analysis failed", "error");
            }
          }
          knownJobStatus.set(j.id, j.status);
        }
        if (inspectorMode === "job" && inspectedJobId) {
          const fresh = (jobs || []).find((j) => j.id === inspectedJobId);
          if (fresh) inspectJob(fresh, true);
        }
        delay = active.length ? 1500 : 4000;
      } catch {}
      if (gen === pollGen) jobPollTimer = setTimeout(tick, delay);
    };
    tick();
  }

  function onJobStarted() {
    knownJobStatus.clear();
    if (jobPollTimer) clearTimeout(jobPollTimer);
    startJobPoll();
  }

  function requestJobs() {
    if (jobPollTimer) clearTimeout(jobPollTimer);
    startJobPoll();
  }

  let saveHandler = null;
  function setSaveHandler(fn) {
    saveHandler = fn;
    const entry = tabs.get(activePath);
    if (entry) entry.save = fn;
  }

  function setupShortcuts() {
    document.addEventListener("keydown", (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        closePalette();
        document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
        const overflow = document.getElementById("overflow-menu");
        if (overflow) overflow.classList.add("hidden");
        const modal = document.querySelector(".modal-backdrop");
        if (modal) document.getElementById("modal-root").innerHTML = "";
        return;
      }
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        openPalette();
      } else if (key === "o") {
        e.preventDefault();
        document.getElementById("search-input").focus();
        document.getElementById("search-input").select();
      } else if (key === "s") {
        if (saveHandler) { e.preventDefault(); saveHandler(); }
      } else if (key === "w") {
        if (activePath) { e.preventDefault(); closeTab(activePath); }
      }
    });
  }

  const paletteCommands = [
    { id: "analysis", label: "Run analysis", hint: "PhyNetPy" },
    { id: "jobs", label: "Jobs", hint: "History" },
    { id: "upload", label: "Upload files" },
    { id: "upload-folder", label: "Upload folder" },
    { id: "new-file", label: "New file" },
    { id: "new-folder", label: "New folder" },
    { id: "theme", label: "Toggle theme" },
    { id: "stats", label: "Storage stats" },
    { id: "search", label: "Search files" },
  ];
  let paletteItems = [];
  let paletteIndex = 0;
  let paletteHits = [];

  function onPaletteDoc(e) {
    const pal = document.getElementById("command-palette");
    if (pal && !pal.classList.contains("hidden") && !pal.contains(e.target)) closePalette();
  }
  function openPalette() {
    const pal = document.getElementById("command-palette");
    const input = document.getElementById("palette-input");
    pal.classList.remove("hidden");
    input.value = "";
    paletteIndex = 0;
    paletteHits = [];
    renderPalette("");
    input.focus();
    setTimeout(() => document.addEventListener("mousedown", onPaletteDoc), 0);
  }
  function closePalette() {
    document.getElementById("command-palette")?.classList.add("hidden");
    document.removeEventListener("mousedown", onPaletteDoc);
  }
  function renderPalette(q, fileHits) {
    const list = document.getElementById("palette-list");
    const query = (q || "").trim().toLowerCase();
    const commands = paletteCommands.filter((c) => !query || c.label.toLowerCase().includes(query));
    paletteItems = commands.map((c) => ({ kind: "command", ...c }));
    (fileHits || []).forEach((h) => {
      if (h.kind === "dir") return;
      paletteItems.push({ kind: "file", id: h.path, label: h.name, hint: h.path, node: h });
    });
    list.innerHTML = "";
    if (!paletteItems.length) {
      list.appendChild(UI.el("div", { class: "muted", style: "padding:12px", text: "No matches" }));
      return;
    }
    paletteItems.forEach((item, i) => {
      const b = UI.el("button", { class: "palette-item" + (i === paletteIndex ? " active" : ""), type: "button" }, [
        UI.el("span", { text: item.label }),
        item.hint ? UI.el("span", { class: "hint", text: item.hint }) : null,
      ]);
      b.addEventListener("click", () => choosePalette(i));
      list.appendChild(b);
    });
  }
  function choosePalette(i) {
    const item = paletteItems[i];
    if (!item) return;
    closePalette();
    if (item.kind === "file") {
      FileTree.expandTo(item.node.path);
      FileTree.refresh();
      openNode(item.node);
    } else {
      runAction(item.id);
    }
  }
  function setupPalette() {
    const input = document.getElementById("palette-input");
    const searchFiles = UI.debounce(async () => {
      const q = input.value.trim();
      paletteHits = [];
      if (q && !q.startsWith("?")) {
        try { paletteHits = ((await API.search(q, false)).results || []).slice(0, 12); }
        catch {}
      }
      renderPalette(q, paletteHits);
    }, 180);
    input.addEventListener("input", () => { paletteIndex = 0; searchFiles(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1);
        renderPalette(input.value, paletteHits);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        paletteIndex = Math.max(0, paletteIndex - 1);
        renderPalette(input.value, paletteHits);
      } else if (e.key === "Enter") {
        e.preventDefault();
        choosePalette(paletteIndex);
      }
    });
    document.getElementById("command-palette").addEventListener("mousedown", (e) => {
      if (e.target.id === "command-palette") closePalette();
    });
  }

  // ---------------- tabs ----------------
  async function openNode(node) {
    if (tabs.has(node.path)) { activateTab(node.path); return; }
    if (node.locked_by && node.locked_by !== API.getDisplayName()) {
      UI.toast(`Locked by ${node.locked_by}`, "error");
      return;
    }
    try {
      await API.acquireLock(node.path);
    } catch (e) {
      if (e.status === 423 || e.locked_by) {
        UI.toast(e.locked_by ? `Locked by ${e.locked_by}` : e.message, "error");
        FileTree.refresh();
        return;
      }
      UI.toast(e.message, "error");
      return;
    }
    createTab(node);
    FileTree.refresh();
  }

  function wireTab(tab, path, closeEl) {
    tab.addEventListener("click", (e) => { if (!closeEl.contains(e.target)) activateTab(path); });
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(path); }
    });
    closeEl.addEventListener("click", (e) => { e.stopPropagation(); closeTab(path); });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      tabContextMenu(path, e.clientX, e.clientY);
    });
    tab.draggable = true;
    tab.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-biostore-tab", path);
      e.dataTransfer.effectAllowed = "move";
    });
    tab.addEventListener("dragover", (e) => {
      if (![...e.dataTransfer.types].includes("application/x-biostore-tab")) return;
      e.preventDefault();
      const rect = tab.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      tab.classList.toggle("drop-before", before);
      tab.classList.toggle("drop-after", !before);
    });
    tab.addEventListener("dragleave", () => {
      tab.classList.remove("drop-before", "drop-after");
    });
    tab.addEventListener("drop", (e) => {
      const from = e.dataTransfer.getData("application/x-biostore-tab");
      tab.classList.remove("drop-before", "drop-after");
      if (!from || from === path || !tabs.has(from)) return;
      e.preventDefault();
      const rect = tab.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      const moving = tabs.get(from).tab;
      if (before) tabsEl.insertBefore(moving, tab);
      else tabsEl.insertBefore(moving, tab.nextSibling);
    });
  }

  function createTab(node) {
    const pane = UI.el("div", { class: "pane" });
    pane.style.display = "none";
    panesEl.appendChild(pane);

    const tab = UI.el("div", { class: "tab", role: "tab" });
    const dot = UI.el("span", { class: "dirty-dot hidden", text: "●", title: "Unsaved changes" });
    const name = UI.el("span", { class: "tab-name", text: node.name });
    const close = UI.el("span", { class: "tab-close", title: "Close" });
    close.appendChild(Icons.el("close"));
    tab.append(dot, UI.iconEl(node.kind), name, close);
    wireTab(tab, node.path, close);
    tabsEl.appendChild(tab);

    const entry = {
      tab, pane, dirty: false,
      kind: node.kind,          // native kind from extension
      view: node.kind,          // current view mode (may be "text")
      name: node.name, dot,
      locked: true,
    };
    tabs.set(node.path, entry);
    activateTab(node.path);
    loadContent(node.path, node.kind);
  }

  async function loadContent(path, view) {
    const entry = tabs.get(path);
    if (!entry) return;
    const pane = entry.pane;
    entry.view = view;
    pane.innerHTML = '<div class="muted" style="padding:20px">Loading…</div>';
    try {
      if (view === "network") {
        const data = await API.network(path);
        NetworkView.build(pane, data, {
          onSummary: () => switchView(path, "summary"),
        });
      } else if (view === "summary") {
        const opts = entry.summaryOpts || {};
        const data = await API.summary(path, opts.reference, opts.threshold);
        SummaryView.build(pane, data, {
          path,
          reference: opts.reference,
          threshold: opts.threshold,
          onBack: () => switchView(path, "network"),
          onReload: (reference, threshold) => {
            entry.summaryOpts = { reference, threshold };
            loadContent(path, "summary");
          },
        });
      } else if (view === "alignment") {
        const data = await API.alignment(path);
        AlignmentView.build(pane, data);
      } else {
        const data = await API.readFile(path);
        TextEditor.build(pane, data);
      }
    } catch (e) {
      pane.innerHTML = "";
      pane.appendChild(UI.el("div", { class: "error-state" }, [
        UI.el("h2", { text: "Could not open this file" }),
        UI.el("p", { text: "BioStore could not read it as " + view + ". " + e.message }),
        UI.el("p", { class: "muted", text: "Open it as plain text if you need to inspect the contents." }),
        UI.el("button", { class: "ghost", text: "Open as plain text", onclick: () => switchView(path, "text") }),
      ]));
    }
  }

  async function switchView(path, view) {
    const entry = tabs.get(path);
    if (!entry) return;
    if (entry.dirty && !confirm(`Discard unsaved changes to ${entry.name} before switching view?`)) return;
    entry.dirty = false;
    entry.dot.classList.add("hidden");
    activateTab(path);
    await loadContent(path, view);
  }

  function tabContextMenu(path, x, y) {
    const entry = tabs.get(path);
    if (!entry) return;
    // Inline network tabs (no real file path) only get Close.
    const isFile = isRealFile(path);
    document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());

    const items = [];
    if (isFile) {
      if (entry.kind === "alignment") {
        items.push({
          label: entry.view === "alignment" ? "✓ Alignment view" : "View as alignment",
          fn: () => switchView(path, "alignment"),
          disabled: entry.view === "alignment",
        });
      }
      if (entry.kind === "network") {
        items.push({
          label: entry.view === "network" ? "✓ Network view" : "View as network",
          fn: () => switchView(path, "network"),
          disabled: entry.view === "network",
        });
        items.push({
          label: entry.view === "summary" ? "✓ Summary" : "View summary",
          fn: () => switchView(path, "summary"),
          disabled: entry.view === "summary",
        });
      }
      // NEXUS files are alignments but often also contain trees/networks.
      if (entry.kind === "alignment" && /\.(nex|nexus)$/i.test(path)) {
        items.push({
          label: entry.view === "network" ? "✓ Network view" : "View as network",
          fn: () => switchView(path, "network"),
          disabled: entry.view === "network",
        });
        items.push({
          label: entry.view === "summary" ? "✓ Summary" : "View summary",
          fn: () => switchView(path, "summary"),
          disabled: entry.view === "summary",
        });
      }
      items.push({
        label: entry.view === "text" ? "✓ Plain text" : "View as plain text",
        fn: () => switchView(path, "text"),
        disabled: entry.view === "text",
      });
      items.push({ label: "—", separator: true });
      items.push({ label: "Copy PhyNetPy snippet", fn: () => showSnippet(path) });
    }
    items.push({ label: "Close tab", fn: () => closeTab(path) });

    UI.contextMenu(items, x, y);
  }

  function activateTab(path) {
    activePath = path;
    welcomeEl && (welcomeEl.style.display = "none");
    for (const [p, e] of tabs) {
      const on = p === path;
      e.tab.classList.toggle("active", on);
      e.pane.style.display = on ? "block" : "none";
    }
    const entry = tabs.get(path);
    if (path === JobsView.KEY) setNav("jobs");
    else if (path === PhyNetPyRunner.KEY) setNav("analyses");
    else setNav("library");
    saveHandler = entry && entry.save ? entry.save : null;
    if (entry && isRealFile(path)) inspectFile(path, entry);
    FileTree.selectPath(path);
    const tab = entry && entry.tab;
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  async function closeTab(path) {
    const e = tabs.get(path);
    if (!e) return;
    if (e.dirty && !confirm(`Discard unsaved changes to ${e.name}?`)) return;
    if (isRealFile(path)) {
      try { await API.releaseLock(path); } catch {}
    }
    e.tab.remove();
    e.pane.remove();
    tabs.delete(path);
    if (activePath === path) {
      const next = [...tabs.keys()].pop();
      if (next) activateTab(next);
      else { activePath = null; welcomeEl && (welcomeEl.style.display = "block"); }
    }
    FileTree.refresh();
  }

  function closeTabsUnder(prefix) {
    for (const p of [...tabs.keys()]) {
      if (p === prefix || p.startsWith(prefix + "/")) {
        const e = tabs.get(p);
        if (isRealFile(p)) {
          try { API.releaseLock(p); } catch {}
        }
        e.tab.remove(); e.pane.remove(); tabs.delete(p);
      }
    }
    if (!tabs.has(activePath)) {
      const next = [...tabs.keys()].pop();
      if (next) activateTab(next); else { activePath = null; welcomeEl.style.display = "block"; }
    }
  }

  function markDirty(path) {
    const e = tabs.get(path);
    if (e && !e.dirty) { e.dirty = true; e.dot.classList.remove("hidden"); }
  }
  function markClean(path) {
    const e = tabs.get(path);
    if (e) { e.dirty = false; e.dot.classList.add("hidden"); }
  }

  // Open a network that isn't a standalone file (e.g. embedded in a NEXUS).
  function openInlineNetwork(title, data) {
    const key = "◈ " + title + " #" + Math.random().toString(36).slice(2, 6);
    const pane = UI.el("div", { class: "pane" });
    pane.style.display = "none";
    panesEl.appendChild(pane);
    const tab = UI.el("div", { class: "tab", role: "tab" });
    const close = UI.el("span", { class: "tab-close", title: "Close" });
    close.appendChild(Icons.el("close"));
    tab.append(UI.iconEl("network"), UI.el("span", { class: "tab-name", text: title }), close);
    wireTab(tab, key, close);
    tabsEl.appendChild(tab);
    tabs.set(key, { tab, pane, dirty: false, kind: "network", name: title, dot: UI.el("span"), locked: false });
    activateTab(key);
    NetworkView.build(pane, data);
  }

  function hasTab(path) {
    return tabs.has(path);
  }

  function openToolTab(key, title, builder) {
    if (tabs.has(key)) { activateTab(key); return; }
    const pane = UI.el("div", { class: "pane" });
    pane.style.display = "none";
    panesEl.appendChild(pane);
    const tab = UI.el("div", { class: "tab", role: "tab" });
    const close = UI.el("span", { class: "tab-close", title: "Close" });
    close.appendChild(Icons.el("close"));
    const glyph = key === JobsView.KEY ? "jobs" : "play";
    tab.append(UI.iconEl(glyph), UI.el("span", { class: "tab-name", text: title }), close);
    wireTab(tab, key, close);
    tabsEl.appendChild(tab);
    tabs.set(key, { tab, pane, dirty: false, kind: "tool", name: title, dot: UI.el("span"), locked: false });
    activateTab(key);
    builder(pane);
  }

  // ---------------- snippet ----------------
  async function showSnippet(path) {
    try {
      const s = await API.snippet(path);
      const pre = UI.el("pre", { text: s.python });
      UI.modal("Load this file from PhyNetPy",
        UI.el("div", {}, [
          UI.el("p", { class: "muted", text: "Paste into your PhyNetPy code. Requires the phynetpy_datastore client (see client/README)." }),
          pre,
        ]),
        [
          { label: "Copy path", onClick: () => UI.copyText(path) },
          { label: "Copy code", primary: true, onClick: (c) => { UI.copyText(s.python); c(); } },
        ]
      );
    } catch (e) { UI.toast(e.message, "error"); }
  }

  // ---------------- search ----------------
  function setupSearch() {
    const input = document.getElementById("search-input");
    const results = document.getElementById("search-results");
    const run = UI.debounce(async () => {
      let q = input.value.trim();
      const content = q.startsWith("?");
      if (content) q = q.slice(1).trim();
      if (!q) { results.classList.add("hidden"); return; }
      try {
        const { results: hits } = await API.search(q, content);
        results.innerHTML = "";
        if (!hits.length) {
          results.appendChild(UI.el("div", { class: "search-result muted", text: "No matches" }));
        }
        for (const h of hits.slice(0, 50)) {
          const lockNote = h.locked_by
            ? UI.el("div", { class: "sr-line", text: "Locked by " + h.locked_by })
            : null;
          const item = UI.el("div", { class: "search-result" }, [
            UI.el("div", { style: "display:flex;align-items:center;gap:6px" }, [UI.iconEl(h.kind), UI.el("span", { text: h.name })]),
            UI.el("div", { class: "sr-path", text: h.path }),
            ...(lockNote ? [lockNote] : []),
            ...(h.content_matches || []).map((m) =>
              UI.el("div", { class: "sr-line", text: `:${m.line}  ${m.text}` })),
          ]);
          item.addEventListener("click", () => {
            results.classList.add("hidden");
            input.value = "";
            if (h.kind !== "dir") { FileTree.expandTo(h.path); FileTree.refresh(); openNode(h); }
          });
          results.appendChild(item);
        }
        results.classList.remove("hidden");
      } catch (e) { UI.toast(e.message, "error"); }
    }, 250);
    input.addEventListener("input", run);
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search")) results.classList.add("hidden");
    });
  }

  // ---------------- upload / dnd ----------------
  // Capture File objects (and webkitRelativePath) before the <input> is
  // cleared or removed. Resetting the input before fetch reads the body is
  // what produced empty multipart posts ("No file part") on folder uploads.
  function snapshotInputFiles(input) {
    return Array.from(input.files || []).map((f) => ({
      file: f,
      relpath: f.webkitRelativePath || f.name,
    }));
  }

  // `skipped` is how many dropped entries the browser refused to read; the
  // upload still goes ahead, the final toast just says so.
  async function uploadFiles(dir, items, { skipped = 0 } = {}) {
    const list = Array.from(items || []).map((it) =>
      it.file ? it : { file: it, relpath: it.name });
    if (!list.length) return;
    const totalBytes = list.reduce((s, it) => s + ((it.file || it).size || 0), 0);
    UI.toast(
      `Uploading ${list.length} file(s)` +
        (totalBytes ? ` (${UI.humanSize(totalBytes)})` : "") +
        "…",
      ""
    );
    try {
      const res = await API.upload(dir, list, {
        onProgress: (done, total) => {
          if (total > 40) UI.toast(`Uploading… ${done}/${total}`, "");
        },
      });
      const n = (res.uploaded || []).length;
      // Files the browser refused to read: counted by the drop walker, or by
      // API.upload when reading their bytes failed.
      const unreadable = (res.skipped || []).length + skipped;
      if (res.skipped && res.skipped.length) {
        console.warn("BioStore: skipped unreadable files", res.skipped);
        showSkipped("Some files could not be read", res.skipped);
      }
      UI.toast(
        `Uploaded ${n} file(s)` + (dir ? ` to ${dir}/` : "") +
          (unreadable ? ` — ${unreadable} unreadable file(s) skipped` : ""),
        unreadable ? "" : "success"
      );
      FileTree.refresh();
    } catch (e) {
      UI.toast(e.message || "Upload failed", "error");
    }
  }

  // List what the browser refused to read, with its reason, so the user can
  // see it without opening the dev console. A failed folder loses its whole
  // subtree, which is why one entry can stand for many missing files.
  function showSkipped(title, entries, note = "") {
    const MAX = 15;
    const rows = entries.slice(0, MAX).map((e) =>
      UI.el("div", { style: "font-family:monospace;font-size:12px;margin:2px 0;word-break:break-all" }, [
        UI.el("span", { text: e.path }),
        UI.el("span", { class: "muted", text: "  —  " + e.error }),
      ])
    );
    if (entries.length > MAX) {
      rows.push(UI.el("div", { class: "muted", text: `…and ${entries.length - MAX} more (full list in the browser console)` }));
    }
    UI.modal(title,
      UI.el("div", {}, [
        note ? UI.el("p", { class: "muted", text: note }) : null,
        entries.length
          ? UI.el("p", { class: "muted", text: `${entries.length} item(s) skipped. A skipped folder means everything inside it was skipped too.` })
          : null,
        ...rows,
      ]),
      [{ label: "OK", primary: true, onClick: (c) => c() }]
    );
  }

  // ---- dropped-folder walker (kept DOM-free so it can be unit tested) ----
  // Reads dropped file/folder entries into {file, relpath} records.
  // Two things matter once a drop holds tens of thousands of files:
  //  - DirectoryEntry.readEntries() returns batches of ≤100; keep calling
  //    until an empty batch arrives, otherwise large folders silently truncate.
  //  - FileEntry.file() must not be issued for every file at once. The old
  //    Promise.all walk did exactly that, and WebKit starts refusing handles
  //    under that load; one refusal then sank the whole drop. Reads now go
  //    through a small pool, and a file that still fails is skipped and
  //    reported instead of aborting everything.
  const READ_POOL_SIZE = 8;

  function entryFile(entry) {
    return new Promise((resolve, reject) =>
      entry.file(resolve, (err) => reject(err || new Error("Failed to read file " + entry.name)))
    );
  }

  function readAllEntries(entry) {
    const reader = entry.createReader();
    return new Promise((resolve, reject) => {
      const all = [];
      const next = () =>
        reader.readEntries(
          (batch) => {
            if (!batch.length) return resolve(all);
            all.push(...batch);
            next();
          },
          (err) => reject(err || new Error("Failed to read folder " + entry.name))
        );
      next();
    });
  }

  // Resolves to { items, failed } once every entry has been visited.
  // `onProgress(count)` fires as files are read so the UI can show activity.
  function walkEntries(roots, { onProgress } = {}) {
    return new Promise((resolve) => {
      const items = [];
      const failed = [];
      const stats = { dirs: 0, emptyDirs: 0 };
      const queue = roots.filter(Boolean).map((entry) => ({ entry, prefix: "" }));
      let active = 0;

      const visit = async ({ entry, prefix }) => {
        try {
          if (entry.isFile) {
            const file = await entryFile(entry);
            items.push({ file, relpath: prefix + entry.name });
            if (onProgress && items.length % 500 === 0) onProgress(items.length);
          } else if (entry.isDirectory) {
            stats.dirs += 1;
            let children = await readAllEntries(entry);
            // An empty listing is either a genuinely empty folder or a browser
            // that quietly declined to open it: WebKit answers a directory it
            // can't read with an empty list, not an error. Give it two more
            // chances before taking its word for it.
            for (let attempt = 0; !children.length && attempt < 2; attempt += 1) {
              await new Promise((r) => setTimeout(r, 150));
              children = await readAllEntries(entry);
            }
            if (!children.length) stats.emptyDirs += 1;
            const childPrefix = prefix + entry.name + "/";
            for (const child of children) queue.push({ entry: child, prefix: childPrefix });
          }
        } catch (err) {
          failed.push({ path: prefix + entry.name, error: err });
        }
      };

      // Keep up to READ_POOL_SIZE reads in flight. A worker that finishes
      // re-pumps, so directories discovered late still get picked up; we're
      // done only when the queue is empty *and* nothing is still running.
      const pump = () => {
        while (active < READ_POOL_SIZE && queue.length) {
          active += 1;
          visit(queue.shift()).then(() => { active -= 1; pump(); });
        }
        if (!active && !queue.length) resolve({ items, failed, stats });
      };
      pump();
    });
  }

  // Handle a drop event, targeting `dir` (empty string = data root).
  async function handleDrop(e, dir) {
    // Ignore internal BioStore path drags (used by PhyNetPy path fields).
    if (e.dataTransfer.types.includes("application/x-biostore-path")) return;

    const dt = e.dataTransfer;
    // Entries must be captured synchronously, before any await.
    const entries = [];
    if (dt.items && dt.items.length) {
      for (const it of dt.items) {
        if (it.kind && it.kind !== "file") continue;
        const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (en) entries.push(en);
      }
    }
    let out = [];
    let failed = [];
    let stats = null;
    try {
      if (entries.length) {
        UI.toast("Reading dropped folder…", "");
        const res = await walkEntries(entries, {
          onProgress: (n) => UI.toast(`Reading dropped folder… ${n} files`, ""),
        });
        out = res.items;
        failed = res.failed;
        stats = res.stats;
      } else {
        for (const f of dt.files) {
          out.push({
            file: f,
            relpath: f.webkitRelativePath || f.name,
          });
        }
      }
    } catch (err) {
      UI.toast("Could not read drop: " + (err.message || err), "error");
      return;
    }
    if (stats) console.info("BioStore: drop read", stats);
    const emptyNote = stats && stats.emptyDirs
      ? `${stats.emptyDirs} of ${stats.dirs} folder(s) came back with no entries — either empty, or the browser declined to list them. ` +
        "If files are missing, pick the folder with Upload → Upload folder… instead; that route doesn't depend on the browser reading dropped folders."
      : "";
    if (failed.length || emptyNote) {
      if (failed.length) console.warn("BioStore: skipped unreadable dropped entries", failed);
      showSkipped("Some dropped items could not be read", failed.map((f) => ({
        path: f.path,
        error: f.error && f.error.name ? `${f.error.name}: ${f.error.message}` : String(f.error),
      })), emptyNote);
    }
    if (!out.length) {
      UI.toast(
        failed.length
          ? `Could not read any of the dropped files (${failed.length} unreadable)`
          : "Nothing to upload (empty folder, or browser blocked folder access)",
        "error"
      );
      return;
    }
    uploadFiles(dir, out, { skipped: failed.length });
  }

  function isExternalFileDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    // Internal sidebar → PhyNetPy path drags must not trigger the upload outline.
    if (types.includes("application/x-biostore-path")) return false;
    return types.includes("Files");
  }

  function setupDragDrop() {
    const layout = document.querySelector(".shell-body");
    if (!layout) return;
    ["dragenter", "dragover"].forEach((ev) =>
      layout.addEventListener(ev, (e) => {
        if (!isExternalFileDrag(e)) {
          layout.classList.remove("drag-over");
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        layout.classList.add("drag-over");
      }));
    layout.addEventListener("dragleave", (e) => {
      e.preventDefault();
      if (e.target === layout) layout.classList.remove("drag-over");
    });
    layout.addEventListener("drop", (e) => {
      layout.classList.remove("drag-over");
      if (!isExternalFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      handleDrop(e, "");
    });
    // Clear a stuck outline if a drag is cancelled or finishes elsewhere.
    document.addEventListener("dragend", () => layout.classList.remove("drag-over"));
    window.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget) layout.classList.remove("drag-over");
    });
  }

  function newFile(dir = "") {
    const input = UI.el("input", {
      type: "text",
      placeholder: "e.g. trees/new_network.nwk",
    });
    input.value = dir ? dir + "/" : "";
    UI.modal("New file",
      UI.el("div", {}, [
        UI.el("p", { class: "muted", text: "Full path relative to the data root. Missing folders are created." }),
        input,
      ]),
      [
        { label: "Cancel", onClick: (c) => c() },
        { label: "Create", primary: true, onClick: async (c) => {
          const path = input.value.trim();
          if (!path || path.endsWith("/")) { UI.toast("Enter a file name", "error"); return; }
          try {
            const node = await API.newFile(path, "");
            UI.toast("Created " + node.name, "success");
            c();
            FileTree.expandTo(path);
            FileTree.refresh();
            openNode(node);
          } catch (e) { UI.toast(e.message, "error"); }
        }},
      ]
    );
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50);
  }

  function newFolder(dir = "") {
    const input = UI.el("input", { type: "text", placeholder: "e.g. datasets/DEFJ/sequences" });
    input.value = dir ? dir + "/" : "";
    UI.modal("New folder", input, [
      { label: "Cancel", onClick: (c) => c() },
      { label: "Create", primary: true, onClick: async (c) => {
        const path = input.value.trim().replace(/\/+$/, "");
        if (!path) return;
        try {
          await API.mkdir(path);
          UI.toast("Created", "success");
          c();
          FileTree.expandTo(path + "/x");
          FileTree.refresh();
        } catch (e) { UI.toast(e.message, "error"); }
      }},
    ]);
    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50);
  }

  // ---------------- stats dashboard ----------------
  async function showStats() {
    try {
      const s = await API.stats();
      const rows = Object.entries(s.by_kind).map(([k, v]) =>
        UI.el("div", { style: "display:flex;justify-content:space-between;padding:3px 0;" }, [
          UI.el("span", { style: "display:flex;align-items:center;gap:6px" }, [UI.iconEl(k), document.createTextNode(k)]),
          UI.el("b", { text: String(v) }),
        ]));
      const body = UI.el("div", {}, [
        UI.el("div", { class: "aln-stats", style: "border:none;padding:0 0 12px;" }, [
          stat(s.files, "Files"), stat(s.dirs, "Folders"), stat(UI.humanSize(s.bytes), "Total size"),
        ]),
        UI.el("h2", { text: "By type", style: "font-size:13px;margin:8px 0;" }),
        ...rows,
        UI.el("p", { class: "muted", style: "margin-top:14px", text: "Data root: " + s.data_root }),
      ]);
      UI.modal("Storage overview", body, [{ label: "Close", primary: true, onClick: (c) => c() }]);
    } catch (e) { UI.toast(e.message, "error"); }
  }
  const stat = (val, label) =>
    UI.el("div", { class: "stat" }, [
      UI.el("span", { class: "stat-val", text: String(val) }),
      UI.el("span", { class: "stat-label", text: label }),
    ]);

  return {
    boot, init, openNode, closeTabsUnder, markDirty, markClean,
    showSnippet, openInlineNetwork, openToolTab, hasTab, activateTab,
    handleDrop, uploadFiles, newFile, newFolderIn: (dir) => newFolder(dir),
    inspectJob, onJobStarted, requestJobs, setSaveHandler,
  };
})();

document.addEventListener("DOMContentLoaded", () => App.boot());
