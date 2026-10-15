"""Multi-tree / multi-network summarisation for BioStore.

Uses BioStore's own eNewick parser for clade frequencies (works for both
trees and networks), and optionally PhyNetPy's ``GeneTrees`` helpers for
duplication/loss and concordance when a reference tree is supplied and
PhyNetPy is importable.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from parsers.newick import parse_networks_from_text, NewickError


def _leaf_descendants(net: dict, node_id: int, children: dict, memo: dict) -> frozenset[str]:
    if node_id in memo:
        return memo[node_id]
    node = next(n for n in net["nodes"] if n["id"] == node_id)
    if node["is_leaf"]:
        label = node.get("label") or f"node_{node_id}"
        memo[node_id] = frozenset([label])
        return memo[node_id]
    leaves: set[str] = set()
    for e in children.get(node_id, []):
        leaves |= _leaf_descendants(net, e["target"], children, memo)
    memo[node_id] = frozenset(leaves)
    return memo[node_id]


def _clusters_of(net: dict) -> set[frozenset[str]]:
    """Rooted clusters (non-trivial leaf sets under each internal node)."""
    children: dict[int, list] = {}
    for e in net["edges"]:
        children.setdefault(e["source"], []).append(e)
    memo: dict = {}
    clusters: set[frozenset[str]] = set()
    for n in net["nodes"]:
        if n["is_leaf"]:
            continue
        cl = _leaf_descendants(net, n["id"], children, memo)
        if 1 < len(cl) < net["leaf_count"]:
            clusters.add(cl)
    return clusters


def _taxa_of(net: dict) -> set[str]:
    return {n["label"] for n in net["nodes"] if n["is_leaf"] and n.get("label")}


def _slim_net(net: dict) -> dict:
    """A frontend-renderable copy of a parsed graph (drops nothing it needs)."""
    return {
        "name": net.get("name"),
        "nodes": net["nodes"],
        "edges": net["edges"],
        "root": net["root"],
        "leaf_count": net.get("leaf_count", 0),
        "reticulation_count": net.get("reticulation_count", 0),
    }


def summarise_networks(networks: list[dict], *, top_k: int = 50) -> dict[str, Any]:
    """Compute clade / topology frequencies across a list of parsed graphs."""
    if not networks:
        return {
            "count": 0,
            "taxa": [],
            "ntaxa": 0,
            "clades": [],
            "topologies": [],
            "reticulation_histogram": {},
            "leaf_count_histogram": {},
            "mean_reticulations": 0.0,
        }

    clade_counts: Counter[frozenset[str]] = Counter()
    topo_counts: Counter[frozenset[frozenset[str]]] = Counter()
    topo_rep: dict[frozenset[frozenset[str]], dict] = {}
    retic_hist: Counter[int] = Counter()
    leaf_hist: Counter[int] = Counter()
    taxon_counts: Counter[str] = Counter()
    all_taxa: set[str] = set()

    for net in networks:
        clusters = _clusters_of(net)
        for c in clusters:
            clade_counts[c] += 1
        sig = frozenset(clusters)
        topo_counts[sig] += 1
        topo_rep.setdefault(sig, net)
        retic_hist[net.get("reticulation_count", 0)] += 1
        leaf_hist[net.get("leaf_count", 0)] += 1
        taxa = _taxa_of(net)
        for t in taxa:
            taxon_counts[t] += 1
        all_taxa |= taxa

    n = len(networks)
    clades = [
        {
            "taxa": sorted(c),
            "size": len(c),
            "count": cnt,
            "frequency": round(cnt / n, 4),
        }
        for c, cnt in clade_counts.most_common(top_k)
    ]
    topologies = []
    for i, (sig, cnt) in enumerate(topo_counts.most_common(min(top_k, 25))):
        entry = {
            "rank": i + 1,
            "count": cnt,
            "frequency": round(cnt / n, 4),
            "n_clades": len(sig),
            "signature": [sorted(c) for c in sorted(sig, key=lambda s: (len(s), sorted(s)))][:12],
        }
        # Attach a drawable representative for the most common topologies only,
        # to keep the payload light.
        if i < 12:
            entry["representative"] = _slim_net(topo_rep[sig])
        topologies.append(entry)

    mean_retic = sum(k * v for k, v in retic_hist.items()) / n
    mean_leaves = sum(k * v for k, v in leaf_hist.items()) / n

    # Per-taxon occupancy: how many trees each taxon appears in. Highly
    # informative for gene-tree sets with ragged / incomplete coverage.
    taxon_occupancy = [
        {"taxon": t, "count": c, "frequency": round(c / n, 4)}
        for t, c in sorted(taxon_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    taxa_in_all = sum(1 for _, c in taxon_counts.items() if c == n)

    return {
        "count": n,
        "taxa": sorted(all_taxa),
        "ntaxa": len(all_taxa),
        "clades": clades,
        "topologies": topologies,
        "unique_topologies": len(topo_counts),
        "reticulation_histogram": {str(k): v for k, v in sorted(retic_hist.items())},
        "leaf_count_histogram": {str(k): v for k, v in sorted(leaf_hist.items())},
        "mean_reticulations": round(mean_retic, 3),
        "networks_with_reticulations": sum(v for k, v in retic_hist.items() if k > 0),
        "mean_leaves": round(mean_leaves, 2),
        "taxon_occupancy": taxon_occupancy,
        "taxa_in_all": taxa_in_all,
        "ragged": taxa_in_all < len(all_taxa),
    }


def _net_to_graph(net) -> dict | None:
    """Serialise a PhyNetPy ``Network`` to the frontend graph dict.

    Goes through the network's Newick representation and reuses BioStore's own
    parser so the shape matches exactly what the network renderer expects.
    """
    if net is None:
        return None
    try:
        nw = net.newick()
    except Exception:
        return None
    if not nw or not nw.strip():
        return None
    if not nw.strip().endswith(";"):
        nw = nw.strip() + ";"
    try:
        graphs = parse_networks_from_text(nw)
    except NewickError:
        return None
    if not graphs:
        return None
    return _slim_net(graphs[0])


def _gene_tree_count(gts) -> int:
    for attr in ("trees", "gene_trees", "networks", "_trees"):
        val = getattr(gts, attr, None)
        if val is not None:
            try:
                return len(val)
            except TypeError:
                pass
    try:
        return len(gts)
    except TypeError:
        return 0


def summarise_with_phynetpy(
    gene_tree_path: str,
    *,
    reference_path: str | None = None,
    threshold: float = 0.5,
) -> dict[str, Any]:
    """Richer summary via PhyNetPy ``GeneTrees`` when available.

    Falls back gracefully if PhyNetPy cannot load the file.
    """
    try:
        from phynetpy.IO import read_nexus, read_newick_file  # type: ignore
        from phynetpy.GeneTrees import GeneTrees  # type: ignore
    except Exception as exc:
        return {"phynetpy_available": False, "error": f"PhyNetPy import failed: {exc}"}

    try:
        path_l = gene_tree_path.lower()
        is_nexus = path_l.endswith((".nex", ".nexus"))
        if is_nexus:
            try:
                gts = read_nexus(gene_tree_path, return_type="genetrees")
            except Exception:
                nets = read_nexus(gene_tree_path, return_type="networks")
                gts = GeneTrees(nets)
        else:
            try:
                gts = read_newick_file(gene_tree_path, return_type="genetrees")
            except Exception:
                nets = read_newick_file(gene_tree_path, return_type="networks")
                gts = GeneTrees(list(nets) if isinstance(nets, list) else [nets])

        if not isinstance(gts, GeneTrees):
            gts = GeneTrees(list(gts))

        out: dict[str, Any] = {
            "phynetpy_available": True,
            "n_gene_trees": _gene_tree_count(gts),
        }
        try:
            out["n_taxa"] = len(getattr(gts, "taxa_names", []) or [])
        except Exception:
            pass

        # cluster support
        try:
            support = gts.cluster_support(include_trivial=False, normalize=True)
            out["cluster_support"] = [
                {
                    "taxa": sorted(c),
                    "size": len(c),
                    "frequency": round(float(freq), 4),
                }
                for c, freq in sorted(support.items(), key=lambda kv: -kv[1])[:50]
            ]
        except Exception as exc:
            out["cluster_support_error"] = str(exc)

        # split (unrooted bipartition) support
        try:
            splits = gts.split_support(normalize=True)
            out["split_support"] = [
                {
                    "taxa": sorted(c),
                    "size": len(c),
                    "frequency": round(float(freq), 4),
                }
                for c, freq in sorted(splits.items(), key=lambda kv: -kv[1])[:50]
            ]
        except Exception as exc:
            out["split_support_error"] = str(exc)

        try:
            consensus = gts.consensus_clusters(threshold=threshold)
            out["consensus_clusters"] = [sorted(c) for c in consensus]
            out["consensus_threshold"] = threshold
        except Exception as exc:
            out["consensus_clusters_error"] = str(exc)

        # Majority-rule consensus tree, rendered as a drawable graph.
        try:
            cons_tree = gts.build_majority_rule_consensus_tree(threshold=threshold)
            g = _net_to_graph(cons_tree)
            if g:
                out["consensus_tree"] = g
        except Exception as exc:
            out["consensus_tree_error"] = str(exc)

        # Most frequent (modal) gene-tree topology, rendered as a drawable graph.
        try:
            modal = gts.most_frequent_gene_tree()
            g = _net_to_graph(modal)
            if g:
                out["modal_tree"] = g
        except Exception as exc:
            out["modal_tree_error"] = str(exc)

        if reference_path:
            try:
                if reference_path.lower().endswith((".nex", ".nexus")):
                    refs = read_nexus(reference_path, return_type="networks")
                else:
                    refs = read_newick_file(reference_path, return_type="networks")
                ref = refs[0] if isinstance(refs, list) else refs
                dl = gts.duplication_loss_summary(ref)
                out["duplication_loss"] = _jsonify(dl)
                try:
                    gcf = gts.gene_concordance_factors(ref)
                    out["gene_concordance_factors"] = {
                        f"{a}|{b}": round(float(v), 4) for (a, b), v in gcf.items()
                    }
                except Exception as exc:
                    out["gene_concordance_factors_error"] = str(exc)
                try:
                    out["rf_distance"] = float(gts.rf_distance(ref, normalize=True))
                except Exception as exc:
                    out["rf_distance_error"] = str(exc)
            except Exception as exc:
                out["reference_error"] = str(exc)

        return out
    except Exception as exc:
        return {"phynetpy_available": True, "error": str(exc)}


def _jsonify(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {str(k): _jsonify(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [_jsonify(v) for v in obj]
    if isinstance(obj, (int, float, str, bool)) or obj is None:
        return obj
    return str(obj)


def summarise_file(text: str, *, path: str | None = None, abs_path: str | None = None,
                   reference_abs: str | None = None, threshold: float = 0.5) -> dict:
    try:
        networks = parse_networks_from_text(text)
    except NewickError as exc:
        raise ValueError(f"Parse error: {exc}") from exc
    if not networks:
        raise ValueError("No parseable network/tree found in file")

    summary = summarise_networks(networks)
    summary["path"] = path
    if abs_path:
        summary["phynetpy"] = summarise_with_phynetpy(
            abs_path, reference_path=reference_abs, threshold=threshold
        )
    return summary
