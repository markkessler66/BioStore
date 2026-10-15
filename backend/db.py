"""Shared SQLite connection helpers for BioStore metadata (sessions, locks)."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from config import METADATA_DB

_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def get_db() -> sqlite3.Connection:
    """Return a per-thread SQLite connection to the metadata database."""
    global _initialized
    conn = getattr(_local, "conn", None)
    if conn is None:
        METADATA_DB.parent.mkdir(parents=True, exist_ok=True)
        conn = _connect(METADATA_DB)
        _local.conn = conn
    if not _initialized:
        with _init_lock:
            if not _initialized:
                _init_schema(conn)
                _initialized = True
    return conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS locks (
            path TEXT PRIMARY KEY,
            holder_token TEXT NOT NULL,
            display_name TEXT NOT NULL,
            acquired_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (holder_token) REFERENCES sessions(token) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_locks_holder ON locks(holder_token);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS phynetpy_jobs (
            id TEXT PRIMARY KEY,
            owner_name TEXT NOT NULL,
            method TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at REAL NOT NULL,
            started_at REAL,
            finished_at REAL,
            params_json TEXT NOT NULL DEFAULT '{}',
            inputs_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT,
            error TEXT,
            log_json TEXT NOT NULL DEFAULT '[]',
            progress_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_phynetpy_jobs_owner
            ON phynetpy_jobs(owner_name, created_at DESC);
        """
    )
    conn.commit()
