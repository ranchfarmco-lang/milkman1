#!/usr/bin/env bash
# Install the software that actually runs local models.
# Everything here is open source and runs on your own machine.
. "$(dirname "$0")/lib.sh"

RUNTIMES_DIR="$BRAIN_DATA/model-runtimes"
mkdir -p "$RUNTIMES_DIR"
GPU="$(gpu_kind)"
log "detected accelerator: $GPU  ($OS/$ARCH)"

# ---- llama.cpp  (CPU/CUDA/Metal/Vulkan GGUF runtime) ------------------------
install_llamacpp() {
  [ -d "$RUNTIMES_DIR/llama.cpp" ] && { ok "llama.cpp present"; return; }
  log "building llama.cpp"
  need cmake
  local args=(-DCMAKE_BUILD_TYPE=Release)
  case "$GPU" in
    cuda) args+=(-DGGML_CUDA=ON) ;;
    metal) args+=(-DGGML_METAL=ON) ;;
    rocm) args+=(-DGGML_HIP=ON) ;;
    *) args+=(-DGGML_NATIVE=ON) ;;
  esac
  mkdir -p "$RUNTIMES_DIR/llama.cpp"
  curl -sSL "https://github.com/ggml-org/llama.cpp/archive/refs/heads/master.tar.gz" \
    | tar xz -C "$RUNTIMES_DIR/llama.cpp" --strip-components=1
  cmake -S "$RUNTIMES_DIR/llama.cpp" -B "$RUNTIMES_DIR/llama.cpp/build" "${args[@]}"
  cmake --build "$RUNTIMES_DIR/llama.cpp/build" --config Release -j"$(nproc 2>/dev/null || echo 4)"
  ok "llama.cpp built -> $RUNTIMES_DIR/llama.cpp/build/bin/llama-server"
}

# ---- Ollama  (one-command model manager + server) ---------------------------
install_ollama() {
  if have ollama; then ok "ollama present"; return; fi
  log "installing ollama"
  curl -fsSL https://ollama.com/install.sh | sh
  ok "ollama installed"
}

# ---- Hugging Face Transformers  (reference Python runtime) -------------------
install_transformers() {
  pip_install "$BRAIN_DATA/runtimes/hf" \
    "transformers[torch]" accelerate sentencepiece protobuf safetensors \
    "huggingface_hub[cli]"
}

# ---- vLLM  (high-throughput GPU serving) ------------------------------------
install_vllm() {
  [ "$GPU" = "cuda" ] || { warn "vLLM needs CUDA; skipping"; return; }
  pip_install "$BRAIN_DATA/runtimes/vllm" vllm
}

# ---- SGLang  (structured generation + serving) -------------------------------
install_sglang() {
  [ "$GPU" = "cuda" ] || { warn "SGLang needs CUDA; skipping"; return; }
  pip_install "$BRAIN_DATA/runtimes/sglang" "sglang[all]"
}

# ---- MLX / mlx-lm  (Apple silicon) ------------------------------------------
install_mlx() {
  if is_apple_silicon; then
    pip_install "$BRAIN_DATA/runtimes/mlx" mlx mlx-lm
  else
    warn "mlx is Apple-silicon only; skipping"
  fi
}

# ---- Text Embeddings Inference (HF TEI) + ExLlamaV2 + llamafile --------------
install_extras() {
  if [ "$GPU" = "cuda" ]; then
    pip_install "$BRAIN_DATA/runtimes/tei" "huggingface_hub[cli]" || true
  fi
  if have docker; then
    log "docker available: TEI image ghcr.io/huggingface/text-embeddings-inference"
  fi
  if [ ! -x "$RUNTIMES_DIR/llamafile" ] && [ "$OS" = "Linux" ]; then
    log "fetching llamafile (single-file local model runner)"
    curl -fsSL -o "$RUNTIMES_DIR/llamafile" \
      "https://github.com/Mozilla-Ocho/llamafile/releases/latest/download/llamafile" \
      && chmod +x "$RUNTIMES_DIR/llamafile" && ok "llamafile ready" \
      || warn "llamafile download failed (optional)"
  fi
}

# ---- tokenizers -------------------------------------------------------------
install_tokenizers() {
  pip_install "$BRAIN_DATA/runtimes/tokenizers" tokenizers sentencepiece tiktoken
}

install_llamacpp
install_ollama
install_transformers
install_vllm
install_sglang
install_mlx
install_extras
install_tokenizers

ok "model runtimes installed under $RUNTIMES_DIR and $BRAIN_DATA/runtimes"
