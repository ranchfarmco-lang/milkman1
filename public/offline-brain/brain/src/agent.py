"""
The reasoning loop: decide, act, check, and say what happened.

This is the part that makes the brain a system rather than a prompt. A question
arrives, and the answer is produced the same way every time:

    1. gather     what the brain already knows — the capability map, the memory
                  that matches, the tools it has, and whether it is online
    2. plan       either ask a local model which tool to call, or, when no model
                  is running, choose from the question directly
    3. act        run the tool and keep its output
    4. check      verify what came back — a file that was written is read back, a
                  command that ran is judged on its exit code
    5. repeat     until there is an answer, or the steps run out
    6. record     the conversation, the steps and the verification, so the next
                  run starts from a better place than this one did

Two modes, and the second is not a fallback in the apologetic sense:

* **with a model**  a local server is asked, in JSON, which tool to call next.
  Every tool's output goes back into the conversation, and the loop stops when
  the model answers in words.
* **without one**   the planner reads the question and picks the tools itself.
  Smaller vocabulary, but it is honest work: it still searches memory, still
  reads files, still runs commands, still verifies, and still says clearly which
  part it could not do. A machine with no model is a machine with no model — not
  a broken system, and it says so rather than pretending.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional

from . import capabilities, config, providers, tools

#: How many tool calls one question may take before the loop stops. Small on
#: purpose: a loop that cannot finish in a handful of steps is usually stuck, and
#: a stuck loop is worse than a short answer that says what it managed.
MAX_STEPS = 6

SYSTEM_PROMPT = """You are the reasoning layer of a local, offline-first system. \
You run on the user's own machine and you must prefer local tools, local memory \
and open sources over anything external.

Available tools (name — purpose — arguments):
{tools}

Answer with ONE JSON object and nothing else.

To use a tool:
{{"tool": "fs.read", "args": {{"path": "notes.txt"}}}}

To finish:
{{"answer": "your answer, in plain language, saying what you did and what you found"}}

Rules:
- Prefer memory.search and fs.search before asking the network.
- After changing anything, say how you checked it.
- If the information is not available locally and there is no network, say so \
plainly instead of guessing.
- Never invent the contents of a file or the result of a command. Call the tool.
"""


def context_block(ctx: tools.ToolContext, question: str) -> Dict[str, Any]:
    """
    What the brain knows before it starts.

    Kept small on purpose: the capability summary and the memory that matched are
    the two things that change the answer, and everything else just costs time.
    """
    built = capabilities.build(ctx.store)
    memory = ctx.store.search_memory(question, limit=5)
    return {
        "online": bool((built.get("network") or {}).get("online")),
        "cores": built.get("cpu", {}).get("cores"),
        "memoryGb": built.get("memory", {}).get("totalGb"),
        "gpus": [gpu.get("name") for gpu in built.get("gpus", [])],
        "modelServers": [server["label"] for server in built.get("models") or []],
        "languages": list((built.get("languages") or {}).keys()),
        "memory": [
            {"id": row.get("id"), "text": row.get("text")} for row in memory
        ],
    }


def _tool_catalog() -> str:
    lines = []
    for tool in tools.registry.all():
        args = ", ".join(f"{name}" for name in tool.args) or "no arguments"
        lines.append(f"- {tool.name} ({args}) — {tool.summary}")
    return "\n".join(lines)


# ------------------------------------------------------------------ the planners


def _plan_with_model(
    ctx: tools.ToolContext,
    question: str,
    context: Dict[str, Any],
    transcript: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """One turn of the model-driven loop: either a tool call, or an answer."""
    system = SYSTEM_PROMPT.format(tools=_tool_catalog())
    messages: List[Dict[str, str]] = [{"role": "system", "content": system}]

    preamble = (
        f"Machine: {context['cores']} cores, {context['memoryGb']} GB RAM, "
        f"GPUs: {', '.join(context['gpus']) or 'none'}, "
        f"network: {'up' if context['online'] else 'DOWN — offline'}, "
        f"model servers answering: {', '.join(context['modelServers']) or 'none'}.\n"
    )
    if context["memory"]:
        preamble += "Things already remembered that may be relevant:\n" + "\n".join(
            f"- {row['text']}" for row in context["memory"]
        )
    messages.append({"role": "user", "content": f"{preamble}\nQuestion: {question}"})

    for step in transcript:
        messages.append({"role": "assistant", "content": json.dumps({"tool": step["tool"], "args": step["args"]})})
        messages.append(
            {
                "role": "user",
                "content": "Result: " + json.dumps(step.get("result"), default=str)[:6000],
            }
        )
    messages.append({"role": "user", "content": "What next? Reply with one JSON object."})

    answer = providers.chat(messages, ctx.settings, temperature=0.1)
    if not answer.get("ok"):
        return {"kind": "error", "error": answer.get("error"), "hint": answer.get("hint")}
    parsed = _extract_json(answer.get("text") or "")
    if parsed is None:
        # A model that answers in prose has still answered; take it as the answer
        # rather than throwing away a usable reply.
        return {"kind": "answer", "answer": (answer.get("text") or "").strip(), "provider": answer}
    if "answer" in parsed:
        return {"kind": "answer", "answer": str(parsed["answer"]), "provider": answer}
    if "tool" in parsed:
        return {
            "kind": "tool",
            "tool": str(parsed["tool"]),
            "args": parsed.get("args") or {},
            "provider": answer,
        }
    return {"kind": "error", "error": "the model replied with neither a tool nor an answer"}


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """Pull the first JSON object out of a reply, fenced or bare."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = [fenced.group(1)] if fenced else []
    depth = 0
    start = -1
    for index, char in enumerate(text):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                candidates.append(text[start: index + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            continue
    return None


#: The tool-only planner's vocabulary: a phrase, and what to do about it. Checked
#: in order, so the specific ones come before the general ones.
#: `terminal` means the tool's own result *is* the answer: once it has run, there
#: is nothing left to look up, and asking the information hierarchy afterwards
#: would only replace a good answer with a worse one.
INTENTS: List[Dict[str, Any]] = [
    {
        "name": "remember",
        "match": r"^\s*(remember|note|keep in mind|don'?t forget)\b[:,]?\s*(.+)$",
        "build": lambda match: ("memory.write", {"text": match.group(2)}),
        "terminal": True,
    },
    {
        "name": "recall",
        "match": r"\b(what do you (know|remember)|recall|look in (your )?memory)\b",
        "build": lambda match: ("memory.search", {"query": _subject(match.string)}),
        "terminal": True,
    },
    {
        "name": "capabilities",
        "match": r"\b(what can you do|capabilit|what.*installed|hardware|cpu|gpu|"
                 r"memory do you have|specs?)\b",
        "build": lambda match: ("caps.get", {}),
        "terminal": True,
    },
    {
        "name": "diagnose",
        "match": r"\b(diagnos|health|what'?s wrong|check yourself|self.?test|"
                 r"is everything (ok|working))\b",
        "build": lambda match: ("diag.check", {}),
        "terminal": True,
    },
    {
        "name": "tests",
        "match": r"\b(run the tests|test suite|run tests)\b",
        "build": lambda match: ("code.test", {}),
    },
    {
        "name": "list",
        "match": r"\b(list|show) (the )?(files|directory|folder|tree)\b",
        "build": lambda match: ("fs.list", {"path": ".", "depth": 2}),
    },
    {
        "name": "search_files",
        "match": r"\b(search|grep|find) (the )?(files|workspace|code|repo) for\s+(.+)$",
        "build": lambda match: ("fs.search", {"query": match.group(4).strip(' ?.')}),
    },
    {
        "name": "read",
        "match": r"\b(read|open|show me|cat)\s+(the file\s+)?([\w./-]+\.[a-z0-9]+)\b",
        "build": lambda match: ("fs.read", {"path": match.group(3)}),
    },
    {
        "name": "run",
        "match": r"^\s*(run|execute|shell):?\s+(.+)$",
        "build": lambda match: ("shell.run", {"command": match.group(2)}),
    },
    {
        "name": "status",
        "match": r"\b(models?|providers?|servers?)\b.*\b(running|available|up|answering)\b|"
                 r"\bwhich models?\b",
        "build": lambda match: ("providers.status", {}),
        "terminal": True,
    },
    {
        "name": "connectors",
        "match": r"\b(connectors?|api keys?|integrations?|which services)\b",
        "build": lambda match: ("connectors.status", {}),
        "terminal": True,
    },
]


def _subject(text: str) -> str:
    """Strip the question words, so the rest can be used as a search query."""
    cleaned = re.sub(
        r"(?i)\b(what|do|you|know|remember|about|recall|please|tell|me|the|of|is|are|"
        r"your|memory|look|in|can)\b",
        " ",
        text,
    )
    return " ".join(cleaned.split()) or text


def _plan_offline(question: str, context: Dict[str, Any], transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Choose tools from the question itself.

    Deliberately shallow: it matches what it knows, and for anything else it
    looks the subject up in the information hierarchy and reports exactly what it
    could and could not reach.
    """
    remaining = MAX_STEPS - len(transcript)
    if remaining <= 0:
        return {"kind": "answer", "answer": _offline_summary(transcript, context)}

    used = [step["tool"] for step in transcript]
    for intent in INTENTS:
        match = re.search(intent["match"], question, re.I)
        if not match:
            continue
        name, args = intent["build"](match)
        if name in used and intent["name"] != "recall":
            continue
        return {
            "kind": "tool",
            "tool": name,
            "args": args,
            "terminal": bool(intent.get("terminal")),
        }

    if "info.lookup" not in used:
        return {"kind": "tool", "tool": "info.lookup", "args": {"query": question}}

    return {"kind": "answer", "answer": _offline_summary(transcript, context)}


def _summarize_step(step: Dict[str, Any], context: Dict[str, Any]) -> str:
    """
    Turn a terminal step's result into the answer.

    Written out per tool rather than dumped as JSON, because the whole value of
    the tool-only mode is that it reads like somebody reporting what they found.
    """
    name = step["tool"]
    result = step.get("result") or {}
    lines: List[str] = []

    if name == "caps.get":
        built = result.get("capabilities") or result.get("value") or {}
        host = built.get("host") or {}
        cpu = built.get("cpu") or {}
        memory = built.get("memory") or {}
        network = built.get("network") or {}
        gpus = built.get("gpus") or []
        lines.append(
            f"This machine runs {host.get('distro') or host.get('os')} on "
            f"{cpu.get('cores')} cores with {memory.get('totalGb')} GB of memory"
            f"{' and ' + ', '.join(g['name'] for g in gpus) if gpus else ' and no GPU'}."
        )
        lines.append(f"Network: {'up' if network.get('online') else 'offline'}.")
        tools_found = sorted((built.get("tools") or {}).keys())
        lines.append(
            "I can read, write and search files, run shell commands, run and test "
            "code, keep and search memory, look things up through the information "
            "hierarchy, and write new tools for myself."
        )
        lines.append(
            f"{len(tools_found)} command-line tools are installed"
            + (f" ({', '.join(tools_found)})." if tools_found else ".")
        )
        servers = built.get("models") or []
        if servers:
            served = sum(len(server.get("models") or []) for server in servers)
            lines.append(f"A local model server is answering with {served} model(s).")
        else:
            lines.append(
                "No local model server is running, so I answer with tools and memory "
                "rather than reasoning through a model."
            )
        return "\n".join(lines)

    if name == "diag.check":
        counts = result.get("counts") or {}
        lines.append(
            f"Self-check: {counts.get('blocking', 0)} blocking, "
            f"{counts.get('degraded', 0)} degraded, {counts.get('note', 0)} notes."
        )
        for item in (result.get("findings") or [])[:8]:
            line = f"- [{item['level']}] {item['message']}"
            if item.get("repair"):
                line += f"  (repair: {item['repair']})"
            lines.append(line)
        return "\n".join(lines)

    if name == "providers.status":
        up = [server for server in (result.get("servers") or []) if server.get("ok")]
        if not up:
            return "No local model server is answering. " + str(result.get("hint") or "")
        lines.append(f"{len(up)} model server(s) answering:")
        for server in up:
            lines.append(f"- {server['label']} at {server['base']}: {', '.join(server['models']) or 'no models listed'}")
        return "\n".join(lines)

    if name == "connectors.status":
        summary = result.get("summary") or {}
        lines.append(
            f"{summary.get('ready', 0)} of {summary.get('total', 0)} connectors are ready; "
            f"{summary.get('needingKeys', 0)} need a key you have not added."
        )
        for entry in (result.get("connectors") or []):
            if entry.get("ready"):
                lines.append(f"- ready: {entry['label']} ({entry['tier']}, {entry['capability']})")
        return "\n".join(lines)

    if name in ("memory.search", "memory.write"):
        if name == "memory.write":
            total = int(result.get("count") or 0)
            return (
                f"Remembered, as #{result.get('id')}. That is {total} "
                f"thing{'s' if total != 1 else ''} kept."
            )
        hits = result.get("hits") or []
        if not hits:
            return "I have nothing remembered about that yet. Tell me and I will keep it."
        lines.append(f"{len(hits)} thing(s) I already know about that:")
        for row in hits:
            lines.append(f"- (remembered) {row['text']}")
        return "\n".join(lines)

    return _offline_summary([step], context)


def _offline_summary(transcript: List[Dict[str, Any]], context: Dict[str, Any]) -> str:
    """Say what was found, what was tried, and why the rest did not happen."""
    if not transcript:
        return (
            "I have no local model running, so I answered with the tools instead — "
            "and nothing matched. " + _offline_advice(context)
        )

    last = transcript[-1]
    result = last.get("result") or {}
    lines: List[str] = []

    if last["tool"] == "info.lookup" and not result.get("ok"):
        tried = ", ".join(
            f"{entry['tier']} ({entry.get('found', 0)})" for entry in result.get("tried") or []
        )
        lines.append(f"I looked everywhere I have and found nothing. Tiers tried: {tried}.")
    elif result.get("answer"):
        lines.append(str(result["answer"]))
    elif result.get("text"):
        lines.append(str(result["text"])[:1200])
    elif result.get("hits"):
        lines.append(json.dumps(result["hits"], default=str)[:1200])
    elif result.get("stdout"):
        lines.append(str(result["stdout"])[:1200])
    else:
        lines.append(f"{last['tool']} finished: " + json.dumps(result, default=str)[:1200])

    lines.append("")
    lines.append(_offline_advice(context))
    return "\n".join(lines)


def _offline_advice(context: Dict[str, Any]) -> str:
    if context.get("modelServers"):
        return "(A model server is answering, so this should have been reasoned through one.)"
    reach = "with the network" if context.get("online") else "offline"
    return (
        "I answered from local tools and memory only — no local model is running "
        f"({reach}). Start one and the same question gets reasoned through properly, "
        "or add a connector for anything I could not reach."
    )


# --------------------------------------------------------------------- verifying


def verify(step: Dict[str, Any], ctx: tools.ToolContext) -> Dict[str, Any]:
    """
    Check the result of a step, rather than trusting that it went well.

    Only the actions with a checkable outcome get checked: a file that was
    written is read back from disk, a command is judged on its exit code, a
    model server on whether it now answers. Everything else is marked as
    unverified, which is a fact about the answer worth carrying.
    """
    name = step.get("tool")
    result = step.get("result") or {}
    args = step.get("args") or {}

    if name == "fs.write" and result.get("ok"):
        target = result.get("path")
        try:
            import os

            size = os.path.getsize(str(target))
            expected = int(result.get("bytes") or 0)
            return {
                "tool": name,
                "checked": True,
                "ok": size == expected if expected else size > 0,
                "detail": f"{size} bytes on disk",
            }
        except OSError as error:
            return {"tool": name, "checked": True, "ok": False, "detail": str(error)}

    if name in ("shell.run", "code.run", "code.test"):
        code = result.get("exitCode")
        return {
            "tool": name,
            "checked": True,
            "ok": bool(result.get("ok")),
            "detail": f"exit code {code}" if code is not None else str(result.get("error") or "no exit code"),
        }

    if name == "memory.write" and result.get("ok"):
        found = ctx.store.search_memory(str(args.get("text", ""))[:120], limit=1)
        return {
            "tool": name,
            "checked": True,
            "ok": bool(found),
            "detail": "read back from the database" if found else "not found after writing",
        }

    if name == "info.lookup":
        return {
            "tool": name,
            "checked": True,
            "ok": bool(result.get("ok")),
            "detail": f"answered from {result.get('tier') or 'nothing'}"
            if result.get("ok")
            else "nothing answered",
        }

    if name == "providers.status":
        return {
            "tool": name,
            "checked": True,
            "ok": bool(result.get("ok")),
            "detail": f"{len([s for s in (result.get('servers') or []) if s.get('ok')])} server(s) up",
        }

    return {"tool": name, "checked": False, "ok": bool(result.get("ok")), "detail": "not verified"}


# --------------------------------------------------------------------- the loop


def ask(
    question: str,
    ctx: tools.ToolContext,
    conversation: Optional[int] = None,
    max_steps: int = MAX_STEPS,
) -> Dict[str, Any]:
    """
    Answer a question, with tools, and show the work.

    The reply always carries its steps and its verification, so a person can see
    what was done rather than infer it from a confident sentence.
    """
    started = time.time()
    question = (question or "").strip()
    if not question:
        return {"ok": False, "answer": "", "error": "nothing was asked"}

    context = context_block(ctx, question)
    chosen = providers.pick(ctx.settings)
    transcript: List[Dict[str, Any]] = []
    mode = "local-model" if chosen.get("ok") else "tools-only"
    answer_text = ""
    model_meta: Dict[str, Any] = {}
    errors: List[str] = []

    ctx.store.event("info", "ask", question[:200], {"mode": mode})

    for _ in range(max(1, min(max_steps, MAX_STEPS))):
        if mode == "local-model":
            decision = _plan_with_model(ctx, question, context, transcript)
            if decision.get("kind") == "error":
                # A model that stops answering mid-loop is a downgrade, not a
                # failure: the tools are still here and the question is still the
                # same, so the loop continues without it.
                errors.append(str(decision.get("error")))
                mode = "tools-only"
                decision = _plan_offline(question, context, transcript)
            elif decision.get("provider"):
                model_meta = {
                    "provider": decision["provider"].get("provider"),
                    "providerLabel": decision["provider"].get("providerLabel"),
                    "model": decision["provider"].get("model"),
                }
        else:
            decision = _plan_offline(question, context, transcript)

        if decision.get("kind") == "answer":
            answer_text = str(decision.get("answer") or "").strip()
            break

        if decision.get("kind") != "tool":
            errors.append(str(decision.get("error") or "the planner gave nothing to do"))
            break

        name = str(decision.get("tool"))
        args = decision.get("args") or {}
        result = tools.registry.run_tool(name, args, ctx)
        step = {"tool": name, "args": args, "result": result, "ok": bool(result.get("ok"))}
        step["verification"] = verify(step, ctx)
        transcript.append(step)
        if not result.get("ok"):
            errors.append(f"{name}: {result.get('error')}")

        # An intent whose result is the answer ends the turn here, rather than
        # sending a good answer on to be replaced by a worse one.
        if decision.get("terminal") and result.get("ok"):
            answer_text = _summarize_step(step, context)
            break

    if not answer_text:
        answer_text = _offline_summary(transcript, context)

    if conversation is not None:
        ctx.store.append_message(conversation, "user", question)
        ctx.store.append_message(
            conversation,
            "assistant",
            answer_text,
            {"mode": mode, "steps": [step["tool"] for step in transcript]},
        )

    return {
        "ok": True,
        "answer": answer_text,
        "mode": mode,
        "offline": not context["online"],
        "steps": transcript,
        "verification": [step.get("verification") for step in transcript],
        "context": context,
        "errors": errors,
        "provider": model_meta.get("provider"),
        "providerLabel": model_meta.get("providerLabel"),
        "model": model_meta.get("model"),
        "modelHint": None if chosen.get("ok") else chosen.get("hint"),
        "dataDir": str(config.data_dir()),
        "workspace": str(config.workspace_dir()),
        "ms": int((time.time() - started) * 1000),
    }


def plan(question: str, ctx: tools.ToolContext) -> Dict[str, Any]:
    """
    Show what the brain *would* do, without doing any of it.

    Useful on its own, and the thing that makes the agent's behaviour legible:
    the intent table is right there to read.
    """
    context = context_block(ctx, question)
    decision = _plan_offline(question, context, [])
    chosen = providers.pick(ctx.settings)
    return {
        "ok": True,
        "question": question,
        "mode": "local-model" if chosen.get("ok") else "tools-only",
        "firstStep": decision if decision.get("kind") == "tool" else None,
        "intents": [{"name": intent["name"], "match": intent["match"]} for intent in INTENTS],
        "context": context,
    }


def review_session(ctx: tools.ToolContext, limit: int = 20) -> Dict[str, Any]:
    """
    Read back the last few answers and note what they used.

    Small, but it is the beginning of the brain noticing its own habits: which
    tools carry the work, and which questions keep coming back.
    """
    questions = [row for row in ctx.store.recent_events(limit=limit * 4, level="info")
                 if row.get("kind") == "ask"]
    tool_counts = {row["tool"]: row["calls"] for row in ctx.store.tool_stats()}
    return {
        "ok": True,
        "questions": [{"at": row["at"], "text": row["text"]} for row in questions[:limit]],
        "toolsUsed": sorted(tool_counts.items(), key=lambda item: item[1], reverse=True)[:10],
        "memory": ctx.store.count_memory(),
    }
