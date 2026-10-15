// Editable multiple-sequence-alignment viewer with live statistics.
const AlignmentView = (() => {
  const NAME_W = 170;

  function build(pane, data) {
    pane.innerHTML = "";
    const state = {
      path: data.path,
      format: data.format,
      datatype: data.datatype,
      taxa: [...data.taxa],
      sequences: { ...data.sequences },
    };

    const wrap = UI.el("div", { class: "aln-wrap" });

    // ---- toolbar ----
    const toolbar = UI.el("div", { class: "workspace-head" });
    toolbar.appendChild(UI.el("div", { class: "workspace-titles" }, [
      UI.el("h1", { class: "workspace-title", text: "Alignment" }),
      UI.el("p", { class: "workspace-desc", text: data.path }),
    ]));
    const actions = UI.el("div", { class: "workspace-actions" });
    toolbar.appendChild(actions);

    const fmtSel = UI.el("select");
    ["fasta", "phylip", "nexus"].forEach((f) =>
      fmtSel.appendChild(UI.el("option", { value: f, text: f.toUpperCase(), selected: f === data.format ? "selected" : null }))
    );
    const dtSel = UI.el("select");
    ["dna", "rna", "protein", "unknown"].forEach((d) =>
      dtSel.appendChild(UI.el("option", { value: d, text: d, selected: d === data.datatype ? "selected" : null }))
    );

    const convertBtn = UI.el("button", { class: "ghost", text: "Preview / Convert" });
    const saveBtn = UI.el("button", { class: "primary", text: "Save" });
    const dlBtn = UI.el("button", { class: "ghost", text: "Download" });
    const snippetBtn = UI.el("button", { class: "ghost", text: "PhyNetPy snippet" });
    actions.append(
      UI.el("span", { class: "muted", text: "format" }), fmtSel,
      UI.el("span", { class: "muted", text: "type" }), dtSel,
      convertBtn, dlBtn, snippetBtn, saveBtn
    );
    if (App.setSaveHandler) App.setSaveHandler(() => saveBtn.click());

    // ---- stats ----
    const statsBar = UI.el("div", { class: "aln-stats" });

    // ---- embedded networks (newick in a NEXUS TREES block) ----
    let embedBar = null;
    if (data.embedded_networks && data.embedded_networks.length) {
      embedBar = UI.el("div", { class: "pane-toolbar" });
      embedBar.appendChild(UI.el("span", { class: "muted", text: `${data.embedded_networks.length} embedded network(s):` }));
      data.embedded_networks.forEach((net) => {
        const b = UI.el("button", { class: "ghost", type: "button", text: net.name || "network" });
        b.addEventListener("click", () => App.openInlineNetwork(net.name || "network", { networks: [net], path: data.path + " → " + (net.name || "") }));
        embedBar.appendChild(b);
      });
    }

    // ---- grid ----
    const scroll = UI.el("div", { class: "aln-grid-scroll" });

    wrap.append(toolbar);
    if (embedBar) wrap.append(embedBar);
    wrap.append(statsBar, scroll);
    pane.appendChild(wrap);

    function readSequencesFromDOM() {
      const seqs = {};
      // Only data rows — the sticky ruler also sits in the scroll area.
      scroll.querySelectorAll(".aln-row").forEach((row) => {
        const nameEl = row.querySelector(".taxon-name");
        const seqEl = row.querySelector(".seq-cell");
        if (!nameEl || !seqEl) return;
        const name = nameEl.textContent.trim();
        const seq = seqEl.textContent.replace(/\s+/g, "");
        if (name) seqs[name] = seq;
      });
      return seqs;
    }

    function refreshStats() {
      const seqs = readSequencesFromDOM();
      const nchar = Math.max(0, ...Object.values(seqs).map((s) => s.length));
      const gapChars = new Set(["-", "?", "."]);
      let gaps = 0, total = 0;
      for (const s of Object.values(seqs)) {
        for (const c of s) { total++; if (gapChars.has(c)) gaps++; }
      }
      const items = [
        ["Taxa", Object.keys(seqs).length],
        ["Columns", nchar],
        ["Gaps", total ? ((100 * gaps) / total).toFixed(1) + "%" : "0%"],
        ["Type", dtSel.value],
      ];
      statsBar.innerHTML = "";
      for (const [label, val] of items) {
        statsBar.appendChild(
          UI.el("div", { class: "stat" }, [
            UI.el("span", { class: "stat-val", text: String(val) }),
            UI.el("span", { class: "stat-label", text: label }),
          ])
        );
      }
    }

    function colorize(seq) {
      const frag = document.createDocumentFragment();
      for (const ch of seq) {
        const up = ch.toUpperCase();
        let cls = "aln-cell";
        if ("ACGTU".includes(up)) cls += " base-" + up;
        else if ("-?.".includes(ch)) cls += " base-gap";
        frag.appendChild(UI.el("span", { class: cls, text: ch }));
      }
      return frag;
    }

    function renderGrid() {
      scroll.innerHTML = "";
      const nchar = Math.max(0, ...Object.values(state.sequences).map((s) => s.length), 1);

      // ruler
      let ruler = "";
      for (let i = 0; i < nchar; i++) ruler += (i % 10 === 0 && i > 0) ? "|" : ((i + 1) % 10 === 0 ? "." : "·");
      const rulerRow = UI.el("div", { class: "aln-ruler", style: "display:flex;position:sticky;top:0;z-index:5;background:var(--bg-elev);" });
      rulerRow.append(
        UI.el("div", { style: `min-width:${NAME_W}px;color:var(--muted);padding:2px 10px;font-family:var(--mono);font-size:11px;`, text: `pos → ${nchar}` }),
        UI.el("div", { style: "font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap;", text: ruler })
      );
      scroll.appendChild(rulerRow);

      for (const name of state.taxa) {
        const row = UI.el("div", { class: "aln-row", style: "display:flex;border-bottom:1px solid var(--border);" });

        const nameCell = UI.el("div", {
          class: "taxon-name",
          contenteditable: "true",
          style: `min-width:${NAME_W}px;max-width:${NAME_W}px;`,
        });
        nameCell.textContent = name;
        nameCell.addEventListener("blur", refreshStats);

        const seqCell = UI.el("div", {
          class: "seq-cell",
          contenteditable: "true",
          style: "font-family:var(--mono);font-size:12px;white-space:nowrap;padding:2px 6px;flex:1;",
        });
        seqCell.appendChild(colorize(state.sequences[name] || ""));

        // On focus flatten to plain text for clean editing; recolor on blur.
        seqCell.addEventListener("focus", () => {
          seqCell.textContent = seqCell.textContent;
        });
        seqCell.addEventListener("blur", () => {
          const plain = seqCell.textContent.replace(/\s+/g, "");
          seqCell.innerHTML = "";
          seqCell.appendChild(colorize(plain));
          refreshStats();
        });

        row.append(nameCell, seqCell);
        scroll.appendChild(row);
      }
      refreshStats();
    }

    async function doSave() {
      const seqs = readSequencesFromDOM();
      try {
        await API.saveAlignment(state.path, seqs, fmtSel.value, dtSel.value);
        UI.toast("Saved " + UI.basename(state.path), "success");
        App.markClean(state.path);
        FileTree.refresh();
      } catch (e) { UI.toast(e.message, "error"); }
    }

    async function doConvert() {
      const seqs = readSequencesFromDOM();
      try {
        const res = await API.convert(seqs, fmtSel.value, dtSel.value);
        const pre = UI.el("pre", { text: res.text });
        UI.modal(`Preview as ${fmtSel.value.toUpperCase()}`, pre, [
          { label: "Copy", onClick: () => UI.copyText(res.text) },
          { label: "Close", primary: true, onClick: (c) => c() },
        ]);
      } catch (e) { UI.toast(e.message, "error"); }
    }

    convertBtn.addEventListener("click", doConvert);
    saveBtn.addEventListener("click", doSave);
    dlBtn.addEventListener("click", () =>
      API.downloadFile(state.path).catch((e) => UI.toast(e.message, "error")));
    snippetBtn.addEventListener("click", () => App.showSnippet(state.path));
    dtSel.addEventListener("change", refreshStats);
    scroll.addEventListener("input", () => App.markDirty(state.path));

    renderGrid();
  }

  return { build };
})();
