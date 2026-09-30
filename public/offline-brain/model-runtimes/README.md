# model-runtimes/

The software that actually runs local models. Installed by
`../scripts/install-runtimes.sh`.

| Runtime | What it is | Best for |
| --- | --- | --- |
| **llama.cpp** | C/C++ GGUF inference, CPU/CUDA/Metal/Vulkan | quantized models, any hardware, `llama-server` |
| **Ollama** | model manager + server wrapping llama.cpp | one-command local models, `ollama serve` |
| **Hugging Face Transformers** | reference Python runtime | loading any repo, scripts, experiments |
| **vLLM** | high-throughput GPU serving, PagedAttention | concurrent agents, high throughput (CUDA) |
| **SGLang** | fast serving + structured generation | constrained decoding, tool schemas |
| **MLX / mlx-lm** | Apple-silicon native | Macs |
| **llamafile** | single-file model + runtime | portable, no install |
| **HF TEI** | Text Embeddings Inference server | embedding/reranking endpoints |

Tokenizer libraries (`tokenizers`, `sentencepiece`, `tiktoken`) install into
`../runtimes/tokenizers`.

Everything exposes or can expose an **OpenAI-compatible** endpoint; see
`../scripts/serve-local-model.sh`.
