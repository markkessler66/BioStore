// Multi-tree / multi-network summarisation panel.
//
// Redesigned to be visual-first: instead of long tables of taxon sets, the
// recurring clades and topologies are drawn as little trees ("mini networks")
// so the structure is legible at a glance. Raw tables are still available
// behind "Show all" toggles.
const SummaryView = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";

  function build(pane, data, opts = {}) {
    const { path, reference, threshold, onBack, onReload } = opts;
    pane.innerHTML = "";
    const wrap = UI.el("div", { class: "summary-wrap" });

    // ---- toolbar ----
    const toolbar = UI.el("div", { class: "workspace-head" });
    toolbar.appendChild(UI.el("div", { class: "workspace-titles" }, [
      UI.el("h1", { class: "workspace-title", text: "Summary" }),
      UI.el("p", { class: "workspace-desc", text: data.path || path || "" }),
    ]));
    const actions = UI.el("div", { class: "workspace-actions" });
    toolbar.appendChild(actions);

    if (onReload) {
      const thLabel = UI.el("label", { class: "summary-th" }, [
        document.createTextNode("consensus ≥ "),
      ]);
      const thInput = UI.el("input", {
        type: "number", min: "0", max: "1", step: "0.05",
        value: String(threshold ?? 0.5),
      });
      thInput.addEventListener("change", () => {
        let v = parseFloat(thInput.value);
        if (isNaN(v)) v = 0.5;
        v = Math.min(1, Math.max(0, v));
        onReload(reference, v);
      });
      thLabel.appendChild(thInput);
      actions.appendChild(thLabel);

      if (reference) {
        actions.appendChild(UI.el("span", { class: "summary-ref" }, [
          document.createTextNode("ref: " + UI.basename(reference)),
          UI.el("button", {
            class: "ghost", type: "button", title: "Clear reference", text: "Clear",
            onclick: () => onReload(undefined, threshold),
          }),
        ]));
      } else {
        const refBtn = UI.el("button", { class: "ghost", text: "Compare to reference…" });
        refBtn.title = "Pick a species/reference tree to compute duplication–loss, RF and gene concordance";
        refBtn.addEventListener("click", async () => {
          const p = await UI.pickStoreFile({
            title: "Select a reference tree",
            acceptKinds: ["network", "file"],
          });
          if (p) onReload(p, threshold);
        });
        actions.appendChild(refBtn);
      }
    }

    if (onBack) {
      const back = UI.el("button", { class: "ghost", type: "button", text: "Back to network" });
      back.addEventListener("click", onBack);
      actions.appendChild(back);
    }

    const body = UI.el("div", { class: "summary-body" });
    const py = data.phynetpy && data.phynetpy.phynetpy_available && !data.phynetpy.error
      ? data.phynetpy : null;

    body.appendChild(overviewCards(data, py));
    body.appendChild(consensusSection(data, py, threshold));
    body.appendChild(cladesSection(data));
    body.appendChild(topologiesSection(data));

    const occ = occupancySection(data);
    if (occ) body.appendChild(occ);

    const retic = reticulationSection(data);
    if (retic) body.appendChild(retic);

    body.appendChild(phynetpySection(data, reference, onReload));

    wrap.append(toolbar, body);
    pane.appendChild(wrap);
  }

  // ---------------------------------------------------------------- overview
  function overviewCards(data, py) {
    const grid = UI.el("div", { class: "stat-grid" });
    const chips = [
      ["Trees / networks", data.count, "sequences in this file"],
      ["Distinct taxa", data.ntaxa, "across all trees"],
      ["Unique topologies", data.unique_topologies, data.count ? pct(data.unique_topologies / data.count) + " of trees" : ""],
      ["Mean leaves / tree", data.mean_leaves, "tips per tree"],
    ];
    if (data.ragged) {
      chips.push(["Complete taxa", `${data.taxa_in_all}/${data.ntaxa}`, "present in every tree"]);
    }
    if (data.networks_with_reticulations) {
      chips.push(["With reticulations", data.networks_with_reticulations, "mean " + data.mean_reticulations]);
    }
    for (const [label, val, sub] of chips) {
      grid.appendChild(UI.el("div", { class: "stat-card" }, [
        UI.el("span", { class: "stat-val", text: val == null ? "—" : String(val) }),
        UI.el("span", { class: "stat-label", text: label }),
        sub ? UI.el("span", { class: "stat-sub", text: sub }) : null,
      ]));
    }
    return grid;
  }

  // -------------------------------------------------------------- consensus
  function consensusSection(data, py, threshold) {
    const sec = UI.el("div", { class: "summary-section" });
    sec.appendChild(sectionHead(
      "At a glance",
      "The tree(s) that best represent the whole file. The consensus keeps only the groupings that most trees agree on; the most-common topology is the single tree shape seen most often."
    ));

    const row = UI.el("div", { class: "consensus-row" });
    let shown = 0;

    if (py && py.consensus_tree) {
      const th = py.consensus_threshold != null ? py.consensus_threshold : (threshold ?? 0.5);
      row.appendChild(figure(
        miniTree(py.consensus_tree, { height: 200 }),
        "Majority-rule consensus",
        "groupings in ≥ " + pct(th) + " of trees"
      ));
      shown++;
    }

    const top = (data.topologies || [])[0];
    const modal = (py && py.modal_tree) || (top && top.representative);
    if (modal) {
      const cap = top ? `seen in ${top.count} tree${top.count === 1 ? "" : "s"} (${pct(top.frequency)})` : "modal topology";
      row.appendChild(figure(miniTree(modal, { height: 200 }), "Most common topology", cap));
      shown++;
    }

    if (shown) {
      sec.appendChild(row);
    } else {
      sec.appendChild(UI.el("p", { class: "muted", text: "Not enough structure to build a consensus (need trees with shared taxa)." }));
    }
    return sec;
  }

  // ------------------------------------------------------------------ clades
  function cladesSection(data) {
    const sec = UI.el("div", { class: "summary-section" });
    sec.appendChild(sectionHead(
      "Recurring groupings (clades)",
      "Each mini tree shows a set of taxa that repeatedly cluster together, split from the rest. The bar is how often that grouping appears across all trees."
    ));

    const clades = data.clades || [];
    if (!clades.length) {
      sec.appendChild(UI.el("p", { class: "muted", text: "No non-trivial clades found." }));
      return sec;
    }

    const grid = UI.el("div", { class: "card-grid" });
    const CARDS = 12;
    for (const c of clades.slice(0, CARDS)) {
      const others = Math.max(0, (data.ntaxa || 0) - c.size);
      const card = UI.el("div", { class: "clade-card" });
      card.appendChild(supportBar(c.frequency));
      card.appendChild(miniTree(cladeGraph(c.taxa, others), { height: cladeHeight(c.taxa.length) }));
      card.appendChild(UI.el("div", { class: "clade-meta" }, [
        UI.el("span", { text: `${c.size} taxa` }),
        UI.el("span", { class: "muted", text: `${c.count} / ${data.count} trees` }),
      ]));
      grid.appendChild(card);
    }
    sec.appendChild(grid);

    if (clades.length > CARDS) {
      sec.appendChild(collapsibleTable(
        `Show all ${clades.length} clusters as a table`,
        ["%", "n", "size", "taxa"],
        clades.map((c) => [pct(c.frequency), c.count, c.size, { mono: c.taxa.join(", ") }])
      ));
    }
    return sec;
  }

  // -------------------------------------------------------------- topologies
  function topologiesSection(data) {
    const topos = data.topologies || [];
    if (!topos.length) return UI.el("div");
    const sec = UI.el("div", { class: "summary-section" });
    sec.appendChild(sectionHead(
      "Distinct tree shapes (topologies)",
      "The different whole-tree shapes present in the file, most frequent first. Compare these to spot conflicting signal between trees."
    ));

    const drawable = topos.filter((t) => t.representative);
    if (drawable.length) {
      const grid = UI.el("div", { class: "card-grid" });
      for (const t of drawable) {
        const card = UI.el("div", { class: "clade-card" });
        card.appendChild(supportBar(t.frequency, "#" + t.rank));
        card.appendChild(miniTree(t.representative, { height: 190 }));
        card.appendChild(UI.el("div", { class: "clade-meta" }, [
          UI.el("span", { text: `${t.n_clades} clades` }),
          UI.el("span", { class: "muted", text: `${t.count} / ${data.count} trees` }),
        ]));
        grid.appendChild(card);
      }
      sec.appendChild(grid);
    }

    if (topos.length > (drawable.length || 0)) {
      sec.appendChild(collapsibleTable(
        `Show all ${topos.length} topologies as a table`,
        ["#", "%", "n", "clades"],
        topos.map((t) => [t.rank, pct(t.frequency), t.count, t.n_clades])
      ));
    }
    return sec;
  }

  // -------------------------------------------------------------- occupancy
  function occupancySection(data) {
    const occ = data.taxon_occupancy || [];
    if (!data.ragged || !occ.length) return null;
    const sec = UI.el("div", { class: "summary-section" });
    sec.appendChild(sectionHead(
      "Taxon occupancy",
      "How many trees each taxon appears in. Ragged coverage (taxa missing from some trees) affects clade and consensus support."
    ));
    const list = UI.el("div", { class: "occ-list" });
    for (const t of occ) {
      list.appendChild(UI.el("div", { class: "occ-row" }, [
        UI.el("span", { class: "occ-name mono", text: t.taxon }),
        UI.el("div", { class: "occ-track" }, [
          UI.el("div", { class: "occ-fill", style: `width:${(t.frequency * 100).toFixed(1)}%` }),
        ]),
        UI.el("span", { class: "occ-count muted", text: `${t.count}/${data.count}` }),
      ]));
    }
    sec.appendChild(list);
    return sec;
  }

  // ------------------------------------------------------------ reticulations
  function reticulationSection(data) {
    const hist = data.reticulation_histogram || {};
    const keys = Object.keys(hist).filter((k) => k !== "0");
    if (!keys.length) return null;
    const sec = UI.el("div", { class: "summary-section" });
    sec.appendChild(sectionHead("Reticulation counts", "Number of trees by how many reticulation (hybrid) edges they contain."));
    sec.appendChild(simpleTable(["# reticulations", "count"], Object.entries(hist).map(([k, v]) => [k, v])));
    return sec;
  }

  // ---------------------------------------------------------------- phynetpy
  function phynetpySection(data, reference, onReload) {
    const py = data.phynetpy;
    const sec = UI.el("div", { class: "summary-section" });
    sec.appendChild(sectionHead("PhyNetPy analysis", "Statistics computed by PhyNetPy's GeneTrees toolkit."));

    if (!py) {
      sec.appendChild(UI.el("p", { class: "muted", text: "PhyNetPy not available for this file." }));
      return sec;
    }
    if (!py.phynetpy_available) {
      sec.appendChild(UI.el("p", { class: "muted", text: "PhyNetPy not available: " + (py.error || "") }));
      return sec;
    }
    if (py.error) {
      sec.appendChild(UI.el("p", { class: "muted", text: "PhyNetPy error: " + py.error }));
      return sec;
    }

    // Gene-tree facts.
    const facts = [];
    if (py.n_gene_trees != null) facts.push(["Gene trees", py.n_gene_trees]);
    if (py.n_taxa != null) facts.push(["Taxa", py.n_taxa]);
    if (py.consensus_clusters) facts.push(["Consensus clusters", py.consensus_clusters.length + " ≥ " + pct(py.consensus_threshold ?? 0.5)]);
    if (py.split_support) facts.push(["Unrooted splits", py.split_support.length]);
    if (facts.length) {
      const grid = UI.el("div", { class: "stat-grid compact" });
      for (const [label, val] of facts) {
        grid.appendChild(UI.el("div", { class: "stat-card" }, [
          UI.el("span", { class: "stat-val", text: String(val) }),
          UI.el("span", { class: "stat-label", text: label }),
        ]));
      }
      sec.appendChild(grid);
    }

    // Reference-based analyses.
    if (!reference) {
      sec.appendChild(UI.el("p", { class: "muted", text: "Pick a reference tree (toolbar) to compute duplication–loss, Robinson–Foulds distance and gene concordance factors." }));
    } else {
      if (py.reference_error) {
        sec.appendChild(UI.el("p", { class: "muted", text: "Reference error: " + py.reference_error }));
      }
      if (py.duplication_loss && py.duplication_loss.totals) {
        const t = py.duplication_loss.totals;
        sec.appendChild(UI.el("h4", { class: "summary-h", text: "Reconciliation vs reference" }));
        const grid = UI.el("div", { class: "stat-grid compact" });
        grid.appendChild(statMini(t.duplications, "Duplications"));
        grid.appendChild(statMini(t.losses, "Losses"));
        if (py.rf_distance != null) grid.appendChild(statMini((+py.rf_distance).toFixed(3), "Mean norm. RF"));
        sec.appendChild(grid);
      } else if (py.rf_distance != null) {
        sec.appendChild(statMini((+py.rf_distance).toFixed(3), "Mean normalised RF distance"));
      }
      if (py.gene_concordance_factors && Object.keys(py.gene_concordance_factors).length) {
        sec.appendChild(UI.el("h4", { class: "summary-h", text: "Gene concordance factors" }));
        sec.appendChild(simpleTable(
          ["edge (taxa)", "gCF"],
          Object.entries(py.gene_concordance_factors).map(([k, v]) => [{ mono: k.replace("|", " … ") }, pct(v)])
        ));
      }
    }
    return sec;
  }

  // ================================================================= helpers

  function sectionHead(title, help) {
    return UI.el("div", { class: "sec-head" }, [
      UI.el("h3", { class: "summary-h", text: title }),
      help ? UI.el("p", { class: "sec-help", text: help }) : null,
    ]);
  }

  function figure(node, title, caption) {
    return UI.el("figure", { class: "net-figure" }, [
      node,
      UI.el("figcaption", {}, [
        UI.el("b", { text: title }),
        caption ? UI.el("span", { class: "muted", text: caption }) : null,
      ]),
    ]);
  }

  function statMini(val, label) {
    return UI.el("div", { class: "stat-card" }, [
      UI.el("span", { class: "stat-val", text: String(val) }),
      UI.el("span", { class: "stat-label", text: label }),
    ]);
  }

  function supportBar(freq, tag) {
    const p = Math.round((freq || 0) * 100);
    const bar = UI.el("div", { class: "support-bar" }, [
      UI.el("div", { class: "support-fill", style: `width:${p}%` }),
      UI.el("span", { class: "support-pct", text: (tag ? tag + " · " : "") + p + "%" }),
    ]);
    return bar;
  }

  function pct(f) {
    return (f == null ? 0 : f * 100).toFixed(f != null && f < 0.1 ? 1 : 0) + "%";
  }

  function cladeHeight(nLeaves) {
    return Math.min(220, 44 + Math.min(nLeaves + 1, 7) * 22);
  }

  // A cartoon graph: root splits into {this clade} vs {the rest}.
  function cladeGraph(taxa, otherCount) {
    const nodes = [];
    const edges = [];
    let id = 0;
    const root = id++;
    nodes.push({ id: root, is_leaf: false, is_hybrid: false });
    const clade = id++;
    nodes.push({ id: clade, is_leaf: false, is_hybrid: false });
    edges.push({ source: root, target: clade });

    const SHOW = 6;
    const shown = taxa.slice(0, SHOW);
    for (const t of shown) {
      const n = id++;
      nodes.push({ id: n, is_leaf: true, is_hybrid: false, label: t });
      edges.push({ source: clade, target: n });
    }
    if (taxa.length > SHOW) {
      const n = id++;
      nodes.push({ id: n, is_leaf: true, is_hybrid: false, label: `+${taxa.length - SHOW} more`, dim: true });
      edges.push({ source: clade, target: n });
    }
    if (otherCount > 0) {
      const n = id++;
      nodes.push({ id: n, is_leaf: true, is_hybrid: false, label: `… ${otherCount} other taxa`, dim: true });
      edges.push({ source: root, target: n });
    }
    return { nodes, edges, root, leaf_count: shown.length };
  }

  // Compact, static left-to-right tree renderer producing a scalable <svg>.
  function miniTree(net, { height = 180 } = {}) {
    const nodes = net.nodes || [];
    const edges = net.edges || [];
    if (!nodes.length) return UI.el("div", { class: "muted", text: "—" });

    const children = new Map();
    for (const e of edges) {
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source).push(e);
    }
    const root = net.root != null ? net.root : nodes[0].id;

    const depth = new Map();
    (function dfs(id, d, guard) {
      if (guard.has(id)) return;
      guard.add(id);
      depth.set(id, Math.max(depth.get(id) ?? -1, d));
      for (const e of children.get(id) || []) dfs(e.target, d + 1, guard);
      guard.delete(id);
    })(root, 0, new Set());
    for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);
    const maxDepth = Math.max(1, ...depth.values());

    const leafOrder = [];
    const seen = new Set();
    (function dfs(id) {
      if (seen.has(id)) return;
      seen.add(id);
      const kids = children.get(id) || [];
      if (!kids.length) { leafOrder.push(id); return; }
      for (const e of kids) dfs(e.target);
    })(root);
    for (const n of nodes) if (!seen.has(n.id) && n.is_leaf) leafOrder.push(n.id);
    const leafY = new Map();
    leafOrder.forEach((id, i) => leafY.set(id, i));

    const memoY = new Map();
    (function computeAll() {
      function cy(id, guard) {
        if (memoY.has(id)) return memoY.get(id);
        if (guard.has(id)) return leafY.get(id) ?? 0;
        guard.add(id);
        const kids = children.get(id) || [];
        if (!kids.length) { const y = leafY.get(id) ?? 0; memoY.set(id, y); return y; }
        let s = 0;
        for (const e of kids) s += cy(e.target, guard);
        const y = s / kids.length;
        memoY.set(id, y);
        return y;
      }
      for (const n of nodes) cy(n.id, new Set());
    })();

    const rowH = 22, colW = 46, mX = 8, mY = 12;
    const pos = new Map();
    for (const n of nodes) {
      pos.set(n.id, { x: mX + depth.get(n.id) * colW, y: mY + (memoY.get(n.id) ?? 0) * rowH });
    }

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    let maxLabelPx = 0;
    for (const id of leafOrder) {
      const lab = (nodeById.get(id) || {}).label || "";
      maxLabelPx = Math.max(maxLabelPx, lab.length * 6.4);
    }
    const w = mX + maxDepth * colW + 8 + maxLabelPx + 6;
    const h = mY * 2 + Math.max(0, leafOrder.length - 1) * rowH;

    const svg = svgEl("svg", {
      class: "mini-net",
      viewBox: `0 0 ${w} ${Math.max(h, 1)}`,
      preserveAspectRatio: "xMinYMid meet",
    });

    for (const e of edges) {
      const s = pos.get(e.source), t = pos.get(e.target);
      if (!s || !t) continue;
      const mid = (s.x + t.x) / 2;
      svg.appendChild(svgEl("path", {
        class: "mini-edge" + (e.is_hybrid_edge ? " hybrid" : ""),
        d: `M${s.x},${s.y} C${mid},${s.y} ${mid},${t.y} ${t.x},${t.y}`,
      }));
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const cls = n.is_hybrid ? "hybrid" : n.is_leaf ? "leaf" : "internal";
      svg.appendChild(svgEl("circle", { class: "mini-node " + cls, cx: p.x, cy: p.y, r: n.is_leaf ? 3 : 2.5 }));
      if (n.is_leaf && n.label) {
        svg.appendChild(svgEl("text", {
          class: "mini-label" + (n.dim ? " dim" : ""),
          x: p.x + 6, y: p.y, dy: "0.32em", text: n.label,
        }));
      }
    }

    const box = UI.el("div", { class: "mini-net-box" });
    box.style.height = height + "px";
    box.appendChild(svg);
    return box;
  }

  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function cell(v) {
    if (v && typeof v === "object" && "mono" in v) return UI.el("td", { class: "mono", text: v.mono });
    return UI.el("td", { text: String(v) });
  }

  function simpleTable(headers, rows) {
    const table = UI.el("table", { class: "summary-table compact" });
    table.appendChild(UI.el("thead", {}, [
      UI.el("tr", {}, headers.map((h) => UI.el("th", { text: h }))),
    ]));
    const tbody = UI.el("tbody");
    for (const r of rows) tbody.appendChild(UI.el("tr", {}, r.map(cell)));
    table.appendChild(tbody);
    return table;
  }

  function collapsibleTable(label, headers, rows) {
    const details = UI.el("details", { class: "summary-details" });
    details.appendChild(UI.el("summary", { text: label }));
    details.appendChild(simpleTable(headers, rows));
    return details;
  }

  return { build };
})();
