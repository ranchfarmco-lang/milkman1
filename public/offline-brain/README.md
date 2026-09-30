# offline-ai-coding-brain

A complete, **locally-runnable** stack that reproduces the capabilities of an AI
coding system: reason, plan, write / understand / search / modify / debug /
review / test code, run commands, use a terminal and filesystem, research and
browse the web, run and coordinate multiple agents, and remember project context.

Everything here is open source or open weight and can legally run on your own
machine. There are no cloud services, accounts, subscriptions or paid APIs.

## What is already in this download vs. what the scripts fetch

| Part | State |
| --- | --- |
| `source/freebuff-source.zip` | **Already in this download** — the complete Freebuff (Codebuff) TypeScript/Bun monorepo (Apache-2.0), 1,773 files. `scripts/capture-freebuff-source.sh` unpacks it to `source/freebuff/`; nothing is fetched for it. |
| The brain, every installer script, the docs | Already in this download. |
| The software — runtimes, tools, agents, frameworks, libraries | Installed by the scripts when you run them on your machine. |
| Model weights | Fetched by `scripts/download-models.sh`; they are many GB and belong on your disk. |

Unpacked from that archive, `source/freebuff/` is the reference implementation of
the whole loop. The parts worth reading first:

```
source/freebuff/agents/            subagents: file-explorer, editor, thinker,
                                   researcher, reviewer, librarian, basher,
                                   context-pruner, browser-use, general-agent
source/freebuff/sdk/src/tools/     the coding tools: read-files, change-file,
                                   apply-patch, code-search, glob,
                                   list-directory, run-terminal-command, read-url
source/freebuff/sdk/src/impl/      model-provider, llm, agent-runtime, database
source/freebuff/packages/          agent-runtime, code-map (tree-sitter), llm-providers
source/freebuff/cli/               the CLI: agents, commands (router, reasoning, ...)
source/freebuff/common/src/tools/  tool definitions + params
source/freebuff/docs/              agents-and-tools.md, testing.md
```

## Quick start

```bash
cd offline-ai-coding-brain

# 1. software: runtimes, tools, agents, frameworks, libraries
./scripts/setup-all.sh                 # MODEL_SET=small SKIP_MODELS=1 for software only

# 2. model weights (pick a size that fits your machine)
MODEL_SET=small   ./scripts/download-models.sh    # 7-14B, laptop friendly
MODEL_SET=recommended ./scripts/download-models.sh
MODEL_SET=all     ./scripts/download-models.sh    # includes 70B+ and 671B

# 3. serve a model behind an OpenAI-compatible API
MODEL="$PWD/models/qwen2.5-coder-7b" ./scripts/serve-local-model.sh
#   -> http://localhost:8000/v1

# 4. point your agents at it
export OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=local

# 5. check what is installed
./scripts/verify.sh
```

Gated weights (Llama, Gemma) need `hf auth login` and license acceptance on
Hugging Face first. `download-models.sh` tells you when it hits one.

Model sets: `tiny`, `small`, `reasoning`, `coding`, `agentic`, `vision`,
`embeddings`, `rerank`, `large`, `recommended`, `all`. GGUF quants:
`GGUF=1 QUANT=Q4_K_M ./scripts/download-models.sh`.

## Layout

```
models/          open-weight models: reasoning, coding, vision, embeddings, rerankers
model-runtimes/  llama.cpp, Ollama, Transformers, vLLM, SGLang, MLX, llamafile
reasoning/       planning, multi-step reasoning, tool selection, verification
agents/          downloadable coding agents (aider, OpenHands, SWE-agent, Cline, ...)
orchestration/   tool calling (MCP), model routing (LiteLLM), parallel agents, tasks
coding-tools/    search, symbols, diffs, patches, lint, format, LSP
terminal-tools/  tmux, process/log inspection, shells
file-tools/      file read/write/search, archives, sync
browser-tools/   Playwright, Puppeteer, Selenium, browser-use, page extraction
research-tools/  SearXNG, doc retrieval, offline docs
context/         codebase indexing, retrieval, task state
memory/          project/conversation memory
embeddings/      embedding models + servers
search/          lexical + vector search engines
databases/       SQLite, Postgres+pgvector, DuckDB, Redis, Qdrant, Chroma, ...
runtimes/        language runtimes (python, node, bun, deno, rust, go)
libraries/       common python + node libraries
source/          Freebuff/Codebuff source (downloaded)
documentation/   architecture, capability map, licenses, offline guide
scripts/         installers, downloaders, verifier
configuration/   catalog.json (capability -> component), env.sh
tests/           smoke tests
```

See `documentation/CAPABILITY-MAP.md` for a capability-by-capability map to the
exact component and, where relevant, the file inside `source/freebuff/` that
implements it. See `documentation/LICENSES.md` before redistributing anything.

## Requirements

Linux or macOS. Roughly: a GPU with 8 GB+ VRAM (or Apple silicon) for 7-14B
models; 24 GB+ for 32B; multi-GPU / large RAM for 70B+. CPU-only works for the
small GGUF sets. Disk: the software is a few GB; model weights range from ~1 GB
(small GGUF) to hundreds of GB (`MODEL_SET=all`).

Use `BRAIN_DATA=/path/to/big/disk ./scripts/setup-all.sh` to keep weights off
your main drive.
