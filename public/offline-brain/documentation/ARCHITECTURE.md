# Architecture

The stack is a pipeline. Each layer is a directory in this package and each
arrow is a real interface you can point at a local process.

```
        ┌──────────────┐
        │   MODELS     │  open weights served by a local runtime
        │ models/      │  (llama.cpp / Ollama / vLLM / MLX)
        └──────┬───────┘
               │ OpenAI-compatible HTTP (:8000/v1)
        ┌──────▼───────┐
        │  RUNTIMES    │  model-runtimes/   tokenizers/
        └──────┬───────┘
               │
        ┌──────▼───────┐
        │  REASONING   │  reasoning/   planning, decomposition, tool selection,
        │              │  verification, reflection, multi-agent debate
        └──────┬───────┘
               │  orchestrates
        ┌──────▼───────┐
        │   AGENTS     │  agents/   coding, planning, research, browser, review
        └──────┬───────┘
               │  calls tools via MCP / function calling
        ┌──────▼───────┐
        │ORCHESTRATION │  orchestration/   tool calling, routing, parallel agents
        └──────┬───────┘
               │
   ┌───────────┼────────────┬────────────┐
   ▼           ▼            ▼            ▼
 ┌──────┐  ┌────────┐  ┌─────────┐  ┌──────────┐
 │FILES │  │TERMINAL│  │BROWSER/ │  │CONTEXT / │
 │file- │  │terminal│  │RESEARCH │  │MEMORY    │
 │tools/│  │-tools/ │  │browser- │  │context/  │
 └──┬───┘  └───┬────┘  │research │  │memory/   │
    │          │       └────┬────┘  │embeddings│
    │          │            │       │search/   │
    │          │            │       │databases/│
    └──────────┴────────────┴───────┴──────┬───┘
                                           ▼
                                    ┌────────────┐
                                    │   TEST /   │  pytest, lint, review,
                                    │  REVIEW    │  verification -> back to
                                    └─────┬──────┘  REASONING (loop closes)
                                          │
                                          └──►  libraries/  runtimes/
                                               (supporting software)
```

## The loop, concretely

1. **Select model** — `scripts/serve-local-model.sh` exposes a chosen model at
   `http://localhost:8000/v1`. `orchestration/` (LiteLLM) can front several.
2. **Gather context** — `context/` indexes the repo (tree-sitter + ctags +
   embeddings in a vector store). The agent asks for relevant files.
3. **Plan** — `reasoning/` (LangGraph / DSPy / AutoGen) decomposes the task.
4. **Act** — an agent in `agents/` calls tools: read/search files
   (`file-tools/`, `coding-tools/`), edit (`coding-tools/` patch/diff), run
   commands (`terminal-tools/`), browse (`browser-tools/`), research
   (`research-tools/`).
5. **Verify** — tests and linters (`tests/`, `coding-tools/`) plus a reviewer
   agent (`reasoning/` + `agents/`) inspect the change.
6. **Iterate** — failures feed back into step 3. Task state is checkpointed in
   `context/` (SQLite via LangGraph) and memory is persisted in `memory/`.

## Where Freebuff implements each layer

The `source/freebuff/` tree — unpacked during setup from
`source/freebuff-source.zip`, which ships in this package — is a working
reference for this architecture:

| Layer | Freebuff location |
| --- | --- |
| Model selection / providers | `sdk/src/impl/model-provider.ts`, `sdk/src/impl/llm.ts`, `packages/llm-providers/` |
| Reasoning / agent step loop | `packages/agent-runtime/src/run-agent-step.ts`, `run-programmatic-step.ts`, `prompt-agent-stream.ts` |
| Planning agent | `agents/thinker/`, `agents/base2/base2-plan.ts` |
| Context gathering | `agents/file-explorer/`, `packages/code-map/` (tree-sitter), `agents/context-pruner.ts` |
| Editing | `agents/editor/`, `sdk/src/tools/change-file.ts`, `apply-patch.ts`, `packages/agent-runtime/src/process-str-replace.ts` |
| Tools | `sdk/src/tools/`, `common/src/tools/` |
| Terminal | `sdk/src/tools/run-terminal-command.ts`, `agents/basher.ts` |
| Browser / research | `agents/browser-use/`, `agents/researcher/`, `sdk/src/tools/read-url.ts` |
| Review | `agents/reviewer/` |
| Librarian / docs | `agents/librarian/` |
| Orchestration / subagents | `agents/general-agent/`, `common/src/tools/`, `sdk/src/agents/load-agents.ts` |
| CLI | `cli/src/` (commands, router, reasoning) |

This is why the source tree is included: it shows how a production coding agent
wires these layers together, which is the part no single library gives you.
