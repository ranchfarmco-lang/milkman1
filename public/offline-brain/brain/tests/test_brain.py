"""
Tests for the local brain, using nothing but the standard library.

`python3 -m unittest discover -s brain/tests` from the package, or
`python3 brain/tests/test_brain.py` on its own. No pytest, no fixtures to
install, no network: a test suite that needs a dependency is a test suite that
stops being run.

What is covered is the part that has to be true on any machine: the store keeps
what it is told and finds it again, the guard refuses commands that destroy data,
a tool the brain wrote loads and runs, the hierarchy stops at the first tier that
answers, the agent answers with no model at all, and the HTTP API refuses a
request with no token and serves one with it.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src import (  # noqa: E402  - after the path is set up
    agent,
    config,
    connectors,
    info,
    scheduler,
    server as server_module,
    store as store_module,
    tools,
    updater,
)


class TempBrain(unittest.TestCase):
    """
    A brain with its own directories.

    Every test gets a fresh data dir and workspace, so one test cannot leave a
    tool file or a memory behind for the next one — and nothing touches the real
    one a person is running.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="brain-test-")
        holder = Path(self._tmp.name)
        self._saved = {
            "BRAIN_HOME": os.environ.get("BRAIN_HOME"),
            "BRAIN_WORKSPACE": os.environ.get("BRAIN_WORKSPACE"),
            # Keep the probes off the network: tests must pass on a machine in a
            # Faraday cage, and must not make requests nobody asked for.
            "BRAIN_NET_PROBE": os.environ.get("BRAIN_NET_PROBE"),
        }
        os.environ["BRAIN_HOME"] = str(holder / "data")
        os.environ["BRAIN_WORKSPACE"] = str(holder / "workspace")
        os.environ["BRAIN_NET_PROBE"] = "127.0.0.1:9"
        config.ensure_dirs()
        self.store = store_module.Store()
        self.settings = dict(config.DEFAULT_CONFIG)
        self.ctx = tools.ToolContext(self.store, self.settings)

    def tearDown(self) -> None:
        self.store.close()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmp.cleanup()


class TestStore(TempBrain):
    def test_remembering_and_finding(self) -> None:
        self.store.remember("the greenhouse timer is on circuit four", tags=["house"])
        self.store.remember("the well pump needs priming after a power cut")
        found = self.store.search_memory("greenhouse timer")
        self.assertTrue(found, "a memory that was just written should be findable")
        self.assertIn("greenhouse", found[0]["text"])
        self.assertIn("house", found[0]["tags"])
        self.assertEqual(self.store.count_memory(), 2)

    def test_forgetting(self) -> None:
        memory_id = self.store.remember("temporary")
        self.assertTrue(self.store.forget(memory_id))
        self.assertFalse(self.store.forget(memory_id))
        self.assertEqual(self.store.search_memory("temporary"), [])

    def test_events_and_snapshots(self) -> None:
        self.store.event("info", "test", "something happened", {"n": 1})
        self.store.save_snapshot({"cores": 4})
        self.store.save_snapshot({"cores": 8})
        self.assertEqual(self.store.recent_events(limit=1)[0]["text"], "something happened")
        self.assertEqual(self.store.latest_snapshot()["data"]["cores"], 8)

    def test_credentials_never_come_back_in_a_listing(self) -> None:
        self.store.put_credential("brave:BRAVE_API_KEY", "secret-value")
        listing = json.dumps(self.store.credential_names())
        self.assertIn("brave:BRAVE_API_KEY", listing)
        self.assertNotIn("secret-value", listing)
        self.assertEqual(self.store.get_credential("brave:BRAVE_API_KEY"), "secret-value")

    def test_tool_runs_are_summarised(self) -> None:
        self.store.record_tool_run("fs.read", {"path": "a"}, True, 5)
        self.store.record_tool_run("fs.read", {"path": "b"}, False, 15, "missing")
        stats = {row["tool"]: row for row in self.store.tool_stats()}
        self.assertEqual(stats["fs.read"]["calls"], 2)
        self.assertEqual(stats["fs.read"]["failures"], 1)


class TestGuardrails(TempBrain):
    def test_destructive_commands_are_refused(self) -> None:
        for command in ("rm -rf /", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda"):
            result = tools.run_command(command)
            self.assertFalse(result["ok"], command)
            self.assertTrue(result.get("blocked"), command)

    def test_a_normal_command_runs(self) -> None:
        result = tools.run_command("echo brain-ok", cwd=config.workspace_dir())
        self.assertTrue(result["ok"])
        self.assertIn("brain-ok", result["stdout"])
        self.assertEqual(result["exitCode"], 0)

    def test_a_failing_command_reports_its_code(self) -> None:
        result = tools.run_command("exit 3", cwd=config.workspace_dir())
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitCode"], 3)

    def test_paths_outside_the_workspace_are_refused(self) -> None:
        with self.assertRaises(tools.ToolError):
            self.ctx.resolve("/etc/passwd")
        # ...unless the caller asks for it deliberately.
        self.assertTrue(self.ctx.resolve("/etc", outside=True).exists())


class TestTools(TempBrain):
    def test_writing_and_reading_a_file(self) -> None:
        written = tools.registry.run_tool(
            "fs.write", {"path": "notes/today.md", "text": "hello"}, self.ctx
        )
        self.assertTrue(written["ok"], written)
        read = tools.registry.run_tool("fs.read", {"path": "notes/today.md"}, self.ctx)
        self.assertEqual(read["text"], "hello")

    def test_searching_the_workspace(self) -> None:
        tools.registry.run_tool(
            "fs.write", {"path": "code/main.py", "text": "print('needle here')"}, self.ctx
        )
        found = tools.registry.run_tool("fs.search", {"query": "needle"}, self.ctx)
        self.assertTrue(found["ok"])
        self.assertEqual(len(found["hits"]), 1)
        self.assertIn("main.py", found["hits"][0]["path"])

    def test_running_a_snippet(self) -> None:
        result = tools.registry.run_tool(
            "code.run", {"code": "print(6 * 7)", "language": "python"}, self.ctx
        )
        self.assertTrue(result["ok"], result)
        self.assertIn("42", result["stdout"])
        self.assertEqual(result["interpreter"], "python3")

    def test_the_brain_can_write_its_own_tool(self) -> None:
        """
        The loop that matters most: it needs something, it writes a tool, and the
        tool is there on the next call — because the file is the tool.
        """
        made = tools.registry.run_tool(
            "tools.new",
            {
                "name": "word_count",
                "summary": "count the words in a file in the workspace",
                "args": "path:the file to count",
                "body": (
                    "def run(ctx, path, **args):\n"
                    "    target = ctx.resolve(path)\n"
                    "    words = target.read_text(encoding='utf-8').split()\n"
                    "    return {'ok': True, 'words': len(words)}\n"
                ),
            },
            self.ctx,
        )
        self.assertTrue(made["ok"], made)
        self.assertTrue(made["registered"], made)
        self.assertTrue(made["path"].startswith(str(config.tools_dir())))

        tools.registry.run_tool("fs.write", {"path": "poem.txt", "text": "one two three"}, self.ctx)
        counted = tools.registry.run_tool("word_count", {"path": "poem.txt"}, self.ctx)
        self.assertTrue(counted["ok"], counted)
        self.assertEqual(counted["words"], 3)

        # And it survives a reload, because it is a file rather than memory.
        reloaded = tools.registry.load_external()
        self.assertIn("word_count", reloaded["loaded"])
        self.assertEqual(reloaded["broken"], {})

    def test_a_broken_tool_is_reported_not_thrown(self) -> None:
        (config.tools_dir() / "typo.py").write_text(
            "TOOL = {'name': 'typo'}\nthis is not python\n", encoding="utf-8"
        )
        loaded = tools.registry.load_external()
        self.assertIn("typo", loaded["broken"])
        # The registry still works, and the broken tool is visible in a listing.
        names = [entry["name"] for entry in tools.registry.describe_all(self.store)]
        self.assertIn("typo", names)

    def test_an_unknown_tool_lists_what_exists(self) -> None:
        result = tools.registry.run_tool("nope.nope", {}, self.ctx)
        self.assertFalse(result["ok"])
        self.assertIn("fs.read", result["available"])


class TestCapabilities(TempBrain):
    def test_the_map_describes_this_machine(self) -> None:
        from src import capabilities

        built = capabilities.build(self.store, force=True)
        self.assertGreaterEqual(built["cpu"]["cores"], 1)
        self.assertIn("python", built["host"])
        self.assertIn("totalGb", built["memory"])
        self.assertIn("workspace", built["disk"])
        self.assertIsInstance(built["tools"], dict)
        # Cached, so the second call costs nothing and reports the same thing.
        self.assertEqual(capabilities.build(self.store)["at"], built["at"])

    def test_diff_reports_what_changed(self) -> None:
        from src import capabilities

        before = {"tools": ["rg"], "languages": [], "models": [], "online": False}
        after = {"tools": [], "languages": [], "models": ["ollama:qwen3"], "online": True}
        lines = capabilities.diff(before, after)
        self.assertTrue(any("disappeared: rg" in line for line in lines))
        self.assertTrue(any("network came back" in line for line in lines))


class TestInformationHierarchy(TempBrain):
    def test_local_memory_answers_before_anything_remote(self) -> None:
        self.store.remember("the water filter is under the sink")
        result = info.lookup("where is the water filter", self.ctx)
        self.assertTrue(result["ok"])
        self.assertEqual(result["tier"], "memory")
        self.assertEqual(result["tried"][0]["tier"], "memory")

    def test_workspace_answers_when_memory_does_not(self) -> None:
        (config.workspace_dir() / "inventory.txt").write_text(
            "spare hydraulic hose: in the barn, shelf three", encoding="utf-8"
        )
        result = info.lookup("hydraulic hose", self.ctx)
        self.assertTrue(result["ok"])
        self.assertEqual(result["tier"], "workspace")

    def test_offline_says_so_instead_of_reaching_out(self) -> None:
        result = info.lookup("a question nothing local can answer", self.ctx, offline=True)
        self.assertFalse(result["ok"])
        tiers = {entry["tier"]: entry for entry in result["tried"]}
        self.assertEqual(tiers["public"].get("skipped"), "offline")

    def test_the_cache_is_a_source(self) -> None:
        info.cache_put("https://example.invalid/page", {"title": "Example", "text": "cached body"})
        fetched = info.fetch("https://example.invalid/page", offline=True)
        self.assertTrue(fetched["ok"])
        self.assertEqual(fetched["tier"], "cache")
        self.assertEqual(fetched["text"], "cached body")
        self.assertIn("Example", [entry["title"] for entry in info.cache_entries()])


class TestConnectors(TempBrain):
    def test_local_and_free_options_come_first(self) -> None:
        entries = connectors.for_capability(self.ctx, "web_search")
        tiers = [entry["tier"] for entry in entries]
        self.assertEqual(tiers, sorted(tiers, key=lambda tier: {"local": 0, "free": 1, "key": 2}[tier]))

    def test_a_key_connector_is_not_ready_until_it_has_a_key(self) -> None:
        listed = {entry["id"]: entry for entry in connectors.describe(self.store)}
        self.assertFalse(listed["brave"]["ready"])
        connectors.put_credential(self.store, "brave", "BRAVE_API_KEY", "abc123")
        listed = {entry["id"]: entry for entry in connectors.describe(self.store)}
        self.assertTrue(listed["brave"]["credential"]["present"])
        self.assertTrue(listed["brave"]["ready"])

    def test_the_environment_is_preferred_over_the_store(self) -> None:
        self.store.put_credential("brave:BRAVE_API_KEY", "stored")
        os.environ["BRAVE_API_KEY"] = "from-env"
        try:
            self.assertEqual(connectors.credential_value(self.store, "brave", "BRAVE_API_KEY"), "from-env")
        finally:
            os.environ.pop("BRAVE_API_KEY", None)

    def test_resolving_a_capability_with_nothing_ready_explains_itself(self) -> None:
        # Both mail connectors out of the box need something: SMTP needs a host
        # and a password, Resend needs a key. So it says exactly that.
        result = connectors.resolve(self.store, "email")
        self.assertFalse(result["ok"])
        self.assertEqual({option["id"] for option in result["options"]}, {"smtp", "resend"})
        self.assertTrue(result["next"], "it should name what each option is missing")

        # Giving SMTP its settings is enough for it to be chosen.
        connectors.put_credential(self.store, "smtp", "SMTP_HOST", "127.0.0.1")
        chosen = connectors.resolve(self.store, "email")
        self.assertTrue(chosen["ok"])
        self.assertEqual(chosen["connector"]["id"], "smtp")


class TestAgentWithoutAModel(TempBrain):
    def test_it_answers_using_tools_when_no_model_is_running(self) -> None:
        result = agent.ask("what can you do", self.ctx)
        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "tools-only")
        self.assertTrue(result["steps"], "the tool-only planner should have called something")
        self.assertEqual(result["steps"][0]["tool"], "caps.get")
        self.assertTrue(result["answer"])

    def test_it_remembers_what_it_is_told(self) -> None:
        agent.ask("remember the spare key is in the blue tin", self.ctx)
        found = self.store.search_memory("spare key")
        self.assertTrue(found)

    def test_it_verifies_a_write(self) -> None:
        result = agent.ask("read notes.txt", self.ctx)
        # The file does not exist yet, so the step fails — and the failure is
        # reported as a step rather than raised as an exception.
        self.assertTrue(result["ok"])
        self.assertTrue(all(step["tool"] != "fs.read" or not step["ok"] for step in result["steps"]))

        tools.registry.run_tool("fs.write", {"path": "notes.txt", "text": "line one"}, self.ctx)
        again = agent.ask("read notes.txt", self.ctx)
        read_step = next(step for step in again["steps"] if step["tool"] == "fs.read")
        self.assertTrue(read_step["ok"])
        self.assertIn("line one", read_step["result"]["text"])

    def test_it_says_which_tier_answered(self) -> None:
        result = agent.ask("where is the tractor key", self.ctx)
        lookup = next((step for step in result["steps"] if step["tool"] == "info.lookup"), None)
        self.assertIsNotNone(lookup, "an unknown question should reach the hierarchy")
        self.assertIn("tier", lookup["result"])


class TestRepairs(TempBrain):
    def test_doctor_reports_and_repairs_are_runnable(self) -> None:
        from src import diagnostics

        report = diagnostics.report(self.ctx)
        self.assertIn("findings", report)
        self.assertIn("caps.refresh", report["repairs"])

        refreshed = diagnostics.repair(self.store, "caps.refresh", self.ctx)
        self.assertTrue(refreshed["ok"], refreshed)
        self.assertIn("cores", refreshed)

        missing = diagnostics.repair(self.store, "not.a.repair", self.ctx)
        self.assertFalse(missing["ok"])
        self.assertIn("available", missing)

    def test_a_failing_tool_shows_up_as_a_finding(self) -> None:
        from src import diagnostics

        for _ in range(4):
            self.store.record_tool_run("shell.run", {"command": "false"}, False, 3, "exit 1")
        report = diagnostics.report(self.ctx)
        self.assertTrue(any("shell.run" in item["id"] for item in report["findings"]))


class TestScheduler(TempBrain):
    """The clock: what a schedule means, and what happens when it comes due."""

    def test_a_schedule_is_understood_in_plain_words(self) -> None:
        self.assertEqual(scheduler.parse_when("every 15 minutes")["everySeconds"], 900)
        self.assertEqual(scheduler.parse_when("15m")["everySeconds"], 900)
        self.assertEqual(scheduler.parse_when("hourly")["everySeconds"], 3600)
        self.assertEqual(scheduler.parse_when("2h")["everySeconds"], 7200)
        daily = scheduler.parse_when("daily at 07:30")
        self.assertIsNone(daily["everySeconds"])
        self.assertEqual(daily["dailyAt"], "07:30")

    def test_a_twelve_hour_clock_is_read_as_a_person_means_it(self) -> None:
        self.assertEqual(scheduler.parse_when("daily at 7pm")["dailyAt"], "19:00")
        self.assertEqual(scheduler.parse_when("daily at 12am")["dailyAt"], "00:00")
        self.assertEqual(scheduler.parse_when("daily at 12pm")["dailyAt"], "12:00")

    def test_a_nonsense_schedule_is_refused_rather_than_guessed(self) -> None:
        for bad in ("", "whenever", "every 5 seconds", "daily at 25:00"):
            with self.assertRaises(ValueError):
                scheduler.parse_when(bad)

    def test_the_next_run_is_counted_from_now_not_from_the_missed_time(self) -> None:
        # A machine that was switched off for a week must not wake up owing a week
        # of work, so the appointment is made from the current moment.
        start = 1_700_000_000.0
        self.assertEqual(scheduler.next_run_at(900, None, now=start), start + 900)

    def test_a_daily_task_lands_on_todays_clock_or_tomorrows(self) -> None:
        # 2023-11-14 22:13:20 UTC: 07:30 has already passed, so it is tomorrow's.
        stamp = 1_700_000_000.0
        upcoming = scheduler.next_run_at(None, "07:30", now=stamp)
        self.assertGreater(upcoming, stamp)
        self.assertLess(upcoming - stamp, 24 * 3600)
        landed = datetime.fromtimestamp(upcoming)
        self.assertEqual((landed.hour, landed.minute), (7, 30))

    def test_a_task_is_saved_and_read_back(self) -> None:
        task = scheduler.add(self.store, "nightly", "daily at 03:30", "ask", "run the tests")
        self.assertEqual(task["kind"], "ask")
        self.assertEqual(task["payload"], "run the tests")
        self.assertTrue(task["enabled"])
        self.assertIn("03:30", scheduler.describe(task)["schedule"])
        self.assertEqual([one["name"] for one in self.store.tasks()], ["nightly"])

    def test_asking_for_the_same_name_twice_adjusts_it(self) -> None:
        scheduler.add(self.store, "sweep", "hourly", "ask", "anything")
        scheduler.add(self.store, "sweep", "every 30 minutes", "ask", "something else")
        self.assertEqual(len(self.store.tasks()), 1)
        self.assertEqual(self.store.tasks()[0]["payload"], "something else")

    def test_a_tool_task_must_say_which_tool(self) -> None:
        with self.assertRaises(ValueError):
            scheduler.add(self.store, "bad", "hourly", "tool", "fs.read")
        with self.assertRaises(ValueError):
            scheduler.add(self.store, "bad", "hourly", "nonsense", "x")

    def test_running_a_due_tool_task_records_what_happened(self) -> None:
        self.store.put_task(
            name="writes",
            kind="tool",
            payload={"tool": "fs.write", "args": {"path": "notes/clock.txt", "text": "tick"}},
            every_seconds=3600,
            next_run=0,  # overdue the moment it is made
        )
        due = self.store.due_tasks()
        self.assertEqual(len(due), 1)
        result = scheduler.run_task(self.store, due[0], self.ctx)
        self.assertTrue(result["ok"], result)
        self.assertEqual((config.workspace_dir() / "notes" / "clock.txt").read_text(), "tick")
        after = self.store.find_task("writes")
        self.assertEqual(after["runs"], 1)
        self.assertTrue(after["lastOk"])
        self.assertGreater(after["next_run"], time.time())  # pushed forward, not left due

    def test_a_task_that_fails_is_recorded_and_rescheduled(self) -> None:
        self.store.put_task(
            name="broken",
            kind="tool",
            payload={"tool": "fs.read", "args": {"path": "definitely/not/here.txt"}},
            every_seconds=3600,
            next_run=0,
        )
        result = scheduler.run_task(self.store, self.store.due_tasks()[0], self.ctx)
        self.assertFalse(result["ok"])
        after = self.store.find_task("broken")
        self.assertFalse(after["lastOk"])
        self.assertGreater(after["next_run"], time.time())
        self.assertEqual(after["runs"], 1)

    def test_pausing_resuming_and_removing(self) -> None:
        scheduler.add(self.store, "quiet", "hourly", "ask", "is anyone there")
        self.assertTrue(self.store.set_task_enabled("quiet", False))
        self.assertEqual(self.store.due_tasks(now=time.time() + 10**6), [])
        self.assertTrue(self.store.set_task_enabled("quiet", True, next_run=0))
        self.assertEqual(len(self.store.due_tasks()), 1)
        self.assertTrue(self.store.remove_task("quiet"))
        self.assertFalse(self.store.remove_task("quiet"))
        self.assertEqual(self.store.tasks(), [])

    def test_one_tick_runs_only_what_is_due_and_only_up_to_the_limit(self) -> None:
        for index in range(3):
            self.store.put_task(
                name=f"job-{index}",
                kind="ask",
                payload="what can you do",
                every_seconds=3600,
                next_run=0,
            )
        runner = scheduler.Runner(self.store, self.ctx, tick=5, max_per_tick=2)
        first = runner.tick_once()
        self.assertEqual(len(first), 2)  # the limit holds when everything is late
        self.assertEqual(runner.runs, 2)
        self.assertIsNotNone(runner.last_tick)
        self.assertEqual(len(runner.tick_once()), 1)  # the rest wait for the next tick
        self.assertFalse(runner.running)  # ticking alone starts no thread

    def test_the_clock_is_a_thread_that_can_be_stopped(self) -> None:
        runner = scheduler.Runner(self.store, self.ctx, tick=5)
        runner.start()
        try:
            self.assertTrue(runner.running)
            self.assertTrue(runner.status()["running"])
            self.assertEqual(runner.status()["maxPerTick"], 3)
        finally:
            runner.stop()
        self.assertFalse(runner.running)


class TestUpdater(TempBrain):
    """The package manager, and the report that says what could be local."""

    def test_the_package_finds_its_own_installers(self) -> None:
        found = updater.installers()
        names = {entry["name"] for entry in found}
        self.assertIn("GET-EVERYTHING.sh", names)
        self.assertIn("install-runtimes.sh", names)
        # Every entry says what it is for, so a plan can be read, not deduced.
        self.assertTrue(all(entry["purpose"] for entry in found))

    def test_running_something_outside_the_package_is_refused(self) -> None:
        result = updater.run_installer(self.store, self.ctx, "../../etc/passwd")
        self.assertFalse(result["ok"])
        self.assertIn("no such installer", result["error"])

    def test_a_check_reads_this_machine_without_contacting_anything(self) -> None:
        report = updater.check(self.store, self.ctx)
        self.assertTrue(report["ok"])
        self.assertEqual(report["version"], config.VERSION)
        self.assertIn("python", report["inventory"])
        self.assertIn("independence", report)
        self.assertIn("installers", report)

    def test_a_version_that_moved_overnight_is_reported(self) -> None:
        before = {"tools": {"rg": "13.0.0"}, "languages": {}, "models": []}
        after = {
            "tools": {"rg": "14.1.0", "jq": "1.7"},
            "languages": {},
            "models": ["ollama:qwen"],
        }
        changes = updater.diff_inventory(before, after)
        self.assertTrue(any("rg" in line and "updated" in line for line in changes))
        self.assertTrue(any("jq" in line and "added" in line for line in changes))
        self.assertTrue(any("model now served" in line for line in changes))

    def test_the_independence_report_names_the_local_replacement(self) -> None:
        report = updater.independence_report(self.store)
        self.assertIn("capabilities", report)
        self.assertIsInstance(report["summary"], str)
        for capability in ("web_search", "llm"):
            entry = next(
                (one for one in report["capabilities"] if one["capability"] == capability), None
            )
            if entry is not None:
                self.assertTrue(entry["use"])  # a replacement, not a shrug
                self.assertTrue(entry["how"])  # and how to get it

    def test_the_two_short_notes_read_as_sentences(self) -> None:
        self.assertTrue(updater.status_line(self.store))
        self.assertIn("brain/", updater.brain_version_note())


class TestHttpApi(TempBrain):
    """A real server on a real port, because that is how the hub will call it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="brain-api-")
        holder = Path(cls._tmp.name)
        cls._env = {key: os.environ.get(key) for key in ("BRAIN_HOME", "BRAIN_WORKSPACE", "BRAIN_NET_PROBE")}
        os.environ["BRAIN_HOME"] = str(holder / "data")
        os.environ["BRAIN_WORKSPACE"] = str(holder / "workspace")
        os.environ["BRAIN_NET_PROBE"] = "127.0.0.1:9"
        config.ensure_dirs()
        cls.store = store_module.Store()
        settings = dict(config.DEFAULT_CONFIG)
        settings["port"] = 0  # let the operating system choose
        cls.server = server_module.serve(cls.store, settings)
        cls.port = cls.server.server_address[1]
        cls.token = cls.server.brain.token  # type: ignore[attr-defined]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.store.close()
        for key, value in cls._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls._tmp.cleanup()

    def call(self, path: str, method: str = "GET", body=None, token="auto"):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        chosen = self.token if token == "auto" else token
        if chosen:
            request.add_header("X-Brain-Token", chosen)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode())

    def test_health_needs_no_token(self) -> None:
        status, payload = self.call("/api/v1/health", token=None)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["protocol"], config.PROTOCOL)
        self.assertTrue(payload["authRequired"])

    def test_everything_else_needs_the_token(self) -> None:
        status, payload = self.call("/api/v1/memory", token=None)
        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])
        self.assertIn("token", payload["hint"])

        status, payload = self.call("/api/v1/memory", token="wrong-token")
        self.assertEqual(status, 401)

    def test_the_protocol_lists_its_endpoints(self) -> None:
        status, payload = self.call("/api/v1/protocol", token=None)
        self.assertEqual(status, 200)
        paths = {entry["path"] for entry in payload["endpoints"]}
        self.assertIn("/api/v1/ask", paths)
        self.assertIn("/api/v1/memory", paths)

    def test_pairing_confirms_a_token(self) -> None:
        status, payload = self.call("/api/v1/pair")
        self.assertEqual(status, 200)
        self.assertTrue(payload["paired"])

    def test_memory_round_trip_over_http(self) -> None:
        status, payload = self.call("/api/v1/memory", "POST", {"text": "the api remembers this"})
        self.assertEqual(status, 200)
        memory_id = payload["id"]
        status, payload = self.call("/api/v1/memory?q=api%20remembers")
        self.assertGreaterEqual(payload["count"], 1)
        status, payload = self.call(f"/api/v1/memory/{memory_id}", "DELETE")
        self.assertTrue(payload["ok"])

    def test_a_tool_runs_over_http(self) -> None:
        status, payload = self.call(
            "/api/v1/tools/run", "POST", {"tool": "fs.write", "args": {"path": "http.txt", "text": "ok"}}
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"], payload)
        status, payload = self.call("/api/v1/tools")
        self.assertTrue(any(entry["name"] == "fs.write" for entry in payload["tools"]))

    def test_asking_over_http_returns_the_steps(self) -> None:
        status, payload = self.call("/api/v1/ask", "POST", {"question": "what can you do"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["steps"])
        self.assertIn("answer", payload)

    def test_a_bad_body_is_a_400_not_a_crash(self) -> None:
        status, payload = self.call("/api/v1/tools/run", "POST", {"args": {}})
        self.assertEqual(status, 400)
        self.assertIn("tool name", payload["error"])

    def test_the_health_check_survives_being_polled(self) -> None:
        for _ in range(3):
            status, _payload = self.call("/api/v1/health", token=None)
            self.assertEqual(status, 200)

    def test_a_schedule_can_be_made_and_seen_over_http(self) -> None:
        status, payload = self.call(
            "/api/v1/tasks",
            "POST",
            {"name": "hourly-check", "when": "hourly", "kind": "ask", "payload": "what can you do"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["task"]["name"], "hourly-check")

        status, listing = self.call("/api/v1/tasks")
        self.assertEqual(status, 200)
        self.assertTrue(listing["runner"]["running"])  # the clock runs while serving
        self.assertTrue(any(entry["name"] == "hourly-check" for entry in listing["tasks"]))

        status, done = self.call("/api/v1/tasks/hourly-check/run", "POST", {})
        self.assertEqual(status, 200)
        self.assertIn("nextRun", done)

        status, paused = self.call("/api/v1/tasks/hourly-check", "POST", {"enabled": False})
        self.assertEqual(status, 200)
        self.assertFalse(paused["task"]["enabled"])

        status, removed = self.call("/api/v1/tasks/hourly-check", "DELETE")
        self.assertEqual(status, 200)
        self.assertEqual(removed["removed"], "hourly-check")

        status, _missing = self.call("/api/v1/tasks/never-existed", "DELETE")
        self.assertEqual(status, 404)

    def test_a_nonsense_schedule_over_http_is_a_400(self) -> None:
        status, payload = self.call(
            "/api/v1/tasks",
            "POST",
            {"name": "bad", "when": "whenever", "kind": "ask", "payload": "hi"},
        )
        self.assertEqual(status, 400)
        self.assertIn("whenever", payload["error"])

    def test_the_update_report_is_reachable_over_http(self) -> None:
        status, payload = self.call("/api/v1/updates")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertIn("installers", payload)
        self.assertIn("independence", payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
