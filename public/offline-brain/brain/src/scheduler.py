"""
The task scheduler: work the brain does on its own, on a clock it owns.

Everything else in this system reacts — a question arrives, a tool is called. This
module is the part that acts without being asked: re-index something hourly, check
that the model server is still up every ten minutes, summarise the day's notes
each morning, run the test suite overnight and keep the result.

Three decisions make it dependable rather than clever:

* **The schedule is in the database, not in memory.** Tasks survive a restart, and
  the table is readable with `sqlite3` like everything else. There is no daemon to
  install and no cron to edit — a system that needs cron to be independent is not
  independent.
* **A task is a question or a tool call.** Those are the two things the rest of the
  brain already knows how to do, so there is no third dialect to learn and no
  separate execution path to secure.
* **A missed run is not a disaster.** The next run is computed from *now*, not from
  when the task was due, so a machine that was switched off for a week does not wake
  up and fire a week of work at once.

The runner is a plain thread started by `serve`. It ticks, asks what is due, runs
it, and writes down what happened — including when it failed, because a scheduled
task that has been failing quietly is exactly the thing self-diagnostics exists to
notice.
"""

from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from . import config

#: How often the runner wakes up. A minute is the resolution of the schedule
#: itself, so waking more often would only burn power.
TICK_SECONDS = 60

#: The two kinds of task there are.
KINDS = ("ask", "tool")

#: `every 15 minutes`, `every 2h`, `daily at 07:30`, `hourly`.
INTERVAL_PATTERN = re.compile(
    r"^\s*(?:every\s+)?(\d+)?\s*(s|sec|second|seconds|m|min|minute|minutes|"
    r"h|hr|hour|hours|d|day|days)\s*$",
    re.I,
)
DAILY_PATTERN = re.compile(r"^\s*(?:daily|every\s+day|each\s+day)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$", re.I)
HOURLY_PATTERN = re.compile(r"^\s*hourly\s*$", re.I)

UNIT_SECONDS = {
    "s": 1, "sec": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
}


def parse_when(text: str) -> Dict[str, Any]:
    """
    Turn what a person would write into an interval or a time of day.

    Accepts `every 30 minutes`, `15m`, `hourly`, `daily at 07:30` and `daily at
    7pm`. Anything else raises with the shapes that are understood, because a
    schedule that silently means the wrong thing is worse than a refusal.
    """
    raw = (text or "").strip()
    if not raw:
        raise ValueError("say when: `every 15 minutes`, `hourly`, or `daily at 07:30`")

    if HOURLY_PATTERN.match(raw):
        return {"everySeconds": 3600, "dailyAt": None, "described": "every hour"}

    daily = DAILY_PATTERN.match(raw)
    if daily:
        hour = int(daily.group(1))
        minute = int(daily.group(2) or 0)
        meridiem = (daily.group(3) or "").lower()
        if meridiem == "pm" and hour < 12:
            hour += 12
        if meridiem == "am" and hour == 12:
            hour = 0
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError(f"that is not a time of day: {raw}")
        stamp = f"{hour:02d}:{minute:02d}"
        return {"everySeconds": None, "dailyAt": stamp, "described": f"every day at {stamp}"}

    interval = INTERVAL_PATTERN.match(raw)
    if interval:
        count = int(interval.group(1) or 1)
        unit = UNIT_SECONDS[interval.group(2).lower()]
        seconds = count * unit
        if seconds < 30:
            raise ValueError("the shortest schedule is 30 seconds")
        return {
            "everySeconds": seconds,
            "dailyAt": None,
            "described": describe_seconds(seconds),
        }

    raise ValueError(
        f"I do not understand {raw!r}. Try `every 15 minutes`, `2h`, `hourly`, "
        "or `daily at 07:30`."
    )


def describe_seconds(seconds: int) -> str:
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if seconds % size == 0 and seconds >= size:
            count = seconds // size
            return f"every {count} {unit}{'s' if count != 1 else ''}"
    return f"every {seconds} seconds"


def next_run_at(
    every_seconds: Optional[int],
    daily_at: Optional[str],
    now: Optional[float] = None,
) -> float:
    """
    When this task should run next, counted from now.

    Deliberately *from now* rather than from the last due time: a laptop that was
    shut for a week should not wake up and immediately run a week of backlog.
    """
    stamp = time.time() if now is None else now
    if every_seconds:
        return stamp + max(30, int(every_seconds))
    if daily_at:
        hour, minute = (int(part) for part in daily_at.split(":"))
        today = datetime.fromtimestamp(stamp)
        target = today.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= today:
            target = target + timedelta(days=1)
        return target.timestamp()
    return stamp + 3600


def add(
    store: Any,
    name: str,
    when: str,
    kind: str,
    payload: Any,
    enabled: bool = True,
) -> Dict[str, Any]:
    """Set up a recurring task, or change the one with this name."""
    if kind not in KINDS:
        raise ValueError(f"a task is one of: {', '.join(KINDS)}")
    if kind == "ask" and not str(payload or "").strip():
        raise ValueError("an `ask` task needs a question")
    if kind == "tool" and not isinstance(payload, dict):
        raise ValueError('a `tool` task needs {"tool": "...", "args": {...}}')

    parsed = parse_when(when)
    return store.put_task(
        name=name,
        kind=kind,
        payload=payload,
        every_seconds=parsed["everySeconds"],
        daily_at=parsed["dailyAt"],
        enabled=enabled,
        next_run=next_run_at(parsed["everySeconds"], parsed["dailyAt"]),
    )


def describe(task: Dict[str, Any]) -> Dict[str, Any]:
    """A task in the shape a page or a person can read."""
    described = dict(task)
    described["schedule"] = (
        describe_seconds(int(task["every_seconds"]))
        if task.get("every_seconds")
        else f"every day at {task.get('daily_at')}"
    )
    described["dueInSeconds"] = (
        max(0, int((task.get("next_run") or 0) - time.time())) if task.get("next_run") else None
    )
    return described


def run_task(store: Any, task: Dict[str, Any], ctx: Any) -> Dict[str, Any]:
    """
    Run one due task and write down what happened.

    Always returns; a task that fails is recorded as failed and rescheduled,
    because a scheduler that stops on the first error is a scheduler nobody can
    trust with anything worth doing.
    """
    from . import agent, tools as tool_module

    started = time.time()
    ok = False
    error: Optional[str] = None
    summary = ""
    try:
        if task["kind"] == "ask":
            answer = agent.ask(str(task["payload"]), ctx)
            ok = bool(answer.get("ok"))
            summary = str(answer.get("answer") or "")[:1000]
            if not ok:
                error = "; ".join(answer.get("errors") or []) or "no answer"
        else:
            payload = task["payload"] or {}
            name = str(payload.get("tool") or "")
            result = tool_module.registry.run_tool(name, payload.get("args") or {}, ctx)
            ok = bool(result.get("ok"))
            summary = (str(result.get("stdout") or "") or str(result.get("answer") or ""))[:1000]
            if not ok:
                error = str(result.get("error") or "the tool refused")
    except Exception as failure:  # noqa: BLE001 - a broken task is data, not a crash
        error = f"{type(failure).__name__}: {failure}"

    following = next_run_at(task.get("every_seconds"), task.get("daily_at"))
    store.mark_task_run(task["id"], ok, following, error=error, result=summary)
    store.event(
        "info" if ok else "warn",
        "task",
        f"{task['name']} {'finished' if ok else 'failed'}",
        {"ms": int((time.time() - started) * 1000), "error": error, "result": summary[:300]},
    )
    return {
        "ok": ok,
        "task": task["name"],
        "ms": int((time.time() - started) * 1000),
        "error": error,
        "result": summary,
        "nextRun": following,
    }


def run_due(store: Any, ctx: Any, limit: int = 3) -> List[Dict[str, Any]]:
    """
    Run whatever is due, up to a limit.

    The limit matters on a machine coming back after a long sleep: better to do a
    few things and stay responsive than to grind through everything at once.
    """
    results: List[Dict[str, Any]] = []
    for task in store.due_tasks()[:limit]:
        results.append(run_task(store, task, ctx))
    return results


class Runner:
    """
    The clock, as a daemon thread.

    Started by `serve`. It does nothing but tick, ask what is due, and sleep —
    which is what makes "continues to function on its own" true rather than
    aspirational. Stop the brain and the clock stops with it, which is the
    honest behaviour for something that has no business running behind your back.
    """

    def __init__(
        self,
        store: Any,
        ctx: Any,
        tick: int = TICK_SECONDS,
        max_per_tick: int = 3,
    ) -> None:
        self.store = store
        self.ctx = ctx
        self.tick = max(5, int(tick))
        self.max_per_tick = max(1, int(max_per_tick))
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.last_tick: Optional[float] = None
        self.runs = 0

    def tick_once(self) -> List[Dict[str, Any]]:
        """One pass: run what is due. Called directly by tests and by the loop."""
        self.last_tick = time.time()
        results = run_due(self.store, self.ctx, limit=self.max_per_tick)
        self.runs += len(results)
        return results

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick_once()
            except Exception as failure:  # noqa: BLE001 - the clock must not die
                config.log("error", f"scheduler tick failed: {failure!r}")
            self._stop.wait(self.tick)

    def start(self) -> "Runner":
        if self._thread and self._thread.is_alive():
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="brain-scheduler", daemon=True)
        self._thread.start()
        config.log("info", f"scheduler running every {self.tick}s")
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def status(self) -> Dict[str, Any]:
        tasks = self.store.tasks()
        return {
            "running": self.running,
            "tickSeconds": self.tick,
            "maxPerTick": self.max_per_tick,
            "lastTick": self.last_tick,
            "runsSinceStart": self.runs,
            "tasks": len(tasks),
            "enabled": sum(1 for task in tasks if task["enabled"]),
            "next": next(
                (describe(task)["next_run"] for task in tasks if task["enabled"] and task["next_run"]),
                None,
            ),
        }
