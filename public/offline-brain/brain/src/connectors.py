"""
The connector layer: every external capability behind one replaceable slot.

The rule this module enforces is that *nothing outside this file knows the name
of a service*. A feature asks for a capability — "search the web", "send a
message", "run a model" — and gets back whichever connector is enabled,
available and cheapest, with its key resolved for it. Swapping a commercial
search API for a self-hosted SearXNG, or a hosted mail provider for a local SMTP
relay, is then a settings change rather than a refactor.

Three ideas do the work:

* **A registry, not code paths.** Each connector is a dictionary entry: what it
  does, what it costs, what it needs, and how to call it. Adding a provider is
  an entry in this file and nothing else changes.
* **Credentials are resolved, never embedded.** A key can come from the
  environment or from the brain's own store, checked in that order, and the API
  only ever reports *which names exist*. Nothing returns a key to a caller.
* **Ranking prefers freedom.** Within a capability, connectors that need no
  account come first, then self-hosted ones, then those with a key present.
  That ordering is what makes the system drift toward independence instead of
  toward whichever service was configured first.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
from typing import Any, Dict, List, Optional

from . import config, info

#: Every connector the brain knows. `capability` is what a caller asks for;
#: `tier` is how much freedom it costs: `local` (on this machine), `free`
#: (no account), `key` (needs a credential), `hosted` (a service somebody else
#: runs, even with a key).
CONNECTORS: Dict[str, Dict[str, Any]] = {
    # ---------------------------------------------------------------- web search
    "searxng": {
        "label": "SearXNG (self-hosted)",
        "capability": "web_search",
        "tier": "local",
        "auth": "none",
        "envVars": [],
        "base": "http://127.0.0.1:8888",
        "docs": "https://docs.searxng.org/",
        "install": "scripts/install-research-tools.sh",
        "note": "A meta-search engine on your own machine: no account, no quota, no tracking.",
    },
    "wikipedia": {
        "label": "Wikipedia",
        "capability": "web_search",
        "tier": "free",
        "auth": "none",
        "envVars": [],
        "base": "https://en.wikipedia.org/w/api.php",
        "docs": "https://www.mediawiki.org/wiki/API:Main_page",
        "note": "Open API, no key, works for anything encyclopaedic.",
    },
    "duckduckgo": {
        "label": "DuckDuckGo",
        "capability": "web_search",
        "tier": "free",
        "auth": "none",
        "envVars": [],
        "base": "https://duckduckgo.com",
        "docs": "https://duckduckgo.com/params",
        "note": "Keyless HTML endpoint; useful when nothing else is configured.",
    },
    "brave": {
        "label": "Brave Search",
        "capability": "web_search",
        "tier": "key",
        "auth": "apiKey",
        "envVars": ["BRAVE_API_KEY"],
        "base": "https://api.search.brave.com/res/v1",
        "docs": "https://api-dashboard.search.brave.com/app/documentation",
        "note": "Own index, free tier, no account needed to read the docs.",
    },
    "tavily": {
        "label": "Tavily",
        "capability": "web_search",
        "tier": "key",
        "auth": "apiKey",
        "envVars": ["TAVILY_API_KEY"],
        "base": "https://api.tavily.com",
        "docs": "https://docs.tavily.com/",
        "note": "Search built for agents; answers come back already summarised.",
    },
    # ----------------------------------------------------------------- model access
    "local-models": {
        "label": "Local model servers",
        "capability": "llm",
        "tier": "local",
        "auth": "none",
        "envVars": [],
        "base": "http://127.0.0.1:11434",
        "docs": "https://github.com/ggml-org/llama.cpp",
        "install": "scripts/install-runtimes.sh",
        "note": "Ollama, llama.cpp, vLLM, LM Studio, text-generation-webui, LiteLLM.",
    },
    "openai": {
        "label": "OpenAI-compatible endpoint",
        "capability": "llm",
        "tier": "key",
        "auth": "apiKey",
        "envVars": ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
        "base": "https://api.openai.com/v1",
        "docs": "https://platform.openai.com/docs/api-reference",
        "note": "Off by default: an external model is a fallback, never the brain.",
    },
    # ------------------------------------------------------------------ knowledge
    "devdocs": {
        "label": "DevDocs (offline documentation)",
        "capability": "documentation",
        "tier": "local",
        "auth": "none",
        "envVars": [],
        "base": "http://127.0.0.1:9292",
        "docs": "https://devdocs.io/",
        "install": "scripts/install-research-tools.sh",
        "note": "API documents downloaded once and readable with no network.",
    },
    "stackexchange": {
        "label": "Stack Exchange",
        "capability": "documentation",
        "tier": "free",
        "auth": "none",
        "envVars": [],
        "base": "https://api.stackexchange.com/2.3",
        "docs": "https://api.stackexchange.com/docs",
        "note": "Keyless at low volume, which is all a person needs.",
    },
    # ------------------------------------------------------------------ messaging
    "ntfy": {
        "label": "ntfy (self-hosted)",
        "capability": "notify",
        "tier": "local",
        "auth": "none",
        "envVars": ["NTFY_URL", "NTFY_TOPIC"],
        "base": "http://127.0.0.1:8080",
        "docs": "https://docs.ntfy.sh/",
        "note": "Push notifications from a server you run; no phone account involved.",
    },
    "smtp": {
        "label": "SMTP (your own mail server)",
        "capability": "email",
        "tier": "local",
        "auth": "credentials",
        "envVars": ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"],
        "base": "",
        "docs": "https://docs.python.org/3/library/smtplib.html",
        "note": "smtplib is in the standard library, so this needs no package at all.",
    },
    "resend": {
        "label": "Resend",
        "capability": "email",
        "tier": "key",
        "auth": "apiKey",
        "envVars": ["RESEND_API_KEY"],
        "base": "https://api.resend.com",
        "docs": "https://resend.com/docs",
        "note": "Convenient when a self-hosted relay is not worth the trouble.",
    },
    # ------------------------------------------------------------------ geography
    "nominatim": {
        "label": "OpenStreetMap / Nominatim",
        "capability": "maps",
        "tier": "free",
        "auth": "none",
        "envVars": [],
        "base": "https://nominatim.openstreetmap.org",
        "docs": "https://nominatim.org/release-docs/latest/api/Overview/",
        "install": "scripts/install-supporting.sh",
        "note": "Geocoding with no key; self-host it and the same calls keep working.",
    },
    # --------------------------------------------------------------------- files
    "filesystem": {
        "label": "Local filesystem",
        "capability": "storage",
        "tier": "local",
        "auth": "none",
        "envVars": [],
        "base": "",
        "docs": "",
        "note": "Files on this machine, which the brain always has.",
    },
    "webdav": {
        "label": "WebDAV / Nextcloud",
        "capability": "storage",
        "tier": "key",
        "auth": "credentials",
        "envVars": ["WEBDAV_URL", "WEBDAV_USER", "WEBDAV_PASSWORD"],
        "base": "",
        "docs": "https://www.rfc-editor.org/rfc/rfc4918",
        "note": "Standard protocol, so any server works and none of them owns the data.",
    },
}


def registry() -> List[Dict[str, Any]]:
    """The catalog itself, without any local state — what *could* be used."""
    return [
        {
            "id": connector_id,
            "label": spec["label"],
            "capability": spec["capability"],
            "tier": spec["tier"],
            "auth": spec["auth"],
            "envVars": list(spec.get("envVars") or []),
            "base": spec.get("base", ""),
            "docs": spec.get("docs", ""),
            "install": spec.get("install", ""),
            "note": spec.get("note", ""),
        }
        for connector_id, spec in sorted(CONNECTORS.items())
    ]


def _state(store: Any, connector_id: str) -> Dict[str, Any]:
    if store is None:
        return {"enabled": False, "settings": {}}
    return store.get_connector(connector_id)


def credential_source(store: Any, connector_id: str) -> Dict[str, Any]:
    """
    Where this connector's credential would come from, and whether it is there.

    The environment is checked first so that a key exported for the session is
    never copied into the database — a secret that was never written down cannot
    leak out of it.
    """
    spec = CONNECTORS.get(connector_id) or {}
    stored = {row["name"] for row in (store.credential_names() if store else [])}
    present_env: List[str] = [
        name for name in (spec.get("envVars") or []) if os.environ.get(name)
    ]
    stored_for = [name for name in stored if name.startswith(f"{connector_id}:")]
    if present_env:
        return {"ok": True, "from": "environment", "names": present_env}
    if stored_for:
        return {"ok": True, "from": "store", "names": stored_for}
    return {"ok": False, "from": None, "names": list(spec.get("envVars") or [])}


def describe(store: Any) -> List[Dict[str, Any]]:
    """Every connector with its live state — what the web page draws."""
    state = store.all_connectors() if store else {}
    out: List[Dict[str, Any]] = []
    for entry in registry():
        saved = state.get(entry["id"]) or {}
        source = credential_source(store, entry["id"])
        needs_key = entry["auth"] in ("apiKey", "credentials")
        stored_enabled = saved.get("enabled")
        # Left alone, a connector that needs nothing from the person is on, and
        # one that needs a key is on as soon as that key exists — the useful
        # default either way. An explicit switch always wins, including switching
        # something on that has no key yet, which then reads as "on, needs a key"
        # rather than silently doing nothing.
        available = (not needs_key) or source["ok"]
        enabled = available if stored_enabled is None else bool(stored_enabled)
        entry.update(
            {
                "enabled": enabled,
                "explicitlyEnabled": stored_enabled is True,
                "credential": {"present": source["ok"], "from": source["from"], "names": source["names"]},
                "ready": enabled and (source["ok"] or not needs_key),
                "lastOkAt": saved.get("last_ok_at"),
                "lastError": saved.get("last_error"),
                "settings": saved.get("settings") or {},
            }
        )
        out.append(entry)
    return out


def for_capability(ctx: Any, capability: str, tier: Optional[str] = None,
                   includeDisabled: bool = False) -> List[Dict[str, Any]]:
    """
    The connectors that could serve this capability, best first.

    The ordering is the whole point: `local` before `free` before `key`, so the
    most independent option that works is always the one used.
    """
    rank = {"local": 0, "free": 1, "key": 2, "hosted": 3}
    found = [
        entry
        for entry in describe(ctx.store)
        if entry["capability"] == capability
        and (includeDisabled or entry["ready"])
        and (tier is None or entry["tier"] == tier)
    ]
    found.sort(key=lambda entry: (rank.get(entry["tier"], 9), entry["label"]))
    return found


def for_capability_report(capability: str) -> List[Dict[str, Any]]:
    """The same list without a live store — used by the hierarchy report."""
    return [
        entry for entry in registry() if entry["capability"] == capability
    ]


def resolve(store: Any, capability: str) -> Dict[str, Any]:
    """
    The one connector to use for a capability, and how to fail well.

    Falling back is not an exception path here: being told *which* providers
    exist and what each one is missing is more useful than a stack trace.
    """

    class _Ctx:
        def __init__(self, store: Any) -> None:
            self.store = store

    ranked = for_capability(_Ctx(store), capability)
    if ranked:
        return {"ok": True, "connector": ranked[0], "alternatives": ranked[1:]}
    everything = [entry for entry in describe(store) if entry["capability"] == capability]
    return {
        "ok": False,
        "connector": None,
        "options": everything,
        "error": f"no connector for {capability} is ready",
        "next": [
            f"{entry['label']}: add {', '.join(entry['credential']['names']) or 'nothing'}"
            for entry in everything
            if not entry["credential"]["present"]
        ],
    }


def set_enabled(store: Any, connector_id: str, enabled: bool) -> Dict[str, Any]:
    if connector_id not in CONNECTORS:
        raise KeyError(f"unknown connector: {connector_id}")
    store.set_connector(connector_id, enabled=enabled)
    store.event("info", "connector", f"{connector_id} {'enabled' if enabled else 'disabled'}")
    return describe(store)[_index(store, connector_id)]


def _index(store: Any, connector_id: str) -> int:
    for position, entry in enumerate(describe(store)):
        if entry["id"] == connector_id:
            return position
    return 0


def put_credential(store: Any, connector_id: str, name: str, value: str) -> Dict[str, Any]:
    """
    Store one key under a connector.

    Named `<connector>:<ENV_VAR>` so the web page and the environment can use the
    same identifier, and so a single connector with several fields (SMTP has
    four) keeps them together.
    """
    if connector_id not in CONNECTORS:
        raise KeyError(f"unknown connector: {connector_id}")
    if not name or not value:
        raise ValueError("a credential needs a name and a value")
    store.put_credential(f"{connector_id}:{name}", value)
    store.event("info", "credential", f"stored {connector_id}:{name}")
    return {"ok": True, "name": f"{connector_id}:{name}"}


def drop_credential(store: Any, connector_id: str, name: str) -> bool:
    removed = store.delete_credential(f"{connector_id}:{name}")
    if removed:
        store.event("info", "credential", f"removed {connector_id}:{name}")
    return removed


def credential_value(store: Any, connector_id: str, name: str) -> Optional[str]:
    """
    The value, for the code that is about to make the call.

    Environment first, store second — the same order as `credential_source`, so
    what is reported and what is used can never disagree.
    """
    if name in (CONNECTORS.get(connector_id, {}).get("envVars") or []):
        from_env = os.environ.get(name)
        if from_env:
            return from_env
    if store is not None:
        stored = store.get_credential(f"{connector_id}:{name}")
        if stored:
            return stored
    return None


def call(connector_id: str, args: Dict[str, Any], ctx: Any, timeout: float = 20.0) -> Dict[str, Any]:
    """
    Use a connector.

    Only the connectors worth calling from the brain's own loop are implemented
    here, and each one is a few lines over `urllib`: no SDK, nothing to pin, and
    nothing that breaks when a vendor ships a major version.
    """
    started = time.time()
    store = ctx.store

    def done(payload: Dict[str, Any]) -> Dict[str, Any]:
        payload.setdefault("connector", connector_id)
        payload["ms"] = int((time.time() - started) * 1000)
        if store is not None:
            store.mark_connector(connector_id, bool(payload.get("ok")), payload.get("error"))
        return payload

    if connector_id == "searxng":
        found = info.searxng(str(args.get("query", "")), limit=int(args.get("limit", 10)))
        if found:
            return done({"ok": True, "hits": found["hits"], "source": found["source"]})
        return done({"ok": False, "error": f"no SearXNG answering on {CONNECTORS['searxng']['base']}",
                     "hint": "scripts/install-research-tools.sh"})

    if connector_id == "wikipedia":
        found = info.wikipedia(str(args.get("query", "")), limit=int(args.get("limit", 3)))
        if found:
            return done({"ok": True, "hits": [found], "answer": found.get("text")})
        return done({"ok": False, "error": "nothing on Wikipedia for that"})

    if connector_id == "brave":
        key = credential_value(store, "brave", "BRAVE_API_KEY")
        if not key:
            return done({"ok": False, "error": "no key stored", "hint": "add BRAVE_API_KEY"})
        query = str(args.get("query", ""))
        query_string = urllib.parse.urlencode({"q": query, "count": int(args.get("limit", 10))})
        answer = info.http_get(
            f"{CONNECTORS['brave']['base']}/web/search?{query_string}",
            timeout=timeout,
            headers={"X-Subscription-Token": key},
        )
        if not answer.get("ok"):
            return done({"ok": False, "error": answer.get("error")})
        try:
            payload = json.loads(answer["body"])
        except ValueError:
            return done({"ok": False, "error": "Brave answered with something unreadable"})
        hits = [
            {
                "title": item.get("title"),
                "url": item.get("url"),
                "snippet": str(item.get("description") or "")[:300],
            }
            for item in ((payload.get("web") or {}).get("results") or [])
        ]
        return done({"ok": True, "hits": hits})

    if connector_id == "tavily":
        key = credential_value(store, "tavily", "TAVILY_API_KEY")
        if not key:
            return done({"ok": False, "error": "no key stored", "hint": "add TAVILY_API_KEY"})
        answer = info.http_post(
            f"{CONNECTORS['tavily']['base']}/search",
            {"api_key": key, "query": str(args.get("query", "")),
             "max_results": int(args.get("limit", 5))},
            timeout=timeout,
        )
        if not answer.get("ok"):
            return done({"ok": False, "error": answer.get("error")})
        payload = answer.get("json") or {}
        hits = [
            {"title": item.get("title"), "url": item.get("url"),
             "snippet": str(item.get("content") or "")[:300]}
            for item in (payload.get("results") or [])
        ]
        if payload.get("answer"):
            return done({"ok": True, "hits": hits, "answer": payload["answer"]})
        return done({"ok": True, "hits": hits})

    if connector_id == "nominatim":
        place = str(args.get("query", ""))
        payload = info.json_get(
            "https://nominatim.openstreetmap.org/search?"
            + info.urllib.parse.urlencode({"q": place, "format": "json", "limit": 3}),
            timeout=timeout,
        )
        if not payload:
            return done({"ok": False, "error": "no answer from OpenStreetMap"})
        return done({"ok": True, "hits": payload})

    if connector_id == "ntfy":
        topic = credential_value(store, "ntfy", "NTFY_TOPIC") or ""
        base = credential_value(store, "ntfy", "NTFY_URL") or CONNECTORS["ntfy"]["base"]
        if not topic:
            return done({"ok": False, "error": "no topic set", "hint": "add NTFY_TOPIC"})
        answer = info.http_get(f"{base.rstrip('/')}/{topic}", timeout=timeout)
        return done({"ok": answer.get("ok"), "status": answer.get("status"),
                     "error": answer.get("error")})

    if connector_id == "local-models":
        from . import providers

        chosen = providers.pick(ctx.settings, str(args.get("model", "")))
        return done({"ok": bool(chosen.get("ok")), "provider": (chosen.get("server") or {}).get("id"),
                     "model": chosen.get("model"), "error": chosen.get("error")})

    return done({"ok": False, "error": f"connector {connector_id} has no call implementation"})


def summary(store: Any) -> Dict[str, Any]:
    """One paragraph of numbers about the connector layer, for the overview."""
    entries = describe(store)
    by_capability: Dict[str, Dict[str, int]] = {}
    for entry in entries:
        bucket = by_capability.setdefault(entry["capability"], {"total": 0, "ready": 0, "local": 0})
        bucket["total"] += 1
        if entry["ready"]:
            bucket["ready"] += 1
        if entry["tier"] == "local":
            bucket["local"] += 1
    return {
        "total": len(entries),
        "ready": sum(1 for entry in entries if entry["ready"]),
        "needingKeys": sum(1 for entry in entries if entry["auth"] in ("apiKey", "credentials")
                            and not entry["credential"]["present"]),
        "byCapability": by_capability,
        "checkedAt": time.time(),
    }
