"""Filesystem-backed storage for BioStore.

All files live under ``config.DATA_ROOT``. Paths coming from the API are
*relative* to that root and are sanitised so a caller can never escape the
data root (no ``..`` traversal, no absolute paths).
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from config import DATA_ROOT, NETWORK_EXTENSIONS, ALIGNMENT_EXTENSIONS


class StorageError(Exception):
    """Raised for invalid paths or illegal operations."""


def _safe_join(rel_path: str | None) -> Path:
    """Resolve ``rel_path`` under DATA_ROOT, rejecting any escape attempts."""
    rel = (rel_path or "").strip().lstrip("/\\")
    # Normalise separators to posix so behaviour is identical on all OSes.
    pure = PurePosixPath(rel.replace("\\", "/"))
    if any(part == ".." for part in pure.parts):
        raise StorageError(f"Illegal path (traversal): {rel_path!r}")
    target = (DATA_ROOT / Path(*pure.parts)).resolve()
    root = DATA_ROOT.resolve()
    if target != root and root not in target.parents:
        raise StorageError(f"Path escapes data root: {rel_path!r}")
    return target


def rel_of(path: Path) -> str:
    """Return the DATA_ROOT-relative posix path for ``path``."""
    return path.resolve().relative_to(DATA_ROOT.resolve()).as_posix()


def _kind_for(path: Path) -> str:
    if path.is_dir():
        return "dir"
    ext = path.suffix.lower()
    if ext in NETWORK_EXTENSIONS:
        return "network"
    if ext in ALIGNMENT_EXTENSIONS:
        return "alignment"
    return "file"


@dataclass
class Node:
    name: str
    path: str  # relative posix path
    kind: str  # dir | network | alignment | file
    size: int | None = None
    modified: str | None = None
    children: list | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        if self.children is None:
            d.pop("children")
        return d


def _stat_node(path: Path) -> Node:
    st = path.stat()
    return Node(
        name=path.name,
        path=rel_of(path),
        kind=_kind_for(path),
        size=None if path.is_dir() else st.st_size,
        modified=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
    )


def list_tree(rel_path: str | None = None, depth: int = -1) -> Node:
    """Return a (possibly recursive) tree rooted at ``rel_path``.

    ``depth`` of -1 means fully recursive; 0 means only the node itself,
    1 means immediate children, etc.
    """
    base = _safe_join(rel_path)
    if not base.exists():
        raise StorageError(f"Not found: {rel_path!r}")

    def build(path: Path, remaining: int) -> Node:
        node = _stat_node(path)
        if path.is_dir():
            node.children = []
            if remaining != 0:
                entries = sorted(
                    path.iterdir(),
                    key=lambda p: (not p.is_dir(), p.name.lower()),
                )
                for entry in entries:
                    if entry.name.startswith(".biostore"):
                        continue
                    node.children.append(build(entry, remaining - 1))
        return node

    return build(base, depth)


def abs_path(rel_path: str) -> Path:
    """Return the absolute filesystem path for a data-root-relative path."""
    return _safe_join(rel_path)


def read_text(rel_path: str) -> str:
    path = _safe_join(rel_path)
    if not path.is_file():
        raise StorageError(f"Not a file: {rel_path!r}")
    return path.read_text(encoding="utf-8", errors="replace")


def read_bytes(rel_path: str) -> tuple[Path, str]:
    path = _safe_join(rel_path)
    if not path.is_file():
        raise StorageError(f"Not a file: {rel_path!r}")
    return path, path.name


def write_text(rel_path: str, content: str) -> Node:
    path = _safe_join(rel_path)
    if path.is_dir():
        raise StorageError(f"Is a directory: {rel_path!r}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return _stat_node(path)


def save_upload(rel_dir: str, rel_name: str, file_storage) -> Node:
    """Persist a Werkzeug FileStorage into ``rel_dir``/``rel_name``.

    ``rel_name`` may contain subdirectories (posix-style) so that dropping a
    whole folder preserves its nested structure. Every component is validated
    through ``_safe_join`` so traversal is impossible.
    """
    parts = [
        p for p in rel_name.replace("\\", "/").split("/")
        if p not in ("", ".", "..")
    ]
    if not parts:
        raise StorageError("Empty filename")
    base = rel_dir.strip("/") if rel_dir else ""
    combined = "/".join([base] + parts) if base else "/".join(parts)
    target = _safe_join(combined)
    target.parent.mkdir(parents=True, exist_ok=True)
    file_storage.save(str(target))
    return _stat_node(target)


def create_file(rel_path: str, content: str = "") -> Node:
    """Create a brand-new (empty by default) file, erroring if it exists."""
    path = _safe_join(rel_path)
    if path.exists():
        raise StorageError(f"Already exists: {rel_path!r}")
    if not path.name:
        raise StorageError("Empty filename")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return _stat_node(path)


def make_dir(rel_path: str) -> Node:
    path = _safe_join(rel_path)
    if path.exists():
        raise StorageError(f"Already exists: {rel_path!r}")
    path.mkdir(parents=True)
    return _stat_node(path)


def delete(rel_path: str) -> None:
    path = _safe_join(rel_path)
    if path == DATA_ROOT.resolve():
        raise StorageError("Refusing to delete the data root")
    if not path.exists():
        raise StorageError(f"Not found: {rel_path!r}")
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def rename(rel_path: str, new_rel_path: str) -> Node:
    src = _safe_join(rel_path)
    dst = _safe_join(new_rel_path)
    if not src.exists():
        raise StorageError(f"Not found: {rel_path!r}")
    if dst.exists():
        raise StorageError(f"Target exists: {new_rel_path!r}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return _stat_node(dst)


def search(query: str, in_content: bool = False, limit: int = 200) -> list[dict]:
    """Search filenames (and optionally file contents) under the data root."""
    query_l = query.lower()
    results: list[dict] = []
    for path in DATA_ROOT.rglob("*"):
        if path.name.startswith(".biostore"):
            continue
        if len(results) >= limit:
            break
        rel = rel_of(path)
        name_hit = query_l in path.name.lower()
        content_hits: list[dict] = []
        if in_content and path.is_file():
            try:
                if path.stat().st_size <= 5 * 1024 * 1024:
                    for i, line in enumerate(
                        path.read_text(encoding="utf-8", errors="ignore").splitlines(),
                        start=1,
                    ):
                        if query_l in line.lower():
                            content_hits.append({"line": i, "text": line.strip()[:300]})
                            if len(content_hits) >= 5:
                                break
            except OSError:
                pass
        if name_hit or content_hits:
            results.append(
                {
                    "name": path.name,
                    "path": rel,
                    "kind": _kind_for(path),
                    "name_match": name_hit,
                    "content_matches": content_hits,
                }
            )
    return results


def stats() -> dict:
    """Aggregate counts for the dashboard."""
    total_files = 0
    total_dirs = 0
    total_bytes = 0
    by_kind: dict[str, int] = {}
    for path in DATA_ROOT.rglob("*"):
        if path.name.startswith(".biostore"):
            continue
        if path.is_dir():
            total_dirs += 1
        else:
            total_files += 1
            try:
                total_bytes += path.stat().st_size
            except OSError:
                pass
            kind = _kind_for(path)
            by_kind[kind] = by_kind.get(kind, 0) + 1
    return {
        "files": total_files,
        "dirs": total_dirs,
        "bytes": total_bytes,
        "by_kind": by_kind,
        "data_root": str(DATA_ROOT),
    }
