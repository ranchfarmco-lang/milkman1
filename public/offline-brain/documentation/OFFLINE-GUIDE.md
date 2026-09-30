# Offline guide

## Truly offline checklist

1. Run all installers **once while online** (`./scripts/setup-all.sh` plus
   `./scripts/download-models.sh`). After that nothing here needs the network.
2. Serve a model locally: `MODEL=... ./scripts/serve-local-model.sh`.
3. Point every agent at the local endpoint:
   ```bash
   export OPENAI_BASE_URL=http://localhost:8000/v1
   export OPENAI_API_KEY=local
   # route specific agents, e.g. aider:
   export AIDER_MODEL=openai/local
   ```
4. Optional: run LiteLLM in front of several local models for routing:
   `litellm --config configuration/litellm.example.yaml`.
5. Web search/research that uses Serper/Google is replaced by self-hosted
   **SearXNG** (`research-tools/docker-compose.searxng.yml` on port 8888). Point
   your research agent's search URL at it. Offline docs come from DevDocs/tldr.
6. Browser agents (browser-use, Playwright) work fully offline against local
   sites (`http://localhost:...`) with headless Chromium.

Anything that still reaches the network is a cloud LLM API, telemetry, or the
built-in web-search provider — switch those to the local equivalents above.

## Hardware sizing

| Model size | Quant | VRAM / unified RAM | Example |
| --- | --- | --- | --- |
| 7-8B | Q4_K_M | ~6 GB | `qwen2.5-coder-7b` |
| 14B | Q4_K_M | ~10 GB | `qwen2.5-coder-14b`, `phi-4` |
| 30B MoE (3B active) | Q4_K_M | ~18 GB | `qwen3-coder-30b-a3b` |
| 32B | Q4_K_M | ~20-24 GB | `qwen2.5-coder-32b`, `qwq-32b` |
| 70B | Q4_K_M | ~40-48 GB | `llama-3.3-70b-instruct` |
| 671B MoE | Q4 | multi-GPU / 200 GB+ | `deepseek-r1` |

- **Apple silicon**: use `mlx`/`mlx-lm` or llama.cpp with Metal. Unified memory
  is shared, so a 32 GB Mac runs 14B comfortably and 32B with a tight context.
- **NVIDIA**: llama.cpp CUDA or vLLM. `-ngl 99` offloads all layers.
- **AMD**: llama.cpp with ROCm (`-DGGML_HIP=ON`).
- **CPU only**: GGUF with `MODEL_SET=tiny`/`small`; expect a few tokens/sec.

## Disk

- Software: a few GB.
- `MODEL_SET=tiny` ~5-10 GB, `small` ~20-40 GB, `recommended` ~80-150 GB,
  `all` hundreds of GB.
- Keep weights off your main disk: `BRAIN_DATA=/mnt/models ./scripts/download-models.sh`.

## Recommended working set

For an offline coding assistant on a single 24 GB GPU:
`qwen3-coder-30b-a3b` (agentic coding) + `deepseek-r1-distill-qwen-32b`
(reasoning) + `bge-m3` (embeddings) + `bge-reranker-v2-m3` (reranking).
On 8-16 GB: `qwen2.5-coder-7b`/`14b` + `deepseek-r1-distill-qwen-7b`.
