"""
Looking at itself, and saying what is wrong in words somebody can act on.

Self-maintenance needs a starting point, and a stack trace is not one. Every
check here produces a *finding*: what was looked at, what state it is in, why it
matters, and what to do about it. The findings are ordered by how much they
block, and each one that can be fixed mechanically carries the name of the
repair that fixes it.

What is checked falls into four groups:

    this machine      memory, disk, whether the data and workspace directories
                      are writable, whether the database opens
    its own tools     tools that no longer load, and tools whose recent calls
                      keep failing — both are the brain's own software, so both
                      are its own to repair
    what it can reach model servers, the network, and gaps worth closing
    what changed      the capability map compared with the previous snapshot, so
                      a tool that vanished overnight is a sentence, not a mystery

The last group is the one that turns diagnosis into maintenance: the difference
between "something is broken" and "ripgrep is not on PATH any more" is the
difference between looking and finding.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Dict, List

from . import capabilities, config, providers

#: How each finding is graded. `blocking` means the brain cannot do its job;
#: `degraded` means it works with fewer options; `note` is information.
LEVELS = ("blocking", "degraded", "note")


def _finding(
    identifier: str,
    level: str,
    area: str,
    message: str,
    detail: str = "",
    repair: str = "",
) -> Dict[str, Any]:
    return {
        "id": identifier,
        "level": level,
        "area": area,
        "message": message,
        "detail": detail,
        "repair": repair,
    }


def report(ctx: Any, deep: bool = False) -> Dict[str, Any]:
    """
    The whole diagnosis, plus the repair actions that are available.

    `deep` re-probes the machine instead of using the cached capability map.
    It costs a second or two, which is why the shallow form is the default.
    """
    started = time.time()
    built = capabilities.build(ctx.store, force=bool(deep))
    findings: List[Dict[str, Any]] = []

    findings.extend(_storage(ctx, built))
    findings.extend(_tools(ctx))
    findings.extend(_models(ctx, built))
    findings.extend(_network(built))
    findings.extend(_independence(built))
    findings.extend(_changes(ctx))

    order = {level: index for index, level in enumerate(LEVELS)}
    findings.sort(key=lambda item: order.get(item["level"], 9))

    return {
        "ok": not any(item["level"] == "blocking" for item in findings),
        "at": time.time(),
        "ms": int((time.time() - started) * 1000),
        "version": config.VERSION,
        "findings": findings,
        "counts": {level: sum(1 for item in findings if item["level"] == level) for level in LEVELS},
        "tools": _tool_health(ctx),
        "repairs": sorted(REPAIRS),
        "capabilities": {
            "host": built.get("host"),
            "cores": built.get("cpu", {}).get("cores"),
            "memoryGb": built.get("memory", {}).get("totalGb"),
            "gpus": [gpu.get("name") for gpu in built.get("gpus", [])],
            "diskFreeGb": (built.get("disk", {}).get("workspace") or {}).get("freeGb"),
            "online": bool(built.get("network", {}).get("online")),
        },
    }


# ------------------------------------------------------------------- the checks


def _storage(ctx: Any, built: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    sandbox = built.get("sandbox") or {}

    for label, path in (("data", config.data_dir()), ("workspace", config.workspace_dir())):
        if not os.access(str(path), os.W_OK):
            findings.append(
                _finding(
                    f"dir.{label}.unwritable",
                    "blocking",
                    "storage",
                    f"the {label} directory cannot be written to",
                    str(path),
                    "dirs.recreate",
                )
            )

    try:
        stats = ctx.store.stats()
    except Exception as error:  # noqa: BLE001 - the database failing is the finding
        return findings + [
            _finding("db.unreadable", "blocking", "storage",
                     "the memory database cannot be read", f"{type(error).__name__}: {error}",
                     "db.repair")
        ]

    if not stats.get("fts"):
        findings.append(
            _finding(
                "db.nofts",
                "note",
                "storage",
                "this SQLite has no full-text search, so memory search is plain matching",
                "everything still works; results are just ranked more simply",
            )
        )

    token = config.read_token()
    if token is None:
        findings.append(
            _finding("auth.notoken", "degraded", "storage",
                     "no pairing token exists, so the API cannot be paired with",
                     "a token is made on the first `serve`, or now by `token.rotate`",
                     "token.rotate")
        )
    else:
        try:
            mode = config.token_path().stat().st_mode & 0o777
            if mode & 0o077:
                findings.append(
                    _finding("auth.token.worldreadable", "degraded", "storage",
                             "the pairing token is readable by other users on this machine",
                             f"mode {oct(mode)} at {config.token_path()}", "token.rotate")
                )
        except OSError:
            pass

    free = (built.get("disk", {}).get("workspace") or {}).get("freeGb")
    if isinstance(free, (int, float)):
        if free < 2:
            findings.append(
                _finding("disk.low", "degraded", "storage",
                         f"only {free} GB free in the workspace",
                         "model weights and test runs both need room", "cache.prune")
            )
        if free < 20:
            findings.append(
                _finding("disk.models", "note", "storage",
                         "there is not much room for local model weights here",
                         "a 7B model needs about 15 GB; a 32B model about 65 GB")
            )

    if not sandbox.get("writable", True):
        findings.append(
            _finding("dirs.notwritable", "blocking", "storage",
                     "one of the brain's own directories is not writable",
                     str(sandbox.get("workspace")), "dirs.recreate")
        )
    return findings


def _tool_health(ctx: Any, failing_ratio: float = 0.5, minimum_calls: int = 3) -> List[Dict[str, Any]]:
    """Tools that keep failing, worst first."""
    unhealthy: List[Dict[str, Any]] = []
    for row in ctx.store.tool_stats():
        calls = int(row.get("calls") or 0)
        failures = int(row.get("failures") or 0)
        if calls >= minimum_calls and failures / max(calls, 1) >= failing_ratio:
            unhealthy.append(
                {
                    "tool": row["tool"],
                    "calls": calls,
                    "failures": failures,
                    "avgMs": row.get("avg_ms"),
                    "lastAt": row.get("last_at"),
                }
            )
    return unhealthy


def _tools(ctx: Any) -> List[Dict[str, Any]]:
    from . import tools as tool_module

    findings: List[Dict[str, Any]] = []
    loaded = tool_module.registry.load_external()

    for name, error in loaded["broken"].items():
        findings.append(
            _finding(
                f"tool.broken.{name}",
                "degraded",
                "tools",
                f"the tool the brain wrote for itself no longer loads: {name}",
                error,
                "tools.rewrite",
            )
        )

    for row in _tool_health(ctx):
        recent = ctx.store.last_runs(row["tool"], limit=1)
        last_error = (recent[0].get("error") if recent else "") or "no error recorded"
        findings.append(
            _finding(
                f"tool.failing.{row['tool']}",
                "degraded",
                "tools",
                f"{row['tool']} has failed {row['failures']} of its last {row['calls']} calls",
                last_error,
                "tool.inspect",
            )
        )

    if loaded["loaded"]:
        findings.append(
            _finding(
                "tools.custom",
                "note",
                "tools",
                f"{len(loaded['loaded'])} tool(s) the brain wrote itself are loaded",
                ", ".join(loaded["loaded"]),
            )
        )
    return findings


def _models(ctx: Any, built: Dict[str, Any]) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    up = built.get("models") or []
    if up:
        served = sum(len(server.get("models") or []) for server in up)
        findings.append(
            _finding(
                "models.up",
                "note",
                "models",
                f"{len(up)} local model server(s) answering, {served} model(s) available",
                ", ".join(f"{s['label']} ({len(s.get('models') or [])})" for s in up),
            )
        )
    else:
        missing = built.get("modelServersMissing") or []
        findings.append(
            _finding(
                "models.none",
                "degraded",
                "models",
                "no local model server is answering, so answers come from the tools "
                "and the memory alone",
                providers.start_hint(missing),
            )
        )
    return findings


def _network(built: Dict[str, Any]) -> List[Dict[str, Any]]:
    online = bool((built.get("network") or {}).get("online"))
    if online:
        return []
    cached = _cache_count()
    return [
        _finding(
            "network.offline",
            "note",
            "network",
            "no network right now — the brain is in offline mode",
            f"{cached} document(s) in the local cache are still reachable",
        )
    ]


def _cache_count() -> int:
    from . import info

    return len(info.cache_entries(limit=10_000))


def _independence(built: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    What is missing that would make this machine more self-sufficient.

    This is the "nudge it forward" section: not errors, but the next things worth
    having, in the order they buy the most independence.
    """
    findings: List[Dict[str, Any]] = []
    tools_found = built.get("tools") or {}
    if not built.get("models"):
        findings.append(
            _finding("independence.model", "note", "independence",
                     "no local model here yet: adding one is the single biggest step",
                     "scripts/install-runtimes.sh, then scripts/download-models.sh")
        )
    if not built.get("gpus"):
        findings.append(
            _finding("independence.gpu", "note", "independence",
                     "no GPU detected, so local models run on CPU",
                     "a 7B quantised model is usable; a 32B one will be slow")
        )
    if "rg" not in tools_found:
        findings.append(
            _finding("independence.rg", "note", "independence",
                     "ripgrep is not installed, so file search is the slower fallback",
                     "scripts/install-coding-tools.sh")
        )
    if "sqlite3" not in tools_found:
        findings.append(
            _finding("independence.sqlite", "note", "independence",
                     "the sqlite3 shell is not installed (the Python module is, so "
                     "memory works regardless)",
                     "install sqlite3 from your distribution")
        )
    return findings


def _changes(ctx: Any) -> List[Dict[str, Any]]:
    """What moved between the last two capability snapshots."""
    snapshots = ctx.store.snapshots(limit=2)
    if len(snapshots) < 2:
        return []
    lines = capabilities.diff(snapshots[1].get("data"), snapshots[0].get("data"))
    if not lines:
        return []
    return [
        _finding("caps.changed", "note", "changes",
                 f"{len(lines)} change(s) since the last snapshot",
                 "; ".join(lines))
    ]


# -------------------------------------------------------------------- repairs


def repair(store: Any, name: str, ctx: Any = None) -> Dict[str, Any]:
    """
    Run one repair by name.

    Every repair is idempotent and safe to run when nothing is wrong: that is
    what makes "just run it and see" a reasonable thing for a person to do.
    """
    action: Callable[..., Dict[str, Any]] | None = REPAIRS.get(name)
    if action is None:
        return {"ok": False, "error": f"no such repair: {name}", "available": sorted(REPAIRS)}
    try:
        return {"ok": True, "repair": name, **action(store, ctx)}
    except Exception as error:  # noqa: BLE001 - a repair that fails is a finding
        store.event("error", "repair", f"{name} failed", {"error": str(error)})
        return {"ok": False, "repair": name, "error": f"{type(error).__name__}: {error}"}


def _repair_dirs(store: Any, ctx: Any = None) -> Dict[str, Any]:
    config.ensure_dirs()
    return {
        "detail": "recreated the data and workspace directories",
        "dataDir": str(config.data_dir()),
        "workspace": str(config.workspace_dir()),
    }


def _repair_db(store: Any, ctx: Any = None) -> Dict[str, Any]:
    """Re-open the database, backing up a file that will not open at all."""
    try:
        store._db.execute("PRAGMA integrity_check")  # noqa: SLF001 - deliberate self-check
        return {"detail": "the database opens and passes its integrity check"}
    except Exception as error:  # noqa: BLE001
        path = config.db_path()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        broken = path.with_name(f"{path.name}.broken-{stamp}")
        try:
            shutil.move(str(path), str(broken))
        except OSError as move_error:
            return {"ok": False, "error": f"could not set the bad database aside: {move_error}",
                    "original": str(error)}
        return {
            "detail": "the unreadable database was moved aside; a new one is made on the next start",
            "movedTo": str(broken),
            "next": "restart the brain to build a fresh database",
        }


def _repair_token(store: Any, ctx: Any = None) -> Dict[str, Any]:
    token = config.rotate_token()
    return {"detail": "a new pairing token was made; every page must pair again",
            "token": token}


def _repair_caps(store: Any, ctx: Any = None) -> Dict[str, Any]:
    built = capabilities.build(store, force=True)
    return {"detail": "the capability map was re-probed",
            "cores": built.get("cpu", {}).get("cores"),
            "models": len(built.get("models") or [])}


def _repair_cache(store: Any, ctx: Any = None, keep_days: float = 30.0) -> Dict[str, Any]:
    """Drop cached pages nobody has needed for a month."""
    from . import info

    cutoff = time.time() - keep_days * 86_400
    removed = 0
    freed = 0
    directory = info.cache_dir()
    if not directory.exists():
        return {"detail": "there is no cache to prune"}
    for path in directory.glob("*.json"):
        try:
            if path.stat().st_mtime >= cutoff:
                continue
            freed += path.stat().st_size
            path.unlink()
            removed += 1
        except OSError:
            continue
    return {"detail": f"removed {removed} cached document(s)", "freedBytes": freed}


def _repair_tools(store: Any, ctx: Any = None) -> Dict[str, Any]:
    """Try every tool file again, and report which are still broken."""
    from . import tools as tool_module

    result = tool_module.registry.load_external()
    return {
        "detail": f"{len(result['loaded'])} tool(s) load",
        "loaded": result["loaded"],
        "broken": result["broken"],
    }


def _repair_self(store: Any, ctx: Any = None) -> Dict[str, Any]:
    """
    Run the brain's own test suite.

    The most direct statement of the idea: the software that runs this can check
    itself, and the check is part of the software.
    """
    from . import tools as tool_module

    root = config.workspace_dir()
    # The brain's own package directory: this file is in `src/`, so one level up
    # is where `brain.py` and `tests/` live.
    package = Path(__file__).resolve().parent.parent
    candidates = [
        ("tests/run.py", "python3 tests/run.py"),
        ("tests/test_brain.py", "python3 -m unittest discover -s tests -q"),
    ]
    for relative, command in candidates:
        if (package / relative).exists():
            return tool_module.run_command(command, cwd=package, timeout=300)
    if ctx is not None and ctx.settings.get("testCommand"):
        return tool_module.run_command(str(ctx.settings["testCommand"]), cwd=root, timeout=300)
    return {
        "ok": False,
        "detail": "no test suite found next to the brain",
        "hint": "run `python3 -m unittest discover -s brain/tests` from the package, "
                "or set testCommand in the config",
    }


#: The repairs the API and the CLI can run by name.
REPAIRS: Dict[str, Callable[..., Dict[str, Any]]] = {
    "dirs.recreate": _repair_dirs,
    "db.repair": _repair_db,
    "token.rotate": _repair_token,
    "caps.refresh": _repair_caps,
    "cache.prune": _repair_cache,
    "tools.reload": _repair_tools,
    "self.test": _repair_self,
}


def what_changed(ctx: Any, limit: int = 10) -> Dict[str, Any]:
    """
    The history of the machine, as sentences.

    Reading this is how somebody answers "it worked last week" without guessing:
    the snapshots are the record, and the diff is the sentence.
    """
    snapshots = ctx.store.snapshots(limit=limit)
    changes: List[Dict[str, Any]] = []
    for newer, older in zip(snapshots, snapshots[1:]):
        changed = capabilities.diff(older.get("data"), newer.get("data"))
        for line in changed:
            changes.append({"at": newer.get("at"), "change": line})
    return {"ok": True, "changes": changes, "snapshots": len(snapshots)}
