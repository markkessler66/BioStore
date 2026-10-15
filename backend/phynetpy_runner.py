"""PhyNetPy method runner for BioStore.

Wraps ``phynetpy.infer`` / ``phynetpy.LikelihoodStrategies`` so the web UI can
score or search networks against gene-tree (or other) data stored in BioStore.
Jobs run in a background thread; progress / results are polled via job id.
"""

from __future__ import annotations

import json
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any


@dataclass
class Job:
    id: str
    method: str
    owner_name: str = ""
    status: str = "queued"  # queued | running | done | error
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    params: dict = field(default_factory=dict)
    inputs: dict = field(default_factory=dict)
    result: dict | None = None
    error: str | None = None
    log: list[str] = field(default_factory=list)
    progress: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["method_name"] = _method_label(self.method)
        _annotate_timing(d)
        return d


_JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()
_PERSIST_LOCK = threading.Lock()


def _method_label(method_id: str) -> str:
    for m in list_methods():
        if m["id"] == method_id:
            return m["name"]
    return method_id


def _finite(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return n


def _annotate_timing(d: dict) -> None:
    now = time.time()
    start = d.get("started_at") or d.get("created_at")
    end = d.get("finished_at") or now
    d["elapsed_sec"] = max(0.0, end - start) if start else None
    progress = d.get("progress") or {}
    iteration = progress.get("iteration")
    num_iter = progress.get("num_iter")
    if (
        d.get("status") == "running"
        and isinstance(iteration, int)
        and isinstance(num_iter, int)
        and iteration > 0
        and num_iter > iteration
        and d.get("elapsed_sec")
    ):
        d["eta_sec"] = d["elapsed_sec"] * (num_iter - iteration) / iteration
    else:
        d["eta_sec"] = None


def _initial_progress(params: dict, method: str) -> dict:
    raw = params.get("num_iter") if params else None
    try:
        num_iter = int(raw) if raw not in (None, "") else None
    except (TypeError, ValueError):
        num_iter = None
    phase = (params or {}).get("strategy") or _method_label(method)
    return {
        "phase": phase,
        "iteration": None,
        "num_iter": num_iter,
        "score": None,
        "best_score": None,
    }


def _persist(job: Job, *, force: bool = False) -> None:
    """Write the job through to SQLite. Progress updates are throttled."""
    if getattr(job, "_deleted", False):
        return
    now = time.monotonic()
    if not force and job.status == "running":
        last = getattr(job, "_last_db", 0.0)
        if now - last < 0.5:
            return
    job._last_db = now
    import db

    payload = (
        job.id,
        job.owner_name,
        job.method,
        job.status,
        job.created_at,
        job.started_at,
        job.finished_at,
        json.dumps(job.params),
        json.dumps(job.inputs),
        json.dumps(job.result) if job.result is not None else None,
        job.error,
        json.dumps(job.log),
        json.dumps(job.progress or {}),
    )
    with _PERSIST_LOCK:
        conn = db.get_db()
        conn.execute(
            """
            INSERT INTO phynetpy_jobs (
                id, owner_name, method, status, created_at, started_at, finished_at,
                params_json, inputs_json, result_json, error, log_json, progress_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                owner_name=excluded.owner_name,
                method=excluded.method,
                status=excluded.status,
                created_at=excluded.created_at,
                started_at=excluded.started_at,
                finished_at=excluded.finished_at,
                params_json=excluded.params_json,
                inputs_json=excluded.inputs_json,
                result_json=excluded.result_json,
                error=excluded.error,
                log_json=excluded.log_json,
                progress_json=excluded.progress_json
            """,
            payload,
        )
        conn.commit()


def _row_to_dict(row) -> dict:
    def loads(raw, fallback):
        if not raw:
            return fallback
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return fallback

    d = {
        "id": row["id"],
        "method": row["method"],
        "method_name": _method_label(row["method"]),
        "owner_name": row["owner_name"],
        "status": row["status"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "params": loads(row["params_json"], {}),
        "inputs": loads(row["inputs_json"], {}),
        "result": loads(row["result_json"], None) if row["result_json"] else None,
        "error": row["error"],
        "log": loads(row["log_json"], []),
        "progress": loads(row["progress_json"], {}),
    }
    _annotate_timing(d)
    return d


def _fail_interrupted_jobs() -> None:
    """Mark runs that died with the previous server process."""
    import db

    conn = db.get_db()
    conn.execute(
        """
        UPDATE phynetpy_jobs
        SET status = 'error',
            finished_at = COALESCE(finished_at, ?),
            error = COALESCE(error, ?)
        WHERE status IN ('queued', 'running')
        """,
        (time.time(), "Server stopped before this run finished."),
    )
    conn.commit()


def _install_progress(job: Job) -> None:
    def cb(iteration, num_iter, score, best_score=None):
        phase = (job.params or {}).get("strategy") or _method_label(job.method)
        with _LOCK:
            prev = job.progress or {}
            job.progress = {
                "phase": phase or prev.get("phase"),
                "iteration": int(iteration),
                "num_iter": int(num_iter) if num_iter else prev.get("num_iter"),
                "score": _finite(score),
                "best_score": _finite(best_score if best_score is not None else score),
            }
        _persist(job)

    try:
        from phynetpy.MetropolisHastings import set_progress_callback
    except Exception:
        return
    set_progress_callback(cb)


def _clear_progress() -> None:
    try:
        from phynetpy.MetropolisHastings import set_progress_callback
        set_progress_callback(None)
    except Exception:
        pass


try:
    _fail_interrupted_jobs()
except Exception:
    pass


def phynetpy_status() -> dict:
    try:
        import phynetpy  # noqa: F401
        from phynetpy import infer  # noqa: F401
        return {
            "available": True,
            "version": getattr(phynetpy, "__version__", "unknown"),
            "path": getattr(phynetpy, "__file__", None),
        }
    except Exception as exc:
        return {"available": False, "error": str(exc)}


def list_methods() -> list[dict]:
    """Describe the methods the UI can launch."""
    return [
        {
            "id": "score_gt",
            "name": "Score network (gene trees)",
            "description": "Score a species network against gene-tree data using Parsimony, PseudoLikelihood, MaximumLikelihood, or MCMC.",
            "action": "score",
            "inputs": ["network", "gene_trees"],
            "params": [
                {"key": "strategy", "label": "Strategy", "type": "select",
                 "options": ["Parsimony", "PseudoLikelihood", "MaximumLikelihood", "MCMC"],
                 "default": "PseudoLikelihood"},
                {"key": "mapping_json", "label": "Species→allele map (JSON, optional)", "type": "textarea",
                 "default": "", "placeholder": '{"A": ["A1","A2"], "B": ["B"]}'},
                {"key": "num_iter", "label": "Iterations (search strategies)", "type": "number", "default": 500},
                {"key": "max_reticulations", "label": "Max reticulations", "type": "number", "default": 2},
                {"key": "seed", "label": "Seed", "type": "number", "default": 42},
            ],
        },
        {
            "id": "infer_gt",
            "name": "Infer network (gene trees)",
            "description": "Search for the best species network from gene trees. Routes to MPL / InferNetwork_ML / INFER_MP_ALLOP / MCMC_GT via LikelihoodStrategies.",
            "action": "infer",
            "inputs": ["gene_trees"],
            "optional_inputs": ["start_network"],
            "params": [
                {"key": "strategy", "label": "Strategy", "type": "select",
                 "options": ["Parsimony", "PseudoLikelihood", "MaximumLikelihood", "MCMC"],
                 "default": "PseudoLikelihood"},
                {"key": "search", "label": "Search method", "type": "select",
                 "options": ["hc", "sa", "mcmc"], "default": "hc"},
                {"key": "num_iter", "label": "Iterations", "type": "number", "default": 500},
                {"key": "max_reticulations", "label": "Max reticulations", "type": "number", "default": 2},
                {"key": "max_lvl", "label": "Max level (optional)", "type": "number", "default": ""},
                {"key": "preset", "label": "Preset", "type": "select",
                 "options": ["default", "fast", "thorough"], "default": "default"},
                {"key": "opt_bl", "label": "Optimise branch lengths", "type": "checkbox", "default": True},
                {"key": "mapping_json", "label": "Species→allele map (JSON, optional)", "type": "textarea",
                 "default": "", "placeholder": '{"A": ["A1","A2"], "B": ["B"]}'},
                {"key": "seed", "label": "Seed", "type": "number", "default": 42},
                {"key": "save_as", "label": "Save best network as (BioStore path)", "type": "text",
                 "default": "results/inferred_network.nwk"},
            ],
        },
        {
            "id": "mpl_score",
            "name": "MPL score (direct)",
            "description": "Compute the maximum pseudo-likelihood score of a species network given gene trees (Yu & Nakhleh 2015).",
            "action": "score",
            "inputs": ["network", "gene_trees"],
            "params": [
                {"key": "mapping_json", "label": "Species→allele map (JSON, optional)", "type": "textarea",
                 "default": ""},
            ],
        },
        {
            "id": "allop_score",
            "name": "MP-Allop score",
            "description": "Maximum-parsimony allopolyploid score (ALLOP_SCORE) for a network vs gene trees with a subgenome map.",
            "action": "score",
            "inputs": ["network", "gene_trees"],
            "params": [
                {"key": "mapping_json", "label": "Subgenome map (JSON, required)", "type": "textarea",
                 "default": "", "placeholder": '{"J": ["J_allo_sub1","J_allo_sub2"], "D": ["D_diploid"]}'},
            ],
        },
        {
            "id": "infer_mp_allop",
            "name": "Infer MP-Allop",
            "description": "Run INFER_MP_ALLOP hill-climbing search from gene trees + subgenome assignment.",
            "action": "infer",
            "inputs": ["gene_trees"],
            "params": [
                {"key": "mapping_json", "label": "Subgenome map (JSON, required)", "type": "textarea",
                 "default": ""},
                {"key": "num_iter", "label": "Iterations", "type": "number", "default": 500},
                {"key": "seed", "label": "Seed", "type": "number", "default": 42},
                {"key": "save_as", "label": "Save best network as", "type": "text",
                 "default": "results/mp_allop_best.nwk"},
            ],
        },
    ]


def _parse_mapping(raw: str | dict | None) -> dict | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, dict):
        return raw
    return json.loads(raw)


def _network_to_newick(net) -> str:
    for attr in ("newick", "to_newick", "toNewick", "get_newick"):
        if hasattr(net, attr):
            val = getattr(net, attr)
            s = val() if callable(val) else val
            if isinstance(s, str) and s.strip():
                return s if s.endswith(";") else s + ";"
    return str(net)


def _is_nexus(path: str) -> bool:
    p = Path(path)
    if p.suffix.lower() in {".nex", ".nexus"}:
        return True
    try:
        head = p.read_text(encoding="utf-8", errors="ignore")[:64].lstrip().upper()
        return head.startswith("#NEXUS")
    except OSError:
        return False


def _extract_newick_strings(text: str) -> list[str]:
    """Pull newick / eNewick strings out of a NEXUS or plain-text blob.

    Handles ``TREE name = (...);`` / ``NETWORK name = (...);`` assignments as
    well as bare ``(...);`` chunks. Extended-newick reticulation markers
    (``#H1``) are left intact for PhyNetPy's ``read_newick``.
    """
    import re

    found: list[str] = []
    assignment_re = re.compile(
        r"(?:TREE|NETWORK)\s+\*?\s*[\w.\-]+\s*=\s*(?:\[[^\]]*\]\s*)?(\(.*?;)",
        re.IGNORECASE | re.DOTALL,
    )
    for m in assignment_re.finditer(text):
        body = m.group(1).strip()
        if not body.endswith(";"):
            body += ";"
        found.append(body)

    if found:
        return found

    for chunk in text.split(";"):
        chunk = chunk.strip()
        if not chunk or "(" not in chunk:
            continue
        # Strip a leading "Tree name =" if present without the regex match.
        eq = chunk.find("=")
        if eq != -1 and chunk.lstrip().upper().startswith(("TREE", "NETWORK")):
            chunk = chunk[eq + 1 :].strip()
        if "(" not in chunk:
            continue
        found.append(chunk + ";")
    return found


def _paren_balance(s: str) -> int:
    """Return open-count minus close-count (0 = balanced). Ignores brackets in labels."""
    depth = 0
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
    return depth


def _parse_newicks_with_phynetpy(strings: list[str]) -> list:
    from phynetpy.IO import read_newick

    out = []
    errors = []
    for s in strings:
        bal = _paren_balance(s)
        if bal != 0:
            hint = (
                f"too many ')' (remove {-bal})"
                if bal < 0
                else f"too many '(' (add {bal} ')')"
            )
            errors.append(f"Parenthesis mismatch ({hint}) in: {s[:80]}")
            continue
        try:
            out.append(read_newick(s))
        except Exception as exc:
            errors.append(f"{s[:60]}… → {exc}")
    if not out:
        msg = "Could not parse any trees/networks"
        if errors:
            msg += ":\n  - " + "\n  - ".join(errors[:5])
        raise ValueError(msg)
    return out


def _load_networks_list(path: str) -> list:
    """Load one or more networks/trees from a BioStore file path.

    Prefer PhyNetPy's eNewick-aware ``read_newick`` over ``read_nexus``, because
    ``python-nexus`` / Bio.Phylo choke on reticulation markers like ``#H1``.
    """
    from phynetpy.IO import read_nexus, read_newick_file

    text = Path(path).read_text(encoding="utf-8", errors="replace")
    strings = _extract_newick_strings(text)
    eNewick_error: Exception | None = None

    # 1) Direct eNewick parse (works for .nwk, .trees, and NEXUS with #H1).
    if strings:
        try:
            nets = _parse_newicks_with_phynetpy(strings)
            if nets:
                return nets
        except Exception as exc:
            eNewick_error = exc

    # 2) Plain multi-newick file reader (no NEXUS wrapper).
    if not _is_nexus(path):
        try:
            nets = read_newick_file(path)
            if isinstance(nets, list) and nets:
                return nets
            if nets is not None and not isinstance(nets, list):
                return [nets]
        except Exception as exc:
            if eNewick_error is None:
                eNewick_error = exc

    # 3) Last resort: python-nexus (only works for ordinary trees, no #H).
    if _is_nexus(path) and eNewick_error is None:
        try:
            nets = read_nexus(path, return_type="networks")
            return list(nets) if isinstance(nets, list) else [nets]
        except Exception as exc:
            raise ValueError(
                f"Could not parse '{path}'. "
                f"If this file contains reticulation markers (#H1), use a balanced "
                f"extended-newick string — python-nexus cannot read those. "
                f"Underlying error: {exc}"
            ) from exc

    if eNewick_error is not None:
        raise ValueError(str(eNewick_error)) from eNewick_error

    raise ValueError(f"No parseable trees/networks in {path}")


def _load_network(path: str):
    nets = _load_networks_list(path)
    if not nets:
        raise ValueError(f"No networks in {path}")
    return nets[0]


def _load_genetrees(path: str, mapping: dict | None = None):
    from phynetpy.GeneTrees import GeneTrees

    # Always go through the eNewick-aware loader so NEXUS files with #H1
    # (or plain .trees) work the same way.
    nets = _load_networks_list(path)
    return GeneTrees(nets, species_gene_mapping=mapping)


def _make_strategy(name: str, params: dict):
    from phynetpy.LikelihoodStrategies import (
        Config, Parsimony, PseudoLikelihood, MaximumLikelihood, MCMC,
    )
    cfg_kwargs = {}
    for key in ("search", "num_iter", "burn_in", "sample_freq", "max_reticulations",
                "max_lvl", "preset", "opt_bl", "fix_st", "optimize_scope", "pseudo",
                "num_runs", "seed", "n_workers"):
        if key in params and params[key] not in ("", None):
            cfg_kwargs[key] = params[key]
    # Coerce numbers that arrived as strings from the form.
    for key in ("num_iter", "burn_in", "sample_freq", "max_reticulations", "max_lvl",
                "num_runs", "seed", "n_workers"):
        if key in cfg_kwargs and cfg_kwargs[key] is not None:
            try:
                cfg_kwargs[key] = int(cfg_kwargs[key])
            except (TypeError, ValueError):
                del cfg_kwargs[key]
    for key in ("opt_bl", "fix_st", "pseudo"):
        if key in cfg_kwargs:
            cfg_kwargs[key] = bool(cfg_kwargs[key])
    cfg = Config(**cfg_kwargs)
    return {
        "Parsimony": Parsimony,
        "PseudoLikelihood": PseudoLikelihood,
        "MaximumLikelihood": MaximumLikelihood,
        "MCMC": MCMC,
    }[name](cfg)


def _run_job(job: Job, abs_paths: dict[str, str], save_callback) -> None:
    job.status = "running"
    job.started_at = time.time()
    if not job.progress:
        job.progress = _initial_progress(job.params, job.method)
    _persist(job, force=True)
    _install_progress(job)
    try:
        status = phynetpy_status()
        if not status.get("available"):
            raise RuntimeError(f"PhyNetPy not available: {status.get('error')}")

        method = job.method
        params = dict(job.params)
        mapping = _parse_mapping(params.get("mapping_json"))
        job.log.append(f"Starting {method}")

        if method == "score_gt":
            from phynetpy.LikelihoodStrategies import Score_Network_Using_GT
            net = _load_network(abs_paths["network"])
            gts = _load_genetrees(abs_paths["gene_trees"], mapping)
            strategy = _make_strategy(params.get("strategy", "PseudoLikelihood"), params)
            score = Score_Network_Using_GT(net, gts, strategy, mapping=mapping)
            job.result = {"score": float(score), "strategy": params.get("strategy")}

        elif method == "infer_gt":
            from phynetpy.LikelihoodStrategies import Infer_Network_From_GT
            gts = _load_genetrees(abs_paths["gene_trees"], mapping)
            strategy = _make_strategy(params.get("strategy", "PseudoLikelihood"), params)
            start = None
            if abs_paths.get("start_network"):
                start = _load_network(abs_paths["start_network"])
            result = Infer_Network_From_GT(gts, strategy, mapping=mapping, start_network=start)
            newick = _network_to_newick(getattr(result, "network", None) or getattr(result, "best_network", result))
            score = getattr(result, "score", None) or getattr(result, "best_score", None)
            saved = None
            if params.get("save_as") and newick:
                saved = save_callback(params["save_as"], newick)
            job.result = {
                "score": float(score) if score is not None else None,
                "network_newick": newick,
                "saved_as": saved,
                "strategy": params.get("strategy"),
            }

        elif method == "mpl_score":
            from phynetpy.infer import MPL
            net = _load_network(abs_paths["network"])
            gts = _load_genetrees(abs_paths["gene_trees"], mapping)
            # Build identity mapping if none given.
            if mapping is None:
                mapping = getattr(gts, "species_gene_mapping", None) or {}
                if callable(mapping):
                    mapping = mapping()
            mpl = MPL(net, gts, mapping or {})
            score = mpl.score()
            job.result = {"score": float(score)}

        elif method == "allop_score":
            from phynetpy.infer import ALLOP_SCORE
            if not mapping:
                raise ValueError("Subgenome map (mapping_json) is required for ALLOP_SCORE")
            score = ALLOP_SCORE(abs_paths["network"], abs_paths["gene_trees"], mapping)
            job.result = {"score": int(score) if isinstance(score, int) else float(score)}

        elif method == "infer_mp_allop":
            from phynetpy.infer import INFER_MP_ALLOP
            if not mapping:
                raise ValueError("Subgenome map (mapping_json) is required for INFER_MP_ALLOP")
            num_iter = int(params.get("num_iter") or 500)
            seed = int(params["seed"]) if params.get("seed") not in (None, "") else None
            result = INFER_MP_ALLOP(
                abs_paths["gene_trees"],
                subgenome_assign=mapping,
                iter_ct=num_iter,
                seed=seed,
            )
            # result is dict[Network, float]
            if isinstance(result, dict) and result:
                best_net, best_score = min(result.items(), key=lambda kv: kv[1])
                newick = _network_to_newick(best_net)
                saved = None
                if params.get("save_as") and newick:
                    saved = save_callback(params["save_as"], newick)
                job.result = {
                    "score": float(best_score),
                    "network_newick": newick,
                    "saved_as": saved,
                    "n_candidates": len(result),
                }
            else:
                job.result = {"score": None, "raw": str(result)}

        else:
            raise ValueError(f"Unknown method: {method}")

        job.status = "done"
        job.log.append("Finished successfully")
    except Exception as exc:
        job.status = "error"
        job.error = f"{exc}\n{traceback.format_exc()}"
        job.log.append(f"Error: {exc}")
    finally:
        job.finished_at = time.time()
        _clear_progress()
        _persist(job, force=True)
        with _LOCK:
            _JOBS.pop(job.id, None)


def start_job(
    method: str,
    params: dict,
    abs_paths: dict[str, str],
    save_callback,
    *,
    owner_name: str = "",
    rel_inputs: dict | None = None,
) -> Job:
    job = Job(
        id=uuid.uuid4().hex[:12],
        method=method,
        owner_name=owner_name,
        params=dict(params or {}),
        inputs=dict(rel_inputs or {}),
        progress=_initial_progress(params or {}, method),
    )
    with _LOCK:
        _JOBS[job.id] = job
    _persist(job, force=True)
    t = threading.Thread(
        target=_run_job, args=(job, abs_paths, save_callback), daemon=True
    )
    t.start()
    return job


def get_job(job_id: str, owner_name: str) -> dict | None:
    """Return one job owned by this display name, or None."""
    with _LOCK:
        mem = _JOBS.get(job_id)
        if mem is not None:
            if mem.owner_name != owner_name:
                return None
            return mem.to_dict()
    import db

    row = db.get_db().execute(
        "SELECT * FROM phynetpy_jobs WHERE id = ? AND owner_name = ?",
        (job_id, owner_name),
    ).fetchone()
    if row is None:
        return None
    return _row_to_dict(row)


def delete_job(job_id: str, owner_name: str) -> bool:
    """Remove a job owned by this display name. Returns True if it existed."""
    import db

    with _LOCK:
        mem = _JOBS.get(job_id)
        if mem is not None and mem.owner_name != owner_name:
            return False
        if mem is not None:
            mem._deleted = True
            _JOBS.pop(job_id, None)
    with _PERSIST_LOCK:
        cur = db.get_db().execute(
            "DELETE FROM phynetpy_jobs WHERE id = ? AND owner_name = ?",
            (job_id, owner_name),
        )
        db.get_db().commit()
        return cur.rowcount > 0 or mem is not None


def list_jobs(
    owner_name: str,
    limit: int = 50,
    offset: int = 0,
    status: str | None = None,
) -> list[dict]:
    """Newest-first jobs for one display name."""
    import db

    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    where = ["owner_name = ?"]
    args: list = [owner_name]
    if status == "active":
        where.append("status IN ('queued', 'running')")
    elif status:
        where.append("status = ?")
        args.append(status)
    args.extend([limit, offset])
    rows = db.get_db().execute(
        f"""
        SELECT * FROM phynetpy_jobs
        WHERE {' AND '.join(where)}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        """,
        args,
    ).fetchall()
    out = []
    with _LOCK:
        live = dict(_JOBS)
    for row in rows:
        mem = live.get(row["id"])
        if mem is not None and mem.owner_name == owner_name:
            out.append(mem.to_dict())
        else:
            out.append(_row_to_dict(row))
    return out
