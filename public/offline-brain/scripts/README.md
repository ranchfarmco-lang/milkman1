# scripts/

| Script | Does |
| --- | --- |
| `lib.sh` | shared helpers (logging, `BRAIN_DATA`, package install, HF CLI) |
| `setup-all.sh` | runs every installer in order |
| `install-supporting.sh` | runtimes, compilers, package managers, databases |
| `install-runtimes.sh` | llama.cpp, Ollama, Transformers, vLLM, SGLang, MLX, llamafile, TEI |
| `install-coding-tools.sh` | search, symbols, diff/patch, lint, format, LSP |
| `install-terminal-tools.sh` | tmux, process/log inspection, shells |
| `install-file-tools.sh` | file ops, archives, transfer |
| `install-browser-tools.sh` | Playwright/Puppeteer/Selenium, browser agents |
| `install-research-tools.sh` | SearXNG, ddgr, offline docs, extraction |
| `install-reasoning.sh` | LangGraph, DSPy, Outlines, Guardrails, multi-agent |
| `install-orchestration.sh` | MCP, LiteLLM, Ray/Celery/Dask, workflow engines |
| `install-context-memory.sh` | indexing, embeddings, vector stores, memory |
| `install-libraries.sh` | common python + node libraries |
| `install-agents.sh` | the coding agents + unpacking the Freebuff source |
| `download-models.sh` | open-weight weights/GGUF by `MODEL_SET` |
| `capture-freebuff-source.sh` | unpacks the Freebuff source archive that ships in this package |
| `serve-local-model.sh` | OpenAI-compatible local server |
| `verify.sh` | reports present/missing components |

All scripts are idempotent and honour `BRAIN_DATA` to redirect large downloads.
