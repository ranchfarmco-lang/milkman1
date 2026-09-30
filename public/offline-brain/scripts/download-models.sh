#!/usr/bin/env bash
# Download open-weight model weights, tokenizers and configs listed in
# models/manifest.json. Everything lands under $BRAIN_DATA/models/<id>.
#
# Usage:
#   ./scripts/download-models.sh                 # the "recommended" set
#   MODEL_SET=small ./scripts/download-models.sh # 7-14B, laptop friendly
#   MODEL_SET=all   ./scripts/download-models.sh # everything incl. 70B+/671B
#   MODEL_SET=reasoning|coding|agentic|vision|embeddings|rerank|tiny ./...
#   GGUF=1 QUANT=Q4_K_M ./scripts/download-models.sh   # GGUF quants instead
#   ONLY=qwen2.5-coder-7b ./scripts/download-models.sh  # a single model id
#
# Gated repos (Llama, Gemma) need `hf auth login` first.
. "$(dirname "$0")/lib.sh"

MODEL_SET="${MODEL_SET:-recommended}"
GGUF="${GGUF:-0}"
QUANT="${QUANT:-Q4_K_M}"
ONLY="${ONLY:-}"

MANIFEST="$BRAIN_ROOT/models/manifest.json"
[ -f "$MANIFEST" ] || die "models/manifest.json not found"

ensure_hf_cli

# Emit "id<TAB>repo<TAB>gated" for the selected models.
select_models() {
  MODEL_SET="$MODEL_SET" ONLY="$ONLY" python3 - "$MANIFEST" <<'PY'
import json, os, sys
m = json.load(open(sys.argv[1]))
want = os.environ["MODEL_SET"].lower()
only = os.environ.get("ONLY", "").strip()
sets = {"tiny", "small", "reasoning", "coding", "agentic", "vision", "embeddings", "rerank", "large"}
for e in m["models"]:
    if only and e["id"] != only:
        continue
    if not only:
        ds = set(e.get("default_sets", []))
        if want == "all":
            pass
        elif want == "recommended":
            if not (ds & {"reasoning", "coding", "agentic", "embeddings", "rerank", "small"}):
                continue
        elif want in sets:
            if want not in ds:
                continue
        else:
            sys.exit(f"unknown MODEL_SET: {want}")
    print(f"{e['id']}\t{e['repo']}\t{'1' if e.get('gated') else '0'}")
PY
}

# For GGUF, map model id -> a community quant repo + file.
gguf_target() {
  case "$1" in
    qwen2.5-coder-7b)   echo "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/Qwen2.5-Coder-7B-Instruct-$QUANT.gguf" ;;
    qwen2.5-coder-14b)  echo "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/Qwen2.5-Coder-14B-Instruct-$QUANT.gguf" ;;
    qwen2.5-coder-32b)  echo "bartowski/Qwen2.5-Coder-32B-Instruct-GGUF/Qwen2.5-Coder-32B-Instruct-$QUANT.gguf" ;;
    qwen3-coder-30b-a3b) echo "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-$QUANT.gguf" ;;
    deepseek-r1-distill-qwen-7b)  echo "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/DeepSeek-R1-Distill-Qwen-7B-$QUANT.gguf" ;;
    deepseek-r1-distill-qwen-14b) echo "bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF/DeepSeek-R1-Distill-Qwen-14B-$QUANT.gguf" ;;
    deepseek-r1-distill-qwen-32b) echo "bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF/DeepSeek-R1-Distill-Qwen-32B-$QUANT.gguf" ;;
    qwen3-8b)           echo "unsloth/Qwen3-8B-GGUF/Qwen3-8B-$QUANT.gguf" ;;
    phi-4)              echo "bartowski/phi-4-GGUF/phi-4-$QUANT.gguf" ;;
    *)                  echo "" ;;
  esac
}

count=0
while IFS=$'\t' read -r id repo gated; do
  [ -n "$id" ] || continue
  dest="$BRAIN_DATA/models/$id"
  mkdir -p "$dest"
  if [ "$GGUF" = "1" ]; then
    target="$(gguf_target "$id")"
    if [ -n "$target" ]; then
      r="${target%%/*}"; rest="${target#*/}"; f="${rest#*/}"
      log "GGUF $id  <- $r/$f"
      hf_download "$r" "$f" --local-dir "$dest" || warn "failed: $r/$f"
    else
      warn "no GGUF mapping for $id; falling back to full repo"
      hf_download "$repo" --local-dir "$dest" || warn "failed: $repo"
    fi
  else
    if [ "$gated" = "1" ]; then
      warn "$id is gated: accepting the license on huggingface.co and running 'hf auth login' is required"
    fi
    log "weights $id  <- $repo"
    hf_download "$repo" --local-dir "$dest" || warn "failed: $repo"
  fi
  count=$((count + 1))
done < <(select_models)

ok "processed $count models into $BRAIN_DATA/models"
log "next: ./scripts/install-runtimes.sh  then serve a model with scripts/serve-local-model.sh"
