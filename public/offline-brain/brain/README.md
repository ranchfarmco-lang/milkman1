# The Local Brain

The brain of this system: a complete, offline-first AI you run on your own Linux
machine. It is Python 3 and **nothing else** — no packages to install, no virtual
environment to create, no account, no key, no service. Every part of it works
with the network unplugged, and the network is treated as an optional extra
rather than a requirement.

## Run it

```bash
python3 brain/brain.py serve
```

It prints the address and a pairing token, and then it is running. Pair the hub
with it once (open the hub → **Local Brain**, paste the address and the token),
or talk to it directly:

```bash
curl -s http://127.0.0.1:8710/api/v1/health
```

Nothing needs installing first, and nothing phones home. The token is created on
the first run, stored `0600`, and can be replaced with `brain.py token`.

### The commands worth knowing

```bash
python3 brain/brain.py serve        # run the HTTP API — this is the system
python3 brain/brain.py pair         # print the address and the pairing token
python3 brain/brain.py ask "..."    # ask something; it calls tools and shows the steps
python3 brain/brain.py caps         # what this machine is and what it can do
python3 brain/brain.py doctor       # check itself, with a suggested repair per problem
python3 brain/brain.py tools        # every tool, and how each has been behaving
python3 brain/brain.py memory add "the spare hose is on shelf three"
python3 brain/brain.py info "what is a trigram index"   # walk the information hierarchy
python3 brain/brain.py repair --list

# work it does on its own, and the package it came from
python3 brain/brain.py schedule add nightly --when "daily at 03:30" --ask "run the tests"
python3 brain/brain.py schedule list --json
python3 brain/brain.py update check          # what is installed, what could be local
python3 brain/brain.py update run install-runtimes.sh
```

Every command takes `--json` and every command works with no network.

## One brain, two hosts

The architecture in one sentence: **the local brain is the system, and the web
version is a view of it.**

```
   your machine                                    a browser anywhere
   ┌───────────────────────────────┐               ┌───────────────────────┐
   │  brain.py  (this directory)   │  HTTP+JSON    │  hub → /local-brain   │
   │  memory · tools · workspace   │◀─────────────▶│  capabilities, memory │
   │  models · connectors · keys   │   loopback    │  tools, diagnostics   │
   └───────────────────────────────┘               └───────────────────────┘
```

There is no second implementation of anything. The page at `/local-brain` reads
the capability map, writes memories, runs tools and reads diagnostics through the
same endpoints `curl` uses. Stop the brain and the page says so; start it again
and the page is live again with its memory intact, because the memory was never
in the page.

## The modules

Each one is a separate file with one job, so any of them can be replaced without
touching the rest.

| Module | File | What it owns |
| --- | --- | --- |
| Configuration | `src/config.py` | Where the data and workspace live, what is allowed, the pairing token |
| Memory | `src/store.py` | SQLite: memory, events, tool runs, capability snapshots, connectors, credentials, conversations, the schedule |
| Capability discovery | `src/capabilities.py` | CPU, memory, disk, GPUs, installed tools, languages, model servers, the network — and what changed since last time |
| Model providers | `src/providers.py` | Ollama, llama.cpp, vLLM, LM Studio, text-generation-webui, LiteLLM, plus any endpoint you add — all on one interface |
| Tools | `src/tools.py` | The registry, the built-ins, the guard rails, and loading tools the brain wrote itself |
| Information access | `src/info.py` | The hierarchy, the on-disk cache, and one HTTP client with no dependency behind it |
| Connectors and credentials | `src/connectors.py` | Every external capability behind one replaceable slot, ranked freedom-first |
| Reasoning | `src/agent.py` | plan → act → verify → record, with a model or without one |
| The clock | `src/scheduler.py` | Recurring work it runs without being asked: the schedule, the runner thread, and what each run did |
| Packages | `src/updater.py` | What is installed, what the package's own installers would add, and what could be replaced with something local |
| Self-diagnostics | `src/diagnostics.py` | Findings, repairs, tool health, and "what changed?" |
| API | `src/server.py` | The endpoints, token auth, CORS and private-network headers |

## Local capability discovery

`brain.py caps` probes the machine and keeps the answer:

- cores, architecture, and the instruction sets that decide how fast a quantised
  model runs (`avx2`, `avx512f`, `fma`);
- total and available memory, free disk in both the data dir and the workspace;
- GPUs with their VRAM, from `nvidia-smi` where it exists;
- installed command-line tools with versions;
- languages and compilers, each with the extension it runs;
- local model servers that are answering and the models they serve;
- whether there is a network — a TCP connect with a short timeout, which is the
  one fact that changes how every other decision is made.

The map is cached, re-probed on demand with `--fresh`, and a summary is kept as a
snapshot whenever something changes. `brain.py doctor` diffs the last two and
says *what* changed — "ripgrep disappeared", "a model is now served", "the
network came back" — which is how self-maintenance gets a starting point.

## Memory

One SQLite file. Conversations, facts, events, tool runs, snapshots, connectors
and credentials all live in it, and searching is full-text when the SQLite build
supports FTS5 and plain matching when it does not. It works offline by
definition, it is one file to back up, and `sqlite3` reads it without this code.

```bash
python3 brain/brain.py memory add "the well pump needs priming after a power cut" --tags house,pump
python3 brain/brain.py memory search "pump"
python3 brain/brain.py stats
```

## The toolbox

Built in: `caps.get`, `fs.list`, `fs.read`, `fs.write`, `fs.search`, `shell.run`,
`code.run`, `code.test`, `memory.write`, `memory.search`, `info.lookup`,
`http.get`, `tools.list`, `tools.new`, `providers.status`, `connectors.status`,
`diag.check`, `files.group`, `git.run`, `lint.run`, `build.run`, `tools.doctor`.

The four newest are the coding toolchain as tools: `git.run` (version control
inside the workspace — pushes and force operations refused, a person does that),
`lint.run` (ruff/eslint/biome/shellcheck, first one installed wins), `build.run`
(make, pip, bun/npm run build, cmake — detected from the project's own files),
and `tools.doctor`, which checks the whole coding toolchain and names the exact
installer that would add anything missing.

**The brain can add to it.** `tools.new` writes a real Python file into
`<workspace>/tools/`, and the registry loads every file there on start. A tool
that raises is reported as *broken* rather than taking the brain down, and
`brain.py repair tools.reload` picks up a fix. That is the loop that stops the
system hitting the same wall twice — the second time it needs something, the tool
is already there, and it is readable source you own.

Guarding is a boundary rather than a jail, and it says so: shell commands that
destroy a machine are refused outright, everything runs with a timeout, and the
workspace is the brain's to use while anything outside it has to be asked for
explicitly.

## Information, without assuming the world is reachable

Every lookup walks a fixed order and stops at the first tier that answers:

```
memory → workspace → cache → public → free → configured services
```

- **memory** — its own database;
- **workspace** — files on this machine, searched with `ripgrep` when it is
  installed and with Python when it is not;
- **cache** — anything fetched before, kept on disk *with its date*, which is why
  an offline question about last week's page still gets an answer;
- **public** — Wikipedia, Stack Overflow and Hacker News through their open APIs,
  no account and no key;
- **free** — a self-hosted SearXNG, if one is running;
- **configured services** — only when you have supplied a key.

The answer always says which tier it came from, and `brain.py hierarchy` shows how
ready each tier is right now, so "why can't it answer?" is answerable before you
ask.

## Connectors and credentials

Nothing outside `connectors.py` knows the name of a service. A feature asks for a
*capability* — search the web, send mail, run a model, store a file — and gets the
best available connector, ranked **local before free before keyed**. Swapping a
commercial search API for SearXNG is a settings change, not a refactor.

A key comes from the environment or from the brain's own store, checked in that
order, so a key you exported for the session is never written to disk. The API
reports *which* keys exist and never their values.

```bash
python3 brain/brain.py connectors                      # what is ready, what needs a key
python3 brain/brain.py connectors set-key brave BRAVE_API_KEY=...
python3 brain/brain.py connectors check web_search      # what would be used, and the fallbacks
```

## Reasoning, with or without a model

The loop is always the same: gather what it knows, plan, act, **verify**, repeat,
record.

- **With a model** — a local server is asked, in JSON, which tool to call next.
  Each result goes back into the conversation and the loop stops when the model
  answers in words.
- **Without one** — the planner reads the question and picks the tools itself. It
  still searches memory, still reads files, still runs commands, still verifies,
  and still says plainly which part it could not do. A machine with no model is a
  machine with no model, not a broken system.

Either way the reply carries its steps and its verification, so what happened is
visible rather than inferred from a confident sentence. Nothing is claimed as
done without being read back: a file that was written is measured on disk, a
command is judged on its exit code, a memory is read back out of the database.

## Work it does on its own

Everything else here reacts — a question arrives, a tool is called. The scheduler
is the part that acts without being asked.

```bash
python3 brain/brain.py schedule add nightly --when "daily at 03:30" --ask "run the tests"
python3 brain/brain.py schedule add watcher --when "every 10 minutes" \
  --tool caps.get --args '{}'
python3 brain/brain.py schedule list --json
python3 brain/brain.py schedule pause nightly
```

Three decisions make it dependable rather than clever:

- **The schedule is a row, not a process.** It lives in the same SQLite file as
the memory, it is readable with `sqlite3`, and it survives a restart. There is no
cron entry to edit and no daemon to install — a system that needs cron to be
independent is not independent.
- **A task is a question or a tool call**, the two things the rest of the brain
already knows how to do, so there is no third dialect and no second execution
path to secure.
- **A missed run is not a disaster.** The next run is counted from *now*, not
from when the task was due, so a machine that was switched off for a week does
not wake up and fire a week of work at once. One tick runs at most
`schedulerMaxPerTick` tasks for the same reason.

The clock is a thread started by `serve`, so it exists exactly as long as the
brain does: stop the brain and the clock stops with it. Every run is written
down — including failures, because a scheduled task that has been failing quietly
is exactly the thing self-diagnostics exists to notice. `brain.py events` and the
Tasks tab both show them.

## Packages, and staying independent

`brain.py update` answers two questions without contacting anything.

```bash
python3 brain/brain.py update check                  # inventory, gaps, independence
python3 brain/brain.py update installers             # the scripts next to the brain
python3 brain/brain.py update run install-runtimes.sh
```

- **What is installed, and what moved.** Tools, languages, model servers and
versions, compared against the last inventory, so a version that changed
overnight is visible in a sentence.
- **What could be yours instead.** Every connector currently in use is listed
next to the local or self-hosted thing that would replace it, as a specific
script or setting rather than a principle.

Nothing here reaches the network. An update *check* compares this machine with
itself, and an update *run* executes a file from the package's own `scripts/`
directory — whitelisted by name against the installers that are actually on disk,
so a caller can never name a path outside the package. Both work with the cable
out, which is the whole point of owning the update path.

## Starting a local model (optional, and worth it)

The brain does not ship a model. When you want one:

```bash
ollama serve && ollama pull qwen2.5-coder:7b          # easiest
llama-server -m models/your-model.gguf --port 8080    # llama.cpp
```

`brain.py models` then shows it, and the same questions get reasoned through
properly instead of answered by tools alone. The package's own installers
(`scripts/install-runtimes.sh`, `scripts/download-models.sh`) fetch and set up
both.

## The API

`GET /api/v1/protocol` lists everything. The short version:

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/v1/health` | running, version, mode (no token needed) |
| GET | `/api/v1/protocol` | the endpoint list (no token needed) |
| GET | `/api/v1/pair` | check a token |
| GET | `/api/v1/capabilities` | the capability map (`?fresh=1`) |
| GET/POST | `/api/v1/tools`, `/api/v1/tools/run` | the tools, and running one |
| GET/POST/DELETE | `/api/v1/memory` | search, list, remember, forget |
| GET | `/api/v1/models` | model servers and their models |
| GET/POST | `/api/v1/connectors` | the registry, switching on, keys |
| GET | `/api/v1/hierarchy` | how ready each information tier is |
| POST | `/api/v1/info` | walk the hierarchy |
| POST | `/api/v1/ask` | the agent loop, with its steps |
| GET/POST | `/api/v1/tasks` | the schedule, and adding one (`{name, when, kind, payload}`) |
| POST/DELETE | `/api/v1/tasks/{id}`, POST `/api/v1/tasks/{id}/run` | pause or resume, remove, run it now |
| GET | `/api/v1/updates` | the inventory, the installers, and what could be local (`?refresh=1` re-probes) |
| POST | `/api/v1/updates/run` | run one of the package's own `scripts/*.sh` |
| GET | `/api/v1/diagnostics`, POST `/api/v1/repairs/{name}` | self-check and repair |
| GET | `/api/v1/events`, `/api/v1/stats`, `/api/v1/config` | the log, the counts, the settings |

Everything except the health check and the protocol list needs
`X-Brain-Token`. The API binds to `127.0.0.1` by default: it can run shell
commands, so reaching it from another machine is a decision you make, not a
default you inherit. Reaching it *from a page* is what the pairing token and the
`Access-Control-Allow-Private-Network` preflight header are for — that header is
what lets a hub served over https talk to the brain on your own machine.

## Settings

`<data dir>/config.json`, with environment variables overriding it:

| Setting | Default | Env |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `8710` | `BRAIN_HOST`, `BRAIN_PORT` |
| `auth` | `token` (`open` disables it) | `BRAIN_AUTH` |
| `allowExternal` | `false` | `BRAIN_ALLOW_EXTERNAL` |
| `model` | first available | `BRAIN_MODEL` |
| `testCommand` | detected | `BRAIN_TEST_COMMAND` |
| `localProviders` | six loopback servers | — |
| `infoTiers` | memory → … → api | — |
| `toolTimeout` / `modelTimeout` | 120 s / 600 s | — |
| `scheduler` | `true` (`--no-schedule` turns it off) | — |
| `schedulerTick` / `schedulerMaxPerTick` | 60 s / 3 | — |

The data dir is `~/.local/share/offline-brain` and the workspace is
`~/brain-workspace`; `BRAIN_HOME` and `BRAIN_WORKSPACE` move both, which is what
makes running the whole thing off an external drive a one-line change.

## Tests

```bash
python3 -m unittest discover -s brain/tests
```

62 tests, standard library only, no network, no fixtures to install. They cover
the store, the guard rails, a tool the brain writes for itself, the information
hierarchy, the connectors, the agent answering with **no model at all**, the
repairs, the schedule (what `every 15 minutes` means, what one tick runs, and
that a failure is recorded rather than thrown), the package inventory and the
independence report, and the HTTP API over a real socket — including that a
request with no token is refused and one with it is served.

## Why it is built this way

Every dependency that was avoidable, was avoided:

| Instead of | This uses | Cost of the choice |
| --- | --- | --- |
| a database server | one SQLite file | none — it ships with Python |
| a vector database | full-text search, with a plain-matching fallback | semantic search needs an embedder; lexical search needs nothing |
| a vendor SDK | one `urllib` client | nothing to pin, nothing that breaks on a major version |
| a hosted search API | Wikipedia, Stack Exchange, Hacker News, then SearXNG if you run one | the paid index is better; it is also optional |
| a hosted model | Ollama or llama.cpp on loopback | a GPU helps; the tools work without one either way |
| a cloud key store | the environment, or a `0600` file in a `0700` directory | no sync between machines |

The result is a directory you can copy, an archive you can read, and a system
that keeps working on a machine that has never been online.
