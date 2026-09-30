"""
The brain's long-term memory, in one SQLite file it owns.

This is the whole "internal memory and organisation" layer, and it is a single
file on disk: no server, no service, no account, and nothing to keep running.
`sqlite3` ships with Python, so the module has no dependency at all — which is
the point, because memory is the one thing the system must never lose access to.

What lives here:

    memory         facts worth keeping, full-text searchable when SQLite was
                   built with FTS5 and by plain matching when it was not
    events         the running log: what the brain did, and what went wrong
    tool_runs      every tool call with its timing and outcome, which is what
                   self-diagnostics reasons over
    snapshots      the capability map as it was on an earlier day, so "what
                   changed?" has an answer beyond a guess
    connectors     which connectors are on, and their last observed health
    credentials    keys the person has explicitly handed over, never returned

Two rules the rest of the code depends on:

* every write goes through one lock, because the HTTP server answers requests on
  several threads and SQLite connections are not for sharing;
* full-text search is optional. If FTS5 is missing the search still works, just
  less cleverly, because "works everywhere" beats "works better sometimes".
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Dict, Iterable, List, Optional

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'brain',
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         REAL NOT NULL,
  level      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  data       TEXT
);

CREATE TABLE IF NOT EXISTS tool_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         REAL NOT NULL,
  tool       TEXT NOT NULL,
  args       TEXT NOT NULL DEFAULT '{}',
  ok         INTEGER NOT NULL,
  ms         INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  preview    TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         REAL NOT NULL,
  data       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connectors (
  id          TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  settings    TEXT NOT NULL DEFAULT '{}',
  last_ok_at  REAL,
  last_error  TEXT,
  updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  every_seconds INTEGER,
  daily_at      TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_run      REAL,
  last_run      REAL,
  last_ok       INTEGER,
  last_error    TEXT,
  last_result   TEXT,
  runs          INTEGER NOT NULL DEFAULT 0,
  created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  convo      INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  meta       TEXT,
  at         REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_updated ON memory (updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_convo ON messages (convo, id);
CREATE INDEX IF NOT EXISTS tool_runs_at ON tool_runs (at DESC);
CREATE INDEX IF NOT EXISTS tasks_next ON tasks (enabled, next_run);
"""


def _now() -> float:
    return time.time()


def _split_tags(raw: str) -> List[str]:
    return [t for t in (piece.strip() for piece in raw.split(",")) if t]


class Store:
    """Everything the brain remembers between runs."""

    def __init__(self, path: Optional[str] = None) -> None:
        config.ensure_dirs()
        self.path = str(path or config.db_path())
        self._lock = threading.RLock()
        # One connection, shared deliberately: the lock below serialises it, and
        # opening a connection per request would be slower and no safer.
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(SCHEMA)
        self._db.commit()
        self.fts = self._enable_fts()

    # ------------------------------------------------------------------ plumbing

    def _enable_fts(self) -> bool:
        """
        Turn on full-text search when this SQLite has it.

        The virtual table is kept in step with `memory` by triggers, so every
        existing write path stays a plain INSERT and cannot forget to index.
        """
        try:
            with self._lock:
                self._db.executescript(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
                    USING fts5(text, tags, content='memory', content_rowid='id');

                    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
                      INSERT INTO memory_fts (rowid, text, tags)
                      VALUES (new.id, new.text, new.tags);
                    END;
                    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
                      INSERT INTO memory_fts (memory_fts, rowid, text, tags)
                      VALUES ('delete', old.id, old.text, old.tags);
                    END;
                    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
                      INSERT INTO memory_fts (memory_fts, rowid, text, tags)
                      VALUES ('delete', old.id, old.text, old.tags);
                      INSERT INTO memory_fts (rowid, text, tags)
                      VALUES (new.id, new.text, new.tags);
                    END;
                    """
                )
                self._db.commit()
            return True
        except sqlite3.DatabaseError:
            return False

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------------ key/value

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
                "updated_at = excluded.updated_at",
                (key, json.dumps(value), _now()),
            )
            self._db.commit()

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._db.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except ValueError:
            return default

    # --------------------------------------------------------------------- memory

    def remember(
        self,
        text: str,
        tags: Iterable[str] = (),
        source: str = "brain",
        pinned: bool = False,
    ) -> int:
        clean = " ".join(text.split())
        if not clean:
            raise ValueError("nothing to remember")
        stamp = _now()
        with self._lock:
            cursor = self._db.execute(
                "INSERT INTO memory (text, tags, source, pinned, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (clean, ",".join(sorted({t.strip() for t in tags if t.strip()})),
                 source, 1 if pinned else 0, stamp, stamp),
            )
            self._db.commit()
            memory_id = int(cursor.lastrowid or 0)
        self.event("info", "memory", f"remembered: {clean[:80]}", {"id": memory_id})
        return memory_id

    def _ranked(self, query: str, limit: int) -> List[sqlite3.Row]:
        """
        Rows for a query, best first.

        FTS5 gives a real ranking (bm25: lower is better). Without it the query
        becomes a set of LIKEs counted by how many of them matched, which is
        cruder but never silently returns nothing.
        """
        words = [w for w in "".join(c if c.isalnum() else " " for c in query).split() if len(w) > 1]
        if not words:
            return []
        with self._lock:
            if self.fts:
                expression = " OR ".join(f'"{w}"' for w in words[:12])
                try:
                    return list(
                        self._db.execute(
                            "SELECT m.* FROM memory_fts f JOIN memory m ON m.id = f.rowid "
                            "WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?",
                            (expression, limit),
                        )
                    )
                except sqlite3.DatabaseError:
                    # A query FTS cannot parse (a stray quote, mostly) should
                    # fall through to the plain scan rather than 500 the caller.
                    pass
            where = " OR ".join(["LOWER(text) LIKE ?"] * len(words[:12]))
            params = [f"%{w.lower()}%" for w in words[:12]]
            return list(
                self._db.execute(
                    f"SELECT * FROM memory WHERE {where} ORDER BY updated_at DESC LIMIT ?",
                    (*params, limit),
                )
            )

    def search_memory(self, query: str, limit: int = 10) -> List[Dict[str, Any]]:
        if not query.strip():
            return self.list_memory(limit)
        return [dict(row) for row in self._ranked(query, limit)]

    def list_memory(self, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM memory ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [dict(row) for row in rows]

    def count_memory(self) -> int:
        with self._lock:
            row = self._db.execute("SELECT COUNT(*) AS n FROM memory").fetchone()
        return int(row["n"]) if row else 0

    def forget(self, memory_id: int) -> bool:
        with self._lock:
            cursor = self._db.execute("DELETE FROM memory WHERE id = ?", (memory_id,))
            self._db.commit()
        return cursor.rowcount > 0

    # --------------------------------------------------------------------- events

    def event(self, level: str, kind: str, text: str, data: Any = None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO events (at, level, kind, text, data) VALUES (?, ?, ?, ?, ?)",
                (_now(), level, kind, text[:2000], json.dumps(data) if data is not None else None),
            )
            self._db.commit()

    def recent_events(self, limit: int = 50, level: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._lock:
            if level:
                rows = self._db.execute(
                    "SELECT * FROM events WHERE level = ? ORDER BY id DESC LIMIT ?",
                    (level, limit),
                ).fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
                ).fetchall()
        return [dict(row) for row in rows]

    # ------------------------------------------------------------------ tool runs

    def record_tool_run(
        self,
        tool: str,
        args: Any,
        ok: bool,
        ms: int,
        error: Optional[str] = None,
        preview: Optional[str] = None,
    ) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO tool_runs (at, tool, args, ok, ms, error, preview) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (_now(), tool, json.dumps(args, default=str)[:4000], 1 if ok else 0,
                 ms, (error or "")[:2000] or None, (preview or "")[:1000] or None),
            )
            self._db.commit()

    def tool_stats(self) -> List[Dict[str, Any]]:
        """Per-tool call count, failure count and average time, slowest first."""
        with self._lock:
            rows = self._db.execute(
                "SELECT tool, COUNT(*) AS calls, SUM(ok = 0) AS failures, "
                "CAST(AVG(ms) AS INTEGER) AS avg_ms, MAX(at) AS last_at "
                "FROM tool_runs GROUP BY tool ORDER BY avg_ms DESC",
            ).fetchall()
        return [dict(row) for row in rows]

    def last_runs(self, tool: str, limit: int = 5) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM tool_runs WHERE tool = ? ORDER BY id DESC LIMIT ?",
                (tool, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    # ------------------------------------------------------------------ snapshots

    def save_snapshot(self, data: Any) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO snapshots (at, data) VALUES (?, ?)",
                (_now(), json.dumps(data, default=str)),
            )
            self._db.commit()

    def snapshots(self, limit: int = 10) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id, at, data FROM snapshots ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        out = []
        for row in rows:
            try:
                data = json.loads(row["data"])
            except ValueError:
                data = None
            out.append({"id": row["id"], "at": row["at"], "data": data})
        return out

    def latest_snapshot(self) -> Optional[Dict[str, Any]]:
        found = self.snapshots(1)
        return found[0] if found else None

    # ------------------------------------------------------------------ connectors

    def set_connector(self, connector_id: str, enabled: bool | None = None,
                      settings: Optional[Dict[str, Any]] = None) -> None:
        current = self.get_connector(connector_id)
        merged = dict(current.get("settings") or {})
        if settings:
            merged.update(settings)
        with self._lock:
            self._db.execute(
                "INSERT INTO connectors (id, enabled, settings, updated_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, "
                "settings = excluded.settings, updated_at = excluded.updated_at",
                (
                    connector_id,
                    1 if (enabled if enabled is not None else bool(current.get("enabled"))) else 0,
                    json.dumps(merged),
                    _now(),
                ),
            )
            self._db.commit()

    def mark_connector(self, connector_id: str, ok: bool, error: Optional[str] = None) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE connectors SET last_ok_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
                (_now() if ok else None, (error or "")[:500] or None, _now(), connector_id),
            )
            self._db.commit()

    def get_connector(self, connector_id: str) -> Dict[str, Any]:
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM connectors WHERE id = ?", (connector_id,)
            ).fetchone()
        if row is None:
            return {"id": connector_id, "enabled": False, "settings": {}}
        found = dict(row)
        try:
            found["settings"] = json.loads(found.get("settings") or "{}")
        except ValueError:
            found["settings"] = {}
        found["enabled"] = bool(found.get("enabled"))
        return found

    def all_connectors(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM connectors").fetchall()
        out: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            entry = dict(row)
            try:
                entry["settings"] = json.loads(entry.get("settings") or "{}")
            except ValueError:
                entry["settings"] = {}
            entry["enabled"] = bool(entry.get("enabled"))
            out[entry["id"]] = entry
        return out

    # ----------------------------------------------------------------- credentials

    def put_credential(self, name: str, value: str) -> None:
        """
        Keep a key the person handed over.

        Written into the same database as everything else, whose directory was
        made `0o700`. Nothing reads it back out to a caller: `get_credential` is
        for the code that needs to make the request, and the API only ever
        reports which names exist.
        """
        with self._lock:
            self._db.execute(
                "INSERT INTO credentials (name, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET value = excluded.value, "
                "updated_at = excluded.updated_at",
                (name, value, _now()),
            )
            self._db.commit()

    def get_credential(self, name: str) -> Optional[str]:
        with self._lock:
            row = self._db.execute(
                "SELECT value FROM credentials WHERE name = ?", (name,)
            ).fetchone()
        return row["value"] if row else None

    def delete_credential(self, name: str) -> bool:
        with self._lock:
            cursor = self._db.execute("DELETE FROM credentials WHERE name = ?", (name,))
            self._db.commit()
        return cursor.rowcount > 0

    def credential_names(self) -> List[Dict[str, Any]]:
        """Which keys exist and when they were set — never what they hold."""
        with self._lock:
            rows = self._db.execute(
                "SELECT name, updated_at FROM credentials ORDER BY name"
            ).fetchall()
        return [dict(row) for row in rows]

    # ---------------------------------------------------------------------- tasks

    def put_task(
        self,
        name: str,
        kind: str,
        payload: Any,
        every_seconds: Optional[int] = None,
        daily_at: Optional[str] = None,
        enabled: bool = True,
        next_run: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Add a recurring task, or replace the one with this name.

        Replacing is deliberate: setting the same task up again should adjust
        it, not leave two copies running.
        """
        clean = " ".join(name.split())
        if not clean:
            raise ValueError("a task needs a name")
        if not every_seconds and not daily_at:
            raise ValueError("say how often: every_seconds or daily_at")
        with self._lock:
            self._db.execute(
                "INSERT INTO tasks (name, kind, payload, every_seconds, daily_at, enabled, "
                "next_run, runs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) "
                "ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, "
                "payload = excluded.payload, every_seconds = excluded.every_seconds, "
                "daily_at = excluded.daily_at, enabled = excluded.enabled, "
                "next_run = excluded.next_run",
                (
                    clean,
                    kind,
                    json.dumps(payload, default=str),
                    every_seconds,
                    daily_at,
                    1 if enabled else 0,
                    next_run if next_run is not None else _now(),
                    _now(),
                ),
            )
            self._db.commit()
        self.event("info", "schedule", f"task saved: {clean}")
        found = self.find_task(clean)
        assert found is not None
        return found

    def _task_row(self, row: Any) -> Dict[str, Any]:
        found = dict(row)
        try:
            found["payload"] = json.loads(found.get("payload") or "null")
        except ValueError:
            found["payload"] = None
        found["enabled"] = bool(found.get("enabled"))
        found["lastOk"] = None if found.get("last_ok") is None else bool(found["last_ok"])
        return found

    def tasks(self, enabled_only: bool = False) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM tasks" + (" WHERE enabled = 1" if enabled_only else "")
                + " ORDER BY COALESCE(next_run, 0) ASC, name ASC"
            ).fetchall()
        return [self._task_row(row) for row in rows]

    def find_task(self, name_or_id: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            if isinstance(name_or_id, int) or str(name_or_id).isdigit():
                row = self._db.execute(
                    "SELECT * FROM tasks WHERE id = ?", (int(name_or_id),)
                ).fetchone()
            else:
                row = self._db.execute(
                    "SELECT * FROM tasks WHERE name = ?", (str(name_or_id),)
                ).fetchone()
        return self._task_row(row) if row is not None else None

    def due_tasks(self, now: Optional[float] = None) -> List[Dict[str, Any]]:
        """Enabled tasks whose time has come, earliest first."""
        stamp = _now() if now is None else now
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM tasks WHERE enabled = 1 AND COALESCE(next_run, 0) <= ? "
                "ORDER BY next_run ASC",
                (stamp,),
            ).fetchall()
        return [self._task_row(row) for row in rows]

    def mark_task_run(
        self,
        task_id: int,
        ok: bool,
        next_run: float,
        error: Optional[str] = None,
        result: Optional[str] = None,
    ) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE tasks SET last_run = ?, last_ok = ?, last_error = ?, "
                "last_result = ?, next_run = ?, runs = runs + 1 WHERE id = ?",
                (_now(), 1 if ok else 0, (error or "")[:1000] or None,
                 (result or "")[:2000] or None, next_run, task_id),
            )
            self._db.commit()

    def set_task_enabled(self, name_or_id: Any, enabled: bool, next_run: Optional[float] = None) -> bool:
        task = self.find_task(name_or_id)
        if task is None:
            return False
        with self._lock:
            self._db.execute(
                "UPDATE tasks SET enabled = ?, next_run = COALESCE(?, next_run) WHERE id = ?",
                (1 if enabled else 0, next_run, task["id"]),
            )
            self._db.commit()
        self.event("info", "schedule", f"task {task['name']} {'enabled' if enabled else 'paused'}")
        return True

    def remove_task(self, name_or_id: Any) -> bool:
        task = self.find_task(name_or_id)
        if task is None:
            return False
        with self._lock:
            cursor = self._db.execute("DELETE FROM tasks WHERE id = ?", (task["id"],))
            self._db.commit()
        self.event("info", "schedule", f"task removed: {task['name']}")
        return cursor.rowcount > 0

    # -------------------------------------------------------------- conversations

    def start_conversation(self, title: str = "") -> int:
        with self._lock:
            cursor = self._db.execute(
                "INSERT INTO conversations (title, created_at) VALUES (?, ?)",
                (title[:200], _now()),
            )
            self._db.commit()
            return int(cursor.lastrowid or 0)

    def append_message(self, convo: int, role: str, text: str, meta: Any = None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO messages (convo, role, text, meta, at) VALUES (?, ?, ?, ?, ?)",
                (convo, role, text, json.dumps(meta) if meta is not None else None, _now()),
            )
            self._db.commit()

    def messages(self, convo: int, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT role, text, meta, at FROM messages WHERE convo = ? "
                "ORDER BY id ASC LIMIT ?",
                (convo, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def conversations(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT c.id, c.title, c.created_at, COUNT(m.id) AS messages "
                "FROM conversations c LEFT JOIN messages m ON m.convo = c.id "
                "GROUP BY c.id ORDER BY c.created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    # ------------------------------------------------------------------- overview

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            def count(table: str) -> int:
                row = self._db.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
                return int(row["n"]) if row else 0

            size = 0
            try:
                import os

                size = os.path.getsize(self.path)
            except OSError:
                pass
            due = self._db.execute(
                "SELECT COUNT(*) AS n FROM tasks WHERE enabled = 1 AND COALESCE(next_run, 0) <= ?",
                (_now(),),
            ).fetchone()
            return {
                "path": self.path,
                "bytes": size,
                "fts": self.fts,
                "memory": count("memory"),
                "events": count("events"),
                "toolRuns": count("tool_runs"),
                "snapshots": count("snapshots"),
                "conversations": count("conversations"),
                "credentials": count("credentials"),
                "tasks": count("tasks"),
                "tasksDue": int(due["n"]) if due else 0,
            }
