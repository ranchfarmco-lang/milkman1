"""
What this machine can actually do, discovered rather than assumed.

The brain should never guess about its own environment. Before it decides how to
answer something it asks: how many cores are there, is there a GPU, how much
memory, how much disk, which command-line tools are installed, which languages
can compile, which local model servers are running, and is there a network at
all. That answer is the *capability map*, and it is the difference between a
plan that works here and a plan that assumes somebody else's machine.

Two properties matter more than completeness:

* **Nothing leaves the machine.** Every probe is a `which`, a file read or a
  loopback request. The one exception is the reachability check, which is a TCP
  connect with a short timeout, and it exists precisely so the rest of the
  system knows whether the internet is usable right now.
* **A missing tool is not an error.** `probe()` returns what it found; anything
  absent is simply absent, and the caller decides what to do without it.
"""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, Iterable, List

from . import config, providers

#: Commands worth knowing about, grouped by what they are for. Each entry is
#: (binary, args for its version, what it is for).
TOOL_PROBES = [
    ("git", ["--version"], "version control"),
    ("rg", ["--version"], "code and text search"),
    ("fd", ["--version"], "file discovery"),
    ("fzf", ["--version"], "interactive filtering"),
    ("jq", ["--version"], "JSON processing"),
    ("sqlite3", ["--version"], "SQLite from the shell"),
    ("ctags", ["--version"], "symbol index"),
    ("tmux", ["-V"], "persistent sessions"),
    ("curl", ["--version"], "fetching URLs"),
    ("rsync", ["--version"], "copying trees"),
    ("tar", ["--version"], "archives"),
    ("zstd", ["--version"], "compression"),
    ("make", ["--version"], "builds"),
    ("cmake", ["--version"], "builds"),
    ("ninja", ["--version"], "builds"),
    ("gcc", ["--version"], "C compiler"),
    ("clang", ["--version"], "C compiler"),
    ("docker", ["--version"], "containers"),
    ("nvidia-smi", ["--version"], "GPU"),
    ("ffmpeg", ["-version"], "media"),
    ("convert", ["-version"], "images"),
]

#: Languages and runtimes, by the file extension each one can run.
LANGUAGE_PROBES = [
    ("python3", "Python", ".py"),
    ("node", "Node.js", ".js"),
    ("bun", "Bun", ".ts"),
    ("deno", "Deno", ".ts"),
    ("go", "Go", ".go"),
    ("rustc", "Rust", ".rs"),
    ("g++", "C++", ".cpp"),
    ("javac", "Java", ".java"),
    ("ruby", "Ruby", ".rb"),
    ("php", "PHP", ".php"),
]


def _run(args: List[str], timeout: float = 4.0) -> str:
    """Run a command and return the first line of its output, or ""."""
    try:
        done = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        text = (done.stdout or done.stderr or "").strip()
        return text.splitlines()[0].strip() if text else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def binaries() -> Dict[str, Dict[str, Any]]:
    """
    Which of the tools we know about are installed, and their versions.

    Asking each one for its version runs a program, so this is deliberately a
    short, fixed list of harmless commands rather than a scan of `$PATH`.
    """
    found: Dict[str, Dict[str, Any]] = {}
    for name, version_args, purpose in TOOL_PROBES:
        path = shutil.which(name)
        if not path:
            continue
        found[name] = {
            "path": path,
            "version": _run([name, *version_args]),
            "purpose": purpose,
        }
    return found


def languages() -> Dict[str, Dict[str, Any]]:
    """Which languages this machine can run or compile, and with what."""
    found: Dict[str, Dict[str, Any]] = {}
    for binary, label, extension in LANGUAGE_PROBES:
        path = shutil.which(binary)
        if not path:
            continue
        found[label] = {
            "binary": binary,
            "path": path,
            "extension": extension,
            "version": _run([binary, "--version"]) or _run([binary, "-v"]),
        }
    return found


def cpu() -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "model": platform.processor() or platform.machine(),
        "cores": os.cpu_count() or 1,
        "arch": platform.machine(),
        "features": [],
    }
    try:
        text = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if line.startswith("model name") and "|" not in info["model"]:
                info["model"] = line.split(":", 1)[1].strip()
            if line.startswith("flags"):
                flags = set(line.split(":", 1)[1].split())
                # The instruction sets that decide how fast a quantised model
                # runs on this CPU. Worth reporting: it is the difference
                # between usable and unusable for local inference.
                info["features"] = [
                    f for f in ("avx", "avx2", "avx512f", "fma", "amx_bf16")
                    if f in flags
                ]
                break
    except OSError:
        pass
    return info


def memory() -> Dict[str, Any]:
    """Total and available memory in GB, from `/proc/meminfo` where it exists."""
    total = available = 0
    try:
        text = Path("/proc/meminfo").read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if line.startswith("MemTotal:"):
                total = int(line.split()[1]) // 1024
            elif line.startswith("MemAvailable:"):
                available = int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    if not total:
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            size = os.sysconf("SC_PAGE_SIZE")
            total = int(pages * size / (1024 * 1024))
            available = total
        except (ValueError, OSError, AttributeError):
            pass
    return {"totalMb": total, "availableMb": available, "totalGb": round(total / 1024, 1)}


def disk() -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for label, path in (("workspace", config.workspace_dir()), ("data", config.data_dir())):
        try:
            usage = shutil.disk_usage(str(path))
            out[label] = {
                "path": str(path),
                "totalGb": round(usage.total / 1024 ** 3, 1),
                "freeGb": round(usage.free / 1024 ** 3, 1),
            }
        except OSError:
            out[label] = {"path": str(path), "error": "not readable"}
    return out


def gpus() -> List[Dict[str, Any]]:
    """
    GPUs, from the vendor's own tool.

    `nvidia-smi` is the only reliable source of VRAM on an NVIDIA box; on
    anything else this returns an empty list rather than a guess, and the model
    sizing advice falls back to CPU and RAM.
    """
    found: List[Dict[str, Any]] = []
    if shutil.which("nvidia-smi"):
        text = _run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,driver_version",
                "--format=csv,noheader,nounits",
            ],
            timeout=6.0,
        )
        for line in text.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2:
                try:
                    vram = int(parts[1])
                except ValueError:
                    vram = 0
                found.append(
                    {
                        "vendor": "nvidia",
                        "name": parts[0],
                        "vramMb": vram,
                        "driver": parts[2] if len(parts) > 2 else "",
                    }
                )
    if not found and shutil.which("rocm-smi"):
        text = _run(["rocm-smi", "--showproductname"], timeout=6.0)
        if text:
            found.append({"vendor": "amd", "name": text, "vramMb": 0, "driver": ""})
    return found


def reachability(timeout: float = 1.5) -> Dict[str, Any]:
    """
    Is there a network right now?

    A TCP connect, not a download: it is fast, it needs no permission from
    anybody, and it fails cleanly when the machine is offline — which is the
    single most important fact for deciding how the brain will answer.
    """
    targets = os.environ.get("BRAIN_NET_PROBE", "1.1.1.1:53,9.9.9.9:53")
    results: List[Dict[str, Any]] = []
    online = False
    for entry in targets.split(","):
        entry = entry.strip()
        if not entry:
            continue
        host, _, port = entry.partition(":")
        try:
            with socket.create_connection((host, int(port or 53)), timeout=timeout):
                results.append({"target": entry, "ok": True})
                online = True
        except (OSError, ValueError):
            results.append({"target": entry, "ok": False})
    return {"online": online, "probes": results, "checkedAt": time.time()}


def software_by_language() -> Dict[str, str]:
    """The runner the brain will use for each file extension it can execute."""
    return {
        entry["extension"]: entry["binary"]
        for entry in languages().values()
        if entry.get("binary")
    }


def build(store: Any = None, force: bool = False) -> Dict[str, Any]:
    """
    The whole capability map, cached.

    Probes cost a few hundred milliseconds, so the result is kept in the store
    and reused until `capabilityTtl` has passed. A snapshot is also written at
    the end, which is what lets self-diagnostics answer "what changed since
    yesterday?" with facts.
    """
    config.ensure_dirs()
    if store is not None and not force:
        cached = store.get("capabilities")
        if isinstance(cached, dict):
            age = time.time() - float(cached.get("at") or 0)
            if age < float(config.load_config()["capabilityTtl"]):
                return cached

    settings = config.load_config()

    with ThreadPoolExecutor(max_workers=4) as pool:
        tools_future = pool.submit(binaries)
        languages_future = pool.submit(languages)
        models_future = pool.submit(providers.discover, settings)
        network_future = pool.submit(reachability)
        tools = tools_future.result()
        langs = languages_future.result()
        models = models_future.result()
        network = network_future.result()

    map_: Dict[str, Any] = {
        "at": time.time(),
        "host": {
            "hostname": socket.gethostname(),
            "os": platform.system(),
            "distro": distro(),
            "kernel": platform.release(),
            "python": platform.python_version(),
        },
        "cpu": cpu(),
        "memory": memory(),
        "disk": disk(),
        "gpus": gpus(),
        "tools": tools,
        "languages": langs,
        "models": [m for m in models if m.get("ok")],
        "modelServersMissing": [m for m in models if not m.get("ok")],
        "network": network,
        "sandbox": sandbox(settings),
    }

    if store is not None:
        store.put("capabilities", map_)
        previous = store.latest_snapshot()
        summary = summarize(map_)
        # Only record a snapshot when something in the summary moved, so the
        # history stays a list of changes rather than a list of timestamps.
        if previous is None or previous.get("data") != summary:
            store.save_snapshot(summary)

    return map_


def distro() -> str:
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return platform.platform()


def sandbox(settings: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "dataDir": str(config.data_dir()),
        "workspace": str(config.workspace_dir()),
        "writable": all(
            os.access(str(path), os.W_OK)
            for path in (config.data_dir(), config.workspace_dir())
        ),
        "allowExternal": bool(settings.get("allowExternal")),
        "auth": settings.get("auth"),
        "modelTimeout": settings.get("modelTimeout"),
    }


def summarize(map_: Dict[str, Any]) -> Dict[str, Any]:
    """
    The part of the map worth remembering: what exists, not how fast it answered.

    Timings change every run; the tool list does not. Comparing summaries is how
    "what changed?" avoids reporting noise as news.
    """
    def keys(values: Any) -> List[str]:
        return sorted(values.keys()) if isinstance(values, dict) else []

    return {
        "os": map_.get("host", {}).get("distro"),
        "kernel": map_.get("host", {}).get("kernel"),
        "cores": map_.get("cpu", {}).get("cores"),
        "memoryGb": map_.get("memory", {}).get("totalGb"),
        "gpus": [g.get("name") for g in map_.get("gpus", [])],
        "tools": keys(map_.get("tools")),
        "languages": keys(map_.get("languages")),
        "models": sorted(
            f"{m.get('id')}:{name}" for m in map_.get("models", []) for name in (m.get("models") or [])
        ),
        "online": bool(map_.get("network", {}).get("online")),
    }


def diff(before: Any, after: Any) -> List[str]:
    """
    What changed between two summaries, in plain sentences.

    This is the raw material for self-maintenance: a tool that disappeared, a
    model server that stopped answering, or a network that came back all show up
    here as a line somebody can act on.
    """
    lines: List[str] = []
    if not isinstance(before, dict) or not isinstance(after, dict):
        return lines
    for field, label in (
        ("tools", "command-line tool"),
        ("languages", "language runtime"),
    ):
        old = set(before.get(field) or [])
        new = set(after.get(field) or [])
        for name in sorted(old - new):
            lines.append(f"{label} disappeared: {name}")
        for name in sorted(new - old):
            lines.append(f"{label} appeared: {name}")
    old_models = set(before.get("models") or [])
    new_models = set(after.get("models") or [])
    for name in sorted(old_models - new_models):
        lines.append(f"model no longer served: {name}")
    for name in sorted(new_models - old_models):
        lines.append(f"model now served: {name}")
    if before.get("online") != after.get("online"):
        lines.append("network came back" if after.get("online") else "network went away")
    for field, label in (("kernel", "kernel"), ("memoryGb", "memory")):
        if before.get(field) != after.get(field):
            lines.append(f"{label} changed: {before.get(field)} → {after.get(field)}")
    return lines


def require(binary: str) -> bool:
    """Does this one command exist? Used by tools to check before they run."""
    return shutil.which(binary) is not None


def missing(tools: Iterable[str]) -> List[str]:
    return [name for name in tools if not shutil.which(name)]
