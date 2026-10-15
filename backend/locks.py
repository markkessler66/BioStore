"""Exclusive per-file locks with lease expiry and heartbeats."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone

from config import LOCK_LEASE_SECONDS
from db import get_db


class LockError(Exception):
    """Raised when a lock cannot be acquired or access is denied."""

    def __init__(
        self,
        message: str,
        *,
        status: int = 423,
        locked_by: str | None = None,
        expires_at: str | None = None,
        path: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.locked_by = locked_by
        self.expires_at = expires_at
        self.path = path

    def to_dict(self) -> dict:
        d = {"error": str(self)}
        if self.locked_by is not None:
            d["locked_by"] = self.locked_by
        if self.expires_at is not None:
            d["expires_at"] = self.expires_at
        if self.path is not None:
            d["path"] = self.path
        return d


@dataclass
class LockInfo:
    path: str
    holder_token: str
    display_name: str
    acquired_at: str
    expires_at: str

    def to_dict(self, *, include_token: bool = False) -> dict:
        d = asdict(self)
        if not include_token:
            d.pop("holder_token", None)
        return d


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def _normalize_path(path: str) -> str:
    return (path or "").strip().replace("\\", "/").lstrip("/")


def purge_expired() -> int:
    """Delete expired locks. Returns number removed."""
    conn = get_db()
    cur = conn.execute(
        "DELETE FROM locks WHERE expires_at <= ?",
        (_iso(_now()),),
    )
    conn.commit()
    return cur.rowcount


def _row_to_lock(row) -> LockInfo:
    return LockInfo(
        path=row["path"],
        holder_token=row["holder_token"],
        display_name=row["display_name"],
        acquired_at=row["acquired_at"],
        expires_at=row["expires_at"],
    )


def get_lock(path: str) -> LockInfo | None:
    purge_expired()
    path = _normalize_path(path)
    if not path:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT path, holder_token, display_name, acquired_at, expires_at "
        "FROM locks WHERE path = ?",
        (path,),
    ).fetchone()
    return _row_to_lock(row) if row else None


def list_locks() -> list[LockInfo]:
    purge_expired()
    conn = get_db()
    rows = conn.execute(
        "SELECT path, holder_token, display_name, acquired_at, expires_at "
        "FROM locks ORDER BY path"
    ).fetchall()
    return [_row_to_lock(r) for r in rows]


def locks_map() -> dict[str, dict]:
    """path -> {display_name, expires_at} for tree annotation."""
    return {
        lk.path: {"locked_by": lk.display_name, "expires_at": lk.expires_at}
        for lk in list_locks()
    }


def acquire(path: str, token: str, display_name: str) -> LockInfo:
    """Acquire an exclusive lock on ``path`` for the given session."""
    path = _normalize_path(path)
    if not path:
        raise LockError("Missing path", status=400)

    purge_expired()
    now = _now()
    expires = now + timedelta(seconds=LOCK_LEASE_SECONDS)
    conn = get_db()

    existing = conn.execute(
        "SELECT path, holder_token, display_name, acquired_at, expires_at "
        "FROM locks WHERE path = ?",
        (path,),
    ).fetchone()

    if existing:
        if existing["holder_token"] == token:
            # Refresh lease for the same holder (re-open / re-acquire).
            conn.execute(
                "UPDATE locks SET expires_at = ?, display_name = ? WHERE path = ?",
                (_iso(expires), display_name, path),
            )
            conn.commit()
            return LockInfo(
                path=path,
                holder_token=token,
                display_name=display_name,
                acquired_at=existing["acquired_at"],
                expires_at=_iso(expires),
            )
        raise LockError(
            f"File is locked by {existing['display_name']}",
            locked_by=existing["display_name"],
            expires_at=existing["expires_at"],
            path=path,
        )

    acquired = _iso(now)
    expires_s = _iso(expires)
    conn.execute(
        "INSERT INTO locks (path, holder_token, display_name, acquired_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (path, token, display_name, acquired, expires_s),
    )
    conn.commit()
    return LockInfo(
        path=path,
        holder_token=token,
        display_name=display_name,
        acquired_at=acquired,
        expires_at=expires_s,
    )


def release(path: str, token: str) -> bool:
    """Release a lock if held by ``token``. Returns True if a row was deleted."""
    path = _normalize_path(path)
    if not path:
        return False
    conn = get_db()
    cur = conn.execute(
        "DELETE FROM locks WHERE path = ? AND holder_token = ?",
        (path, token),
    )
    conn.commit()
    return cur.rowcount > 0


def release_all_for(token: str) -> int:
    conn = get_db()
    cur = conn.execute("DELETE FROM locks WHERE holder_token = ?", (token,))
    conn.commit()
    return cur.rowcount


def heartbeat(paths: list[str], token: str) -> list[LockInfo]:
    """Extend the lease on locks held by ``token`` for the given paths."""
    purge_expired()
    now = _now()
    expires = _iso(now + timedelta(seconds=LOCK_LEASE_SECONDS))
    conn = get_db()
    refreshed: list[LockInfo] = []
    for raw in paths or []:
        path = _normalize_path(raw)
        if not path:
            continue
        row = conn.execute(
            "SELECT path, holder_token, display_name, acquired_at, expires_at "
            "FROM locks WHERE path = ? AND holder_token = ?",
            (path, token),
        ).fetchone()
        if not row:
            continue
        conn.execute(
            "UPDATE locks SET expires_at = ? WHERE path = ? AND holder_token = ?",
            (expires, path, token),
        )
        refreshed.append(
            LockInfo(
                path=path,
                holder_token=token,
                display_name=row["display_name"],
                acquired_at=row["acquired_at"],
                expires_at=expires,
            )
        )
    conn.commit()
    return refreshed


def assert_can_access(path: str, token: str) -> None:
    """Raise LockError if ``path`` is locked by someone other than ``token``.

    The lock holder may read and write. Everyone else is blocked.
    Unlocked files are accessible to any authenticated user.
    """
    path = _normalize_path(path)
    if not path:
        return
    lock = get_lock(path)
    if lock is None:
        return
    if lock.holder_token == token:
        return
    raise LockError(
        f"File is locked by {lock.display_name}",
        locked_by=lock.display_name,
        expires_at=lock.expires_at,
        path=path,
    )


def assert_can_mutate_tree(path: str, token: str) -> None:
    """Block delete/rename when ``path`` or any descendant is locked by another user."""
    path = _normalize_path(path)
    assert_can_access(path, token)
    purge_expired()
    conn = get_db()
    if path:
        rows = conn.execute(
            "SELECT path, holder_token, display_name, expires_at FROM locks "
            "WHERE path = ? OR path LIKE ?",
            (path, path + "/%"),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT path, holder_token, display_name, expires_at FROM locks"
        ).fetchall()
    for row in rows:
        if row["holder_token"] != token:
            raise LockError(
                f"Cannot modify: {row['path']} is locked by {row['display_name']}",
                locked_by=row["display_name"],
                expires_at=row["expires_at"],
                path=row["path"],
            )


def annotate_tree(node: dict, lock_info: dict[str, dict] | None = None) -> dict:
    """Attach ``locked_by`` / ``expires_at`` onto file nodes in a tree dict."""
    if lock_info is None:
        lock_info = locks_map()
    info = lock_info.get(node.get("path", ""))
    if info and node.get("kind") != "dir":
        node["locked_by"] = info["locked_by"]
        node["expires_at"] = info["expires_at"]
    for child in node.get("children") or []:
        annotate_tree(child, lock_info)
    return node
