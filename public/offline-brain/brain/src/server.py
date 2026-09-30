"""
The API, which is the one thing the two versions share.

The local brain is the system; this file is how anything else talks to it. A web
page, a shell script, the hub, an editor plugin — all of them see the same
endpoints, so "the web version" is a *view* of the local brain rather than a
second implementation of it. That is the whole architecture in one sentence:
one brain, reachable from wherever you are.

Three decisions worth naming:

* **Loopback by default.** The API can run shell commands and read files, so it
  binds to `127.0.0.1` unless somebody deliberately changes the host. Reaching
  it from another machine is a decision, not a default.
* **A pairing token, always.** Any page you have open can reach loopback, so
  every endpoint except the health check and the protocol list needs
  `X-Brain-Token`. The token is created on first start, is stored `0600`, and can
  be rotated from the CLI.
* **Private-network headers.** A page served over https cannot normally call
  `http://127.0.0.1`, because browsers block public pages from reaching private
  networks. The preflight here answers with
  `Access-Control-Allow-Private-Network: true`, which is what makes a hosted hub
  page able to talk to the brain on your own machine.
"""

from __future__ import annotations

import hmac
import json
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import (
    agent,
    capabilities,
    config,
    connectors,
    diagnostics,
    info,
    providers,
    scheduler,
    tools,
    updater,
)

__all__ = [
    "Brain",
    "Handler",
    "ENDPOINTS",
    "PUBLIC_PATHS",
    "serve",
    "banner",
    "agent",
    "capabilities",
    "config",
    "connectors",
    "diagnostics",
    "info",
    "providers",
    "scheduler",
    "tools",
    "updater",
]

#: Endpoints that do not need the pairing token: enough to discover a brain and
#: see that it is alive, and nothing that reads a memory or runs a command.
PUBLIC_PATHS = ("/api/v1/health", "/api/v1/protocol")

ENDPOINTS = [
    {"method": "GET", "path": "/api/v1/health", "auth": False, "what": "is it running, and in which mode"},
    {"method": "GET", "path": "/api/v1/protocol", "auth": False, "what": "this list"},
    {"method": "GET", "path": "/api/v1/pair", "auth": True, "what": "check a token and report the host"},
    {"method": "GET", "path": "/api/v1/stats", "auth": True, "what": "database, memory and event counts"},
    {"method": "GET", "path": "/api/v1/capabilities", "auth": True, "what": "the capability map (?fresh=1 to re-probe)"},
    {"method": "GET", "path": "/api/v1/tools", "auth": True, "what": "every tool, with health and stats"},
    {"method": "POST", "path": "/api/v1/tools/run", "auth": True, "what": "{tool, args}"},
    {"method": "GET", "path": "/api/v1/models", "auth": True, "what": "local model servers and their models"},
    {"method": "GET", "path": "/api/v1/memory", "auth": True, "what": "search or list memory (?q=&limit=)"},
    {"method": "POST", "path": "/api/v1/memory", "auth": True, "what": "{text, tags, pinned}"},
    {"method": "DELETE", "path": "/api/v1/memory/{id}", "auth": True, "what": "forget one"},
    {"method": "GET", "path": "/api/v1/connectors", "auth": True, "what": "the connector registry and its state"},
    {"method": "POST", "path": "/api/v1/connectors/{id}", "auth": True, "what": "{enabled}"},
    {"method": "POST", "path": "/api/v1/connectors/{id}/credentials", "auth": True, "what": "{name, value}"},
    {"method": "DELETE", "path": "/api/v1/connectors/{id}/credentials/{name}", "auth": True, "what": "remove one"},
    {"method": "GET", "path": "/api/v1/hierarchy", "auth": True, "what": "the information tiers and their readiness"},
    {"method": "POST", "path": "/api/v1/info", "auth": True, "what": "{query, tiers} — walk the hierarchy"},
    {"method": "GET", "path": "/api/v1/cache", "auth": True, "what": "documents kept for offline use"},
    {"method": "POST", "path": "/api/v1/ask", "auth": True, "what": "{question} — the agent loop, with its steps"},
    {"method": "POST", "path": "/api/v1/plan", "auth": True, "what": "{question} — what it would do, without doing it"},
    {"method": "GET", "path": "/api/v1/tasks", "auth": True, "what": "scheduled work, and whether the clock is running"},
    {"method": "POST", "path": "/api/v1/tasks", "auth": True, "what": "{name, when, kind, payload}"},
    {"method": "POST", "path": "/api/v1/tasks/{id}", "auth": True, "what": "{enabled}"},
    {"method": "POST", "path": "/api/v1/tasks/{id}/run", "auth": True, "what": "run it now"},
    {"method": "DELETE", "path": "/api/v1/tasks/{id}", "auth": True, "what": "remove one"},
    {"method": "GET", "path": "/api/v1/updates", "auth": True, "what": "inventory, installers, and what could be replaced locally"},
    {"method": "POST", "path": "/api/v1/updates/run", "auth": True, "what": "{installer} — run one of the package's own scripts"},
    {"method": "GET", "path": "/api/v1/diagnostics", "auth": True, "what": "self-check, findings and repairs"},
    {"method": "POST", "path": "/api/v1/repairs/{name}", "auth": True, "what": "run one repair"},
    {"method": "GET", "path": "/api/v1/events", "auth": True, "what": "the log (?limit=&level=)"},
    {"method": "GET", "path": "/api/v1/config", "auth": True, "what": "settings in force (no secrets)"},
    {"method": "POST", "path": "/api/v1/config", "auth": True, "what": "change settings"},
]

#: Settings a caller may change over the API. Notably absent: `auth`. Turning the
#: token requirement off is something a person does at the CLI, on the machine,
#: deliberately — not something a web page can ask for.
EDITABLE_SETTINGS = {
    "model",
    "allowExternal",
    "externalProviders",
    "localProviders",
    "infoTiers",
    "testCommand",
    "hubUrl",
    "toolTimeout",
    "modelTimeout",
    "capabilityTtl",
    "allowedOrigins",
    "port",
    "host",
}


class Brain:
    """The wiring: one store, one registry, one context, shared by every request."""

    def __init__(self, store: Any, settings: Dict[str, Any]) -> None:
        self.store = store
        self.settings = settings
        self.started = time.time()
        self.token = config.ensure_token() if settings.get("auth") != "open" else None
        self.loaded_tools = tools.registry.load_external()
        # The clock. Started here rather than in `serve` so that every entry point
        # — the API, the tests, anything embedding the brain — gets the same
        # behaviour, and stopped explicitly so nothing outlives its process.
        self.runner = scheduler.Runner(
            store,
            tools.ToolContext(store, settings),
            tick=int(settings.get("schedulerTick") or scheduler.TICK_SECONDS),
            max_per_tick=int(settings.get("schedulerMaxPerTick") or 3),
        )
        if settings.get("scheduler", True):
            self.runner.start()
        self.store.event(
            "info",
            "server",
            f"brain {config.VERSION} started",
            {
                "tools": len(tools.registry.all()),
                "custom": self.loaded_tools["loaded"],
                "scheduler": self.runner.running,
            },
        )

    def context(self) -> tools.ToolContext:
        return tools.ToolContext(self.store, self.settings)

    def stop(self) -> None:
        """Take the clock down with the server."""
        self.runner.stop()

    def token_ok(self, supplied: Optional[str]) -> bool:
        if self.token is None:
            return True
        if not supplied:
            return False
        return hmac.compare_digest(str(supplied), str(self.token))

    @property
    def mode(self) -> str:
        online = capabilities.reachability(timeout=0.8).get("online")
        models = providers.discover(self.settings)
        has_model = any(server["ok"] for server in models)
        if has_model and online:
            return "hybrid"
        if has_model:
            return "local"
        return "tools-only" if not online else "tools-only"


class Handler(BaseHTTPRequestHandler):
    server_version = f"{config.PACKAGE}-brain/{config.VERSION}"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- HTTP plumbing

    def log_message(self, format: str, *args: Any) -> None:
        """Quieter than the default: one line per request, and no banner."""
        if self.path.startswith("/api/v1/health"):
            return
        config.log("http", f"{self.command} {self.path}")

    @property
    def brain(self) -> Brain:
        return self.server.brain  # type: ignore[attr-defined]

    def _cors(self) -> None:
        """
        Allow a page on any origin to *try*, and say yes to a private-network
        preflight. The token is what actually decides who gets in.
        """
        allowed = self.brain.settings.get("allowedOrigins") or ["*"]
        origin = self.headers.get("Origin")
        if "*" in allowed:
            self.send_header("Access-Control-Allow-Origin", origin or "*")
        elif origin and origin in allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Brain-Token, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        # What Chrome wants before a public page may reach loopback.
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, status: int, payload: Any, content_type: str = "application/json") -> None:
        body = (
            json.dumps(payload, default=str).encode("utf-8")
            if content_type.startswith("application/json")
            else str(payload).encode("utf-8")
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str, **extra: Any) -> None:
        self._send(status, {"ok": False, "error": message, **extra})

    def _query(self) -> Dict[str, str]:
        parsed = urllib.parse.urlparse(self.path)
        return {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}

    def _segments(self) -> List[str]:
        return [part for part in urllib.parse.urlparse(self.path).path.split("/") if part]

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 4_000_000:
            raise ValueError("request body is too large")
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        if not raw.strip():
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("a request body has to be a JSON object")
        return parsed

    def _supplied_token(self) -> Optional[str]:
        header = self.headers.get("X-Brain-Token")
        if header:
            return header.strip()
        authorization = self.headers.get("Authorization") or ""
        if authorization.lower().startswith("bearer "):
            return authorization[7:].strip()
        return self._query().get("token")

    def _authorize(self, path: str) -> bool:
        if path in PUBLIC_PATHS:
            return True
        if self.brain.token_ok(self._supplied_token()):
            return True
        self._error(
            HTTPStatus.UNAUTHORIZED,
            "the pairing token is missing or wrong",
            hint="paste the pairing token printed by `python3 brain.py pair` on the "
                 "machine running the brain",
        )
        return False

    # ------------------------------------------------------------------ routing

    def do_OPTIONS(self) -> None:  # noqa: N802 - the name http.server expects
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._route("DELETE")

    def _route(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        try:
            if path == "/" and method == "GET":
                return self._index()
            if not self._authorize(path):
                return

            handler = self._find(method, path)
            if handler is None:
                return self._error(
                    HTTPStatus.NOT_FOUND,
                    f"no such endpoint: {method} {path}",
                    endpoints=[f"{entry['method']} {entry['path']}" for entry in ENDPOINTS],
                )
            handler(path)
        except ValueError as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
        except KeyError as error:
            self._error(HTTPStatus.NOT_FOUND, f"not found: {error}")
        except Exception as error:  # noqa: BLE001 - an API that crashes is useless
            self.brain.store.event("error", "http", f"{method} {path}", {"error": repr(error)})
            self._error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                f"{type(error).__name__}: {error}",
                hint="this is recorded in the event log and in diag.check",
            )

    def _find(self, method: str, path: str) -> Optional[Callable[[str], None]]:
        query = self._query()
        segments = self._segments()

        table: Dict[Tuple[str, str], Callable[[str], None]] = {
            ("GET", "/api/v1/health"): lambda _: self._health(),
            ("GET", "/api/v1/protocol"): lambda _: self._send(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "protocol": config.PROTOCOL,
                    "version": config.VERSION,
                    "package": config.PACKAGE,
                    "endpoints": ENDPOINTS,
                },
            ),
            ("GET", "/api/v1/pair"): lambda _: self._pair(),
            ("GET", "/api/v1/stats"): lambda _: self._send(HTTPStatus.OK, {"ok": True, **self.brain.store.stats()}),
            ("GET", "/api/v1/capabilities"): lambda _: self._send(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "capabilities": capabilities.build(self.brain.store, force=query.get("fresh") in ("1", "true")),
                },
            ),
            ("GET", "/api/v1/tools"): lambda _: self._send(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "tools": tools.registry.describe_all(self.brain.store),
                    "loaded": self.brain.loaded_tools,
                },
            ),
            ("POST", "/api/v1/tools/run"): lambda _: self._run_tool(),
            ("GET", "/api/v1/models"): lambda _: self._models(),
            ("GET", "/api/v1/memory"): lambda _: self._memory_list(),
            ("POST", "/api/v1/memory"): lambda _: self._memory_add(),
            ("GET", "/api/v1/connectors"): lambda _: self._send(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "connectors": connectors.describe(self.brain.store),
                    "summary": connectors.summary(self.brain.store),
                },
            ),
            ("GET", "/api/v1/hierarchy"): lambda _: self._send(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "tiers": info.hierarchy_report(self.brain.settings),
                    "order": self.brain.settings.get("infoTiers"),
                },
            ),
            ("POST", "/api/v1/info"): lambda _: self._info(),
            ("GET", "/api/v1/cache"): lambda _: self._send(
                HTTPStatus.OK, {"ok": True, "documents": info.cache_entries(limit=int(query.get("limit") or 100))}
            ),
            ("POST", "/api/v1/ask"): lambda _: self._ask(),
            ("POST", "/api/v1/plan"): lambda _: self._plan(),
            ("GET", "/api/v1/tasks"): lambda _: self._tasks(),
            ("POST", "/api/v1/tasks"): lambda _: self._task_add(),
            ("GET", "/api/v1/updates"): lambda _: self._send(
                HTTPStatus.OK,
                updater.check(
                    self.brain.store,
                    self.brain.context(),
                    refresh=query.get("refresh") in ("1", "true"),
                ),
            ),
            ("POST", "/api/v1/updates/run"): lambda _: self._updates_run(),
            ("GET", "/api/v1/diagnostics"): lambda _: self._send(
                HTTPStatus.OK,
                diagnostics.report(self.brain.context(), deep=query.get("deep") in ("1", "true")),
            ),
            ("GET", "/api/v1/events"): lambda _: self._send(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "events": self.brain.store.recent_events(
                        limit=int(query.get("limit") or 100), level=query.get("level")
                    ),
                },
            ),
            ("GET", "/api/v1/config"): lambda _: self._send(
                HTTPStatus.OK, {"ok": True, "config": self.brain.settings, "editable": sorted(EDITABLE_SETTINGS)}
            ),
            ("POST", "/api/v1/config"): lambda _: self._config(),
        }

        direct = table.get((method, path))
        if direct:
            return direct

        # Paths with an id in them.
        if len(segments) >= 4 and segments[0] == "api" and segments[1] == "v1":
            if method == "DELETE" and segments[2] == "memory" and len(segments) == 4:
                return lambda _: self._memory_forget(int(segments[3]))
            if len(segments) >= 4 and segments[2] == "connectors":
                if method == "POST" and len(segments) == 4:
                    return lambda _: self._connector_state(segments[3])
                if len(segments) == 5 and segments[4] == "credentials" and method == "POST":
                    return lambda _: self._connector_credential(segments[3])
                if len(segments) == 6 and segments[4] == "credentials" and method == "DELETE":
                    return lambda _: self._connector_credential_drop(segments[3], segments[5])
            if method == "POST" and segments[2] == "repairs" and len(segments) == 4:
                return lambda _: self._repair(segments[3])
            if segments[2] == "tasks" and len(segments) >= 4:
                # Task names may hold spaces, so the identifier arrives percent-encoded.
                task = urllib.parse.unquote(segments[3])
                if method == "DELETE" and len(segments) == 4:
                    return lambda _: self._task_remove(task)
                if method == "POST" and len(segments) == 4:
                    return lambda _: self._task_state(task)
                if method == "POST" and len(segments) == 5 and segments[4] == "run":
                    return lambda _: self._task_run(task)
        return None

    # ----------------------------------------------------------------- endpooints

    def _index(self) -> None:
        """A page for a person who opened the port in a browser by accident."""
        host = self.headers.get("Host") or "127.0.0.1"
        self._send(
            HTTPStatus.OK,
            f"""<!doctype html><meta charset="utf-8">
<title>Local Brain</title>
<style>
 body {{ background:#0a0a0a; color:#fafafa; font:14px/1.6 ui-monospace,monospace;
        max-width:44rem; margin:4rem auto; padding:0 1.25rem }}
 a {{ color:#fafafa }} code {{ background:#1a1a1a; padding:.15rem .4rem; border-radius:.25rem }}
 pre {{ background:#141414; padding:.75rem; border-radius:.5rem; overflow:auto }}
</style>
<h1>Local Brain</h1>
<p>Running on <code>{host}</code>, protocol <code>{config.PROTOCOL}</code>,
version <code>{config.VERSION}</code>.</p>
<p>This is the local half of the system. The web half is the hub's
<strong>Local Brain</strong> page, which pairs with this port and shows the same
memory, tools, connectors and diagnostics.</p>
<p>Check it directly:</p>
<pre>curl -s http://{host}/api/v1/health</pre>
<p><a href="/api/v1/protocol">/api/v1/protocol</a> lists every endpoint.
The pairing token is printed by <code>python3 brain.py pair</code>.</p>
""",
            content_type="text/html; charset=utf-8",
        )

    def _health(self) -> None:
        """Cheap on purpose: a page polls this, so it reads the cache and never probes."""
        cached = self.brain.store.get("capabilities")
        online = None
        if isinstance(cached, dict):
            network = cached.get("network") or {}
            online = bool(network.get("online")) if "online" in network else None
        self._send(
            HTTPStatus.OK,
            {
                "ok": True,
                "product": config.PACKAGE,
                "version": config.VERSION,
                "protocol": config.PROTOCOL,
                "uptimeSeconds": int(time.time() - self.brain.started),
                "authRequired": self.brain.token is not None,
                "online": online,
                "offline": online is False,
                "workspace": str(config.workspace_dir()),
                "dataDir": str(config.data_dir()),
                "tools": len(tools.registry.all()),
                "memory": self.brain.store.count_memory(),
                "host": str(config.load_config().get("host")),
            },
        )

    def _pair(self) -> None:
        self._send(
            HTTPStatus.OK,
            {
                "ok": True,
                "paired": True,
                "host": self.headers.get("Host"),
                "version": config.VERSION,
                "workspace": str(config.workspace_dir()),
                "dataDir": str(config.data_dir()),
                "tools": len(tools.registry.all()),
                "memory": self.brain.store.count_memory(),
                "modelHint": providers.start_hint(),
            },
        )

    def _run_tool(self) -> None:
        body = self._body()
        name = str(body.get("tool") or body.get("name") or "")
        args = body.get("args") or {}
        if not name:
            raise ValueError("a tool name is required")
        if not isinstance(args, dict):
            raise ValueError("args has to be a JSON object")
        self._send(HTTPStatus.OK, tools.registry.run_tool(name, args, self.brain.context()))

    def _models(self) -> None:
        servers = providers.discover(self.brain.settings)
        picked = providers.pick(self.brain.settings)
        self._send(
            HTTPStatus.OK,
            {
                "ok": True,
                "servers": servers,
                "chosen": picked.get("ok") and {"provider": picked["server"]["id"], "model": picked["model"]},
                "hint": picked.get("hint"),
            },
        )

    def _memory_list(self) -> None:
        query = self._query()
        term = query.get("q") or ""
        limit = int(query.get("limit") or 50)
        hits = self.brain.store.search_memory(term, limit=limit) if term else self.brain.store.list_memory(limit=limit)
        self._send(
            HTTPStatus.OK,
            {"ok": True, "query": term, "hits": hits, "count": len(hits), "total": self.brain.store.count_memory()},
        )

    def _memory_add(self) -> None:
        body = self._body()
        text = str(body.get("text") or "").strip()
        if not text:
            raise ValueError("text is required")
        tags = body.get("tags")
        if isinstance(tags, str):
            tags = [piece.strip() for piece in tags.split(",") if piece.strip()]
        memory_id = self.brain.store.remember(
            text, tags=tags or [], source=str(body.get("source") or "web"), pinned=bool(body.get("pinned"))
        )
        self._send(HTTPStatus.OK, {"ok": True, "id": memory_id, "total": self.brain.store.count_memory()})

    def _memory_forget(self, memory_id: int) -> None:
        self._send(HTTPStatus.OK, {"ok": self.brain.store.forget(memory_id), "id": memory_id})

    def _connector_state(self, connector_id: str) -> None:
        body = self._body()
        if "enabled" not in body:
            raise ValueError("enabled is required")
        self._send(HTTPStatus.OK, connectors.set_enabled(self.brain.store, connector_id, bool(body["enabled"])))

    def _connector_credential(self, connector_id: str) -> None:
        body = self._body()
        name = str(body.get("name") or "")
        value = str(body.get("value") or "")
        self._send(
            HTTPStatus.OK,
            connectors.put_credential(self.brain.store, connector_id, name, value),
        )

    def _connector_credential_drop(self, connector_id: str, name: str) -> None:
        self._send(
            HTTPStatus.OK,
            {"ok": connectors.drop_credential(self.brain.store, connector_id, name), "name": f"{connector_id}:{name}"},
        )

    def _info(self) -> None:
        body = self._body()
        query = str(body.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        tiers = body.get("tiers")
        if isinstance(tiers, str):
            tiers = [piece.strip() for piece in tiers.split(",") if piece.strip()]
        self._send(
            HTTPStatus.OK,
            info.lookup(query, self.brain.context(), tiers=tiers, limit=int(body.get("limit") or 5)),
        )

    def _ask(self) -> None:
        body = self._body()
        question = str(body.get("question") or body.get("q") or "").strip()
        if not question:
            raise ValueError("question is required")
        conversation = body.get("conversation")
        self._send(
            HTTPStatus.OK,
            agent.ask(
                question,
                self.brain.context(),
                conversation=int(conversation) if conversation else None,
                max_steps=int(body.get("steps") or agent.MAX_STEPS),
            ),
        )

    def _plan(self) -> None:
        body = self._body()
        question = str(body.get("question") or "").strip()
        if not question:
            raise ValueError("question is required")
        self._send(HTTPStatus.OK, agent.plan(question, self.brain.context()))

    def _repair(self, name: str) -> None:
        self._send(HTTPStatus.OK, diagnostics.repair(self.brain.store, name, self.brain.context()))

    # ------------------------------------------------------------------- tasks

    def _tasks(self) -> None:
        tasks = [scheduler.describe(task) for task in self.brain.store.tasks()]
        self._send(
            HTTPStatus.OK,
            {
                "ok": True,
                "tasks": tasks,
                "runner": self.brain.runner.status(),
                "kinds": list(scheduler.KINDS),
                "examples": [
                    "every 15 minutes", "hourly", "2h", "daily at 07:30", "daily at 7pm",
                ],
            },
        )

    def _task_add(self) -> None:
        body = self._body()
        task = scheduler.add(
            self.brain.store,
            name=str(body.get("name") or ""),
            when=str(body.get("when") or body.get("schedule") or ""),
            kind=str(body.get("kind") or "ask"),
            payload=body.get("payload"),
            enabled=bool(body.get("enabled", True)),
        )
        self._send(HTTPStatus.OK, {"ok": True, "task": scheduler.describe(task)})

    def _task_state(self, name_or_id: str) -> None:
        body = self._body()
        if "enabled" not in body:
            raise ValueError("enabled is required")
        changed = self.brain.store.set_task_enabled(
            name_or_id, bool(body["enabled"]), next_run=time.time() + 1 if body["enabled"] else None
        )
        if not changed:
            raise KeyError(name_or_id)
        found = self.brain.store.find_task(name_or_id)
        self._send(HTTPStatus.OK, {"ok": True, "task": scheduler.describe(found) if found else None})

    def _task_remove(self, name_or_id: str) -> None:
        if not self.brain.store.remove_task(name_or_id):
            raise KeyError(name_or_id)
        self._send(HTTPStatus.OK, {"ok": True, "removed": name_or_id})

    def _task_run(self, name_or_id: str) -> None:
        found = self.brain.store.find_task(name_or_id)
        if found is None:
            raise KeyError(name_or_id)
        self._send(HTTPStatus.OK, scheduler.run_task(self.brain.store, found, self.brain.context()))

    # ----------------------------------------------------------------- updates

    def _updates_run(self) -> None:
        body = self._body()
        name = str(body.get("installer") or body.get("name") or "")
        if not name:
            raise ValueError("an installer name is required")
        self._send(
            HTTPStatus.OK,
            updater.run_installer(
                self.brain.store,
                self.brain.context(),
                name,
                timeout=float(body.get("timeout") or 3600),
            ),
        )

    def _config(self) -> None:
        body = self._body()
        unknown = [key for key in body if key not in EDITABLE_SETTINGS]
        if unknown:
            raise ValueError(
                f"these settings cannot be changed here: {', '.join(unknown)}"
            )
        from . import config as config_module

        merged = dict(self.brain.settings)
        merged.update(body)
        config_module.save_config(merged)
        self.brain.settings = config_module.load_config()
        self.brain.store.event("info", "config", "settings changed", {"keys": sorted(body)})
        self._send(
            HTTPStatus.OK,
            {"ok": True, "config": self.brain.settings, "note": "a restart applies host and port"},
        )


def serve(store: Any, settings: Dict[str, Any]) -> ThreadingHTTPServer:
    """
    Start answering. Returns the server, so a caller can stop it or read its port.

    `port 0` is honoured: the operating system picks a free port and the caller
    reads it back. That is what makes the test suite able to start a real server
    without guessing at ports or racing other tests.
    """
    config.ensure_dirs()
    brain = Brain(store, settings)
    server = ThreadingHTTPServer((settings.get("host", "127.0.0.1"), int(settings.get("port", 8710))), Handler)
    server.daemon_threads = True
    server.brain = brain  # type: ignore[attr-defined]
    return server


def banner(server: ThreadingHTTPServer, settings: Dict[str, Any]) -> str:
    """What a person sees when they start the brain: the address and the token."""
    address, port = server.server_address[0], server.server_address[1]
    brain: Brain = server.brain  # type: ignore[attr-defined]
    status = brain.runner.status()
    lines = [
        "",
        f"  {config.PACKAGE} — local brain {config.VERSION}",
        "  ─────────────────────────────────────────────",
        f"  listening     http://{address}:{port}",
        f"  workspace     {config.workspace_dir()}",
        f"  data          {config.data_dir()}",
        f"  tools         {len(tools.registry.all())}",
        f"  schedule      {status['enabled']} task(s) enabled, ticking every {status['tickSeconds']}s"
        if status["running"]
        else "  schedule      paused (set scheduler: true in config.json to run tasks)",
    ]
    if brain.loaded_tools["loaded"]:
        lines.append(f"  its own tools {', '.join(brain.loaded_tools['loaded'])}")
    if brain.loaded_tools["broken"]:
        lines.append(f"  broken tools  {', '.join(brain.loaded_tools['broken'])}  (run: brain.py repair tools.reload)")
    if brain.token:
        lines.append(f"  pairing token {brain.token}")
        lines.append("                type this into the hub's Local Brain page once")
    else:
        lines.append("  pairing token none — this API is open on this machine (auth: \"open\")")
    lines.append("")
    lines.append("  Pair it:  open the hub → Local Brain, and paste the address and token.")
    lines.append("  Or:       curl -s http://127.0.0.1:%d/api/v1/health" % port)
    lines.append("")
    return "\n".join(lines)
