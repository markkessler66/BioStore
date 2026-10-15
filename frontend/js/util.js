// Small DOM + UX helpers shared across modules.
const UI = (() => {
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function")
        node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  };

  let toastTimer;
  function toast(msg, type = "") {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast " + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
  }

  function humanSize(bytes) {
    if (bytes == null) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function iconName(kind) {
    return { dir: "folder", network: "network", alignment: "align", file: "file" }[kind] || "file";
  }

  function iconEl(kindOrName) {
    const known = { dir: "folder", network: "network", alignment: "align", file: "file" };
    const name = known[kindOrName] || kindOrName;
    return Icons.el(Icons.paths[name] ? name : "file");
  }

  function iconFor(kind) {
    return "";
  }

  function modal(title, contentNode, actions = [], { wide } = {}) {
    const root = document.getElementById("modal-root");
    const close = () => (root.innerHTML = "");
    const actionBar = el("div", { class: "modal-actions" });
    for (const a of actions) {
      const b = el("button", { class: a.primary ? "primary" : "ghost", text: a.label });
      b.addEventListener("click", () => a.onClick(close));
      actionBar.appendChild(b);
    }
    const box = el("div", { class: "modal" + (wide ? " modal-wide" : ""), role: "dialog", "aria-modal": "true" }, [
      el("h2", { text: title }),
      contentNode,
      actionBar,
    ]);
    const backdrop = el("div", { class: "modal-backdrop" }, [box]);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    root.innerHTML = "";
    root.appendChild(backdrop);
    return close;
  }

  /**
   * Open a BioStore file picker. Resolves to a relative path, or null if cancelled.
   * Options: { title, acceptKinds: ['network','alignment','file'], startPath }
   */
  function pickStoreFile({ title = "Select a file", acceptKinds = null } = {}) {
    return new Promise(async (resolve) => {
      let selected = null;
      const body = el("div", { class: "picker" });
      const crumb = el("div", { class: "picker-crumb muted", text: "Loading…" });
      const list = el("div", { class: "picker-list" });
      const selectedLabel = el("div", { class: "picker-selected muted", text: "No file selected" });
      body.append(crumb, list, selectedLabel);

      let tree = null;
      try {
        tree = await API.tree("", -1);
      } catch (e) {
        toast(e.message, "error");
        resolve(null);
        return;
      }

      const expanded = new Set([""]);

      function allowed(node) {
        if (node.kind === "dir") return true;
        if (!acceptKinds || !acceptKinds.length) return true;
        return acceptKinds.includes(node.kind) || acceptKinds.includes("file");
      }

      function render() {
        list.innerHTML = "";
        crumb.textContent = "Click a file to select it · double-click or Use to confirm";
        const walk = (nodes, depth) => {
          for (const node of nodes || []) {
            if (!allowed(node)) continue;
            const isDir = node.kind === "dir";
            const isOpen = expanded.has(node.path);
            const row = el("div", {
              class: "picker-row kind-" + node.kind
                + (selected && selected.path === node.path ? " selected" : ""),
              style: `padding-left:${8 + depth * 14}px`,
            });
            const caret = el("span", {
              class: "tree-caret" + (isOpen ? " open" : "") + (isDir && (node.children || []).length ? " has-kids" : ""),
            });
            row.append(
              caret,
              iconEl(node.kind),
              el("span", { class: "tree-label", text: node.name })
            );
            row.addEventListener("click", (e) => {
              e.stopPropagation();
              if (isDir) {
                if (isOpen) expanded.delete(node.path);
                else expanded.add(node.path);
                render();
              } else {
                selected = node;
                selectedLabel.textContent = "Selected: " + node.path;
                selectedLabel.classList.remove("muted");
                render();
              }
            });
            row.addEventListener("dblclick", (e) => {
              e.stopPropagation();
              if (!isDir) {
                selected = node;
                close();
                resolve(node.path);
              }
            });
            list.appendChild(row);
            if (isDir && isOpen) walk(node.children, depth + 1);
          }
        };
        walk(tree.children, 0);
        if (!list.children.length) {
          list.appendChild(el("div", { class: "muted", style: "padding:12px", text: "No matching files." }));
        }
      }

      render();

      const close = modal(title, body, [
        { label: "Cancel", onClick: (c) => { c(); resolve(null); } },
        {
          label: "Use",
          primary: true,
          onClick: (c) => {
            if (!selected) { toast("Click a file first", "error"); return; }
            c();
            resolve(selected.path);
          },
        },
      ], { wide: true });
    });
  }

  /** Make an input accept a BioStore path dropped from the sidebar file tree. */
  function makePathDropTarget(input, onPath) {
    const setPath = (path) => {
      if (!path) return;
      input.value = path;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (onPath) onPath(path);
    };
    ["dragenter", "dragover"].forEach((ev) =>
      input.addEventListener(ev, (e) => {
        if (e.dataTransfer.types.includes("application/x-biostore-path")) {
          e.preventDefault();
          e.stopPropagation();
          input.classList.add("path-drop-target");
        }
      })
    );
    input.addEventListener("dragleave", () => input.classList.remove("path-drop-target"));
    input.addEventListener("drop", (e) => {
      input.classList.remove("path-drop-target");
      const path = e.dataTransfer.getData("application/x-biostore-path");
      if (path) {
        e.preventDefault();
        e.stopPropagation();
        setPath(path);
        toast("Path set: " + path, "success");
      }
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard", "success");
    } catch {
      toast("Copy failed — select manually", "error");
    }
  }

  function contextMenu(items, x, y) {
    document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
    const menu = el("div", { class: "ctx-menu", role: "menu" });
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    for (const it of items) {
      if (it.separator) {
        menu.appendChild(el("div", { class: "ctx-sep" }));
        continue;
      }
      const b = el("button", {
        class: "ctx-item" + (it.danger ? " danger" : ""),
        type: "button",
        text: it.label,
        role: "menuitem",
        disabled: it.disabled ? "disabled" : null,
      });
      if (!it.disabled) b.addEventListener("click", () => { menu.remove(); it.fn(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = Math.max(8, window.innerWidth - r.width - 8) + "px";
    if (r.bottom > window.innerHeight) menu.style.top = Math.max(8, window.innerHeight - r.height - 8) + "px";
    const close = (e) => {
      if (e.type === "keydown" && e.key !== "Escape") return;
      if (e.type !== "keydown" && menu.contains(e.target)) return;
      menu.remove();
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", close);
    }, 0);
    return menu;
  }

  function disclosure(title, body, { open = false } = {}) {
    const d = el("details", { class: "disclosure" });
    if (open) d.open = true;
    const inner = el("div", { class: "disclosure-body" });
    if (body) inner.appendChild(body);
    d.append(el("summary", { text: title }), inner);
    return d;
  }

  function emptyState(title, body) {
    return el("div", { class: "empty-state" }, [
      el("h2", { text: title }),
      el("p", { text: body }),
    ]);
  }

  function formatDuration(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return "00:00";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    if (h) return h + ":" + mm + ":" + ss;
    return mm + ":" + ss;
  }

  function formatWhen(ts) {
    if (!ts) return "—";
    try { return new Date(ts * 1000).toLocaleString(); }
    catch { return "—"; }
  }

  function bindStoreDrop(node, onPath) {
    ["dragenter", "dragover"].forEach((ev) =>
      node.addEventListener(ev, (e) => {
        const types = e.dataTransfer && e.dataTransfer.types;
        if (types && [...types].includes("application/x-biostore-path")) {
          e.preventDefault();
          e.stopPropagation();
          node.classList.add("path-drop-target");
        }
      })
    );
    node.addEventListener("dragleave", () => node.classList.remove("path-drop-target"));
    node.addEventListener("drop", (e) => {
      node.classList.remove("path-drop-target");
      const path = e.dataTransfer.getData("application/x-biostore-path");
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      onPath(path);
    });
  }

  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const basename = (p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);

  return {
    el, toast, humanSize, iconFor, iconEl, modal, pickStoreFile, makePathDropTarget,
    copyText, debounce, dirname, basename, contextMenu, disclosure, emptyState,
    formatDuration, formatWhen, bindStoreDrop,
  };
})();
