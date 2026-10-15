"""Configuration for the BioStore server.

The data root is where all stored files live. It is intentionally kept
*outside* of any git repository so that large / generated data files do not
clutter version control. Override it with the BIOSTORE_DATA_ROOT env var.
"""

from __future__ import annotations

import os
from pathlib import Path

# Root of the repository (one level above this file's package).
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"


def _resolve_data_root() -> Path:
    env = os.environ.get("BIOSTORE_DATA_ROOT")
    if env:
        root = Path(env).expanduser().resolve()
    else:
        root = (PROJECT_ROOT / "biostore_data").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


DATA_ROOT = _resolve_data_root()

# SQLite metadata db lives beside the data root but in its own file.
METADATA_DB = DATA_ROOT / ".biostore_meta.sqlite3"

# Host / port for the local server.
HOST = os.environ.get("BIOSTORE_HOST", "127.0.0.1")
PORT = int(os.environ.get("BIOSTORE_PORT", "8765"))

# Public URL used in PhyNetPy snippets (defaults to the bind address).
PUBLIC_URL = os.environ.get(
    "BIOSTORE_PUBLIC_URL", f"http://{HOST}:{PORT}"
).rstrip("/")

# Shared lab password. When unset, auth is optional (local solo / dev mode).
PASSWORD = os.environ.get("BIOSTORE_PASSWORD") or None

# Exclusive file-lock lease timings (seconds).
LOCK_LEASE_SECONDS = int(os.environ.get("BIOSTORE_LOCK_LEASE", "60"))
LOCK_HEARTBEAT_SECONDS = int(os.environ.get("BIOSTORE_LOCK_HEARTBEAT", "15"))

# Session lifetime (seconds). Default 7 days.
SESSION_TTL_SECONDS = int(os.environ.get("BIOSTORE_SESSION_TTL", str(7 * 24 * 3600)))

# Files larger than this (bytes) are not sent as text to the browser.
MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024

# Extensions we treat as phylogenetic network / tree files.
NETWORK_EXTENSIONS = {
    ".nwk",
    ".newick",
    ".tree",
    ".trees",
    ".tre",
    ".net",
    ".gt",
}
# Extensions we treat as alignments / sequence data.
ALIGNMENT_EXTENSIONS = {".nex", ".nexus", ".fasta", ".fa", ".fna", ".phy", ".phylip", ".aln"}
