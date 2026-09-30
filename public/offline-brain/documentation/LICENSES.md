# Licenses

Nothing in this package is proprietary to a cloud service. Verify each license
yourself before redistributing; this file is a summary, not legal advice.

## Source

| Project | License |
| --- | --- |
| Freebuff / Codebuff (`source/freebuff/`) | Apache-2.0 |

The tree ships in this package as `source/freebuff-source.zip`, and
the installer unpacks it to `source/freebuff/`. `freebuff/LICENSE` and
`freebuff/NOTICE` are both inside the archive — keep them if you redistribute
the source.

## Models (`models/manifest.json`)

| License | Models | Notes |
| --- | --- | --- |
| Apache-2.0 | Qwen2.5-Coder, Qwen3, Qwen3-Coder, QwQ, Qwen2.5-VL, Qwen2.5-7B-1M, nomic-embed-text, all-MiniLM | Most permissive; safe for commercial use. |
| MIT | DeepSeek-R1 and distills, phi-4, bge-reranker-large | |
| Llama-3.x Community License | Llama-3.3-70B, Llama-3.1-8B, Llama-3.2-11B-Vision, Hermes-3 | **Gated.** Accept the license on Hugging Face, then `hf auth login`. |
| Gemma Terms | gemma-3-27b-it | **Gated.** |
| Qwen License | Qwen2.5-72B-Instruct | |
| BigCode OpenRAIL-M | starcoder2 | Use restrictions apply. |
| Llama-2 Community License | CodeLlama | |
| CC-BY-NC-4.0 | jina-embeddings-v3 | **Non-commercial only.** |

`models/manifest.json` carries a `license` and `gated` field per model; the
downloader warns before pulling a gated repo.

## Tools and frameworks

All installers in `scripts/` pull from official upstream sources. Representative
licenses:

- **Apache-2.0 / MIT**: llama.cpp, Ollama, Transformers, vLLM, SGLang, MLX,
  ripgrep, fd, ast-grep, fzf, tmux, Playwright, Puppeteer, Selenium, SearXNG,
  LangGraph, DSPy, LiteLLM, AutoGen, CrewAI, Ray, Chroma, Qdrant, LanceDB,
  DuckDB, Redis, and the coding agents (aider, OpenHands, Goose, Cline,
  Continue, Plandex, gptme, Tabby, Roo-Code, codex-cli, gemini-cli, opencode).
- **GPL / LGPL**: some system utilities installed via your distro's package
  manager (e.g. parts of the GNU toolchain), and GNU global. These run locally
  without affecting your own code's license, but review before bundling.
- **Mozilla Public License 2.0**: some browser/Python tooling.
- **AGPL**: OpenSearch (if you choose it), and a few self-hosted search/RAG
  servers. AGPL matters if you *offer them as a network service* to others;
  private local use is fine.

## Rule of thumb

- Running any of this locally for yourself is fine under every license here.
- Redistributing binaries or weights: keep each project's LICENSE and NOTICE,
  respect gated/NC licenses, and re-check upstream, because licenses change.
