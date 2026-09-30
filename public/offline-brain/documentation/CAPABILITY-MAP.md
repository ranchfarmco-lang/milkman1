# Capability map

Every capability you asked for, mapped to the components that provide it. Where
Freebuff implements the same capability, the file is named so you can read a
working example.

## Brain / models

| Capability | Component |
| --- | --- |
| General reasoning | `qwen3-32b`, `qwen2.5-72b-instruct`, `llama-3.3-70b-instruct`, `gemma-3-27b-it`, `phi-4` |
| Deep reasoning | `deepseek-r1` (+ 7B/14B/32B distills), `qwq-32b` |
| Coding / code generation | `qwen3-coder-30b-a3b`, `qwen2.5-coder-32b/14b/7b`, `starcoder2-15b`, `codellama-13b` |
| Code analysis / debugging / review | `qwen2.5-coder-*`, `deepseek-r1-distill-*`, `qwq-32b` |
| Planning / tool use | `qwen3-32b`, `qwen3-8b`, `hermes-3-llama-3.1-8b`, `llama-3.1-8b-instruct` |
| Long context | `qwen2.5-7b-instruct-1m` (1M tokens), `qwen3-*`, `qwen2.5-72b` |
| Vision | `qwen2.5-vl-7b-instruct`, `llama-3.2-11b-vision-instruct`, `gemma-3-27b-it` |
| Embeddings | `bge-m3`, `bge-large-en-v1.5`, `e5-large-v2`, `nomic-embed-text-v1.5`, `all-MiniLM-L6-v2`, `jina-embeddings-v3` |
| Reranking | `bge-reranker-v2-m3`, `bge-reranker-large`, `mxbai-rerank-large-v1` |

Quantized versions: `GGUF=1 QUANT=Q4_K_M ./scripts/download-models.sh` pulls
GGUF quants from bartowski / unsloth / lmstudio-community.

## Model runtimes

`model-runtimes/` — llama.cpp (CPU/CUDA/Metal/Vulkan), Ollama, Hugging Face
Transformers, vLLM, SGLang, MLX (Apple silicon), llamafile, HF TEI, plus the
tokenizer libraries (`tokenizers`, `sentencepiece`, `tiktoken`).

## Reasoning system

| Capability | Component |
| --- | --- |
| Planning | LangGraph, DSPy, AutoGen, CrewAI |
| Task decomposition | LangGraph state machines, DSPy signatures, MetaGPT |
| Multi-step reasoning | ReAct loops (LangGraph), program-aided reasoning (DSPy) |
| Tool selection | MCP + function calling, LiteLLM, `outlines`/`guidance` constrained decoding |
| Agent coordination | AutoGen, CrewAI, smolagents, PydanticAI, Agno, CAMEL, OpenAI Agents SDK |
| Context selection | LlamaIndex retrievers + BM25 + rerankers (`context/`) |
| Verification / error correction | Guardrails AI, Instructor, pyright, pytest, hypothesis, Reflexion loop |
| Code review | semgrep, reviewdog, bandit, ruff, pyright, clang-tidy; Freebuff `agents/reviewer/` |

## Coding agents

`agents/` — aider, OpenHands, SWE-agent, Goose, Cline, Continue, Roo-Code,
Plandex, gpt-engineer, gptme, open-interpreter, shell-gpt, mentat,
smol-developer, Devika, Tabby, codex-cli, gemini-cli, opencode. Each is fetched
or installed into its own environment; the Freebuff reference implementation is
in `source/freebuff/agents/`.

## Coding tools → source files

| Capability | Component |
| --- | --- |
| File reader | `file-tools/` (coreutils, bat); Freebuff `sdk/src/tools/read-files.ts` |
| File writer / editor | `sd`, editors; Freebuff `sdk/src/tools/change-file.ts` |
| Patch | `patch`, `diff`; Freebuff `sdk/src/tools/apply-patch.ts` |
| File search | `fd`, `fzf`; Freebuff `sdk/src/tools/glob.ts`, `list-directory.ts` |
| Code search | `ripgrep`, `ast-grep`; Freebuff `sdk/src/tools/code-search.ts`, `sdk/src/native/ripgrep.ts` |
| Symbol search | `universal-ctags`, GNU global, cscope, LSPs |
| Directory traversal | `tree`, `fd`; Freebuff `agents/file-explorer/` |
| Terminal / shell / commands | `terminal-tools/`; Freebuff `sdk/src/tools/run-terminal-command.ts` |
| Git / diff | `git`, `git-delta`, `difftastic`, `lazygit` |
| Build / test | `make`, `cmake`, `ninja`, `just`, `pytest`, `vitest` |
| Lint / format | `ruff`, `eslint`, `prettier`, `biome`, `shellcheck`, `shfmt`, `clang-format` |
| Package management | `uv`, `pip`, `npm`, `bun`, `cargo`, `go` |
| Process / log inspection | `htop`, `btop`, `procs`, `lsof`, `strace`, `tmux`, `jq` |
| Version control as a tool | `git.run` in `brain/src/tools.py` (wraps git; refuses push/force) |
| Lint as a tool | `lint.run` in `brain/src/tools.py` (ruff, eslint, biome, shellcheck) |
| Build as a tool | `build.run` in `brain/src/tools.py` (make, pip, bun/npm, cmake) |
| Toolchain self-check | `tools.doctor` in `brain/src/tools.py`; `diag.check` for the whole machine |
| Same tools in the browser | the web app's `src/lib/browser-brain.ts` — memory, fs.write/fs.read/fs.search, grep, code_run (offline JS), html_run; the browser tools share the local registry's names, and `run_shell`/`model_serve` are marked "needs the local brain" |

## Browser / research

`browser-tools/` — Playwright (+ Chromium/Firefox/WebKit), Puppeteer, Selenium,
Chrome DevTools Protocol (`chrome-remote-interface`), browser-use, Stagehand,
LaVague, Skyvern, browser-use web UI; static inspectors lynx, w3m, htmlq,
xmllint, pandoc; extraction via trafilatura, readability, newspaper3k.
`research-tools/` — SearXNG, ddgr, googler, DevDocs, tldr.

## Context / memory

| Capability | Component |
| --- | --- |
| Codebase indexing | tree-sitter (+ language pack), ctags, zoekt, livegrep; Freebuff `packages/code-map/` |
| Context gathering | LlamaIndex, Haystack; Freebuff `agents/file-explorer/`, `context-pruner.ts` |
| Semantic / vector search | Chroma, Qdrant, LanceDB, FAISS, Weaviate, Milvus |
| Embeddings | sentence-transformers, FlagEmbedding, fastembed, TEI |
| Reranking | bge-reranker, mxbai, `llama-index-postprocessor-flag-embedding-reranker` |
| Conversation history | LangGraph checkpoints, SQLite |
| Project memory | mem0, Letta (MemGPT), cognee, GPTCache |
| Knowledge files | LlamaIndex, txtai, DevDocs, `cheat`/`tldr` |
| Task / agent state | LangGraph SQLite checkpointer, sqlite-utils, Redis |

## Orchestration

MCP (tool calling + agent communication), LiteLLM (model/context routing),
Ray / Celery / Dask (parallel agents), Prefect / Dagster / Airflow / APScheduler
(task management), Open WebUI (workspace). Freebuff's equivalents:
`packages/agent-runtime/run-agent-step.ts`, `sdk/src/agents/load-agents.ts`,
`common/src/tools/`.

## Supporting software

`runtimes/` (python, uv, node, deno, bun, rust, go, JDK), `libraries/`
(python + node), `databases/` (SQLite, Postgres+pgvector, DuckDB, Redis,
Qdrant, Chroma, Milvus, Weaviate, LanceDB, FAISS, Neo4j), `search/`
(ripgrep, Meilisearch, Typesense, tantivy, bm25s), build tools and compilers.

## Freebuff source

`source/freebuff/` — agents, SDK, CLI, agent-runtime, code-map, llm-providers,
common tools, docs, scripts, tests, build files (Apache-2.0). It ships in this
package as `source/freebuff-source.zip`; `scripts/capture-freebuff-source.sh`
unpacks it here during setup, so it is never fetched.
