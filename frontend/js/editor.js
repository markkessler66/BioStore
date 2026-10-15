// Plain-text editor for generic files (and a fallback for anything else).
const TextEditor = (() => {
  function build(pane, data) {
    pane.innerHTML = "";
    const wrap = UI.el("div", { class: "editor-wrap" });

    const info = UI.el("p", { class: "workspace-desc" });
    const saveBtn = UI.el("button", { class: "primary", type: "button", text: "Save" });
    const dlBtn = UI.el("button", { class: "ghost", type: "button", text: "Download" });
    const snippetBtn = UI.el("button", { class: "ghost", type: "button", text: "PhyNetPy snippet" });
    const head = UI.el("div", { class: "workspace-head" }, [
      UI.el("div", { class: "workspace-titles" }, [
        UI.el("h1", { class: "workspace-title", text: UI.basename(data.path) }),
        info,
      ]),
      UI.el("div", { class: "workspace-actions" }, [dlBtn, snippetBtn, saveBtn]),
    ]);

    const ta = UI.el("textarea", { class: "text-editor", spellcheck: "false" });
    ta.value = data.content;

    const updateInfo = () => {
      const lines = ta.value.split("\n").length;
      info.textContent = `${lines} lines · ${UI.humanSize(ta.value.length)}`;
    };
    updateInfo();

    ta.addEventListener("input", () => { updateInfo(); App.markDirty(data.path); });
    saveBtn.addEventListener("click", async () => {
      try {
        await API.writeFile(data.path, ta.value);
        UI.toast("Saved " + UI.basename(data.path), "success");
        App.markClean(data.path);
        FileTree.refresh();
      } catch (e) { UI.toast(e.message, "error"); }
    });
    dlBtn.addEventListener("click", () =>
      API.downloadFile(data.path, UI.basename(data.path)).catch((e) => UI.toast(e.message, "error")));
    snippetBtn.addEventListener("click", () => App.showSnippet(data.path));

    // Ctrl/Cmd+S to save.
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveBtn.click(); }
    });

    wrap.append(head, ta);
    pane.appendChild(wrap);
    if (App.setSaveHandler) App.setSaveHandler(() => saveBtn.click());
    setTimeout(() => ta.focus(), 30);
  }
  return { build };
})();
