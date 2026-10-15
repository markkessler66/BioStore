"""Multiple-sequence-alignment parsing, statistics and conversion.

Supports FASTA, relaxed PHYLIP and NEXUS (DATA / CHARACTERS blocks). The goal
is not to be a full bioinformatics stack but to give the frontend a clean,
editable representation:

    {
        "format": "fasta" | "phylip" | "nexus",
        "taxa": ["A", "B", ...],
        "sequences": {"A": "ACGT-", ...},
        "ntax": int,
        "nchar": int,
        "datatype": "dna" | "rna" | "protein" | "unknown",
        # networks embedded in a NEXUS TREES block are surfaced separately.
    }
"""

from __future__ import annotations

import re
from collections import Counter


class AlignmentError(Exception):
    pass


_DNA = set("ACGTUN-?.RYSWKMBDHVacgtun")
_PROTEIN = set("ACDEFGHIKLMNPQRSTVWYXBZ*-.")


def _guess_datatype(sequences: dict[str, str]) -> str:
    counts: Counter[str] = Counter()
    for seq in sequences.values():
        counts.update(seq.upper())
    total = sum(v for k, v in counts.items() if k not in "-?.N")
    if total == 0:
        return "unknown"
    acgt = sum(counts.get(c, 0) for c in "ACGT")
    acgu = sum(counts.get(c, 0) for c in "ACGU")
    if acgt / total > 0.9:
        return "dna"
    if acgu / total > 0.9:
        return "rna"
    return "protein"


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def parse_fasta(text: str) -> dict[str, str]:
    sequences: dict[str, str] = {}
    name = None
    buf: list[str] = []
    for line in text.splitlines():
        if line.startswith(">"):
            if name is not None:
                sequences[name] = "".join(buf)
            name = line[1:].strip().split()[0] if line[1:].strip() else line[1:].strip()
            buf = []
        elif name is not None:
            buf.append(line.strip())
    if name is not None:
        sequences[name] = "".join(buf)
    return sequences


def parse_phylip(text: str) -> dict[str, str]:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return {}
    header = lines[0].split()
    sequences: dict[str, str] = {}
    if len(header) >= 2 and header[0].isdigit() and header[1].isdigit():
        body = lines[1:]
    else:
        body = lines
    for line in body:
        parts = line.split(None, 1)
        if not parts:
            continue
        name = parts[0]
        seq = parts[1].replace(" ", "") if len(parts) > 1 else ""
        sequences[name] = sequences.get(name, "") + seq
    return sequences


def _parse_nexus_matrix(block: str) -> dict[str, str]:
    """Parse the MATRIX region of a NEXUS DATA/CHARACTERS block."""
    m = re.search(r"MATRIX(.*?);", block, re.IGNORECASE | re.DOTALL)
    if not m:
        return {}
    matrix = m.group(1)
    sequences: dict[str, str] = {}
    for line in matrix.splitlines():
        line = line.strip()
        if not line or line.startswith("["):
            continue
        # token may be quoted "'Homo sapiens' ACGT"
        qm = re.match(r"'([^']+)'\s+(.*)", line)
        if qm:
            name, seq = qm.group(1), qm.group(2)
        else:
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            name, seq = parts[0], parts[1]
        seq = re.sub(r"\s+", "", seq)
        sequences[name] = sequences.get(name, "") + seq
    return sequences


def parse_alignment(text: str, filename: str = "") -> dict:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    stripped = text.lstrip()

    fmt = None
    sequences: dict[str, str] = {}

    if stripped.upper().startswith("#NEXUS") or ext in ("nex", "nexus"):
        fmt = "nexus"
        sequences = _parse_nexus_matrix(text)
    elif stripped.startswith(">") or ext in ("fasta", "fa", "fna", "aln"):
        fmt = "fasta"
        sequences = parse_fasta(text)
    elif ext in ("phy", "phylip"):
        fmt = "phylip"
        sequences = parse_phylip(text)
    else:
        # Heuristic fallback.
        if stripped.startswith(">"):
            fmt, sequences = "fasta", parse_fasta(text)
        elif "MATRIX" in text.upper():
            fmt, sequences = "nexus", _parse_nexus_matrix(text)
        else:
            fmt, sequences = "phylip", parse_phylip(text)

    taxa = list(sequences.keys())
    nchar = max((len(s) for s in sequences.values()), default=0)
    return {
        "format": fmt,
        "taxa": taxa,
        "sequences": sequences,
        "ntax": len(taxa),
        "nchar": nchar,
        "datatype": _guess_datatype(sequences),
    }


# --------------------------------------------------------------------------- #
# Statistics
# --------------------------------------------------------------------------- #
def alignment_stats(parsed: dict) -> dict:
    sequences: dict[str, str] = parsed["sequences"]
    if not sequences:
        return {"per_taxon": [], "columns": {}, "composition": {}}

    nchar = parsed["nchar"]
    gap_chars = set("-?.")

    per_taxon = []
    composition: Counter[str] = Counter()
    for name, seq in sequences.items():
        upper = seq.upper()
        gaps = sum(1 for c in seq if c in gap_chars)
        composition.update(c for c in upper if c not in gap_chars)
        per_taxon.append(
            {
                "taxon": name,
                "length": len(seq),
                "gaps": gaps,
                "gap_fraction": round(gaps / len(seq), 4) if seq else 0.0,
            }
        )

    # Column-wise conservation / variability.
    identical_cols = 0
    variable_cols = 0
    gap_cols = 0
    padded = {n: s.ljust(nchar, "-") for n, s in sequences.items()}
    for col in range(nchar):
        col_chars = [padded[n][col].upper() for n in sequences]
        non_gap = [c for c in col_chars if c not in gap_chars]
        if not non_gap:
            gap_cols += 1
            continue
        if len(set(non_gap)) == 1 and len(non_gap) == len(col_chars):
            identical_cols += 1
        else:
            variable_cols += 1

    total_residues = sum(composition.values())
    comp_pct = {
        c: round(100 * n / total_residues, 2) for c, n in composition.most_common()
    } if total_residues else {}

    return {
        "per_taxon": per_taxon,
        "columns": {
            "total": nchar,
            "conserved": identical_cols,
            "variable": variable_cols,
            "all_gap": gap_cols,
        },
        "composition": comp_pct,
        "mean_gap_fraction": round(
            sum(t["gap_fraction"] for t in per_taxon) / len(per_taxon), 4
        ),
    }


# --------------------------------------------------------------------------- #
# Conversion / serialisation
# --------------------------------------------------------------------------- #
def to_fasta(sequences: dict[str, str], width: int = 0) -> str:
    out = []
    for name, seq in sequences.items():
        out.append(f">{name}")
        if width and width > 0:
            for i in range(0, len(seq), width):
                out.append(seq[i : i + width])
        else:
            out.append(seq)
    return "\n".join(out) + "\n"


def to_phylip(sequences: dict[str, str]) -> str:
    ntax = len(sequences)
    nchar = max((len(s) for s in sequences.values()), default=0)
    out = [f" {ntax} {nchar}"]
    for name, seq in sequences.items():
        out.append(f"{name}  {seq.ljust(nchar, '-')}")
    return "\n".join(out) + "\n"


def to_nexus(sequences: dict[str, str], datatype: str = "dna") -> str:
    ntax = len(sequences)
    nchar = max((len(s) for s in sequences.values()), default=0)
    lines = [
        "#NEXUS",
        "",
        "BEGIN DATA;",
        f"    DIMENSIONS NTAX={ntax} NCHAR={nchar};",
        f"    FORMAT DATATYPE={datatype.upper()} MISSING=? GAP=-;",
        "    MATRIX",
    ]
    pad = max((len(n) for n in sequences), default=0) + 2
    for name, seq in sequences.items():
        lines.append(f"    {name.ljust(pad)}{seq.ljust(nchar, '-')}")
    lines += ["    ;", "END;", ""]
    return "\n".join(lines)


def serialise(sequences: dict[str, str], fmt: str, datatype: str = "dna") -> str:
    fmt = fmt.lower()
    if fmt in ("fasta", "fa", "fna"):
        return to_fasta(sequences)
    if fmt in ("phylip", "phy"):
        return to_phylip(sequences)
    if fmt in ("nexus", "nex"):
        return to_nexus(sequences, datatype)
    raise AlignmentError(f"Unknown output format: {fmt!r}")
