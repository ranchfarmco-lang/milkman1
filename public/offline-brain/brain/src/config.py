"""
Where the brain keeps its things, and what it is allowed to do.

Everything the brain owns lives in two ordinary directories on the machine that
runs it. There is no account, no service and no cloud anywhere in this module:

    data dir    the database, the logs, the settings and the pairing token
    workspace   the files the brain makes, the tools it writes for itself, and
                the scratch space commands run in

Both move with one environment variable (`BRAIN_HOME`, `BRAIN_WORKSPACE`),
which is what makes "run the whole thing off an external drive" a one-line
change instead of a migration.

`config.json` in the data dir holds the settings a person actually changes:
which model server to prefer, which origins may talk to the HTTP API, and which
external providers are permitted at all. Environment variables override the
file, so a systemd unit or a shell one-liner can adjust one value without
editing anything — and anything set in the environment is never written down.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Dict

VERSION = "1.0.0"

#: The package this runtime belongs to, and the release the protocol speaks.
PACKAGE = "offline-ai-coding-brain"
PROTOCOL = "brain/1"


def _env_path(name: str) -> Path | None:
    raw = os.environ.get(name)
    return Path(raw).expanduser() if raw else None


def data_dir() -> Path:
    """The directory the brain reads and writes. `BRAIN_HOME` wins over XDG."""
    override = _env_path("BRAIN_HOME")
    if override:
        return override
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return base / "offline-brain"


def workspace_dir() -> Path:
    """
    Where the brain is allowed to create things.

    It is deliberately separate from the data dir: a person can hand the brain a
    project directory, or keep everything in a folder of its own, and either way
    the database and the token are not sitting inside the tree the brain edits.
    """
    return _env_path("BRAIN_WORKSPACE") or (Path.home() / "brain-workspace")


def tools_dir() -> Path:
    """Tools the brain writes for itself are loaded from here on every start."""
    return workspace_dir() / "tools"


def scratch_dir() -> Path:
    """Scratch space for generated files and command output."""
    return workspace_dir() / "scratch"


def logs_dir() -> Path:
    return data_dir() / "logs"


def db_path() -> Path:
    return data_dir() / "brain.db"


def token_path() -> Path:
    return data_dir() / "token"


def config_path() -> Path:
    return data_dir() / "config.json"


# --------------------------------------------------------------------- settings

DEFAULT_CONFIG: Dict[str, Any] = {
    # The host and port the HTTP API listens on. Loopback by default: the API
    # hands out memory, files and shell, so it is not something to expose on a
    # network without meaning to.
    "host": "127.0.0.1",
    "port": 8710,
    # "" means "ask for the pairing token", which is the default and the safe
    # answer. Set it to "open" only for a machine nobody else can reach.
    "auth": "token",
    # The origins a browser page may call this API from. "*" is the friendly
    # default: the token is still required, and a hub that runs on whatever
    # address the person happened to use cannot be enumerated in advance.
    "allowedOrigins": ["*"],
    # Model servers to look for, in the order they are preferred. Each one is
    # probed on loopback only; nothing here reaches out to the internet.
    "localProviders": [
        "ollama",
        "llama.cpp",
        "vllm",
        "lmstudio",
        "text-generation-webui",
        "litellm",
    ],
    # Extra OpenAI-compatible endpoints (a second machine on the LAN, a
    # self-hosted gateway). Kept in the config so a provider can be added
    # without touching code, and off by default so nothing leaves the machine
    # until somebody says so.
    "externalProviders": [],
    # An endpoint outside the machine is only ever used when this is true.
    "allowExternal": False,
    # Which model to ask first. "" means "whatever the leading server offers".
    "model": "",
    # The information hierarchy, in the order the resolver will try it. Removing
    # a tier is how somebody says "never use public sources" without patching
    # code.
    "infoTiers": ["memory", "workspace", "cache", "public", "free", "api"],
    # A command the brain may run to prove the workspace still builds. Used by
    # the development loop and by self-diagnostics.
    "testCommand": "",
    # Where a task the brain cannot do locally gets looked up: a hub address, a
    # colleague's endpoint, anything OpenAI-compatible that is not this machine.
    "hubUrl": "",
    # Seconds a single shell command, tool or model call may take.
    "toolTimeout": 120,
    "modelTimeout": 600,
    # Run scheduled tasks while `serve` is up. On by default: a scheduler a
    # person has to remember to start is not a scheduler.
    "scheduler": True,
    # How often the scheduler looks for due work, and how many tasks one tick
    # will start — the cap is what keeps a machine coming back from a long sleep
    # responsive instead of grinding through a backlog.
    "schedulerTick": 60,
    "schedulerMaxPerTick": 3,
    # Loopback probes are cheap but not free; the capability map is cached for
    # this long before it is rebuilt.
    "capabilityTtl": 900,
    # How much of a file a read tool returns in one go.
    "maxReadBytes": 200_000,
}


def load_config() -> Dict[str, Any]:
    """
    The settings in force: defaults, then the file, then the environment.

    Environment wins because it is the layer that is never written to disk —
    `BRAIN_PORT=9999 brain.py serve` is a thing you can do over ssh without
    changing what the next run does.
    """
    config = dict(DEFAULT_CONFIG)
    path = config_path()
    if path.exists():
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                config.update(stored)
        except (OSError, ValueError):
            # A settings file that cannot be read must not stop the brain from
            # starting: the defaults are a working configuration.
            log("warn", f"config.json is unreadable, using defaults: {path}")

    overrides = {
        "host": os.environ.get("BRAIN_HOST"),
        "port": os.environ.get("BRAIN_PORT"),
        "auth": os.environ.get("BRAIN_AUTH"),
        "model": os.environ.get("BRAIN_MODEL"),
        "hubUrl": os.environ.get("BRAIN_HUB_URL"),
        "testCommand": os.environ.get("BRAIN_TEST_COMMAND"),
        "allowExternal": _env_bool("BRAIN_ALLOW_EXTERNAL"),
    }
    for key, value in overrides.items():
        if value is None:
            continue
        if key == "port":
            try:
                config[key] = int(value)
            except ValueError:
                log("warn", f"BRAIN_PORT is not a number: {value!r}")
        elif key == "allowExternal":
            config[key] = value
        elif value != "":
            config[key] = value

    origins = os.environ.get("BRAIN_ORIGINS")
    if origins:
        config["allowedOrigins"] = [o.strip() for o in origins.split(",") if o.strip()]

    return config


def save_config(config: Dict[str, Any]) -> Path:
    path = config_path()
    write_private(path, json.dumps(config, indent=2, sort_keys=True) + "\n")
    return path


def _env_bool(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    return raw.strip().lower() in ("1", "true", "yes", "on")


# ------------------------------------------------------------------- filesystem


def ensure_dirs() -> None:
    """
    Create the two trees the brain owns, private to the user running it.

    `0o700` matters: the database holds the memories and the pairing token, so
    the directory is not world-readable even on a shared machine.
    """
    for path in (data_dir(), logs_dir(), workspace_dir(), tools_dir(), scratch_dir()):
        path.mkdir(parents=True, exist_ok=True)
        try:
            path.chmod(0o700)
        except OSError:
            # Some filesystems (a mounted FAT drive, a Windows share) have no
            # permissions to set. That is not a reason to refuse to start.
            pass


def write_private(path: Path, text: str) -> None:
    """
    Write a file only its owner can read.

    Created with the mode already set, rather than created and then chmod'ed,
    so a secret is never briefly readable by everybody on the machine.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write(text)


# ------------------------------------------------------------------------ token


def ensure_token() -> str:
    """
    The pairing token, made once and kept.

    A browser page on another origin can reach a loopback API, so the token is
    what stops any page you happen to have open from reading your memory or
    running commands on your machine. It is printed by `serve` and by `pair`,
    and typed into the hub once.
    """
    path = token_path()
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        except OSError:
            pass
    token = secrets.token_urlsafe(32)
    write_private(path, token + "\n")
    return token


def rotate_token() -> str:
    """Forget the old token and make a new one. Every paired page must re-pair."""
    path = token_path()
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass
    return ensure_token()


def read_token() -> str | None:
    path = token_path()
    if not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


# ------------------------------------------------------------------------- log


def log(level: str, message: str) -> None:
    """
    One line to stderr, in a shape that is easy to grep.

    Deliberately stderr rather than stdout: stdout belongs to the CLI's own
    output, and a server started by systemd puts stderr in the journal.
    """
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {level:<5} {message}", file=sys.stderr, flush=True)
