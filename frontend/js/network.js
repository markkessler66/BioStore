// Renders a phylogenetic network (parsed graph dict) with D3.
// Layout: left-to-right. Root on the left, taxa (leaves) on the right with
// their labels. Internal + hybrid nodes are hoverable for details.
const NetworkView = (() => {
  function build(pane, data, { onSummary } = {}) {
    pane.innerHTML = "";
    const networks = data.networks || [];
    const wrap = UI.el("div", { class: "network-wrap" });

    const toolbar = UI.el("div", { class: "workspace-head" });
    const titles = UI.el("div", { class: "workspace-titles" }, [
      UI.el("h1", { class: "workspace-title", text: "Network" }),
      UI.el("p", { class: "workspace-desc", text: data.path || "Inline network" }),
    ]);
    toolbar.appendChild(titles);
    const actions = UI.el("div", { class: "workspace-actions" });
    toolbar.appendChild(actions);

    let selector = null;
    if (networks.length > 1) {
      selector = UI.el("select");
      networks.forEach((n, i) =>
        selector.appendChild(UI.el("option", { value: i, text: n.name || `network ${i + 1}` }))
      );
      actions.appendChild(selector);
    }

    const info = UI.el("span", { class: "muted" });
    actions.appendChild(info);

    const fitBtn = UI.el("button", { class: "ghost", type: "button", text: "Fit" });
    const summaryBtn = UI.el("button", { class: "ghost", type: "button", text: "Summary" });
    const snippetBtn = UI.el("button", { class: "ghost", type: "button", text: "PhyNetPy snippet" });
    actions.append(fitBtn, summaryBtn, snippetBtn);
    if (data.path)
      snippetBtn.addEventListener("click", () => App.showSnippet(data.path));
    else snippetBtn.style.display = "none";

    if (onSummary && networks.length >= 1) {
      summaryBtn.addEventListener("click", onSummary);
      if (networks.length < 2) summaryBtn.title = "Summarise this file (more useful with multiple trees)";
    } else {
      summaryBtn.style.display = "none";
    }

    const canvas = UI.el("div", { class: "network-canvas" });
    const tooltip = UI.el("div", { class: "net-tooltip hidden" });

    const legend = UI.el("div", {
      class: "net-legend",
      html:
        '<span><span class="dot" style="background:var(--leaf)"></span>Leaf (taxon)</span>' +
        '<span><span class="dot" style="background:var(--accent)"></span>Internal</span>' +
        '<span><span class="dot" style="background:var(--hybrid)"></span>Reticulation</span>' +
        '<span style="border-bottom:2px dashed var(--hybrid);">hybrid edge (γ)</span>',
    });

    wrap.append(toolbar, canvas, legend);
    pane.appendChild(wrap);
    canvas.appendChild(tooltip);

    let currentFit = null;
    let ro = null;

    function draw(idx) {
      const net = networks[idx];
      info.textContent = `${net.leaf_count} taxa · ${net.reticulation_count} reticulation(s) · ${net.nodes.length} nodes`;
      if (ro) { ro.disconnect(); ro = null; }
      const result = render(canvas, tooltip, net);
      currentFit = result.fit;
      // Fit once the canvas has a real size (pane may still be laying out).
      whenSized(canvas, () => currentFit && currentFit(false));
      // Keep centered if the pane is resized.
      if (typeof ResizeObserver !== "undefined") {
        let first = true;
        ro = new ResizeObserver(() => {
          if (first) { first = false; return; }
          if (currentFit) currentFit(false);
        });
        ro.observe(canvas);
      }
    }

    if (selector) selector.addEventListener("change", () => draw(+selector.value));
    fitBtn.addEventListener("click", () => currentFit && currentFit(true));

    draw(0);
  }

  // Wait until the canvas has non-zero dimensions, then run `fn`.
  function whenSized(el, fn) {
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      requestAnimationFrame(fn);
      return;
    }
    let tries = 0;
    const tick = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0 || tries++ > 40) {
        fn();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function render(canvas, tooltip, net) {
    canvas.querySelectorAll("svg").forEach((s) => s.remove());

    const children = new Map();
    const parents = new Map();
    for (const e of net.edges) {
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source).push(e);
      if (!parents.has(e.target)) parents.set(e.target, []);
      parents.get(e.target).push(e);
    }

    // ---- depth (x) via longest path from root ----
    const depth = new Map();
    (function dfsDepth(id, d) {
      if ((depth.get(id) ?? -1) >= d) return;
      depth.set(id, d);
      for (const e of children.get(id) || []) dfsDepth(e.target, d + 1);
    })(net.root, 0);
    for (const n of net.nodes) if (!depth.has(n.id)) depth.set(n.id, 0);
    const maxDepth = Math.max(1, ...depth.values());

    // ---- leaf ordering (y) via DFS ----
    const leafOrder = [];
    const seen = new Set();
    (function dfsLeaves(id) {
      if (seen.has(id)) return;
      seen.add(id);
      const kids = children.get(id) || [];
      if (kids.length === 0) { leafOrder.push(id); return; }
      for (const e of kids) dfsLeaves(e.target);
    })(net.root);
    const leafY = new Map();
    leafOrder.forEach((id, i) => leafY.set(id, i));

    const memoY = new Map();
    function computeY(id) {
      if (memoY.has(id)) return memoY.get(id);
      const kids = children.get(id) || [];
      if (kids.length === 0) { memoY.set(id, leafY.get(id) ?? 0); return memoY.get(id); }
      memoY.set(id, 0);
      let sum = 0;
      for (const e of kids) sum += computeY(e.target);
      const y = sum / kids.length;
      memoY.set(id, y);
      return y;
    }
    net.nodes.forEach((n) => computeY(n.id));

    // ---- layout in a local coordinate system (not screen pixels) ----
    const nLeaves = Math.max(1, leafOrder.length);
    const rowH = 34;
    const colW = 90;
    const marginX = 40;
    const marginY = 30;
    const labelSpace = 160;

    const pos = new Map();
    for (const n of net.nodes) {
      pos.set(n.id, {
        x: marginX + depth.get(n.id) * colW,
        y: marginY + computeY(n.id) * rowH,
      });
    }

    // SVG fills the canvas; zoom transform maps layout coords → screen.
    const svg = d3
      .select(canvas)
      .append("svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .style("display", "block");
    const g = svg.append("g");

    const link = (s, t) => {
      const mx = (s.x + t.x) / 2;
      return `M${s.x},${s.y} C${mx},${s.y} ${mx},${t.y} ${t.x},${t.y}`;
    };

    g.selectAll("path.net-edge")
      .data(net.edges)
      .join("path")
      .attr("class", (e) => "net-edge" + (e.is_hybrid_edge ? " hybrid" : ""))
      .attr("d", (e) => link(pos.get(e.source), pos.get(e.target)));

    g.selectAll("text.net-gamma-label")
      .data(net.edges.filter((e) => e.is_hybrid_edge && e.gamma != null))
      .join("text")
      .attr("class", "net-gamma-label")
      .attr("x", (e) => (pos.get(e.source).x + pos.get(e.target).x) / 2)
      .attr("y", (e) => (pos.get(e.source).y + pos.get(e.target).y) / 2 - 4)
      .attr("text-anchor", "middle")
      .text((e) => "γ=" + (+e.gamma).toFixed(2));

    const nodeSel = g
      .selectAll("g.net-node")
      .data(net.nodes)
      .join("g")
      .attr("class", (n) =>
        "net-node " + (n.is_hybrid ? "hybrid" : n.is_leaf ? "leaf" : "internal"))
      .attr("transform", (n) => `translate(${pos.get(n.id).x},${pos.get(n.id).y})`);

    nodeSel.append("circle").attr("r", (n) => (n.is_leaf ? 4 : n.is_hybrid ? 5 : 3.5));

    nodeSel
      .filter((n) => n.is_leaf)
      .append("text")
      .attr("class", "net-leaf-label")
      .attr("x", 9)
      .attr("dy", "0.32em")
      .text((n) => n.label || "(unnamed)");

    nodeSel
      .filter((n) => n.is_hybrid)
      .append("text")
      .attr("class", "net-gamma-label")
      .attr("x", 8)
      .attr("dy", "-0.6em")
      .text((n) => "#" + (n.hybrid_label || "H"));

    nodeSel
      .on("mouseenter", (event, n) => {
        const incoming = (parents.get(n.id) || [])
          .map((e) => {
            const bits = [];
            if (e.length != null) bits.push("len " + (+e.length).toFixed(3));
            if (e.gamma != null) bits.push("γ " + (+e.gamma).toFixed(3));
            if (e.support != null) bits.push("supp " + e.support);
            return bits.join(", ");
          })
          .filter(Boolean);
        const lines = [
          `<b>${n.label || (n.is_hybrid ? "#" + n.hybrid_label : "internal node")}</b>`,
          n.is_leaf ? "leaf / taxon" : n.is_hybrid ? "reticulation node" : "internal node",
          `id ${n.id}`,
        ];
        if (incoming.length) lines.push("edges: " + incoming.join(" | "));
        tooltip.innerHTML = lines.join("<br>");
        tooltip.classList.remove("hidden");
      })
      .on("mousemove", (event) => {
        const r = canvas.getBoundingClientRect();
        tooltip.style.left = event.clientX - r.left + 14 + "px";
        tooltip.style.top = event.clientY - r.top + 12 + "px";
      })
      .on("mouseleave", () => tooltip.classList.add("hidden"));

    const zoom = d3.zoom().scaleExtent([0.15, 8]).on("zoom", (e) => g.attr("transform", e.transform));
    svg.call(zoom);

    function fit(animate) {
      const gNode = g.node();
      if (!gNode) return;
      let bbox;
      try {
        bbox = gNode.getBBox();
      } catch {
        return;
      }
      if (!bbox.width || !bbox.height) return;

      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw < 10 || ch < 10) return;

      const pad = 48;
      const scale = Math.min((cw - pad) / bbox.width, (ch - pad) / bbox.height, 2.5);
      const tx = (cw - bbox.width * scale) / 2 - bbox.x * scale;
      const ty = (ch - bbox.height * scale) / 2 - bbox.y * scale;
      const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);

      // Reset the group's own transform so zoom owns positioning.
      g.attr("transform", null);
      if (animate) {
        svg.transition().duration(280).call(zoom.transform, transform);
      } else {
        svg.call(zoom.transform, transform);
      }
    }

    return { fit };
  }

  return { build };
})();
