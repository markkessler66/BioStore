// Renders the nested file tree and dispatches open/context actions.
const FileTree = (() => {
  let container;
  let onOpen;
  let selectedPath = null;
  const expanded = new Set([""]); // remember which dirs are open

  function init(el, openHandler) {
    container = el;
    onOpen = openHandler;
    refresh();
  }

  async function refresh() {
    try {
      const root = await API.tree("", -1);
      container.innerHTML = "";
      // Render the root's children directly (don't show the data root itself).
      for (const child of root.children || []) {
        container.appendChild(renderNode(child, 0));
      }
      if (!root.children || root.children.length === 0) {
        container.appendChild(UI.emptyState("Library is empty", "Upload a file or create one to start."));
      }
    } catch (e) {
      UI.toast(e.message, "error");
    }
  }

  function renderNode(node, depth) {
    const wrap = UI.el("div", { class: "tree-node kind-" + node.kind });
    const isDir = node.kind === "dir";
    const isOpen = expanded.has(node.path);
    const lockedBy = node.locked_by || null;
    const lockedByOther = lockedBy && lockedBy !== API.getDisplayName();

    const row = UI.el("div", {
      class: "tree-row"
        + (node.path === selectedPath ? " selected" : "")
        + (lockedByOther ? " locked" : "")
        + (lockedBy && !lockedByOther ? " locked-mine" : ""),
      title: lockedBy
        ? `${node.path} — locked by ${lockedBy}`
        : node.path,
    });
    row.dataset.path = node.path;

    const caret = UI.el("span", {
      class: "tree-caret" + (isOpen ? " open" : "") + (isDir && (node.children || []).length ? " has-kids" : ""),
    });
    const icon = UI.iconEl(node.kind);
    const label = UI.el("span", { class: "tree-label", text: node.name });

    row.append(caret, icon, label);
    if (lockedBy) {
      const lock = UI.el("span", {
        class: "tree-lock" + (lockedByOther ? "" : " mine"),
        title: lockedByOther
          ? `Locked by ${lockedBy} — cannot open until they close it`
          : "You have this file open",
      });
      lock.appendChild(Icons.el("lock"));
      row.appendChild(lock);
    }
    wrap.appendChild(row);

    // Files can be dragged onto PhyNetPy path fields (and similar drop targets).
    if (!isDir) {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-biostore-path", node.path);
        e.dataTransfer.setData("text/plain", node.path);
        e.dataTransfer.effectAllowed = "copy";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
    }

    let childrenEl = null;
    let childrenBuilt = false;
    // Build descendant DOM lazily. Eagerly rendering hidden subtrees freezes
    // the browser on large datasets (e.g. DEFJ has ~28k nodes), so we only
    // create child nodes the first time a folder is actually expanded.
    const buildChildren = () => {
      if (childrenBuilt || !childrenEl) return;
      childrenBuilt = true;
      for (const child of node.children || []) {
        childrenEl.appendChild(renderNode(child, depth + 1));
      }
    };
    if (isDir) {
      childrenEl = UI.el("div", { class: "tree-children" });
      childrenEl.style.display = isOpen ? "block" : "none";
      if (isOpen) buildChildren();
      wrap.appendChild(childrenEl);
    }

    row.addEventListener("click", () => {
      selectPath(node.path);
      if (isDir) {
        const nowOpen = childrenEl.style.display === "none";
        if (nowOpen) buildChildren();
        childrenEl.style.display = nowOpen ? "block" : "none";
        caret.classList.toggle("open", nowOpen);
        if (nowOpen) expanded.add(node.path);
        else expanded.delete(node.path);
      } else {
        onOpen(node);
      }
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      contextMenu(node, e.clientX, e.clientY);
    });

    // Directories are drop targets: dropping here uploads into that folder.
    if (isDir) {
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove("drop-target");
        expanded.add(node.path);
        App.handleDrop(e, node.path);
      });
    }

    return wrap;
  }

  // Trigger a file picker that uploads into a specific folder.
  function uploadInto(dir) {
    const picker = UI.el("input", { type: "file", multiple: "true", style: "display:none" });
    document.body.appendChild(picker);
    picker.addEventListener("change", async () => {
      const files = Array.from(picker.files || []).map((f) => ({
        file: f,
        relpath: f.webkitRelativePath || f.name,
      }));
      try {
        await App.uploadFiles(dir, files);
      } finally {
        picker.remove();
      }
    });
    picker.click();
  }

  function selectPath(path) {
    selectedPath = path;
    container.querySelectorAll(".tree-row.selected").forEach((r) => r.classList.remove("selected"));
    const row = container.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
    if (row) row.classList.add("selected");
  }

  function contextMenu(node, x, y) {
    document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
    const isDir = node.kind === "dir";
    const items = [
      { label: "Open", fn: () => onOpen(node), show: !isDir },
      { label: "New file here…", fn: () => App.newFile(node.path), show: isDir },
      { label: "New subfolder…", fn: () => App.newFolderIn(node.path), show: isDir },
      { label: "Upload here…", fn: () => uploadInto(node.path), show: isDir },
      { label: "Download", fn: () => API.downloadFile(node.path, node.name).catch((e) => UI.toast(e.message, "error")), show: !isDir },
      { label: "Copy PhyNetPy snippet", fn: () => App.showSnippet(node.path), show: !isDir },
      { label: "Rename / move", fn: () => renameNode(node), show: true },
      { label: "Delete", fn: () => deleteNode(node), show: true, danger: true },
    ].filter((i) => i.show);

    UI.contextMenu(items, x, y);
  }

  function renameNode(node) {
    const input = UI.el("input", { type: "text", value: node.path });
    UI.modal("Rename / move", input, [
      { label: "Cancel", onClick: (c) => c() },
      {
        label: "Rename",
        primary: true,
        onClick: async (c) => {
          try {
            await API.rename(node.path, input.value.trim());
            UI.toast("Renamed", "success");
            c();
            refresh();
          } catch (e) { UI.toast(e.message, "error"); }
        },
      },
    ]);
    setTimeout(() => input.focus(), 50);
  }

  function deleteNode(node) {
    UI.modal(
      "Delete " + node.name + "?",
      UI.el("p", { class: "muted", text: `This permanently removes ${node.path}.` }),
      [
        { label: "Cancel", onClick: (c) => c() },
        {
          label: "Delete",
          primary: true,
          onClick: async (c) => {
            try {
              await API.remove(node.path);
              UI.toast("Deleted", "success");
              App.closeTabsUnder(node.path);
              c();
              refresh();
            } catch (e) { UI.toast(e.message, "error"); }
          },
        },
      ]
    );
  }

  return { init, refresh, selectPath, expandTo: (p) => { 
    const parts = p.split("/");
    let acc = "";
    for (const part of parts.slice(0, -1)) { acc = acc ? acc + "/" + part : part; expanded.add(acc); }
  } };
})();
