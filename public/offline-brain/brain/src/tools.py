"""
The toolbox, and the ability to add a tool to it.

A tool is a name, a description, a list of arguments, and a function. That is
all the brain needs to decide what to call, and all it needs to make a new one:
`tools.new` writes a Python file into `<workspace>/tools/`, and the registry
picks it up. This is how the system stops hitting the same wall twice — the
second time it needs something, the tool already exists, and it exists as plain
readable source the person owns.

Everything here is deliberately local. A tool either touches the machine, the
brain's own memory, or the network through the information layer, and the ones
that touch the network say so in their description so a caller can skip them
when the machine is offline.

Guarding is honest rather than airtight. `shell.run` refuses the handful of
commands that destroy a machine, runs with a timeout, and works inside the
workspace unless told otherwise — the same posture as a careful person at a
terminal, not a jail. A sandbox that lies about being a sandbox is worse than a
clear boundary, so the boundary is stated: the workspace is the brain's to use,
and anything outside it asks first.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import capabilities, config, info, providers

#: Commands that destroy a machine or a dataset. Matched anywhere in the line,
#: because `sudo rm -rf /` finds its way into more scripts than anybody expects.
BLOCKED_PATTERNS = [
    r"rm\s+-[a-z]*[rf][a-z]*\s+/(\s|$)",
    r"\bmkfs(\.|\s)",
    r"\bdd\b[^\n]*\bof=/dev/(sd|nvme|hd|vd)",
    r":\(\)\s*\{\s*:\|:&\s*\}\s*;:",
    r">\s*/dev/(sd|nvme|hd|vd)",
    r"\b(shutdown|reboot|halt|poweroff)\b",
    r"\bchmod\s+-R\s+777\s+/(\s|$)",
    r"\bmv\s+/\s",
]

#: Where a command may write. `shell.run` is confined to the workspace unless a
#: caller passes `outside=true`, which it has to do deliberately.
def _sandbox_root() -> Path:
    return config.workspace_dir()


class ToolError(Exception):
    """A tool refused, or failed in a way worth telling the caller about."""


class ToolContext:
    """What a tool is given: the store, the settings, and the guard rails."""

    def __init__(self, store: Any, settings: Dict[str, Any], capability_map: Optional[Dict[str, Any]] = None):
        self.store = store
        self.settings = settings
        self._capabilities = capability_map
        self.workspace = config.workspace_dir()
        self.started = time.time()

    def capability(self, section: str, default: Any = None) -> Any:
        if self._capabilities is None:
            self._capabilities = capabilities.build(self.store)
        return self._capabilities.get(section, default)

    def resolve(self, path: str, must_exist: bool = True, outside: bool = False) -> Path:
        """
        A path inside the workspace, or a refusal.

        Relative paths are resolved against the workspace, so a tool never
        depends on which directory the server happened to start in.
        """
        raw = Path(path).expanduser()
        target = raw if raw.is_absolute() else self.workspace / raw
        target = Path(os.path.normpath(str(target)))
        if not outside:
            root = _sandbox_root().resolve()
            try:
                target.resolve().relative_to(root)
            except ValueError as error:
                raise ToolError(
                    f"{target} is outside the workspace ({root}); pass outside=true "
                    "to reach it on purpose"
                ) from error
        if must_exist and not target.exists():
            raise ToolError(f"no such file or directory: {target}")
        return target


class Tool:
    def __init__(
        self,
        name: str,
        summary: str,
        args: Dict[str, str],
        run: Callable[..., Any],
        needs_network: bool = False,
        mutates: bool = False,
        source: str = "builtin",
    ) -> None:
        self.name = name
        self.summary = summary
        self.args = args
        self.run = run
        self.needs_network = needs_network
        self.mutates = mutates
        self.source = source

    def describe(self, stats: Optional[Dict[str, Any]] = None, broken: Optional[str] = None) -> Dict[str, Any]:
        return {
            "name": self.name,
            "summary": self.summary,
            "args": self.args,
            "needsNetwork": self.needs_network,
            "mutates": self.mutates,
            "source": self.source,
            "stats": stats or {},
            "broken": broken,
        }


# ------------------------------------------------------------------------ helpers


def _truncate(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [{len(text) - limit} more characters]"


def run_command(
    command: str,
    cwd: Optional[Path] = None,
    timeout: float = 120.0,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Run a shell command and come back with everything a diagnosis needs.

    Exit code, stdout, stderr and duration all come back even when the command
    fails, because "it failed" without the output is not something anybody can
    act on. The timeout kills the process group, so a hung child cannot hold the
    brain hostage.
    """
    for pattern in BLOCKED_PATTERNS:
        if re.search(pattern, command):
            return {
                "ok": False,
                "blocked": True,
                "error": f"refused: this command matches a pattern that destroys data ({pattern})",
                "command": command,
            }

    started = time.time()
    environment = dict(os.environ)
    environment.update(env or {})
    try:
        done = subprocess.run(
            command,
            shell=True,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=environment,
            # Its own process group, so the timeout can take the children too.
            start_new_session=True,
        )
        return {
            "ok": done.returncode == 0,
            "exitCode": done.returncode,
            "stdout": _truncate(done.stdout or ""),
            "stderr": _truncate(done.stderr or ""),
            "ms": int((time.time() - started) * 1000),
            "command": command,
            "cwd": str(cwd) if cwd else str(Path.cwd()),
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "timeout": True,
            "error": f"took longer than {timeout:g}s and was killed",
            "command": command,
            "ms": int((time.time() - started) * 1000),
        }
    except OSError as error:
        return {"ok": False, "error": str(error), "command": command}


def interpreter_for(path: Path) -> Optional[str]:
    """Which program runs this file, based on what the machine actually has."""
    mapping = {
        ".py": "python3",
        ".js": "node",
        ".mjs": "node",
        ".ts": "bun",
        ".sh": "bash",
        ".rb": "ruby",
        ".go": "go",
        ".rs": None,  # needs a compile step, not a run step
    }
    wanted = mapping.get(path.suffix)
    if wanted and capabilities.require(wanted):
        return wanted
    if path.suffix == ".ts" and capabilities.require("deno"):
        return "deno run"
    return None


# ------------------------------------------------------------------- built-ins


def tool_capabilities(ctx: ToolContext, section: str = "", fresh: bool = False) -> Dict[str, Any]:
    """The capability map — what this machine has — optionally one section of it."""
    built = capabilities.build(ctx.store, force=bool(fresh))
    if section:
        return {"ok": True, "section": section, "value": built.get(section)}
    return {"ok": True, "capabilities": built}


def tool_fs_list(ctx: ToolContext, path: str = ".", depth: int = 2, limit: int = 300, **_: Any) -> Dict[str, Any]:
    """List a directory tree, so the brain can see what is actually there."""
    root = ctx.resolve(path)
    if root.is_file():
        return {"ok": True, "path": str(root), "entries": [{"path": str(root), "type": "file"}]}
    entries: List[Dict[str, Any]] = []
    stack = [(root, 0)]
    while stack and len(entries) < limit:
        current, level = stack.pop()
        try:
            children = sorted(current.iterdir(), key=lambda item: (item.is_file(), item.name))
        except OSError as error:
            entries.append({"path": str(current), "error": str(error)})
            continue
        for child in children:
            entries.append(
                {
                    "path": str(child.relative_to(root)) or ".",
                    "type": "dir" if child.is_dir() else "file",
                    "bytes": child.stat().st_size if child.is_file() else None,
                }
            )
            if child.is_dir() and level + 1 < depth:
                stack.append((child, level + 1))
            if len(entries) >= limit:
                break
    return {"ok": True, "root": str(root), "depth": depth, "entries": entries, "truncated": len(entries) >= limit}


def tool_fs_read(
    ctx: ToolContext,
    path: str,
    start: int = 1,
    lines: int = 400,
    outside: bool = False,
    **_: Any,
) -> Dict[str, Any]:
    """Read a file by line range, so a long file can be paged instead of dumped."""
    target = ctx.resolve(path, outside=outside)
    limit_bytes = int(config.load_config()["maxReadBytes"])
    size = target.stat().st_size
    if size > limit_bytes and lines <= 0:
        raise ToolError(f"{target} is {size} bytes; pass a line range")
    text = target.read_text(encoding="utf-8", errors="replace")
    all_lines = text.splitlines()
    begin = max(1, int(start))
    window = all_lines[begin - 1: begin - 1 + max(1, int(lines))]
    return {
        "ok": True,
        "path": str(target),
        "lines": len(all_lines),
        "from": begin,
        "text": "\n".join(window),
        "truncated": begin - 1 + len(window) < len(all_lines),
    }


def tool_fs_write(
    ctx: ToolContext,
    path: str,
    text: str,
    append: bool = False,
    outside: bool = False,
    **_: Any,
) -> Dict[str, Any]:
    """Write a file, making the directories it needs."""
    target = ctx.resolve(path, must_exist=False, outside=outside)
    target.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if append else "w"
    with target.open(mode, encoding="utf-8") as stream:
        stream.write(text)
    ctx.store.event("info", "tool", f"wrote {target} ({len(text)} chars)")
    return {"ok": True, "path": str(target), "bytes": len(text.encode("utf-8")), "append": append}


def tool_fs_search(ctx: ToolContext, query: str, root: str = ".", limit: int = 40, **_: Any) -> Dict[str, Any]:
    """Search the workspace by text or regular expression."""
    target = ctx.resolve(root, must_exist=False)
    hits = info.search_files(query, root=str(target), limit=int(limit))
    return {"ok": True, "query": query, "hits": hits, "count": len(hits)}


def tool_shell_run(
    ctx: ToolContext,
    command: str,
    cwd: str = ".",
    timeout: float = 0,
    outside: bool = False,
    **_: Any,
) -> Dict[str, Any]:
    """Run a command in the workspace and bring back its output."""
    workdir = ctx.resolve(cwd, must_exist=False, outside=outside)
    workdir.mkdir(parents=True, exist_ok=True)
    limit = float(timeout or config.load_config()["toolTimeout"])
    result = run_command(command, cwd=workdir, timeout=limit)
    ctx.store.record_tool_run(
        "shell.run",
        {"command": command},
        bool(result.get("ok")),
        int(result.get("ms") or 0),
        result.get("error"),
        (result.get("stdout") or "")[:500],
    )
    return result


def tool_code_run(
    ctx: ToolContext,
    code: str = "",
    path: str = "",
    language: str = "",
    explain: bool = False,
    **_: Any,
) -> Dict[str, Any]:
    """
    Write code to the scratch area and run it.

    The development loop needs this to be one call: put the file somewhere
    predictable, run it with whatever interpreter the machine actually has, and
    hand back stdout, stderr and the exit code together.
    """
    if path and not code:
        target = ctx.resolve(path)
    else:
        extensions = {value: key for key, value in capabilities.software_by_language().items()}
        extension = _extension_for(language, extensions, code)
        target = config.scratch_dir() / f"snippet-{int(time.time() * 1000)}{extension}"
        ctx.resolve(target, must_exist=False)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(code, encoding="utf-8")

    if explain:
        return {"ok": True, "path": str(target), "interpreter": interpreter_for(target), "ran": False}

    runner = interpreter_for(target)
    if not runner:
        return {
            "ok": False,
            "path": str(target),
            "error": f"no interpreter on this machine runs {target.suffix or 'that'} files",
            "hint": "check `brain.py caps` for what is installed",
        }
    command = f"{runner} {_quote(str(target))}"
    result = run_command(command, cwd=target.parent, timeout=float(config.load_config()["toolTimeout"]))
    result["path"] = str(target)
    result["interpreter"] = runner
    ctx.store.record_tool_run(
        "code.run", {"path": str(target)}, bool(result.get("ok")),
        int(result.get("ms") or 0), result.get("error"), (result.get("stdout") or "")[:500],
    )
    return result


def _extension_for(language: str, extensions: Dict[str, str], code: str) -> str:
    wanted = (language or "").strip().lower()
    names = {
        "python": ".py", "py": ".py", "javascript": ".js", "js": ".js",
        "typescript": ".ts", "ts": ".ts", "bash": ".sh", "sh": ".sh",
        "shell": ".sh", "ruby": ".rb", "go": ".go",
    }
    if wanted in names:
        return names[wanted]
    if code.lstrip().startswith(("import ", "def ", "from ")):
        return ".py"
    if code.lstrip().startswith(("#!/", "set -e", "echo ")):
        return ".sh"
    return ".py"


def _quote(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


def tool_code_test(ctx: ToolContext, command: str = "", path: str = ".", **_: Any) -> Dict[str, Any]:
    """
    Run the tests, whichever framework this project actually uses.

    With no command configured it looks for the usual suspects, so "run the
    tests" works in a fresh project without anybody writing a config first.
    """
    root = ctx.resolve(path, must_exist=False)
    chosen = command or str(ctx.settings.get("testCommand") or "")
    if not chosen:
        if (root / "package.json").exists():
            try:
                scripts = json.loads((root / "package.json").read_text(encoding="utf-8")).get("scripts") or {}
            except (OSError, ValueError):
                scripts = {}
            if "test" in scripts:
                chosen = "bun test" if capabilities.require("bun") else "npm test"
        if not chosen and list(root.glob("tests/*.py")) or (root / "pytest.ini").exists():
            chosen = "python3 -m pytest -q" if _has_module("pytest") else "python3 -m unittest discover -s tests"
        if not chosen and (root / "Cargo.toml").exists():
            chosen = "cargo test"
        if not chosen and (root / "go.mod").exists():
            chosen = "go test ./..."
        if not chosen:
            return {
                "ok": False,
                "error": "no test command here; set one with `brain.py config testCommand \"...\"`",
                "checked": str(root),
            }
    result = run_command(chosen, cwd=root, timeout=float(config.load_config()["toolTimeout"]) * 3)
    result["command"] = chosen
    ctx.store.record_tool_run(
        "code.test", {"command": chosen}, bool(result.get("ok")),
        int(result.get("ms") or 0), result.get("error"), (result.get("stdout") or "")[:500],
    )
    return result


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def tool_memory_write(ctx: ToolContext, text: str, tags: str = "", pinned: bool = False, **_: Any) -> Dict[str, Any]:
    """Remember something, so the next run does not have to work it out again."""
    memory_id = ctx.store.remember(
        text, tags=[t for t in tags.split(",") if t.strip()], source="tool", pinned=pinned
    )
    return {"ok": True, "id": memory_id, "count": ctx.store.count_memory()}


def tool_memory_search(ctx: ToolContext, query: str, limit: int = 10, **_: Any) -> Dict[str, Any]:
    """Search what the brain remembers."""
    hits = ctx.store.search_memory(query, limit=int(limit))
    return {"ok": True, "query": query, "hits": hits, "count": len(hits)}


def tool_info_lookup(ctx: ToolContext, query: str, tiers: str = "", limit: int = 5, **_: Any) -> Dict[str, Any]:
    """Look something up, walking the information hierarchy until something answers."""
    chosen = [t.strip() for t in tiers.split(",") if t.strip()] or None
    return info.lookup(query, ctx, tiers=chosen, limit=int(limit))


def tool_http_get(ctx: ToolContext, url: str, max_age: float = 0, **_: Any) -> Dict[str, Any]:
    """Fetch a page or an API answer, from the cache when there is one."""
    result = info.fetch(url, max_age=float(max_age or 86_400.0))
    if result.get("ok"):
        result["text"] = _truncate(result.get("text") or "", 8000)
    return result


def tool_tools_list(ctx: ToolContext, **_: Any) -> Dict[str, Any]:
    """Every tool, with how it has been behaving."""
    return {"ok": True, "tools": registry.describe_all(ctx.store)}


def tool_tools_new(
    ctx: ToolContext,
    name: str,
    summary: str,
    body: str,
    args: str = "",
    **_: Any,
) -> Dict[str, Any]:
    """
    Write a new tool for the brain to keep.

    The file it writes is ordinary Python that a person can read, edit and
    version — which is the whole point of tools being files rather than prompts.
    """
    clean = re.sub(r"[^a-z0-9_]", "_", name.strip().lower())
    if not clean or clean[0].isdigit():
        raise ToolError("a tool name has to start with a letter and hold only letters, digits or _")
    if "def run(" not in body:
        raise ToolError("the tool body must define `def run(ctx, **args)`")
    config.tools_dir().mkdir(parents=True, exist_ok=True)
    target = config.tools_dir() / f"{clean}.py"
    source = f'''"""
{summary}

Written by the brain itself. Edit it freely: it is loaded on start, and a
version that raises is reported as broken rather than taking the brain down.
"""

TOOL = {{
    "name": {json.dumps(clean)},
    "summary": {json.dumps(summary)},
    "args": {json.dumps(_parse_args(args))},
}}


{body.strip()}
'''
    target.write_text(source, encoding="utf-8")
    loaded = registry.load_external()
    ctx.store.event("info", "tool", f"wrote tool {clean}", {"path": str(target)})
    return {
        "ok": True,
        "path": str(target),
        "registered": clean in loaded["loaded"],
        "broken": loaded["broken"].get(clean),
        "summary": summary,
    }


def _parse_args(raw: str) -> Dict[str, str]:
    """
    Argument descriptions, from `name:description` pairs or a JSON object.

    Both shapes are accepted because the model writing the tool will produce one
    or the other, and rejecting either would just be friction.
    """
    if not raw.strip():
        return {}
    stripped = raw.strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                return {str(k): str(v) for k, v in parsed.items()}
        except ValueError:
            pass
    out: Dict[str, str] = {}
    for piece in stripped.split(","):
        key, _, description = piece.partition(":")
        if key.strip():
            out[key.strip()] = description.strip() or "no description"
    return out


def tool_providers_status(ctx: ToolContext, **_: Any) -> Dict[str, Any]:
    """Which model servers are answering, and what they are serving."""
    servers = providers.discover(ctx.settings)
    return {
        "ok": any(server["ok"] for server in servers),
        "servers": servers,
        "hint": providers.start_hint(servers),
    }


def tool_connectors_status(ctx: ToolContext, capability: str = "", **_: Any) -> Dict[str, Any]:
    """Which external capabilities are available, and what each is missing."""
    from . import connectors

    if capability:
        return {"ok": True, **connectors.resolve(ctx.store, capability)}
    return {"ok": True, "connectors": connectors.describe(ctx.store), "summary": connectors.summary(ctx.store)}


def tool_diag_check(ctx: ToolContext, deep: bool = False, **_: Any) -> Dict[str, Any]:
    """Check the brain's own machine, tools and dependencies, and say what is wrong."""
    from . import diagnostics

    return diagnostics.report(ctx, deep=bool(deep))


def tool_group(ctx: ToolContext, root: str, pattern: str = "*", **_: Any) -> Dict[str, Any]:
    """
    Group the files under a directory by extension, with counts and sizes.

    Small, but it is exactly the kind of thing that gets asked for twice, which
    is the case this toolbox exists for.
    """
    target = ctx.resolve(root, must_exist=False)
    target = ctx.resolve(root, must_exist=False)
    buckets: Dict[str, Dict[str, Any]] = {}
    for path in target.rglob(pattern) if target.exists() else []:
        if not path.is_file():
            continue
        key = path.suffix.lower() or "(none)"
        bucket = buckets.setdefault(key, {"files": 0, "bytes": 0, "examples": []})
        bucket["files"] += 1
        try:
            bucket["bytes"] += path.stat().st_size
        except OSError:
            pass
        if len(bucket["examples"]) < 3:
            bucket["examples"].append(str(path.relative_to(target)))
    ordered = sorted(buckets.items(), key=lambda item: item[1]["files"], reverse=True)
    return {"ok": True, "root": str(target), "groups": [{"extension": k, **v} for k, v in ordered]}


def tool_git_run(ctx: ToolContext, args: str = "status", **_: Any) -> Dict[str, Any]:
    """"
    Run git inside a workspace repository, refusing anything that leaves it.

    The safe-by-default wrapper around version control: pushes and force
    operations are refused outright, and --git-dir/--work-tree injections are
    rejected so a caller cannot repoint git at another repository.
    """
    if not capabilities.require("git"):
        return {"ok": False, "error": "git is not installed on this machine.", "install": "scripts/install-coding-tools.sh"}
    argv = shlex.split(args)
    if not argv:
        return {"ok": False, "error": "no git arguments given"}
    if argv[0] in {"push", "remote"}:
        return {"ok": False, "error": f"refusing `git {argv[0]}`: pushing is a person's decision, not a tool's"}
    for flag in ("--force", "-f", "--hard", "--git-dir", "--work-tree"):
        if flag in argv:
            return {"ok": False, "error": f"refusing `git` with {flag}: destructive or escaping the workspace"}
    return run_command(shlex.join(["git", *argv]), timeout=60)


def tool_lint_run(ctx: ToolContext, path: str = ".", tool: str = "", **_: Any) -> Dict[str, Any]:
    """
    Lint a file or a project with the first linter this machine actually has.

    `tool` picks one explicitly (ruff, eslint, biome, shellcheck); left blank,
    each is tried in turn. Nothing is installed here — the installers own that,
    and a machine with no linters gets told so honestly.
    """
    target = ctx.resolve(path, must_exist=False)
    candidates = [tool] if tool else ["ruff", "eslint", "biome", "shellcheck"]
    for name in candidates:
        if not capabilities.require(name):
            continue
        argv = [name, "check", str(target)] if name == "ruff" else [name, str(target)]
        result = run_command(shlex.join(argv), timeout=120)
        result["linter"] = name
        return result
    return {
        "ok": False,
        "error": "no linter found (tried: " + ", ".join(candidates) + ")",
        "install": "scripts/install-coding-tools.sh",
    }


def tool_build_run(ctx: ToolContext, path: str = ".", command: str = "", **_: Any) -> Dict[str, Any]:
    """
    Build a project with its own tooling, detected or named.

    Detection order: an explicit `command`, then the conventional build files —
    Makefile, pyproject.toml, package.json, CMakeLists.txt. A project this
    machine has no builder for is reported, not pretended at.
    """
    target = ctx.resolve(path, must_exist=False)
    if command:
        return run_command(command, cwd=target, timeout=600)
    if (target / "Makefile").exists() and capabilities.require("make"):
        return run_command("make", cwd=target, timeout=600)
    if (target / "pyproject.toml").exists() and capabilities.require("python3"):
        return run_command("python3 -m pip install -e .", cwd=target, timeout=600)
    if (target / "package.json").exists():
        for runner in ("bun", "npm"):
            if capabilities.require(runner):
                return run_command(f"{runner} run build", cwd=target, timeout=600)
    if (target / "CMakeLists.txt").exists() and capabilities.require("cmake"):
        return run_command(f"cmake -S {shlex.quote(str(target))} -B {shlex.quote(str(target / 'build'))}", timeout=600)
    return {"ok": False, "error": "no build recipe detected (Makefile, pyproject.toml, package.json, CMakeLists.txt)"}


def tool_tools_doctor(ctx: ToolContext, **_: Any) -> Dict[str, Any]:
    """
    The coding toolchain, checked: what is installed, what is missing, and the
    exact installer that would add each missing piece.
    """
    wanted = ["git", "rg", "fd", "jq", "ctags", "make", "cmake", "gcc", "clang", "docker", "uv", "node", "bun", "python3"]
    found, missing = [], []
    for name in wanted:
        if capabilities.require(name):
            found.append(name)
        else:
            missing.append(name)
    return {
        "ok": True,
        "installed": found,
        "missing": missing,
        "installer": "scripts/install-coding-tools.sh" if missing else None,
        "note": "a missing tool is not an error; it is the next thing to install",
    }


# ---------------------------------------------------------------------- registry


BUILTIN: List[Tool] = [
    Tool("caps.get", "The capability map: CPU, GPU, memory, disk, tools, "
         "languages, model servers and whether there is a network.",
         {"section": "one section only, or blank for all", "fresh": "true to re-probe"},
         tool_capabilities),
    Tool("fs.list", "List a directory tree inside the workspace.",
         {"path": "directory, relative to the workspace", "depth": "how deep", "limit": "max entries"},
         tool_fs_list),
    Tool("fs.read", "Read a file, by line range when it is long.",
         {"path": "file to read", "start": "first line (1)", "lines": "how many"},
         tool_fs_read),
    Tool("fs.write", "Write a file, creating the directories it needs.",
         {"path": "file to write", "text": "contents", "append": "true to add to the end"},
         tool_fs_write, mutates=True),
    Tool("fs.search", "Search the workspace for text or a regular expression.",
         {"query": "what to look for", "root": "where to start", "limit": "max hits"},
         tool_fs_search),
    Tool("shell.run", "Run a shell command in the workspace and return its output.",
         {"command": "the command", "cwd": "working directory", "timeout": "seconds",
          "outside": "true to leave the workspace"},
         tool_shell_run, mutates=True),
    Tool("code.run", "Write code to scratch and run it, returning stdout, stderr "
         "and the exit code together.",
         {"code": "the source", "language": "python, javascript, typescript, bash…",
          "path": "run a file that already exists instead", "explain": "true to only report the runner"},
         tool_code_run, mutates=True),
    Tool("code.test", "Run this project's tests, detected or configured.",
         {"command": "override the detected one", "path": "project root"},
         tool_code_test, mutates=True),
    Tool("memory.write", "Remember something worth keeping.",
         {"text": "what to remember", "tags": "comma-separated", "pinned": "true to keep it near the top"},
         tool_memory_write, mutates=True),
    Tool("memory.search", "Search what the brain remembers.",
         {"query": "what to look for", "limit": "max results"},
         tool_memory_search),
    Tool("info.lookup", "Look something up, walking memory → workspace → cache → "
         "public → free → configured services and stopping at the first answer.",
         {"query": "the question", "tiers": "limit which tiers are tried", "limit": "max results"},
         tool_info_lookup, needs_network=True),
    Tool("http.get", "Fetch a URL, using the on-disk cache when there is one.",
         {"url": "what to fetch", "max_age": "seconds a cached copy stays fresh"},
         tool_http_get, needs_network=True),
    Tool("tools.list", "Every tool, and how each one has been behaving.",
         {}, tool_tools_list),
    Tool("tools.new", "Write a new tool into the workspace so it is available from "
         "now on. The body must define `def run(ctx, **args)`.",
         {"name": "tool name", "summary": "what it does", "body": "the Python",
          "args": "name:description pairs"},
         tool_tools_new, mutates=True),
    Tool("providers.status", "Which local model servers are answering.",
         {}, tool_providers_status),
    Tool("connectors.status", "Which external capabilities are ready, which need a key.",
         {"capability": "one capability, e.g. web_search"}, tool_connectors_status),
    Tool("diag.check", "Check the brain's own machine and tools, and report problems "
         "with a suggested repair for each.",
         {"deep": "true to re-probe everything"}, tool_diag_check),
    Tool("files.group", "Group the files under a directory by type.",
         {"root": "where to look", "pattern": "glob, * by default"}, tool_group),
    Tool("git.run", "Run git inside a workspace repository — status, diff, log, "
         "add, commit. Pushes and force operations are refused.",
         {"args": "everything after the word git"}, tool_git_run, mutates=True),
    Tool("lint.run", "Lint a file or project with the first linter this machine "
         "has (ruff, eslint, biome, shellcheck).",
         {"path": "file or project", "tool": "pick one explicitly, or blank to auto-detect"},
         tool_lint_run, mutates=True),
    Tool("build.run", "Build a project with its own tooling: make, pip, bun/npm "
         "run build, or cmake — detected from the project's files.",
         {"path": "project root", "command": "override the detected builder"},
         tool_build_run, mutates=True),
    Tool("tools.doctor", "Check the coding toolchain and name the installer for "
         "anything missing.", {}, tool_tools_doctor),
]


class Registry:
    """
    The registry, including tools the brain wrote for itself.

    External tools are re-read on every start rather than cached, so editing a
    tool file by hand takes effect on the next run with nothing to remember.
    """

    def __init__(self) -> None:
        self._tools: Dict[str, Tool] = {tool.name: tool for tool in BUILTIN}
        self._broken: Dict[str, str] = {}

    # ------------------------------------------------------------------ loading

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def load_external(self) -> Dict[str, Any]:
        """Import every file in `<workspace>/tools/` that looks like a tool."""
        self._broken = {}
        loaded: List[str] = []
        directory = config.tools_dir()
        if not directory.exists():
            return {"loaded": loaded, "broken": self._broken}

        for path in sorted(directory.glob("*.py")):
            name = path.stem
            if name.startswith("_"):
                continue
            try:
                spec = importlib.util.spec_from_file_location(f"brain_tool_{name}", path)
                if spec is None or spec.loader is None:
                    raise ImportError("could not load the file")
                module = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = module
                spec.loader.exec_module(module)
                declared = getattr(module, "TOOL", {}) or {}
                runner = getattr(module, "run", None)
                if not callable(runner):
                    raise ImportError("no run(ctx, **args) in the file")
                self.register(
                    Tool(
                        str(declared.get("name") or name),
                        str(declared.get("summary") or "a tool the brain wrote"),
                        dict(declared.get("args") or {}),
                        runner,
                        needs_network=bool(declared.get("needsNetwork")),
                        mutates=bool(declared.get("mutates", True)),
                        source=str(path),
                    )
                )
                loaded.append(str(declared.get("name") or name))
            except Exception as error:  # noqa: BLE001 - a bad tool must not stop the brain
                # Whatever went wrong, the tool is kept as *broken* rather than
                # dropped: self-diagnostics reports it, and the brain can repair
                # its own file on the next turn.
                self._broken[name] = f"{type(error).__name__}: {error}"
        return {"loaded": loaded, "broken": self._broken}

    # -------------------------------------------------------------------- lookup

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def names(self) -> List[str]:
        return sorted(self._tools)

    def all(self) -> List[Tool]:
        return [self._tools[name] for name in self.names()]

    def describe_all(self, store: Any = None) -> List[Dict[str, Any]]:
        stats = {row["tool"]: row for row in (store.tool_stats() if store else [])}
        described: List[Dict[str, Any]] = []
        for tool in self.all():
            entry = tool.describe(
                stats=stats.get(tool.name, {}),
                broken=self._broken.get(tool.name),
            )
            if tool.source != "builtin" and Path(tool.source).exists():
                entry["path"] = tool.source
            described.append(entry)
        for name, error in self._broken.items():
            described.append(
                {
                    "name": name,
                    "summary": "a tool the brain wrote, which no longer loads",
                    "args": {},
                    "source": str(config.tools_dir() / f"{name}.py"),
                    "broken": error,
                    "stats": stats.get(name, {}),
                }
            )
        return described

    # ----------------------------------------------------------------------- run

    def run_tool(self, name: str, args: Dict[str, Any], ctx: ToolContext) -> Dict[str, Any]:
        """
        Call a tool and always come back with an answer.

        A tool that raises is recorded as a failure with its real error, which is
        both what the caller needs to see and what self-diagnostics reasons over
        later.
        """
        tool = self.get(name)
        if tool is None:
            return {
                "ok": False,
                "error": f"no such tool: {name}",
                "available": self.names(),
            }
        if tool.needs_network and ctx.capability("network", {}).get("online") is False:
            # Not a hard stop: the cache exists precisely for this case.
            args = dict(args)
            args.setdefault("offline", True)

        started = time.time()
        try:
            result = tool.run(ctx, **args)
            if not isinstance(result, dict):
                result = {"ok": True, "result": result}
            ms = int((time.time() - started) * 1000)
            ctx.store.record_tool_run(
                name, args, bool(result.get("ok", True)), ms,
                result.get("error"), json.dumps(result, default=str)[:800],
            )
            result.setdefault("ms", ms)
            return result
        except ToolError as error:
            ctx.store.record_tool_run(name, args, False, int((time.time() - started) * 1000), str(error))
            return {"ok": False, "tool": name, "error": str(error), "refused": True}
        except Exception as error:  # noqa: BLE001 - reported, never raised
            ctx.store.record_tool_run(
                name, args, False, int((time.time() - started) * 1000), f"{type(error).__name__}: {error}"
            )
            return {
                "ok": False,
                "tool": name,
                "error": f"{type(error).__name__}: {error}",
                "hint": "this is a bug in the tool; `diag.check` records it and it can be rewritten",
            }


#: One registry for the process. Tools live in memory; the files are the truth.
registry = Registry()
