"""BioStore — a local data hub for phylogenetic network development.

Run with::

    py backend/app.py

then open http://127.0.0.1:8765 in a browser. All data lives under
``BIOSTORE_DATA_ROOT`` (defaults to ``./biostore_data``), deliberately kept
outside your PhyNetPy git repo.
"""

from __future__ import annotations

from flask import (
    Flask,
    g,
    jsonify,
    request,
    send_file,
    send_from_directory,
    abort,
)
from werkzeug.exceptions import RequestEntityTooLarge

import auth
import config
import locks
import storage
from parsers.newick import parse_networks_from_text, NewickError
from parsers.alignment import (
    parse_alignment,
    alignment_stats,
    serialise,
    AlignmentError,
)
from parsers.summary import summarise_file
import phynetpy_runner

app = Flask(__name__, static_folder=None)
# Large folder drops (hundreds of MB) should not be rejected by Flask's default.
# Werkzeug 3.1 also caps non-file form memory (500 KB) and part count (1000);
# folder uploads send many file + relpath parts and can exceed both.
_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB
app.config["MAX_CONTENT_LENGTH"] = _MAX_UPLOAD_BYTES
app.config["MAX_FORM_MEMORY_SIZE"] = _MAX_UPLOAD_BYTES
app.config["MAX_FORM_PARTS"] = 20_000

# Paths that do not require a Bearer token.
_AUTH_EXEMPT = {
    "/api/auth/login",
    "/api/auth/status",
}


# --------------------------------------------------------------------------- #
# Error handling
# --------------------------------------------------------------------------- #
@app.errorhandler(storage.StorageError)
def _handle_storage_error(exc):
    return jsonify({"error": str(exc)}), 400


@app.errorhandler(auth.AuthError)
def _handle_auth_error(exc):
    return jsonify({"error": str(exc)}), exc.status


@app.errorhandler(locks.LockError)
def _handle_lock_error(exc):
    return jsonify(exc.to_dict()), exc.status


@app.errorhandler(RequestEntityTooLarge)
def _handle_too_large(exc):
    return jsonify({
        "error": "Upload too large. Try a smaller folder, or fewer files at once.",
    }), 413


def _bad_request(msg: str):
    return jsonify({"error": msg}), 400


# --------------------------------------------------------------------------- #
# Auth middleware
# --------------------------------------------------------------------------- #
@app.before_request
def _require_auth():
    if not request.path.startswith("/api/"):
        return None
    if request.path in _AUTH_EXEMPT:
        return None
    # Allow CORS preflight if ever added.
    if request.method == "OPTIONS":
        return None

    token = auth.parse_bearer(request.headers.get("Authorization"))
    try:
        session = auth.require_session(token)
    except auth.AuthError as exc:
        return jsonify({"error": str(exc)}), exc.status
    g.session = session
    g.token = session.token
    return None


def _session():
    return g.session


def _token() -> str:
    return g.token


def _guard(path: str | None) -> None:
    """Block access if ``path`` is locked by someone else."""
    if path:
        locks.assert_can_access(path, _token())


# --------------------------------------------------------------------------- #
# Static frontend
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return send_from_directory(config.FRONTEND_DIR, "index.html")


@app.route("/<path:asset>")
def static_assets(asset):
    # Only serve real files from the frontend dir; otherwise 404.
    target = (config.FRONTEND_DIR / asset).resolve()
    if config.FRONTEND_DIR.resolve() in target.parents and target.is_file():
        return send_from_directory(config.FRONTEND_DIR, asset)
    abort(404)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
@app.get("/api/auth/status")
def api_auth_status():
    return jsonify(
        {
            "auth_required": auth.auth_required(),
            "lock_lease_seconds": config.LOCK_LEASE_SECONDS,
            "lock_heartbeat_seconds": config.LOCK_HEARTBEAT_SECONDS,
        }
    )


@app.post("/api/auth/login")
def api_auth_login():
    data = request.get_json(silent=True) or {}
    session = auth.login(data.get("password"), data.get("display_name", ""))
    return jsonify(
        {
            "token": session.token,
            "display_name": session.display_name,
            "expires_at": session.expires_at,
        }
    )


@app.post("/api/auth/logout")
def api_auth_logout():
    auth.logout(_token())
    return jsonify({"ok": True})


@app.get("/api/auth/me")
def api_auth_me():
    s = _session()
    return jsonify(
        {
            "display_name": s.display_name,
            "expires_at": s.expires_at,
        }
    )


# --------------------------------------------------------------------------- #
# Locks
# --------------------------------------------------------------------------- #
@app.get("/api/locks")
def api_locks_list():
    return jsonify(
        {
            "locks": [lk.to_dict() for lk in locks.list_locks()],
            "lease_seconds": config.LOCK_LEASE_SECONDS,
            "heartbeat_seconds": config.LOCK_HEARTBEAT_SECONDS,
        }
    )


@app.post("/api/locks/acquire")
def api_locks_acquire():
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    if not path:
        return _bad_request("Missing 'path'")
    s = _session()
    lock = locks.acquire(path, s.token, s.display_name)
    return jsonify(lock.to_dict())


@app.post("/api/locks/release")
def api_locks_release():
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    if not path:
        return _bad_request("Missing 'path'")
    released = locks.release(path, _token())
    return jsonify({"released": released, "path": path})


@app.post("/api/locks/heartbeat")
def api_locks_heartbeat():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    refreshed = locks.heartbeat(paths, _token())
    return jsonify({"locks": [lk.to_dict() for lk in refreshed]})


# --------------------------------------------------------------------------- #
# File tree / CRUD
# --------------------------------------------------------------------------- #
@app.get("/api/tree")
def api_tree():
    rel = request.args.get("path", "")
    depth = int(request.args.get("depth", "-1"))
    node = storage.list_tree(rel, depth)
    return jsonify(locks.annotate_tree(node.to_dict()))


@app.get("/api/file")
def api_get_file():
    rel = request.args.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    _guard(rel)
    raw = request.args.get("raw") == "1"
    if raw:
        path, name = storage.read_bytes(rel)
        return send_file(path, as_attachment=True, download_name=name)
    content = storage.read_text(rel)
    return jsonify(
        {
            "path": rel,
            "content": content,
            "size": len(content),
        }
    )


@app.put("/api/file")
def api_put_file():
    data = request.get_json(silent=True) or {}
    rel = data.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    _guard(rel)
    node = storage.write_text(rel, data.get("content", ""))
    return jsonify(node.to_dict())


@app.post("/api/upload")
def api_upload():
    rel_dir = request.form.get("path", "")
    files = request.files.getlist("file")
    if not files:
        ct = request.content_type or "missing Content-Type"
        return _bad_request(
            "No file part (server did not receive any files; "
            f"content-type={ct!r})"
        )
    # Optional parallel list of relative paths (preserves folder structure).
    relpaths = request.form.getlist("relpath")
    results = []
    for i, f in enumerate(files):
        rel_name = relpaths[i] if i < len(relpaths) and relpaths[i] else f.filename
        if not rel_name:
            continue
        parts = [
            p for p in rel_name.replace("\\", "/").split("/")
            if p not in ("", ".", "..")
        ]
        base = rel_dir.strip("/") if rel_dir else ""
        combined = "/".join([base] + parts) if base else "/".join(parts)
        _guard(combined)
        node = storage.save_upload(rel_dir, rel_name, f)
        results.append(node.to_dict())
    return jsonify({"uploaded": results})


@app.post("/api/mkdir")
def api_mkdir():
    data = request.get_json(silent=True) or {}
    rel = data.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    return jsonify(storage.make_dir(rel).to_dict())


@app.post("/api/newfile")
def api_newfile():
    data = request.get_json(silent=True) or {}
    rel = data.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    _guard(rel)
    return jsonify(storage.create_file(rel, data.get("content", "")).to_dict())


@app.post("/api/delete")
def api_delete():
    data = request.get_json(silent=True) or {}
    rel = data.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    locks.assert_can_mutate_tree(rel, _token())
    storage.delete(rel)
    # Drop locks on the deleted path and any descendants we held.
    for lk in locks.list_locks():
        if lk.path == rel or lk.path.startswith(rel + "/"):
            if lk.holder_token == _token():
                locks.release(lk.path, _token())
    return jsonify({"deleted": rel})


@app.post("/api/rename")
def api_rename():
    data = request.get_json(silent=True) or {}
    rel = data.get("path")
    new = data.get("new_path")
    if not rel or not new:
        return _bad_request("Missing 'path' or 'new_path'")
    locks.assert_can_mutate_tree(rel, _token())
    _guard(new)
    # Capture locks we hold under the old path before renaming.
    held = [
        lk
        for lk in locks.list_locks()
        if lk.holder_token == _token()
        and (lk.path == rel or lk.path.startswith(rel + "/"))
    ]
    node = storage.rename(rel, new)
    for lk in held:
        locks.release(lk.path, _token())
        suffix = lk.path[len(rel) :]  # '' or '/child...'
        locks.acquire(new + suffix, _token(), _session().display_name)
    return jsonify(node.to_dict())


@app.get("/api/search")
def api_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"results": []})
    in_content = request.args.get("content") == "1"
    results = storage.search(q, in_content=in_content)
    lock_info = locks.locks_map()
    for r in results:
        info = lock_info.get(r.get("path", ""))
        if info:
            r["locked_by"] = info["locked_by"]
            r["expires_at"] = info["expires_at"]
    return jsonify({"results": results})


@app.get("/api/stats")
def api_stats():
    return jsonify(storage.stats())


# --------------------------------------------------------------------------- #
# Phylogenetic networks
# --------------------------------------------------------------------------- #
@app.get("/api/network")
def api_network():
    rel = request.args.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    _guard(rel)
    text = storage.read_text(rel)
    try:
        networks = parse_networks_from_text(text)
    except NewickError as exc:
        return _bad_request(f"Parse error: {exc}")
    if not networks:
        return _bad_request("No parseable network/tree found in file")
    return jsonify({"path": rel, "networks": networks})


@app.post("/api/network/parse")
def api_network_parse():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    try:
        networks = parse_networks_from_text(text)
    except NewickError as exc:
        return _bad_request(f"Parse error: {exc}")
    return jsonify({"networks": networks})


# --------------------------------------------------------------------------- #
# Alignments
# --------------------------------------------------------------------------- #
@app.get("/api/alignment")
def api_alignment():
    rel = request.args.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    _guard(rel)
    text = storage.read_text(rel)
    parsed = parse_alignment(text, filename=rel)
    parsed["stats"] = alignment_stats(parsed)
    # Also surface any embedded networks (NEXUS TREES block) for convenience.
    try:
        embedded = parse_networks_from_text(text)
    except NewickError:
        embedded = []
    parsed["embedded_networks"] = embedded
    parsed["path"] = rel
    return jsonify(parsed)


@app.post("/api/alignment/save")
def api_alignment_save():
    data = request.get_json(silent=True) or {}
    rel = data.get("path")
    sequences = data.get("sequences")
    if not rel or sequences is None:
        return _bad_request("Missing 'path' or 'sequences'")
    _guard(rel)
    fmt = data.get("format", "fasta")
    datatype = data.get("datatype", "dna")
    try:
        text = serialise(sequences, fmt, datatype)
    except AlignmentError as exc:
        return _bad_request(str(exc))
    node = storage.write_text(rel, text)
    return jsonify(node.to_dict())


@app.post("/api/alignment/convert")
def api_alignment_convert():
    """Convert alignment content to another format (returns text; does not save)."""
    data = request.get_json(silent=True) or {}
    sequences = data.get("sequences")
    if sequences is None:
        return _bad_request("Missing 'sequences'")
    fmt = data.get("format", "fasta")
    datatype = data.get("datatype", "dna")
    try:
        text = serialise(sequences, fmt, datatype)
    except AlignmentError as exc:
        return _bad_request(str(exc))
    return jsonify({"format": fmt, "text": text})


# --------------------------------------------------------------------------- #
# Snippet helper (bonus): generate PhyNetPy loading code for a file.
# --------------------------------------------------------------------------- #
@app.get("/api/snippet")
def api_snippet():
    rel = request.args.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    base_url = config.PUBLIC_URL
    python = (
        "from phynetpy_datastore import BioStore\n\n"
        f'store = BioStore("{base_url}")\n'
        f'local_path = store.fetch("{rel}")   # downloads + caches, returns a Path\n'
        "print(local_path)"
    )
    return jsonify({"path": rel, "python": python, "base_url": base_url})


# --------------------------------------------------------------------------- #
# Multi-tree / network summarisation
# --------------------------------------------------------------------------- #
@app.get("/api/summary")
def api_summary():
    rel = request.args.get("path")
    if not rel:
        return _bad_request("Missing 'path'")
    _guard(rel)
    text = storage.read_text(rel)
    ref = request.args.get("reference")
    threshold = float(request.args.get("threshold", "0.5"))
    ref_abs = None
    if ref:
        _guard(ref)
        ref_abs = str(storage.abs_path(ref))
    try:
        summary = summarise_file(
            text,
            path=rel,
            abs_path=str(storage.abs_path(rel)),
            reference_abs=ref_abs,
            threshold=threshold,
        )
    except ValueError as exc:
        return _bad_request(str(exc))
    return jsonify(summary)


# --------------------------------------------------------------------------- #
# PhyNetPy method runner
# --------------------------------------------------------------------------- #
@app.get("/api/phynetpy/status")
def api_phynetpy_status():
    return jsonify(phynetpy_runner.phynetpy_status())


@app.get("/api/phynetpy/methods")
def api_phynetpy_methods():
    return jsonify({"methods": phynetpy_runner.list_methods()})


@app.get("/api/phynetpy/jobs")
def api_phynetpy_jobs():
    owner = _session().display_name
    limit = request.args.get("limit", 50, type=int)
    offset = request.args.get("offset", 0, type=int)
    status = request.args.get("status") or None
    return jsonify({
        "jobs": phynetpy_runner.list_jobs(owner, limit=limit, offset=offset, status=status),
    })


@app.get("/api/phynetpy/jobs/<job_id>")
def api_phynetpy_job(job_id):
    job = phynetpy_runner.get_job(job_id, _session().display_name)
    if not job:
        return jsonify({"error": "Unknown job"}), 404
    return jsonify(job)


@app.delete("/api/phynetpy/jobs/<job_id>")
def api_phynetpy_delete_job(job_id):
    if not phynetpy_runner.delete_job(job_id, _session().display_name):
        return jsonify({"error": "Unknown job"}), 404
    return jsonify({"deleted": job_id})


@app.post("/api/phynetpy/run")
def api_phynetpy_run():
    data = request.get_json(silent=True) or {}
    method = data.get("method")
    if not method:
        return _bad_request("Missing 'method'")
    params = data.get("params") or {}
    inputs = data.get("inputs") or {}

    abs_paths: dict[str, str] = {}
    for key, rel in inputs.items():
        if not rel:
            continue
        _guard(rel)
        path = storage.abs_path(rel)
        if not path.exists():
            return _bad_request(f"Input '{key}' not found: {rel}")
        abs_paths[key] = str(path)

    def save_callback(rel_path: str, content: str) -> str:
        _guard(rel_path)
        storage.write_text(rel_path, content if content.endswith("\n") else content + "\n")
        return rel_path

    job = phynetpy_runner.start_job(
        method,
        params,
        abs_paths,
        save_callback,
        owner_name=_session().display_name,
        rel_inputs={k: v for k, v in inputs.items() if v},
    )
    return jsonify(job.to_dict()), 202


if __name__ == "__main__":
    print(f"BioStore data root: {config.DATA_ROOT}")
    print(f"Serving on http://{config.HOST}:{config.PORT}")
    print(f"Public URL (snippets): {config.PUBLIC_URL}")
    if config.PASSWORD:
        print("Auth: shared password enabled (BIOSTORE_PASSWORD is set)")
    else:
        print(
            "WARNING: BIOSTORE_PASSWORD is unset — anyone who can reach the "
            "server can log in with any password. Set BIOSTORE_PASSWORD for lab sharing."
        )
    # Initialise metadata DB early so schema errors surface at startup.
    from db import get_db

    get_db()
    app.run(host=config.HOST, port=config.PORT, debug=True)
