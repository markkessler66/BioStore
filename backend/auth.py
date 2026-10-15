"""Light shared-password authentication with display-name sessions."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from config import PASSWORD, SESSION_TTL_SECONDS
from db import get_db


class AuthError(Exception):
    """Raised for authentication / authorization failures."""

    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


@dataclass
class Session:
    token: str
    display_name: str
    created_at: str
    expires_at: str


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def auth_required() -> bool:
    """True when a shared password is configured."""
    return bool(PASSWORD)


def login(password: str | None, display_name: str) -> Session:
    """Validate credentials and create a session.

    When ``BIOSTORE_PASSWORD`` is unset, any password (including empty) is
    accepted so solo / localhost use still gets a display name for locks.
    """
    name = (display_name or "").strip()
    if not name:
        raise AuthError("Display name is required", 400)
    if len(name) > 64:
        raise AuthError("Display name is too long (max 64 characters)", 400)

    if PASSWORD is not None:
        if (password or "") != PASSWORD:
            raise AuthError("Invalid password", 401)

    token = secrets.token_urlsafe(32)
    now = _now()
    expires = now + timedelta(seconds=SESSION_TTL_SECONDS)
    session = Session(
        token=token,
        display_name=name,
        created_at=_iso(now),
        expires_at=_iso(expires),
    )
    conn = get_db()
    conn.execute(
        "INSERT INTO sessions (token, display_name, created_at, expires_at) "
        "VALUES (?, ?, ?, ?)",
        (session.token, session.display_name, session.created_at, session.expires_at),
    )
    conn.commit()
    return session


def logout(token: str | None) -> None:
    if not token:
        return
    conn = get_db()
    # Locks cascade via FK, but release explicitly for clarity.
    conn.execute("DELETE FROM locks WHERE holder_token = ?", (token,))
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()


def get_session(token: str | None) -> Session | None:
    if not token:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT token, display_name, created_at, expires_at FROM sessions WHERE token = ?",
        (token,),
    ).fetchone()
    if not row:
        return None
    if _parse(row["expires_at"]) <= _now():
        conn.execute("DELETE FROM locks WHERE holder_token = ?", (token,))
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        return None
    return Session(
        token=row["token"],
        display_name=row["display_name"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
    )


def require_session(token: str | None) -> Session:
    session = get_session(token)
    if not session:
        raise AuthError("Authentication required", 401)
    return session


def parse_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None
