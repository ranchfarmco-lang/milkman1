"""
Getting an answer about the world without assuming the world is reachable.

This is the information-access layer. Its whole job is to know the *order* of
places to look, and to stop at the first one that has something — so a question
never turns into "configure an API key first" when a local answer existed all
along.

The hierarchy, cheapest and most private first:

    memory      what the brain already knows, in its own database
    workspace   files on this machine, including everything it has written
    cache       anything it has fetched before, kept on disk with its date
    public      open interfaces with no account at all — Wikipedia, Hacker News,
                Stack Exchange, OpenStreetMap
    free        a self-hosted service the person is running, such as SearXNG, or
                any connector marked free
    api         a connector that needs a key, used only when one is present

Two behaviours are deliberate:

* **Every tier reports itself.** A caller always learns which tier answered, so
  "this is from your own notes, and that was fetched live just now" is visible
  rather than guessed at.
* **The cache is a first-class source, not a fallback.** Offline, a question
  whose page was fetched last week is answered from that copy, dated, instead of
  failing.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from . import config

USER_AGENT = f"{config.PACKAGE}/{config.VERSION} (local brain; +offline-first)"

TIER_NOTES = {
    "memory": "answered from the brain's own memory",
    "workspace": "found in files on this machine",
    "cache": "from a copy fetched earlier and kept on disk",
    "public": "from an open interface that needs no account",
    "free": "from a free or self-hosted service",
    "api": "from a configured service, using a key you supplied",
}


# ------------------------------------------------------------------------ cache


def cache_dir() -> Path:
    return config.data_dir() / "cache"


def _cache_path(url: str) -> Path:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
    return cache_dir() / f"{digest}.json"


def cache_put(url: str, payload: Dict[str, Any]) -> None:
    cache_dir().mkdir(parents=True, exist_ok=True)
    record = {**payload, "url": url, "cachedAt": time.time()}
    path = _cache_path(url)
    path.write_text(json.dumps(record), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def cache_get(url: str, max_age: Optional[float] = None) -> Optional[Dict[str, Any]]:
    path = _cache_path(url)
    if not path.exists():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if max_age is not None and time.time() - float(record.get("cachedAt") or 0) > max_age:
        return None
    return record


def cache_entries(limit: int = 200) -> List[Dict[str, Any]]:
    """What has been cached, newest first — the offline library, listed."""
    out: List[Dict[str, Any]] = []
    directory = cache_dir()
    if not directory.exists():
        return out
    for path in directory.glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append(
            {
                "url": record.get("url"),
                "title": record.get("title"),
                "cachedAt": record.get("cachedAt"),
                "bytes": path.stat().st_size,
            }
        )
    out.sort(key=lambda entry: entry.get("cachedAt") or 0, reverse=True)
    return out[:limit]


# ------------------------------------------------------------------ HTTP, once


def http_get(url: str, timeout: float = 12.0, headers: Optional[Dict[str, str]] = None,
             accept: str = "application/json, text/html;q=0.8, */*;q=0.5") -> Dict[str, Any]:
    """
    One HTTP GET, with the failure returned rather than raised.

    `urllib` is the whole client: it is in the standard library, it is
    maintained, and it cannot be withdrawn by a vendor.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(config.load_config()["maxReadBytes"])
            return {
                "ok": True,
                "status": response.status,
                "body": body.decode("utf-8", errors="replace"),
                "contentType": response.headers.get("Content-Type", ""),
                "url": response.geturl(),
            }
    except urllib.error.HTTPError as error:
        return {"ok": False, "status": error.code, "error": f"HTTP {error.code}"}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {"ok": False, "error": str(getattr(error, "reason", error))}
    except ValueError as error:
        return {"ok": False, "error": f"unreadable response: {error}"}


def http_post(
    url: str,
    payload: Dict[str, Any],
    timeout: float = 12.0,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """The POST half of the same client, for the services that insist on it."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("User-Agent", USER_AGENT)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read(config.load_config()["maxReadBytes"]).decode("utf-8", errors="replace")
        try:
            parsed = json.loads(text) if text.strip() else {}
        except ValueError:
            parsed = None
        return {"ok": True, "status": response.status, "json": parsed, "body": text}
    except urllib.error.HTTPError as error:
        return {"ok": False, "status": error.code, "error": f"HTTP {error.code}"}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {"ok": False, "error": str(getattr(error, "reason", error))}


def json_get(url: str, timeout: float = 12.0, headers: Optional[Dict[str, str]] = None) -> Any:
    answer = http_get(url, timeout=timeout, headers=headers)
    if not answer.get("ok"):
        return None
    try:
        return json.loads(answer["body"])
    except ValueError:
        return None


def strip_html(text: str) -> str:
    """Enough HTML removal to read a page, and no more than that."""
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?is)<!--.*?-->", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    for entity, char in (
        ("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
        ("&quot;", '"'), ("&#39;", "'"),
    ):
        text = text.replace(entity, char)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


# ------------------------------------------------------------------ local search


def search_files(
    query: str,
    root: Optional[str] = None,
    limit: int = 40,
    max_bytes: int = 2_000_000,
) -> List[Dict[str, Any]]:
    """
    Find a string in the tree, with ripgrep when it is installed.

    The Python fallback is not as fast, but it means search works on a machine
    where nothing has been installed yet — which is exactly the machine a
    person is trying this on first.
    """
    target = str(root or config.workspace_dir())
    if not Path(target).exists():
        return []

    rg = _which("rg")
    if rg and not Path(target).is_file():
        done = _run(
            [rg, "--line-number", "--no-heading", "--color=never", "--max-count", "3",
             "--max-filesize", "2M", "--ignore-case", "--", query, target],
            timeout=20.0,
        )
        if done is not None:
            return _parse_rg(done, limit)

    hits: List[Dict[str, Any]] = []
    needle = query.lower()
    for path in _walk(Path(target)):
        if len(hits) >= limit:
            break
        try:
            if path.stat().st_size > max_bytes:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if needle in line.lower():
                hits.append(
                    {"path": str(path), "line": number, "text": line.strip()[:400]}
                )
                if len(hits) >= limit:
                    break
    return hits


def _walk(root: Path, depth: int = 6) -> Iterable[Path]:
    skip = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", ".cache"}
    if root.is_file():
        yield root
        return
    stack = [(root, 0)]
    while stack:
        current, level = stack.pop()
        if level > depth:
            continue
        try:
            entries = sorted(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.name in skip:
                continue
            if entry.is_dir():
                stack.append((entry, level + 1))
            else:
                yield entry


def _which(binary: str) -> Optional[str]:
    from shutil import which

    return which(binary)


def _run(args: List[str], timeout: float) -> Optional[str]:
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
        return done.stdout
    except (OSError, subprocess.SubprocessError):
        return None


def _parse_rg(output: str, limit: int) -> List[Dict[str, Any]]:
    hits: List[Dict[str, Any]] = []
    for line in (output or "").splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        path, number, text = parts
        try:
            line_number = int(number)
        except ValueError:
            continue
        hits.append({"path": path, "line": line_number, "text": text.strip()[:400]})
        if len(hits) >= limit:
            break
    return hits


# ------------------------------------------------------------------ public tiers


def wikipedia(query: str, limit: int = 3) -> Optional[Dict[str, Any]]:
    """The free encyclopaedia's own API. No account, no key, no quota."""
    search = json_get(
        "https://en.wikipedia.org/w/api.php?"
        + urllib.parse.urlencode(
            {"action": "query", "list": "search", "srsearch": query,
             "format": "json", "srlimit": limit}
        )
    )
    if not search:
        return None
    pages = (search.get("query") or {}).get("search") or []
    if not pages:
        return None
    best = pages[0]
    title = best.get("title", "")
    summary = json_get(
        "https://en.wikipedia.org/api/rest_v1/page/summary/"
        + urllib.parse.quote(title.replace(" ", "_"))
    )
    text = (summary or {}).get("extract") or strip_html(best.get("snippet", ""))
    return {
        "title": title,
        "url": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
        "text": text,
        "alsoFound": [p.get("title") for p in pages[1:]],
        "source": "Wikipedia",
    }


def hacker_news(query: str, limit: int = 5) -> Optional[Dict[str, Any]]:
    """Hacker News' search API — technical discussion, no key."""
    data = json_get(
        "https://hn.algolia.com/api/v1/search?"
        + urllib.parse.urlencode({"query": query, "hitsPerPage": limit})
    )
    if not data:
        return None
    hits = [
        {
            "title": hit.get("title") or hit.get("story_title") or "",
            "url": hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
            "points": hit.get("points"),
            "comments": hit.get("num_comments"),
        }
        for hit in (data.get("hits") or [])
    ]
    if not hits:
        return None
    return {"title": f"Hacker News: {query}", "hits": hits, "source": "Hacker News"}


def stack_exchange(query: str, limit: int = 5) -> Optional[Dict[str, Any]]:
    """Stack Exchange's API, keyless at low volume."""
    data = json_get(
        "https://api.stackexchange.com/2.3/search/advanced?"
        + urllib.parse.urlencode(
            {"order": "desc", "sort": "relevance", "q": query, "site": "stackoverflow",
             "pagesize": limit, "filter": "default"}
        )
    )
    if not data:
        return None
    items = [
        {
            "title": strip_html(item.get("title", "")),
            "url": item.get("link"),
            "answered": bool(item.get("is_answered")),
            "score": item.get("score"),
        }
        for item in (data.get("items") or [])
    ]
    if not items:
        return None
    return {"title": f"Stack Overflow: {query}", "hits": items, "source": "Stack Overflow"}


PUBLIC_SOURCES = (wikipedia, stack_exchange, hacker_news)


def searxng(query: str, limit: int = 10) -> Optional[Dict[str, Any]]:
    """
    A self-hosted SearXNG, when one is running.

    This is the tier that makes the hierarchy worth having: the same breadth as a
    commercial search API, on your own machine, with no key and no account.
    """
    base = os.environ.get("BRAIN_SEARX_URL") or "http://127.0.0.1:8888"
    data = json_get(
        f"{base.rstrip('/')}/search?"
        + urllib.parse.urlencode({"q": query, "format": "json"}),
        timeout=15.0,
    )
    if not data:
        return None
    results = [
        {
            "title": item.get("title"),
            "url": item.get("url"),
            "snippet": (item.get("content") or "")[:400],
            "engine": item.get("engine"),
        }
        for item in (data.get("results") or [])[:limit]
    ]
    if not results:
        return None
    return {"title": f"SearXNG: {query}", "hits": results, "source": base}


# ---------------------------------------------------------------------- fetch


def fetch(url: str, max_age: float = 86_400.0, offline: bool = False) -> Dict[str, Any]:
    """
    A page, from the cache when it is recent, from the network when it is not.

    Offline the cache is still consulted, which is the entire difference between
    "I looked this up last week" and "I cannot answer that".
    """
    cached = cache_get(url, max_age=None if offline else max_age)
    if cached is not None:
        age_hours = (time.time() - float(cached.get("cachedAt") or 0)) / 3600
        return {
            "ok": True,
            "tier": "cache",
            "url": url,
            "title": cached.get("title") or url,
            "text": cached.get("text") or "",
            "contentType": cached.get("contentType"),
            "ageHours": round(age_hours, 1),
            "cached": True,
        }

    if offline:
        return {
            "ok": False,
            "tier": "cache",
            "url": url,
            "error": "not in the cache, and this machine has no network",
            "cached": False,
        }

    answer = http_get(url)
    if not answer.get("ok"):
        return {
            "ok": False,
            "tier": "public",
            "url": url,
            "error": answer.get("error"),
            "cached": False,
        }

    content_type = answer.get("contentType") or ""
    body = answer.get("body") or ""
    if "json" in content_type:
        try:
            record = {"title": url, "text": json.dumps(json.loads(body), indent=2)[:60_000],
                      "contentType": content_type}
        except ValueError:
            record = {"title": url, "text": body[:60_000], "contentType": content_type}
    else:
        text = strip_html(body)
        record = {"title": _title_of(body) or url, "text": text[:60_000], "contentType": content_type}

    cache_put(url, record)
    return {
        "ok": True,
        "tier": "public",
        "url": url,
        "title": record["title"],
        "text": record["text"],
        "contentType": content_type,
        "cached": False,
    }


def _title_of(html: str) -> str:
    match = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    return strip_html(match.group(1))[:200] if match else ""


# ---------------------------------------------------------------------- lookup


def lookup(
    query: str,
    ctx: Any,
    tiers: Optional[List[str]] = None,
    limit: int = 5,
    offline: Optional[bool] = None,
) -> Dict[str, Any]:
    """
    Walk the hierarchy and stop at the first tier that has something.

    Returns the answer *and* the tiers that were tried, because "nothing found"
    is only useful when it says where nothing was found.
    """
    settings = ctx.settings
    order = tiers or list(settings.get("infoTiers") or ["memory", "workspace", "cache", "public"])
    if offline is None:
        offline = bool(ctx.capability("network", {}).get("online") is False)

    tried: List[Dict[str, Any]] = []

    for tier in order:
        if tier == "memory":
            rows = ctx.store.search_memory(query, limit=limit)
            tried.append({"tier": tier, "found": len(rows)})
            if rows:
                return {
                    "ok": True,
                    "tier": "memory",
                    "query": query,
                    "answer": rows[0]["text"],
                    "hits": rows,
                    "note": TIER_NOTES["memory"],
                    "tried": tried,
                }

        elif tier == "workspace":
            hits = search_files(query, limit=limit)
            tried.append({"tier": tier, "found": len(hits)})
            if hits:
                return {
                    "ok": True,
                    "tier": "workspace",
                    "query": query,
                    "answer": hits[0]["text"],
                    "hits": hits,
                    "note": TIER_NOTES["workspace"],
                    "tried": tried,
                }

        elif tier == "cache":
            needle = query.lower()
            found = [
                entry for entry in cache_entries(limit=400)
                if needle in (entry.get("title") or "").lower()
                or needle in (entry.get("url") or "").lower()
            ]
            tried.append({"tier": tier, "found": len(found)})
            if found:
                best = cache_get(str(found[0].get("url"))) or {}
                return {
                    "ok": True,
                    "tier": "cache",
                    "query": query,
                    "answer": (best.get("text") or "")[:2000],
                    "hits": found,
                    "note": TIER_NOTES["cache"],
                    "tried": tried,
                }

        elif tier in ("public", "free", "api"):
            if offline and tier != "api":
                tried.append({"tier": tier, "found": 0, "skipped": "offline"})
                continue
            result = _remote(query, ctx, tier, limit)
            tried.append({"tier": tier, "found": 1 if result else 0})
            if result:
                result.update({"query": query, "tried": tried, "note": TIER_NOTES.get(tier, "")})
                return result

        else:
            tried.append({"tier": tier, "found": 0, "error": "unknown tier"})

    return {
        "ok": False,
        "query": query,
        "tier": None,
        "answer": "",
        "hits": [],
        "tried": tried,
        "error": (
            "nothing in memory, in the workspace, in the cache, and a service "
            "that would have it needs a key you have not added"
        ),
    }


def _remote(query: str, ctx: Any, tier: str, limit: int) -> Optional[Dict[str, Any]]:
    """Try the remote tiers a source at a time, cheapest and freest first."""
    if tier in ("free", "api"):
        from . import connectors

        for connector in connectors.for_capability(ctx, "web_search", tier=tier):
            answer = connectors.call(
                connector["id"], {"query": query}, ctx, timeout=20.0
            )
            if answer.get("ok") and answer.get("hits"):
                return {
                    "ok": True,
                    "tier": tier,
                    "answer": _first_line(answer["hits"]),
                    "hits": answer["hits"],
                    "source": connector["label"],
                }
        if tier == "api":
            return None

    searx = searxng(query, limit=limit)
    if searx:
        return {"ok": True, "tier": "free", "answer": _first_line(searx["hits"]), "hits": searx["hits"],
                "source": searx["source"]}

    for source in PUBLIC_SOURCES:
        found = source(query, limit=min(limit, 5))
        if not found:
            continue
        hits = found.get("hits")
        if hits:
            return {
                "ok": True,
                "tier": "public",
                "answer": found.get("text") or _first_line(hits),
                "hits": hits,
                "source": found.get("source"),
                "title": found.get("title"),
            }
        if found.get("text"):
            return {
                "ok": True,
                "tier": "public",
                "answer": found["text"],
                "hits": [{"title": found.get("title"), "url": found.get("url")}],
                "source": found.get("source"),
                "title": found.get("title"),
            }
    return None


def _first_line(hits: Any) -> str:
    if isinstance(hits, list) and hits:
        first = hits[0]
        if isinstance(first, dict):
            return str(first.get("title") or first.get("text") or first.get("snippet") or "")
    return ""


def hierarchy_report(settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    What each tier *would* do right now, for the web page to draw.

    The point of showing it is that "why can't it answer?" becomes answerable at
    a glance: the tier that needs the missing key is visible before it is asked.
    """
    from . import capabilities, connectors

    online = bool(capabilities.reachability(timeout=1.0).get("online"))
    report: List[Dict[str, Any]] = []
    for tier in settings.get("infoTiers") or []:
        if tier == "memory":
            entry = {"ready": True, "detail": "the brain's own database"}
        elif tier == "workspace":
            entry = {
                "ready": config.workspace_dir().exists(),
                "detail": str(config.workspace_dir()),
            }
        elif tier == "cache":
            entries = cache_entries(limit=1)
            entry = {
                "ready": True,
                "detail": f"{len(cache_entries(limit=1000))} documents kept"
                + (f", newest {time.strftime('%Y-%m-%d', time.localtime(entries[0]['cachedAt']))}"
                   if entries and entries[0].get("cachedAt") else ""),
            }
        elif tier == "public":
            entry = {
                "ready": online,
                "detail": "Wikipedia, Stack Overflow, Hacker News — no account needed"
                if online else "needs a network",
            }
        elif tier == "free":
            available = connectors.for_capability_report("web_search")
            ready = any(c["ready"] for c in available if c["tier"] == "free")
            entry = {
                "ready": ready or online,
                "detail": "SearXNG on this machine, when it is running",
            }
        elif tier == "api":
            available = [c for c in connectors.for_capability_report("web_search") if c["tier"] == "api"]
            ready = any(c["ready"] for c in available)
            entry = {
                "ready": ready,
                "detail": (
                    "configured: " + ", ".join(c["label"] for c in available if c["ready"])
                ) if ready else (
                    "add a key for " + ", ".join(c["label"] for c in available)
                ),
            }
        else:
            entry = {"ready": False, "detail": "unknown tier"}
        entry.update({"tier": tier, "note": TIER_NOTES.get(tier, "")})
        report.append(entry)
    return report
