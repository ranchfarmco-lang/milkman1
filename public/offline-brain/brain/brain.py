#!/usr/bin/env python3
"""
The local brain, from a terminal.

Run this on the machine that is going to hold the system. One command starts the
whole thing:

    python3 brain.py serve

and then the hub's Local Brain page, or `curl`, pairs with it. Everything else
here is the same brain reached without starting a server: ask it something, see
what it can do, check its own health, read and write its memory, look at the
connectors and the keys, or rotate the token.

Requires nothing but Python 3.9 and its standard library. There is no virtual
environment to make, nothing to install, and no account to create — which is the
point, because this is the piece that has to keep working when everything else
is unavailable.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src import (  # noqa: E402  - after sys.path, deliberately
    agent,
    capabilities,
    config,
    connectors,
    diagnostics,
    info,
    providers,
    scheduler,
    server as server_module,
    store as store_module,
    tools,
    updater,
)


def open_context(args: argparse.Namespace) -> tuple:
    """A store and a tool context, wired the way every command needs them."""
    settings = config.load_config()
    if getattr(args, "host", None):
        settings["host"] = args.host
    if getattr(args, "port", None) is not None:
        settings["port"] = args.port
    if getattr(args, "open", False):
        settings["auth"] = "open"
    database = store_module.Store()
    tools.registry.load_external()
    return database, settings, tools.ToolContext(database, settings)


def emit(args: argparse.Namespace, payload, human: str = "") -> None:
    """JSON when asked for it, a readable summary otherwise."""
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, default=str))
    elif human:
        print(human)
    else:
        print(json.dumps(payload, indent=2, default=str))


# ------------------------------------------------------------------- commands


def cmd_serve(args: argparse.Namespace) -> int:
    database, settings, _ = open_context(args)
    if args.no_schedule:
        settings["scheduler"] = False
    server = server_module.serve(database, settings)
    print(server_module.banner(server, settings), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping.", file=sys.stderr)
    finally:
        server.shutdown()
        # The clock is a daemon thread; take it down with the server rather than
        # letting it fire one more task on the way out.
        server.brain.stop()  # type: ignore[attr-defined]
        server.server_close()
        database.close()
    return 0


def cmd_pair(args: argparse.Namespace) -> int:
    token = config.ensure_token()
    settings = config.load_config()
    payload = {
        "ok": True,
        "address": f"http://{settings.get('host')}:{settings.get('port')}",
        "token": token,
        "workspace": str(config.workspace_dir()),
        "dataDir": str(config.data_dir()),
    }
    emit(
        args,
        payload,
        f"address  {payload['address']}\ntoken    {token}\n"
        "Type both into the hub's Local Brain page once.",
    )
    return 0


def cmd_token(args: argparse.Namespace) -> int:
    token = config.rotate_token()
    emit(args, {"ok": True, "token": token},
         f"new token  {token}\nEvery paired page has to be paired again.")
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    database, settings, ctx = open_context(args)
    result = agent.ask(args.question, ctx, max_steps=args.steps)
    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(result["answer"])
        print()
        print(f"mode        {result['mode']}" + (" (offline)" if result.get("offline") else ""))
        if result.get("model"):
            print(f"model       {result['providerLabel']} · {result['model']}")
        if result.get("steps"):
            print("steps")
            for step in result["steps"]:
                mark = "ok " if step["ok"] else "err"
                print(f"  {mark} {step['tool']}  {json.dumps(step['args'], default=str)[:120]}")
        if result.get("modelHint"):
            print(f"hint        {result['modelHint']}")
    database.close()
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    database, settings, ctx = open_context(args)
    emit(args, agent.plan(args.question, ctx))
    database.close()
    return 0


def cmd_caps(args: argparse.Namespace) -> int:
    database, settings, ctx = open_context(args)
    built = capabilities.build(database, force=args.fresh)
    database.close()
    if args.json:
        print(json.dumps(built, indent=2, default=str))
        return 0
    host = built["host"]
    cpu = built["cpu"]
    print(f"{host['distro']} · kernel {host['kernel']} · python {host['python']}")
    print(f"cpu      {cpu['cores']} cores · {cpu['model'][:60]} · {' '.join(cpu.get('features') or [])}")
    print(f"memory   {built['memory']['totalGb']} GB ({built['memory']['availableMb'] // 1024} GB free)")
    for label, disk in built["disk"].items():
        print(f"disk {label:<4} {disk.get('freeGb')} GB free of {disk.get('totalGb')} GB")
    print(f"gpus     {', '.join(g['name'] for g in built['gpus']) or 'none detected'}")
    print(f"network  {'up' if built['network']['online'] else 'offline'}")
    print(f"tools    {len(built['tools'])}: {', '.join(sorted(built['tools']))}")
    print(f"langs    {', '.join(sorted(built['languages']))}")
    models = built["models"]
    if models:
        for entry in models:
            print(f"model    {entry['label']:<28} {len(entry['models'])} model(s)  {entry['base']}")
    else:
        print(f"models   none answering — {providers.start_hint()}")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    database, settings, ctx = open_context(args)
    report = diagnostics.report(ctx, deep=args.deep)
    database.close()
    if args.json:
        print(json.dumps(report, indent=2, default=str))
        return 0
    caps = report["capabilities"]
    print(f"brain {report['version']} · {caps['cores']} cores · {caps['memoryGb']} GB · "
          f"{'online' if caps['online'] else 'offline'} · {caps['diskFreeGb']} GB free")
    print(f"findings: {report['counts']['blocking']} blocking, "
          f"{report['counts']['degraded']} degraded, {report['counts']['note']} notes")
    for item in report["findings"]:
        print(f"\n[{item['level']}] {item['message']}")
        if item.get("detail"):
            print(f"    {item['detail']}")
        if item.get("repair"):
            print(f"    repair: brain.py repair {item['repair']}")
    if report["tools"]:
        print("\ntools needing attention")
        for row in report["tools"]:
            print(f"  {row['tool']}: {row['failures']}/{row['calls']} failed")
    print("\nrepairs available: " + ", ".join(report["repairs"]))
    return 0 if report["ok"] else 1


def cmd_repair(args: argparse.Namespace) -> int:
    database, settings, ctx = open_context(args)
    if args.list or not args.name:
        emit(args, {"ok": True, "repairs": sorted(diagnostics.REPAIRS)},
             "\n".join(sorted(diagnostics.REPAIRS)))
        database.close()
        return 0
    result = diagnostics.repair(database, args.name, ctx)
    emit(args, result, json.dumps(result, indent=2, default=str))
    database.close()
    return 0 if result.get("ok") else 1


def cmd_memory(args: argparse.Namespace) -> int:
    database, _, _ = open_context(args)
    if args.action == "add":
        memory_id = database.remember(
            args.text, tags=[t for t in (args.tags or "").split(",") if t.strip()],
            source="cli", pinned=args.pinned,
        )
        emit(args, {"ok": True, "id": memory_id}, f"remembered #{memory_id} ({database.count_memory()} total)")
    elif args.action == "search":
        hits = database.search_memory(args.text, limit=args.limit)
        if args.json:
            print(json.dumps({"ok": True, "hits": hits}, indent=2, default=str))
        else:
            for row in hits:
                tags = f"  [{row['tags']}]" if row.get("tags") else ""
                print(f"#{row['id']:<4} {row['text'][:110]}{tags}")
            print(f"{len(hits)} of {database.count_memory()}")
    elif args.action == "forget":
        removed = database.forget(int(args.text))
        emit(args, {"ok": removed, "id": int(args.text)}, "forgotten" if removed else "not found")
    else:
        rows = database.list_memory(limit=args.limit)
        if args.json:
            print(json.dumps({"ok": True, "memory": rows}, indent=2, default=str))
        else:
            for row in rows:
                tags = f"  [{row['tags']}]" if row.get("tags") else ""
                print(f"#{row['id']:<4} {row['text'][:110]}{tags}")
            print(f"{database.count_memory()} remembered")
    database.close()
    return 0


def cmd_tools(args: argparse.Namespace) -> int:
    database, settings, ctx = open_context(args)
    if args.action == "run":
        if not args.name:
            print("a tool name is required", file=sys.stderr)
            return 2
        payload = json.loads(args.args) if args.args else {}
        result = tools.registry.run_tool(args.name, payload, ctx)
        emit(args, result, json.dumps(result, indent=2, default=str))
        database.close()
        return 0 if result.get("ok") else 1
    described = tools.registry.describe_all(database)
    database.close()
    if args.json:
        print(json.dumps({"ok": True, "tools": described}, indent=2, default=str))
        return 0
    width = max(len(entry["name"]) for entry in described) if described else 10
    for entry in described:
        stats = entry.get("stats") or {}
        note = ""
        if entry.get("broken"):
            note = f"  BROKEN: {entry['broken']}"
        elif stats.get("calls"):
            note = f"  {stats['calls']} call(s), {stats.get('failures', 0)} failed, {stats.get('avg_ms', 0)}ms avg"
        origin = "" if entry.get("source") == "builtin" else "  (written here)"
        print(f"{entry['name']:<{width}}  {entry['summary'][:78]}{origin}{note}")
    return 0


def cmd_connectors(args: argparse.Namespace) -> int:
    database, settings, _ = open_context(args)
    if args.action == "enable" and args.name:
        connectors.set_enabled(database, args.name, True)
    elif args.action == "disable" and args.name:
        connectors.set_enabled(database, args.name, False)
    elif args.action == "set-key" and args.name and args.value:
        name, _, key = args.value.partition("=")
        if not key:
            print("use: connectors set-key <id> ENV_VAR_NAME=value", file=sys.stderr)
            database.close()
            return 2
        connectors.put_credential(database, args.name, name, key)
    elif args.action == "drop-key" and args.name and args.value:
        connectors.drop_credential(database, args.name, args.value)
    elif args.action == "check" and args.name:
        capability = args.value or "web_search"
        result = connectors.resolve(database, capability)
        emit(args, result, json.dumps(result, indent=2, default=str))
        database.close()
        return 0

    entries = connectors.describe(database)
    summary = connectors.summary(database)
    database.close()
    if args.json:
        print(json.dumps({"ok": True, "connectors": entries, "summary": summary},
                         indent=2, default=str))
        return 0
    for entry in entries:
        state = "ready" if entry["ready"] else ("on, needs a key" if entry["enabled"] else "off")
        key = entry["credential"]
        detail = f"key from {key['from']}" if key["present"] else (
            "no key: " + ", ".join(key["names"]) if key["names"] else "no key needed"
        )
        print(f"{entry['id']:<14} {entry['tier']:<6} {state:<16} {entry['capability']:<14} {detail}")
        print(f"{'':<14} {entry['label']} — {entry['note'][:90]}")
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    database, settings, _ = open_context(args)
    servers = providers.discover(settings)
    picked = providers.pick(settings)
    database.close()
    payload = {"ok": True, "servers": servers, "chosen": picked.get("model"), "hint": providers.start_hint(servers)}
    if args.json:
        print(json.dumps(payload, indent=2, default=str))
        return 0
    for server in servers:
        mark = "up  " if server["ok"] else "down"
        models = ", ".join(server["models"][:4]) or (server.get("error") or "")
        print(f"{mark} {server['label']:<28} {server['base']:<28} {models}")
    print()
    if picked.get("ok"):
        print(f"asking {picked['server']['label']} · {picked['model']}")
    else:
        print(f"no model answering — {payload['hint']}")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    database, settings, ctx = open_context(args)
    result = info.lookup(args.query, ctx)
    database.close()
    if args.json:
        print(json.dumps(result, indent=2, default=str))
        return 0
    if result.get("ok"):
        print(f"[{result['tier']}] {result.get('note', '')}")
        print(str(result.get("answer") or "")[:2000])
    else:
        print("nothing found. tiers tried:")
        for entry in result.get("tried") or []:
            print(f"  {entry['tier']:<10} found {entry.get('found', 0)}")
    return 0


def cmd_hierarchy(args: argparse.Namespace) -> int:
    _, settings, _ = open_context(args)
    tiers = info.hierarchy_report(settings)
    if args.json:
        print(json.dumps({"ok": True, "tiers": tiers}, indent=2, default=str))
        return 0
    for tier in tiers:
        mark = "ready" if tier["ready"] else "not  "
        print(f"{mark} {tier['tier']:<10} {tier['detail']}")
    return 0


def cmd_events(args: argparse.Namespace) -> int:
    database, _, _ = open_context(args)
    rows = database.recent_events(limit=args.limit, level=args.level)
    database.close()
    if args.json:
        print(json.dumps({"ok": True, "events": rows}, indent=2, default=str))
        return 0
    for row in rows:
        when = row["at"]
        print(f"{when:.0f} {row['level']:<5} {row['kind']:<10} {row['text'][:110]}")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    database, _, _ = open_context(args)
    stats = database.stats()
    database.close()
    emit(args, {"ok": True, **stats}, json.dumps(stats, indent=2))
    return 0


def cmd_config(args: argparse.Namespace) -> int:
    settings = config.load_config()
    if args.action == "set" and args.key and args.value:
        editable = {"model", "allowExternal", "testCommand", "hubUrl", "host", "port",
                    "auth", "toolTimeout", "modelTimeout", "capabilityTtl"}
        if args.key not in editable:
            print(f"not editable from here: {args.key} (edit config.json instead)", file=sys.stderr)
            return 2
        parsed: object = args.value
        if args.value.lower() in ("true", "false"):
            parsed = args.value.lower() == "true"
        elif args.value.isdigit():
            parsed = int(args.value)
        settings[args.key] = parsed
        config.save_config(settings)
        print(f"{args.key} = {parsed}")
        return 0
    emit(args, {"ok": True, "config": settings, "path": str(config.config_path())})

    if not args.json:
        print()
        print(f"settings file  {config.config_path()}")
        print(f"data dir       {config.data_dir()}")
        print(f"workspace      {config.workspace_dir()}")
    return 0


def cmd_schedule(args: argparse.Namespace) -> int:
    """Work the brain does on its own, on a clock it owns."""
    database, settings, ctx = open_context(args)

    if args.action == "add":
        if not args.name or not args.when:
            print("use: schedule add NAME --when \"every 15 minutes\" --ask \"...\"", file=sys.stderr)
            database.close()
            return 2
        if args.tool:
            try:
                payload: Any = {"tool": args.tool, "args": json.loads(args.args or "{}")}
            except ValueError as error:
                print(f"--args has to be a JSON object: {error}", file=sys.stderr)
                database.close()
                return 2
            kind = "tool"
        else:
            payload = args.ask
            kind = "ask"
        try:
            task = scheduler.add(database, args.name, args.when, kind, payload)
        except ValueError as error:
            print(str(error), file=sys.stderr)
            database.close()
            return 2
        emit(args, {"ok": True, "task": task}, f"{task['name']}: {scheduler.describe(task)['schedule']}")

    elif args.action == "remove":
        removed = database.remove_task(args.name or "")
        emit(args, {"ok": removed}, "removed" if removed else "no such task")

    elif args.action in ("pause", "resume"):
        enabled = args.action == "resume"
        ok = database.set_task_enabled(
            args.name or "", enabled, next_run=time.time() + 1 if enabled else None
        )
        emit(args, {"ok": ok}, f"{args.name}: {'enabled' if enabled else 'paused'}" if ok else "no such task")

    elif args.action == "run":
        due = database.due_tasks()
        if args.name:
            found = database.find_task(args.name)
            if found is None:
                print("no such task", file=sys.stderr)
                database.close()
                return 2
            due = [found]
        if not due:
            print("nothing is due right now.")
        for task in due:
            result = scheduler.run_task(database, task, ctx)
            mark = "ok " if result["ok"] else "err"
            print(f"{mark} {result['task']} ({result['ms']}ms)")
            if result.get("result"):
                print(f"    {str(result['result']).splitlines()[0][:110]}")
            if result.get("error"):
                print(f"    {result['error']}")

    else:
        status = scheduler.Runner(database, ctx).status()
        tasks = [scheduler.describe(task) for task in database.tasks()]
        if args.json:
            print(json.dumps({"ok": True, "runner": status, "tasks": tasks}, indent=2, default=str))
        else:
            for task in tasks:
                state = "on " if task["enabled"] else "off"
                when = task["schedule"]
                last = "never run" if not task.get("last_run") else (
                    f"last {'ok' if task.get('lastOk') else 'failed'}, {task['runs']} run(s)"
                )
                print(f"{state} {task['name']:<22} {when:<22} {last}")
                summary = (task.get("last_result") or task.get("last_error") or "").splitlines()
                if summary:
                    print(f"    {summary[0][:110]}")
            print()
            print(
                f"{len(tasks)} task(s). The clock runs while the brain is serving; "
                "`schedule run` does them now."
            )
    database.close()
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    """What is installed, what the package would add, and what could be local."""
    database, settings, ctx = open_context(args)

    if args.action == "installers":
        entries = updater.installers()
        database.close()
        if args.json:
            print(json.dumps({"ok": True, "installers": entries}, indent=2, default=str))
            return 0
        if not entries:
            print(f"no scripts found next to the brain ({updater.scripts_dir()})")
            return 0
        width = max(len(entry["name"]) for entry in entries)
        for entry in entries:
            print(f"{entry['name']:<{width}}  {entry['purpose']}")
        return 0

    if args.action == "run":
        if not args.name:
            print("use: update run <script name>", file=sys.stderr)
            database.close()
            return 2
        result = updater.run_installer(database, ctx, args.name)
        emit(args, result, json.dumps(result, indent=2, default=str)[:4000])
        database.close()
        return 0 if result.get("ok") else 1

    report = updater.check(database, ctx, refresh=args.refresh)
    database.close()
    if args.json:
        print(json.dumps(report, indent=2, default=str))
        return 0

    print(f"brain {report['version']} · package at {report['packageRoot']}")
    print(f"python {report['inventory'].get('python')} · {len(report['inventory'].get('tools') or {})} tools · "
          f"{len(report['inventory'].get('languages') or {})} languages")
    if report["changes"]:
        print("\nchanged since the last check")
        for line in report["changes"]:
            print(f"  {line}")
    if report["suggestions"]:
        print("\nworth installing")
        for entry in report["suggestions"]:
            print(f"  {entry['missing']:<14} {entry['why']}")
            print(f"  {'':<14} {entry['install']}")
    independence = report["independence"]
    print(f"\nindependence: {independence['summary']}")
    for entry in independence["capabilities"]:
        if entry["couldBeReplaced"]:
            print(f"  {entry['capability']:<14} uses {', '.join(entry['keyed'])} → "
                  f"{entry['use']}  ({entry['how']})")
    print("\ninstallers")
    for entry in report["installers"]:
        print(f"  {entry['name']:<28} {entry['purpose']}")
    return 0


def cmd_version(args: argparse.Namespace) -> int:
    emit(
        args,
        {"version": config.VERSION, "package": config.PACKAGE, "protocol": config.PROTOCOL,
         "python": sys.version.split()[0]},
        f"{config.PACKAGE} {config.VERSION} · protocol {config.PROTOCOL} · python {sys.version.split()[0]}",
    )
    return 0


# -------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="brain.py",
        description="The local brain: offline-first, own your machine, no account anywhere.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "start here:\n"
            "  python3 brain.py serve        run it and print the pairing token\n"
            "  python3 brain.py ask \"what is this machine?\"\n"
            "  python3 brain.py caps         what is installed and what it can do\n"
            "  python3 brain.py doctor       check itself and suggest repairs\n"
            "  python3 brain.py schedule add nightly --when \"daily at 03:30\" --ask \"run the tests\"\n"
            "  python3 brain.py update check what is missing, and what could be local\n"
        ),
    )
    # `--json` is accepted before *and* after the subcommand, because both read
    # naturally and having only one of them work is a papercut nobody deserves.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", parents=[common], help="run the HTTP API")
    serve.add_argument("--host", help="bind address (default 127.0.0.1)")
    serve.add_argument("--port", type=int, help="port (default 8710)")
    serve.add_argument("--open", action="store_true", help="no pairing token — only on a machine you trust")
    serve.add_argument("--no-schedule", action="store_true", help="serve the API without running scheduled tasks")
    serve.set_defaults(func=cmd_serve)

    sub.add_parser("pair", parents=[common], help="print the address and the pairing token").set_defaults(func=cmd_pair)
    sub.add_parser("token", parents=[common], help="make a new pairing token").set_defaults(func=cmd_token)

    ask = sub.add_parser("ask", parents=[common], help="ask a question; it calls tools and shows the steps")
    ask.add_argument("question")
    ask.add_argument("--steps", type=int, default=agent.MAX_STEPS)
    ask.set_defaults(func=cmd_ask)

    plan = sub.add_parser("plan", parents=[common], help="what it would do, without doing it")
    plan.add_argument("question")
    plan.set_defaults(func=cmd_plan)

    caps = sub.add_parser("caps", parents=[common], help="the capability map")
    caps.add_argument("--fresh", action="store_true", help="re-probe instead of using the cache")
    caps.set_defaults(func=cmd_caps)

    doctor = sub.add_parser("doctor", parents=[common], help="self-check with suggested repairs")
    doctor.add_argument("--deep", action="store_true")
    doctor.set_defaults(func=cmd_doctor)

    repair = sub.add_parser("repair", parents=[common], help="run a repair by name")
    repair.add_argument("name", nargs="?")
    repair.add_argument("--list", action="store_true")
    repair.set_defaults(func=cmd_repair)

    memory = sub.add_parser("memory", parents=[common], help="read and write what it remembers")
    memory.add_argument("action", nargs="?", choices=["list", "add", "search", "forget"], default="list")
    memory.add_argument("text", nargs="?", default="")
    memory.add_argument("--tags", default="")
    memory.add_argument("--pinned", action="store_true")
    memory.add_argument("--limit", type=int, default=30)
    memory.set_defaults(func=cmd_memory)

    toolbox = sub.add_parser("tools", parents=[common], help="list the tools, or run one")
    toolbox.add_argument("action", nargs="?", choices=["list", "run"], default="list")
    toolbox.add_argument("name", nargs="?")
    toolbox.add_argument("args", nargs="?", help="a JSON object of arguments")
    toolbox.set_defaults(func=cmd_tools)

    conns = sub.add_parser("connectors", parents=[common], help="what could reach outside, and with which key")
    conns.add_argument("action", nargs="?",
                       choices=["list", "enable", "disable", "set-key", "drop-key", "check"],
                       default="list")
    conns.add_argument("name", nargs="?")
    conns.add_argument("value", nargs="?")
    conns.set_defaults(func=cmd_connectors)

    sub.add_parser("models", parents=[common], help="which local model servers are answering").set_defaults(func=cmd_models)

    lookup = sub.add_parser("info", parents=[common], help="look something up through the information hierarchy")
    lookup.add_argument("query")
    lookup.set_defaults(func=cmd_info)

    sub.add_parser("hierarchy", parents=[common], help="how ready each information tier is").set_defaults(func=cmd_hierarchy)

    events = sub.add_parser("events", parents=[common], help="the log")
    events.add_argument("--limit", type=int, default=40)
    events.add_argument("--level", choices=["info", "warn", "error"])
    events.set_defaults(func=cmd_events)

    sub.add_parser("stats", parents=[common], help="database and memory counts").set_defaults(func=cmd_stats)

    settings = sub.add_parser("config", parents=[common], help="show or change settings")
    settings.add_argument("action", nargs="?", choices=["get", "set"], default="get")
    settings.add_argument("key", nargs="?")
    settings.add_argument("value", nargs="?")
    settings.set_defaults(func=cmd_config)

    schedule = sub.add_parser(
        "schedule", parents=[common], help="work the brain does on its own, on a clock"
    )
    schedule.add_argument(
        "action", nargs="?", choices=["list", "add", "remove", "pause", "resume", "run"], default="list"
    )
    schedule.add_argument("name", nargs="?")
    schedule.add_argument("--when", help='every 15 minutes | hourly | 2h | daily at 07:30')
    schedule.add_argument("--ask", help="a question to ask on that schedule")
    schedule.add_argument("--tool", help="a tool to run on that schedule")
    schedule.add_argument("--args", help="a JSON object of arguments for --tool")
    schedule.set_defaults(func=cmd_schedule)

    update = sub.add_parser(
        "update", parents=[common], help="what is installed, and what the package would add"
    )
    update.add_argument("action", nargs="?", choices=["check", "installers", "run"], default="check")
    update.add_argument("name", nargs="?", help="an installer to run")
    update.add_argument("--refresh", action="store_true", help="re-probe the machine first")
    update.set_defaults(func=cmd_update)

    sub.add_parser("version", parents=[common], help="what this is").set_defaults(func=cmd_version)
    return parser


def main(argv: list | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    # `serve` sets its own host and port; every other command just reads them.
    for attribute, default in (("host", None), ("port", None), ("open", False), ("no_schedule", False)):
        if not hasattr(args, attribute):
            setattr(args, attribute, default)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
