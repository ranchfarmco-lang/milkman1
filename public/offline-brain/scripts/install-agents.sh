#!/usr/bin/env bash
# Downloadable, locally-runnable coding agents and their frameworks.
# Each agent gets its own isolated environment so versions never collide.
. "$(dirname "$0")/lib.sh"

A="$BRAIN_DATA/agents"
mkdir -p "$A" "$BRAIN_ROOT/agents"

# fetch a repository as a tarball (no git required) into agents/<name>
fetch_repo() {
  local owner_repo="$1" dest="$A/$2" branch="${3:-main}"
  [ -d "$dest" ] && { ok "$2 already present"; return; }
  log "fetching $owner_repo -> agents/$2"
  mkdir -p "$dest"
  curl -sSL "https://codeload.github.com/$owner_repo/tar.gz/refs/heads/$branch" \
    | tar xz -C "$dest" --strip-components=1 || warn "failed to fetch $owner_repo"
}

# install a python agent into its own venv and expose its CLI on PATH.
#   agent_venv <name> <binary> <packages...>
agent_venv() {
  local name="$1" bin="$2"; shift 2
  pip_install "$A/$name/venv" "$@"
  if [ -x "$A/$name/venv/bin/$bin" ]; then
    ln -sf "$A/$name/venv/bin/$bin" "$BRAIN_ROOT/agents/$name"
  else
    warn "$name: no '$bin' binary in its venv (look in $A/$name/venv/bin)"
  fi
}

# ---- terminal coding agents --------------------------------------------------
agent_venv aider            aider            aider-chat
agent_venv gpt-engineer     gpt-engineer     gpt-engineer
agent_venv gptme            gptme            gptme
agent_venv open-interpreter interpreter      open-interpreter
agent_venv shell-gpt        sgpt             shell-gpt
agent_venv sweagent         sweagent         sweagent
agent_venv mentat           mentat           mentat
agent_venv smol-developer   smol-developer   smol-developer

# ---- larger agent projects (fetched as source) -------------------------------
fetch_repo All-Hands-AI/OpenHands OpenHands main
fetch_repo princeton-nlp/SWE-agent SWE-agent main
fetch_repo block/goose goose main
fetch_repo plandex-ai/plandex plandex main
fetch_repo stitionai/devika devika main

# ---- editors / IDE agents (fetched as source; install into your IDE) ---------
fetch_repo cline/cline cline main
fetch_repo continuedev/continue continue main
fetch_repo RooCodeInc/Roo-Code Roo-Code main
fetch_repo TabbyML/tabby tabby main

# ---- node-based agent CLIs ---------------------------------------------------
if have bun || have npm; then
  pm="npm"; have bun && pm="bun"
  install_node_agent() { # name npm-package
    local name="$1" pkg="$2"
    mkdir -p "$A/$name"
    ( cd "$A/$name" && $pm init -y >/dev/null 2>&1 || true; $pm install "$pkg" ) || warn "failed: $pkg"
  }
  install_node_agent codex-cli   @openai/codex
  install_node_agent gemini-cli  @google/gemini-cli
  install_node_agent opencode    opencode-ai
fi

# ---- Freebuff / Codebuff (the reference implementation) ----------------------
"$BRAIN_ROOT/scripts/capture-freebuff-source.sh" || warn "freebuff capture failed"

ok "coding agents installed under $A and $BRAIN_ROOT/agents"
