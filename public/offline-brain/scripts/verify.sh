#!/usr/bin/env bash
# Report what is installed, what is missing, and where model weights live.
. "$(dirname "$0")/lib.sh"

pass=0; fail=0
check() { # check <label> <command...>  (passes if any candidate is present)
  local label="$1"; shift
  local c found=""
  for c in "$@"; do if have "$c"; then found="$(command -v "$c")"; break; fi; done
  if [ -n "$found" ]; then printf '  %sok%s  %-28s %s\n' "$C_GREEN" "$C_OFF" "$label" "$found"; pass=$((pass+1));
  else printf '  %s--%s  %-28s missing\n' "$C_YELLOW" "$C_OFF" "$label"; fail=$((fail+1)); fi
}
checkdir() { # checkdir <label> <path>
  if [ -e "$2" ]; then printf '  %sok%s  %-28s %s\n' "$C_GREEN" "$C_OFF" "$1" "$2"; pass=$((pass+1));
  else printf '  %s--%s  %-28s not found\n' "$C_YELLOW" "$C_OFF" "$1"; fail=$((fail+1)); fi
}

echo; log "base tools";       check "bash" bash; check "curl" curl; check "git" git; check "tar" tar; check "python3" python3; check "python3 venv" python3
check "container runtime" docker podman
echo; log "model runtimes";   check "llama.cpp" llama-server llama-cli; check "ollama" ollama; check "hf cli" hf huggingface-cli
echo; log "coding tools";     check "ripgrep" rg; check "fd" fd fdfind; check "ast-grep" ast-grep sg; check "ctags" ctags; check "jq" jq
echo; log "terminal tools";   check "tmux" tmux; check "htop" htop; check "strace" strace
echo; log "file tools";       check "rsync" rsync; check "zstd" zstd; check "tree" tree
echo; log "supporting";       check "uv" uv; check "pipx" pipx; check "node" node; check "bun" bun; check "sqlite3" sqlite3
echo; log "venvs / source"
checkdir "transformers venv" "$BRAIN_DATA/runtimes/hf"
checkdir "reasoning venv"    "$BRAIN_DATA/reasoning/langgraph"
checkdir "agents"            "$BRAIN_DATA/agents/aider"
checkdir "browser tools"     "$BRAIN_DATA/browser-tools/playwright"
checkdir "context/memory"    "$BRAIN_DATA/context/memory"
checkdir "freebuff archive"  "$BRAIN_ROOT/source/freebuff-source.zip"
checkdir "freebuff source"   "$BRAIN_ROOT/source/freebuff"

echo; log "downloaded models"
if [ -d "$BRAIN_DATA/models" ] && [ -n "$(ls -A "$BRAIN_DATA/models" 2>/dev/null)" ]; then
  du -sh "$BRAIN_DATA/models"/* 2>/dev/null | sort -h | tail -20 | sed 's/^/  /'
else
  printf '  %s--%s  no models downloaded yet (run scripts/download-models.sh)\n' "$C_YELLOW" "$C_OFF"
fi

echo; printf '%s%d present, %d missing%s\n' "$C_BLUE" "$pass" "$fail" "$C_OFF"
[ "$fail" -eq 0 ] || warn "some components are unpinned/optional; see the category README files"
