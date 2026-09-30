# models/

Open-weight models that form the brain: reasoning, coding, agentic coding,
planning, tool use, long context, vision, embeddings and reranking.

- `manifest.json` — the catalog: repo id, params, license, gated flag,
  capabilities and which download set each model belongs to.
- Weights land in `models/<id>/` after running `../scripts/download-models.sh`.

```bash
cd ..
MODEL_SET=recommended ./scripts/download-models.sh
MODEL_SET=small       ./scripts/download-models.sh   # laptop
GGUF=1 QUANT=Q4_K_M   ./scripts/download-models.sh   # quantized GGUF
ONLY=qwen2.5-coder-7b ./scripts/download-models.sh   # one model
```

Tokenizers, configs and quantization metadata are downloaded with each repo
(`tokenizer.json`, `config.json`, `generation_config.json`, safetensors), which
is exactly what the runtimes in `../model-runtimes/` load. Gated repos (Llama,
Gemma) need `hf auth login` and license acceptance on Hugging Face.

Start with the set that matches your hardware — see
`../documentation/OFFLINE-GUIDE.md` for sizing.
