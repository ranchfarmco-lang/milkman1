"""
The package manager, and the report that keeps the system moving toward freedom.

Two jobs, and they belong together:

* **Know what is installed, and what the package would install if asked.** The
  brain does not run `apt` behind your back and cannot update itself from a
  service it does not have. What it can do is hold an accurate inventory of every
  tool, runtime and library it depends on, diff that against the last inventory
  so a version that moved overnight is visible, and run the package's *own*
  installer scripts — the ones you already have on disk — when you ask it to.
* **Say what could stop being a dependency.** Every external capability the
  system uses is listed next to the local or self-hosted thing that could replace
  it. This is the report that answers "can this be moved onto my own machine?"
  with a specific script name instead of a shrug, and it is the mechanism by which
  the project becomes more independent over time rather than less.

Nothing here reaches the network. An update *check* is a comparison against what
this machine already has, and an update *run* executes a file from the package's
own `scripts/` directory — so both work with the cable out, which is the whole
point of owning the update path.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import capabilities, config

#: What each installer in the package is for, so a plan can be read rather than
#: deduced from a filename.
SCRIPT_PURPOSE: Dict[str, str] = {
    "setup-all.sh": "every installer, in order — idempotent",
    "install-supporting.sh": "runtimes and base tooling: python, node, bun, rust, go, git",
    "install-runtimes.sh": "llama.cpp, Ollama, vLLM, MLX and the model servers",
    "install-reasoning.sh": "planning, structured output, verification and review engines",
    "install-agents.sh": "the coding agents, pointed at a local model",
    "install-coding-tools.sh": "ripgrep, ast-grep, ctags, diffs, linters and language servers",
    "install-terminal-tools.sh": "tmux, process and log inspection, debuggers",
    "install-file-tools.sh": "find, archives, sync and file watchers",
    "install-browser-tools.sh": "Playwright, Selenium and page extraction",
    "install-research-tools.sh": "SearXNG, DevDocs and offline documentation",
    "install-context-memory.sh": "codebase indexing, vector stores and memory frameworks",
    "install-libraries.sh": "the Python and Node libraries the stack imports",
    "capture-freebuff-source.sh": "unpack the Freebuff reference source from the archive in this package",
}

#: The independence candidates: for a capability, what a keyed or hosted
#: connector could be replaced by, and how.
REPLACEMENTS: Dict[str, Dict[str, Any]] = {
    "web_search": {
        "instead": "a paid search API",
        "use": "SearXNG on this machine",
        "how": "scripts/install-research-tools.sh",
        "note": "Same breadth, no key, no quota, and it keeps working offline via the cache.",
    },
    "llm": {
        "instead": "a hosted model API",
        "use": "Ollama, llama.cpp, vLLM or LM Studio on loopback",
        "how": "scripts/install-runtimes.sh && scripts/download-models.sh",
        "note": "The brain already prefers a local server whenever one is answering.",
    },
    "email": {
        "instead": "a hosted mail provider",
        "use": "your own SMTP server",
        "how": "set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD",
        "note": "smtplib is in the standard library, so this needs no package at all.",
    },
    "storage": {
        "instead": "a hosted drive",
        "use": "the local filesystem, or WebDAV against a server you run",
        "how": "nothing to install: the workspace is already yours",
        "note": "rsync and rclone move a tree anywhere without a service in the middle.",
    },
    "notify": {
        "instead": "a push service",
        "use": "ntfy, self-hosted",
        "how": "run ntfy and set NTFY_URL and NTFY_TOPIC",
        "note": "Notifications from a server on your own network.",
    },
    "documentation": {
        "instead": "an online documentation index",
        "use": "DevDocs downloaded once",
        "how": "scripts/install-research-tools.sh",
        "note": "Readable with no network at all.",
    },
    "maps": {
        "instead": "a commercial geocoding API",
        "use": "OpenStreetMap / Nominatim, or a self-hosted instance",
        "how": "scripts/install-supporting.sh",
        "note": "Keyless already; self-host it and the same calls keep working.",
    },
}


def package_root() -> Path:
    """
    The folder the package was unpacked into.

    `brain/src/updater.py` → `brain/src` → `brain` → the package. Everything the
    package ships (the scripts, the docs, the models folder) is found from here,
    which is what lets the whole thing live on an external drive.
    """
    return Path(__file__).resolve().parents[2]


def scripts_dir() -> Path:
    return package_root() / "scripts"


def installers() -> List[Dict[str, Any]]:
    """Every installer the package ships, with what it is for and whether it is here."""
    found: List[Dict[str, Any]] = []
    directory = scripts_dir()
    if not directory.exists():
        return found
    for path in sorted(directory.glob("*.sh")):
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        found.append(
            {
                "name": path.name,
                "path": str(path),
                "purpose": SCRIPT_PURPOSE.get(path.name, "an installer from the package"),
                "bytes": size,
                "runnable": os.access(str(path), os.R_OK),
            }
        )
    entry = package_root() / "GET-EVERYTHING.sh"
    if entry.exists():
        found.insert(
            0,
            {
                "name": "GET-EVERYTHING.sh",
                "path": str(entry),
                "purpose": "install everything and download the models, onto this drive",
                "bytes": entry.stat().st_size,
                "runnable": os.access(str(entry), os.R_OK),
            },
        )
    return found


def _inventory_of(built: Dict[str, Any]) -> Dict[str, Any]:
    """The versions worth watching, flattened so two inventories can be compared."""
    return {
        "brain": config.VERSION,
        "python": built.get("host", {}).get("python"),
        "kernel": built.get("host", {}).get("kernel"),
        "tools": {
            name: entry.get("version") or "installed"
            for name, entry in (built.get("tools") or {}).items()
        },
        "languages": {
            name: entry.get("version") or "installed"
            for name, entry in (built.get("languages") or {}).items()
        },
        "models": sorted(
            f"{server.get('id')}:{model}"
            for server in built.get("models") or []
            for model in server.get("models") or []
        ),
    }


def diff_inventory(before: Any, after: Dict[str, Any]) -> List[str]:
    """
    What moved since the last inventory, in sentences.

    Version changes, tools that appeared or vanished, and models that are no
    longer served — the same shape as the capability diff, because "what changed?"
    should read the same way wherever it is asked.
    """
    lines: List[str] = []
    if not isinstance(before, dict):
        return lines
    for section, label in (("tools", "tool"), ("languages", "runtime")):
        old = before.get(section) or {}
        new = after.get(section) or {}
        if not isinstance(old, dict):
            continue
        for name in sorted(set(new) - set(old)):
            lines.append(f"{label} added: {name} {new[name]}")
        for name in sorted(set(old) - set(new)):
            lines.append(f"{label} gone: {name} (was {old[name]})")
        for name in sorted(set(old) & set(new)):
            if old[name] != new[name]:
                lines.append(f"{label} updated: {name} {old[name]} → {new[name]}")
    for field in ("python", "kernel", "brain"):
        if before.get(field) and after.get(field) and before[field] != after[field]:
            lines.append(f"{field} changed: {before[field]} → {after[field]}")
    old_models = set(before.get("models") or [])
    new_models = set(after.get("models") or [])
    for name in sorted(old_models - new_models):
        lines.append(f"model no longer served: {name}")
    for name in sorted(new_models - old_models):
        lines.append(f"model now served: {name}")
    return lines


def check(store: Any, ctx: Any, refresh: bool = False) -> Dict[str, Any]:
    """
    The whole picture: what is here, what the package would add, what moved.

    `refresh` re-probes the machine; otherwise the cached capability map is used,
    so opening this page costs nothing.
    """
    built = capabilities.build(store, force=bool(refresh))
    inventory = _inventory_of(built)
    previous = store.get("package.inventory")
    changes = diff_inventory(previous, inventory)
    if refresh or previous is None:
        store.put("package.inventory", inventory)

    present = set((built.get("tools") or {}).keys()) | set((built.get("languages") or {}).keys())
    suggestions: List[Dict[str, str]] = []
    for name, why, script in (
        ("rg", "file and code search falls back to a slower Python walk", "scripts/install-coding-tools.sh"),
        ("git", "nothing can be versioned or diffed", "scripts/install-supporting.sh"),
        ("sqlite3", "the shell for reading the memory database by hand", "scripts/install-supporting.sh"),
        ("llama-server", "no local model can be served by llama.cpp", "scripts/install-runtimes.sh"),
        ("ollama", "the easiest way to run a local model", "scripts/install-runtimes.sh"),
        ("docker", "the self-hosted services run as containers", "scripts/install-supporting.sh"),
    ):
        if name not in present:
            suggestions.append({"missing": name, "why": why, "install": script})

    return {
        "ok": True,
        "at": time.time(),
        "version": config.VERSION,
        "packageRoot": str(package_root()),
        "packagePresent": package_root().exists(),
        "inventory": inventory,
        "changes": changes,
        "suggestions": suggestions,
        "installers": installers(),
        "independence": independence_report(store),
        "note": (
            "Nothing here contacted a service: an update check compares this machine "
            "with itself, and an update run executes an installer you already have."
        ),
    }


def run_installer(store: Any, ctx: Any, name: str, timeout: float = 3600.0) -> Dict[str, Any]:
    """
    Run one installer from the package, by name.

    The name is matched against the installers the package actually ships, so a
    caller can never name a path outside `scripts/`. Long timeout by default: an
    installer that fetches compilers and Python environments is measured in
    minutes, not seconds.
    """
    from . import tools as tool_module

    wanted = name.strip()
    if not wanted.endswith(".sh"):
        wanted = f"{wanted}.sh"
    known = {entry["name"]: entry for entry in installers()}
    entry = known.get(wanted)
    if entry is None:
        return {
            "ok": False,
            "error": f"no such installer: {name}",
            "available": sorted(known),
        }
    store.event("info", "package", f"running {wanted}")
    result = tool_module.run_command(
        f"bash {tool_module._quote(entry['path'])}",  # noqa: SLF001 - same package
        cwd=package_root(),
        timeout=timeout,
    )
    store.event(
        "info" if result.get("ok") else "warn",
        "package",
        f"{wanted} {'finished' if result.get('ok') else 'failed'}",
        {"ms": result.get("ms"), "exitCode": result.get("exitCode")},
    )
    result["installer"] = wanted
    return result


def independence_report(store: Any) -> Dict[str, Any]:
    """
    Every outside capability in use, next to what could replace it.

    This is §12 of the brief made concrete: not "prefer open source" as a
    principle, but a list of the specific services currently reachable, whether
    each one needs a key or an account, and the name of the installer or setting
    that would move it onto your own machine.
    """
    from . import connectors

    entries = connectors.describe(store)
    by_capability: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        bucket = by_capability.setdefault(
            entry["capability"],
            {"capability": entry["capability"], "inUse": [], "local": [], "free": [], "keyed": []},
        )
        if entry["ready"]:
            bucket["inUse"].append(entry["id"])
        bucket[{"local": "local", "free": "free"}.get(entry["tier"], "keyed")].append(entry["id"])

    report: List[Dict[str, Any]] = []
    for capability, bucket in sorted(by_capability.items()):
        replacement = REPLACEMENTS.get(capability, {})
        using_local = any(name in bucket["local"] for name in bucket["inUse"])
        report.append(
            {
                **bucket,
                "independent": using_local or not bucket["keyed"],
                "couldBeReplaced": bool(bucket["keyed"]) and not using_local,
                "instead": replacement.get("instead", ""),
                "use": replacement.get("use", ""),
                "how": replacement.get("how", ""),
                "note": replacement.get("note", ""),
            }
        )

    dependent = [entry for entry in report if entry["couldBeReplaced"]]
    return {
        "capabilities": report,
        "independent": sum(1 for entry in report if entry["independent"]),
        "couldBeReplaced": len(dependent),
        "summary": (
            "every configured capability can be served from this machine"
            if not dependent
            else f"{len(dependent)} capability(ies) are served by a service that could be "
                 "replaced with something local"
        ),
    }


def status_line(store: Any) -> str:
    """One sentence for the CLI: what this machine is missing, if anything."""
    built = capabilities.build(store)
    present = set((built.get("tools") or {}).keys())
    gaps = [name for name in ("rg", "sqlite3", "ollama", "llama-server") if name not in present]
    if not gaps:
        return "everything the brain recommends is installed"
    return "missing: " + ", ".join(gaps) + " (see `brain.py update check`)"


def brain_version_note() -> str:
    """
    How this copy of the brain gets updated.

    There is no self-update over the network, on purpose: the brain is files, and
    replacing files is something a person does deliberately — copy the new
    `brain/` directory over the old one and the memory, being a separate
    database, is untouched.
    """
    return (
        "The brain is files. To update it, replace the brain/ directory with a newer "
        "copy — the database in the data directory is separate and is not touched."
    )
