"""
The model layer: local servers first, everything else strictly optional.

The brain does not ship a model and does not need one to function. What it needs
is a *place to ask*, and this module is the list of places worth asking, tried in
order:

    the local model servers on this machine   Ollama, llama.cpp, vLLM, LM Studio,
                                              text-generation-webui, LiteLLM —
                                              every one of them on loopback,
                                              every one of them free
    an OpenAI-compatible endpoint you added   another machine on your network, or
                                              a self-hosted gateway; only used
                                              when `allowExternal` is on
    nothing                                   not an error. `chat()` says so, and
                                              the caller answers from local tools
                                              and memory instead

All of them are spoken to the same way — HTTP with JSON — so adding a backend is
a dictionary entry, not a new code path. Nothing here imports a vendor SDK, and
nothing here needs an account: a model server that is installed and running is
reachable with no key at all, which is the whole reason local inference is the
default.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

#: Model servers to look for, by id. `kind` says which wire protocol it speaks;
#: `openai` covers the `/v1/chat/completions` family that most servers implement.
LOCAL_SERVERS: Dict[str, Dict[str, Any]] = {
    "ollama": {
        "label": "Ollama",
        "base": "http://127.0.0.1:11434",
        "kind": "ollama",
        "start": "ollama serve",
        "note": "one-command local models",
    },
    "llama.cpp": {
        "label": "llama.cpp (llama-server)",
        "base": "http://127.0.0.1:8080",
        "kind": "openai",
        "start": "llama-server -m models/your-model.gguf --port 8080",
        "note": "GGUF on CPU, CUDA, Metal or Vulkan",
    },
    "vllm": {
        "label": "vLLM",
        "base": "http://127.0.0.1:8000",
        "kind": "openai",
        "start": "vllm serve Qwen/Qwen3-8B",
        "note": "high-throughput GPU serving",
    },
    "lmstudio": {
        "label": "LM Studio",
        "base": "http://127.0.0.1:1234",
        "kind": "openai",
        "start": "start the local server in LM Studio",
        "note": "desktop models with an OpenAI-compatible port",
    },
    "text-generation-webui": {
        "label": "text-generation-webui",
        "base": "http://127.0.0.1:5000",
        "kind": "openai",
        "start": "python server.py --api --listen",
        "note": "many loaders, one port",
    },
    "litellm": {
        "label": "LiteLLM proxy",
        "base": "http://127.0.0.1:4000",
        "kind": "openai",
        "start": "litellm --config configuration/litellm.example.yaml",
        "note": "one endpoint in front of several servers",
    },
}


def _request(
    url: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout: float = 2.0,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    One JSON call, with every failure turned into a value.

    A model server that is not running must read as "not running", never as a
    traceback: the caller is a loop that tries the next one.
    """
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
        return {"ok": True, "json": json.loads(body) if body.strip() else {}}
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode("utf-8", errors="replace")[:400]
        except Exception:  # pragma: no cover - the body is a nicety, not a need
            pass
        return {"ok": False, "error": f"HTTP {error.code}", "detail": detail}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {"ok": False, "error": str(getattr(error, "reason", error))}
    except ValueError as error:
        return {"ok": False, "error": f"unreadable response: {error}"}


def _probe_one(server_id: str, spec: Dict[str, Any], timeout: float = 1.2) -> Dict[str, Any]:
    """Is this server up, and what is it serving?"""
    base = str(spec["base"]).rstrip("/")
    models: List[str] = []
    if spec["kind"] == "ollama":
        answer = _request(f"{base}/api/tags", timeout=timeout)
        if answer.get("ok"):
            for entry in (answer.get("json") or {}).get("models", []):
                name = entry.get("name") or entry.get("model")
                if name:
                    models.append(str(name))
    else:
        answer = _request(f"{base}/v1/models", timeout=timeout)
        if answer.get("ok"):
            for entry in (answer.get("json") or {}).get("data", []):
                name = entry.get("id")
                if name:
                    models.append(str(name))

    return {
        "id": server_id,
        "label": spec.get("label", server_id),
        "base": base,
        "kind": spec["kind"],
        "ok": bool(answer.get("ok")),
        "models": sorted(models),
        "error": None if answer.get("ok") else str(answer.get("error")),
        "start": spec.get("start", ""),
        "note": spec.get("note", ""),
        "local": spec.get("local", True),
    }


def discover(settings: Dict[str, Any], timeout: float = 1.2) -> List[Dict[str, Any]]:
    """
    Every model server that could answer, with the ones that are up first.

    Probed in parallel because six loopback probes in series is a second of
    waiting before the brain can decide anything.
    """
    wanted = list(settings.get("localProviders") or LOCAL_SERVERS.keys())
    jobs: List[Dict[str, Any]] = []
    for server_id in wanted:
        spec = LOCAL_SERVERS.get(server_id)
        if spec:
            jobs.append({"id": server_id, **spec, "local": True})

    if settings.get("allowExternal"):
        for entry in settings.get("externalProviders") or []:
            if not isinstance(entry, dict) or not entry.get("base"):
                continue
            jobs.append(
                {
                    "id": str(entry.get("id") or entry["base"]),
                    "label": str(entry.get("label") or entry["base"]),
                    "base": str(entry["base"]).rstrip("/"),
                    "kind": str(entry.get("kind") or "openai"),
                    "start": "",
                    "note": "added by hand",
                    "local": False,
                    "apiKeyEnv": entry.get("apiKeyEnv"),
                }
            )

    if not jobs:
        return []

    with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as pool:
        futures = [
            pool.submit(_probe_one, job["id"], job, timeout) for job in jobs
        ]
        results = [future.result() for future in futures]

    # Keep the configured order for what is up, so "prefer llama.cpp" is a
    # setting that means something; anything down is reported after it.
    up = [r for r in results if r["ok"]]
    down = [r for r in results if not r["ok"]]
    for job in jobs:
        for result in up + down:
            if result["id"] == job["id"]:
                result["apiKeyEnv"] = job.get("apiKeyEnv")
                result["local"] = job.get("local", True)
    return up + down


def pick(settings: Dict[str, Any], wanted_model: str = "") -> Dict[str, Any]:
    """
    The server to ask, and the model to ask it with.

    A model name that was asked for explicitly is honoured when some server
    offers it. Otherwise the leading available server's first model is used —
    which is the same rule the Control Room uses for AI systems, so the idea
    carries over instead of being a second thing to learn.
    """
    servers = discover(settings)
    for server in servers:
        if not server["ok"]:
            continue
        if wanted_model:
            for name in server["models"]:
                if name == wanted_model or name.split(":")[0] == wanted_model.split(":")[0]:
                    return {"ok": True, "server": server, "model": name}
        if server["models"]:
            return {"ok": True, "server": server, "model": server["models"][0]}

    reason = (
        "no local model server answered and no external endpoint is enabled"
        if not settings.get("allowExternal")
        else "no model server answered"
    )
    return {
        "ok": False,
        "servers": servers,
        "error": reason,
        "hint": start_hint(servers),
    }


def start_hint(servers: Optional[List[Dict[str, Any]]] = None) -> str:
    """What to type to get a model answering, using what this machine has."""
    from . import capabilities

    if capabilities.require("ollama"):
        return "ollama serve   (then: ollama pull qwen2.5-coder:7b)"
    if capabilities.require("llama-server") or capabilities.require("llama.cpp"):
        return "llama-server -m models/your-model.gguf --port 8080"
    if capabilities.require("docker"):
        return "docker run --rm -p 11434:11434 ollama/ollama"
    return (
        "Install one with the package's own installers "
        "(scripts/install-runtimes.sh), then pull a model"
    )


def chat(
    messages: List[Dict[str, str]],
    settings: Dict[str, Any],
    model: str = "",
    timeout: Optional[float] = None,
    temperature: float = 0.2,
) -> Dict[str, Any]:
    """
    Ask the best available model. Never raises: a failure is a return value.

    The shape of a successful answer is the same whichever server produced it,
    which is what keeps every caller free of `if ollama / if vllm`.
    """
    picked = pick(settings, model or str(settings.get("model") or ""))
    if not picked.get("ok"):
        return {
            "ok": False,
            "error": picked.get("error"),
            "hint": picked.get("hint"),
            "provider": None,
            "model": None,
            "text": "",
        }

    server = picked["server"]
    chosen = picked["model"]
    limit = float(timeout or settings.get("modelTimeout") or 600)
    headers: Dict[str, str] = {}
    api_key_env = server.get("apiKeyEnv")
    if api_key_env:
        import os

        key = os.environ.get(str(api_key_env))
        if key:
            headers["Authorization"] = f"Bearer {key}"

    started = time.time()
    if server["kind"] == "ollama":
        answer = _request(
            f"{server['base']}/api/chat",
            {
                "model": chosen,
                "messages": messages,
                "stream": False,
                "options": {"temperature": temperature},
            },
            timeout=limit,
            headers=headers,
        )
        text = ((answer.get("json") or {}).get("message") or {}).get("content", "")
    else:
        answer = _request(
            f"{server['base']}/v1/chat/completions",
            {
                "model": chosen,
                "messages": messages,
                "temperature": temperature,
                "stream": False,
            },
            timeout=limit,
            headers=headers,
        )
        choices = (answer.get("json") or {}).get("choices") or []
        text = ""
        if choices:
            text = (choices[0].get("message") or {}).get("content", "") or ""

    return {
        "ok": bool(answer.get("ok") and str(text).strip()),
        "text": str(text).strip(),
        "provider": server["id"],
        "providerLabel": server["label"],
        "model": chosen,
        "ms": int((time.time() - started) * 1000),
        "error": None if answer.get("ok") else str(answer.get("error")),
        "detail": answer.get("detail"),
        # An empty completion is usually a model still loading, which is worth
        # saying out loud rather than reporting as an empty answer.
        "note": "the server answered but the model returned nothing" if answer.get("ok") else None,
    }


def ask_once(prompt: str, settings: Dict[str, Any], system: str = "") -> Dict[str, Any]:
    """One-shot convenience wrapper, for the CLI and for health checks."""
    messages: List[Dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return chat(messages, settings)
