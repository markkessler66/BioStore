"""Extended-Newick (eNewick) parser for phylogenetic networks.

Handles ordinary Newick trees as well as the extended notation used by
PhyloNet / PhyNetPy for reticulate (hybrid) networks, e.g.::

    ((A:1,(B:1)#H1:1::0.7):1,(#H1:1::0.3,C:1):1);

A hybrid node is written once with a full subtree and once (or more) as a
"pointer" ``#H1`` with no subtree. Both occurrences refer to the *same* node,
which therefore has more than one parent (a reticulation).

The parser returns a plain-dict graph::

    {
        "nodes": [{"id", "label", "is_leaf", "is_hybrid", "hybrid_label"}...],
        "edges": [{"source", "target", "length", "gamma", "is_hybrid_edge"}...],
        "root": <node id>,
        "leaf_count": int,
        "reticulation_count": int,
    }

that the frontend lays out with D3.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


class NewickError(Exception):
    pass


@dataclass
class _RawNode:
    node_id: int
    label: str = ""
    hybrid_label: str | None = None  # e.g. "H1" (without the '#')
    children: list = field(default_factory=list)  # list[(child_RawNode, edge_meta)]
    is_hybrid: bool = False


_HYBRID_RE = re.compile(r"#(?:(LGT|H|R)?)(\w+)?$")


def _split_label(token: str) -> tuple[str, str | None]:
    """Split a node token into (label, hybrid_label).

    ``token`` is the part before the ``:`` branch data. A hybrid marker looks
    like ``name#H1`` or just ``#H1``. Returns ("name", "H1") or (token, None).
    """
    if "#" not in token:
        return token, None
    name, _, hyb = token.partition("#")
    hyb = hyb.strip()
    return name.strip(), (hyb if hyb else None)


class _Parser:
    def __init__(self, text: str):
        # Strip comments in square brackets (NEXUS-style), keep the string.
        self.text = re.sub(r"\[[^\]]*\]", "", text).strip()
        if self.text.endswith(";"):
            self.text = self.text[:-1]
        self.pos = 0
        self.n = len(self.text)
        self._id = 0
        # Map hybrid label -> the canonical _RawNode carrying its subtree.
        self.hybrids: dict[str, _RawNode] = {}

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _peek(self) -> str:
        return self.text[self.pos] if self.pos < self.n else ""

    def parse(self) -> _RawNode:
        if not self.text:
            raise NewickError("Empty newick string")
        node = self._parse_subtree()
        return node

    def _parse_subtree(self) -> _RawNode:
        node = _RawNode(node_id=self._next_id())
        if self._peek() == "(":
            self.pos += 1  # consume '('
            while True:
                child, meta = self._parse_child()
                node.children.append((child, meta))
                if self._peek() == ",":
                    self.pos += 1
                    continue
                if self._peek() == ")":
                    self.pos += 1
                    break
                raise NewickError(
                    f"Expected ',' or ')' at position {self.pos}: "
                    f"{self.text[self.pos:self.pos+20]!r}"
                )
        # Parse this node's own label + branch data.
        self._read_node_data(node)
        return node

    def _parse_child(self) -> tuple[_RawNode, dict]:
        child = self._parse_subtree()
        # Branch metadata for the edge parent->child lives on the child token.
        meta = child.__dict__.pop("_edge_meta", {})  # set by _read_node_data
        return child, meta

    def _read_node_data(self, node: _RawNode) -> None:
        # Read the label token (up to : , ) or end).
        start = self.pos
        while self.pos < self.n and self.text[self.pos] not in ":,()":
            self.pos += 1
        raw_label = self.text[start:self.pos].strip().strip("'\"")

        # Branch data: :length:support:gamma  (any may be blank).
        length = support = gamma = None
        if self._peek() == ":":
            fields: list[str] = []
            while self._peek() == ":":
                self.pos += 1
                fstart = self.pos
                while self.pos < self.n and self.text[self.pos] not in ":,()":
                    self.pos += 1
                fields.append(self.text[fstart:self.pos].strip())
            length = _to_float(fields[0]) if len(fields) > 0 else None
            support = _to_float(fields[1]) if len(fields) > 1 else None
            gamma = _to_float(fields[2]) if len(fields) > 2 else None

        label, hybrid_label = _split_label(raw_label)
        node.label = label
        node._edge_meta = {"length": length, "support": support, "gamma": gamma}

        if hybrid_label is not None:
            node.is_hybrid = True
            node.hybrid_label = hybrid_label
            canonical = self.hybrids.get(hybrid_label)
            if canonical is None:
                self.hybrids[hybrid_label] = node
            else:
                # This is a pointer occurrence. If it carries a subtree and the
                # canonical one does not, promote it.
                if node.children and not canonical.children:
                    canonical.children = node.children
                    canonical.label = node.label or canonical.label


def _to_float(s: str) -> float | None:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_network(text: str) -> dict:
    """Parse a single eNewick string into a graph dict."""
    parser = _Parser(text)
    root = parser.parse()

    nodes: dict[int, dict] = {}
    edges: list[dict] = []
    # Track which canonical node id each hybrid label maps to.
    hybrid_ids: dict[str, int] = {}
    leaf_count = 0

    def canonical_for(raw: _RawNode) -> _RawNode:
        if raw.hybrid_label and raw.hybrid_label in parser.hybrids:
            return parser.hybrids[raw.hybrid_label]
        return raw

    visited_edges: set[tuple[int, int]] = set()
    walked: set[int] = set()

    def register(raw: _RawNode) -> int:
        canon = canonical_for(raw)
        nid = canon.node_id
        if canon.hybrid_label:
            if canon.hybrid_label in hybrid_ids:
                nid = hybrid_ids[canon.hybrid_label]
            else:
                hybrid_ids[canon.hybrid_label] = nid
        if nid not in nodes:
            is_leaf = len(canon.children) == 0
            nodes[nid] = {
                "id": nid,
                "label": canon.label,
                "is_leaf": is_leaf,
                "is_hybrid": bool(canon.hybrid_label),
                "hybrid_label": canon.hybrid_label,
            }
        return nid

    def walk(raw: _RawNode) -> None:
        canon = canonical_for(raw)
        parent_id = register(canon)
        if parent_id in walked:
            return
        walked.add(parent_id)
        for child, meta in canon.children:
            child_id = register(child)
            key = (parent_id, child_id)
            if key in visited_edges:
                continue
            visited_edges.add(key)
            edges.append(
                {
                    "source": parent_id,
                    "target": child_id,
                    "length": meta.get("length"),
                    "gamma": meta.get("gamma"),
                    "support": meta.get("support"),
                    "is_hybrid_edge": nodes[child_id]["is_hybrid"],
                }
            )
        # Only recurse into the canonical subtree once.
        for child, _ in canon.children:
            walk(child)

    walk(root)

    for node in nodes.values():
        if node["is_leaf"]:
            leaf_count += 1

    root_id = register(canonical_for(root))
    reticulation_count = len(hybrid_ids)

    return {
        "nodes": list(nodes.values()),
        "edges": edges,
        "root": root_id,
        "leaf_count": leaf_count,
        "reticulation_count": reticulation_count,
    }


def parse_networks_from_text(text: str) -> list[dict]:
    """Parse one or more networks from a blob.

    Splits on ';' terminators and also handles NEXUS ``TREES`` blocks where
    lines look like ``TREE name = (...);`` or ``NETWORK name = (...);``.
    """
    networks: list[dict] = []
    # Pull out NEXUS tree/network assignments if present.
    assignment_re = re.compile(
        r"(?:TREE|NETWORK)\s+\*?\s*([\w.\-]+)\s*=\s*(?:\[[^\]]*\]\s*)?(\(.*?;)",
        re.IGNORECASE | re.DOTALL,
    )
    found_named = False
    for m in assignment_re.finditer(text):
        found_named = True
        name = m.group(1)
        body = m.group(2)
        try:
            graph = parse_network(body)
            graph["name"] = name
            networks.append(graph)
        except NewickError:
            continue

    if not found_named:
        # Fall back: treat every ';'-terminated chunk that starts with '(' as one.
        chunks = [c.strip() for c in text.split(";") if c.strip()]
        for i, chunk in enumerate(chunks):
            if "(" not in chunk:
                continue
            try:
                graph = parse_network(chunk + ";")
                graph["name"] = f"network_{i + 1}"
                networks.append(graph)
            except NewickError:
                continue

    return networks
