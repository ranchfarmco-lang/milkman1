#!/usr/bin/env bash
# Serve a local model behind an OpenAI-compatible API so every agent and tool in
# this package can point at it. Pick the engine with ENGINE=, default per format.
#
#   MODEL=models/qwen2.5-coder-7b ./scripts/serve-local-model.sh
#   ENGINE=ollama MODEL=qwen2.5-coder:7b ./scripts/serve-local-model.sh
#   ENGINE=vllm   MODEL=Qwen/Qwen3-Coder-30B-A3B-Instruct ./scripts/serve-local-model.sh
#
# Leaves a running server; agents then use OPENAI_BASE_URL=http://localhost:8000/v1
. "$(dirname "$0")/lib.sh"

MODEL="${MODEL:-}"
ENGINE="${ENGINE:-}"
PORT="${PORT:-8000}"

[ -n "$MODEL" ] || { echo "set MODEL, e.g. MODEL=Qwen/Qwen2.5-Coder-7B-Instruct"; exit 1; }

latest_gguf() {
  # find the newest .gguf inside a local model dir
  find "$1" -maxdepth 2 -iname '*.gguf' | head -1
}

if [ -z "$ENGINE" ]; then
  if [ -d "$MODEL" ] && [ -n "$(latest_gguf "$MODEL")" ]; then ENGINE=llama.cpp
  elif is_apple_silicon; then ENGINE=mlx
  else ENGINE=vllm; fi
fi

case "$ENGINE" in
  llama.cpp)
    BIN="$BRAIN_DATA/model-runtimes/llama.cpp/build/bin/llama-server"
    [ -x "$BIN" ] || die "llama-server not built; run scripts/install-runtimes.sh"
    GGUF="$(latest_gguf "$MODEL")"; [ -n "$GGUF" ] || die "no .gguf in $MODEL"
    log "llama.cpp serving $GGUF on :$PORT"
    exec "$BIN" -m "$GGUF" --host 127.0.0.1 --port "$PORT" -c "${CTX:-8192}" -ngl "${NGL:-99}"
    ;;
  ollama)
    have ollama || die "ollama not installed"
    log "ollama serving $MODEL on :11434"
    # start the ollama daemon unless it is already listening
    if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      ollama serve >/dev/null 2>&1 &
      for _ in $(seq 1 30); do
        curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
        sleep 1
      done
    fi
    exec ollama run "$MODEL"
    ;;
  vllm)
    PY="$BRAIN_DATA/runtimes/vllm/bin/python"
    [ -x "$PY" ] || die "vLLM venv missing; run scripts/install-runtimes.sh on a CUDA box"
    exec "$PY" -m vllm.entrypoints.openai.api_server --model "$MODEL" --port "$PORT" \
      --served-model-name local "$@"
    ;;
  transformers)
    PY="$BRAIN_DATA/runtimes/hf/bin/python"
    [ -x "$PY" ] || die "transformers venv missing; run scripts/install-runtimes.sh"
    # transformers has no built-in OpenAI server; prefer llama.cpp/vLLM, or use
    # the hf venv to run a tiny OpenAI-compatible shim.
    die "transformers cannot serve an OpenAI API on its own; set ENGINE=llama.cpp, vllm or ollama"
    ;;
  mlx)
    PY="$BRAIN_DATA/runtimes/mlx/bin/python"
    [ -x "$PY" ] || die "mlx venv missing; run scripts/install-runtimes.sh on Apple silicon"
    log "mlx serving $MODEL on :$PORT"
    exec "$PY" -m mlx_lm.server --model "$MODEL" --port "$PORT"
    ;;
  *)
    die "unknown ENGINE: $ENGINE (llama.cpp|ollama|vllm|transformers|mlx)"
    ;;
esac
