"""HTTP client for a BioStore server.

Only depends on the Python standard library so it can be dropped into any
PhyNetPy environment without extra installs.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = os.environ.get("BIOSTORE_URL", "http://127.0.0.1:8765")
DEFAULT_CACHE = Path(
    os.environ.get("BIOSTORE_CACHE", Path.home() / ".phynetpy_datastore_cache")
)
DEFAULT_PASSWORD = os.environ.get("BIOSTORE_PASSWORD")
DEFAULT_DISPLAY_NAME = os.environ.get("BIOSTORE_DISPLAY_NAME", "phynetpy-client")


class BioStoreError(Exception):
    pass


class BioStore:
    """A tiny client for the BioStore data hub."""

    def __init__(
        self,
        base_url: str = DEFAULT_URL,
        cache_dir: str | os.PathLike | None = None,
        *,
        password: str | None = DEFAULT_PASSWORD,
        display_name: str = DEFAULT_DISPLAY_NAME,
        token: str | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._password = password if password is not None else ""
        self._display_name = display_name
        self._token = token

    # ------------------------------------------------------------------ #
    # auth
    # ------------------------------------------------------------------ #
    def login(self, password: str | None = None, display_name: str | None = None) -> str:
        """Authenticate and store a session token. Returns the token."""
        body = {
            "password": self._password if password is None else password,
            "display_name": self._display_name if display_name is None else display_name,
        }
        data = self._request_json("POST", "/api/auth/login", body=body, auth=False)
        self._token = data["token"]
        self._display_name = data.get("display_name", self._display_name)
        return self._token

    def ensure_auth(self) -> None:
        """Login if we do not yet have a token."""
        if not self._token:
            self.login()

    # ------------------------------------------------------------------ #
    # low-level helpers
    # ------------------------------------------------------------------ #
    def _url(self, endpoint: str, **params) -> str:
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        return f"{self.base_url}{endpoint}" + (f"?{query}" if query else "")

    def _request_json(
        self,
        method: str,
        endpoint: str,
        *,
        params: dict | None = None,
        body: dict | None = None,
        auth: bool = True,
    ):
        if auth:
            self.ensure_auth()
        url = self._url(endpoint, **(params or {}))
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if auth and self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8"))
                detail = payload.get("error", "")
                if payload.get("locked_by"):
                    detail = f"{detail} (locked by {payload['locked_by']})"
            except Exception:
                detail = exc.reason
            raise BioStoreError(f"{exc.code}: {detail}") from None
        except urllib.error.URLError as exc:
            raise BioStoreError(
                f"Cannot reach BioStore at {self.base_url} ({exc.reason}). "
                "Is the server running (py backend/app.py)?"
            ) from None

    def _get_json(self, endpoint: str, **params):
        return self._request_json("GET", endpoint, params=params)

    def _get_bytes(self, endpoint: str, **params) -> bytes:
        self.ensure_auth()
        url = self._url(endpoint, **params)
        headers = {}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8"))
                detail = payload.get("error", "")
                if payload.get("locked_by"):
                    detail = f"{detail} (locked by {payload['locked_by']})"
            except Exception:
                detail = exc.reason
            raise BioStoreError(f"{exc.code}: {detail}") from None
        except urllib.error.URLError as exc:
            raise BioStoreError(
                f"Cannot reach BioStore at {self.base_url} ({exc.reason}). "
                "Is the server running (py backend/app.py)?"
            ) from None

    # ------------------------------------------------------------------ #
    # public API
    # ------------------------------------------------------------------ #
    def list(self, path: str = "", depth: int = 1) -> dict:
        """Return the (nested) file tree at ``path``."""
        return self._get_json("/api/tree", path=path, depth=depth)

    def read_text(self, rel_path: str) -> str:
        """Return the text content of a stored file."""
        data = self._get_json("/api/file", path=rel_path)
        return data["content"]

    def read_bytes(self, rel_path: str) -> bytes:
        return self._get_bytes("/api/file", path=rel_path, raw=1)

    def fetch(self, rel_path: str, refresh: bool = False) -> Path:
        """Download ``rel_path`` to the local cache and return its Path.

        The cache mirrors the store's directory layout so relative includes
        (e.g. a nexus that references a fasta) stay intact.

        Raises ``BioStoreError`` with HTTP 423 if another user has the file open.
        """
        local = self.cache_dir / rel_path
        if local.exists() and not refresh:
            return local
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(self.read_bytes(rel_path))
        return local

    def network(self, rel_path: str) -> list[dict]:
        """Return parsed network graph(s) for a newick/nexus file."""
        return self._get_json("/api/network", path=rel_path)["networks"]

    def alignment(self, rel_path: str) -> dict:
        """Return the parsed alignment (taxa, sequences, stats)."""
        return self._get_json("/api/alignment", path=rel_path)

    def search(self, query: str, content: bool = False) -> list[dict]:
        return self._get_json("/api/search", q=query, content=1 if content else 0)["results"]

    def newick_strings(self, rel_path: str) -> list[str]:
        """Convenience: raw newick/eNewick strings from a file, ready to feed
        into a PhyNetPy reader."""
        text = self.read_text(rel_path)
        return [chunk.strip() + ";" for chunk in text.split(";") if chunk.strip() and "(" in chunk]
