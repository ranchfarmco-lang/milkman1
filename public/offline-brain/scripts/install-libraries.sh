#!/usr/bin/env bash
# Common libraries shared by the runtimes, agents and tools.
. "$(dirname "$0")/lib.sh"

L="$BRAIN_DATA/libraries"

# ---- python core ------------------------------------------------------------
pip_install "$L/python" requests httpx pydantic pydantic-settings pyyaml toml rich typer click \
  tqdm numpy pandas regex tiktoken tenacity python-dotenv gitpython dulwich pathspec

# ---- structured prompts / templating ---------------------------------------
pip_install "$L/prompts" jinja2 "openai" "anthropic" "google-genai" "ollama" "llama-cpp-python"

# ---- tree-sitter grammars (parsing many languages) -------------------------
pip_install "$L/parsing" tree-sitter tree-sitter-language-pack

# ---- node / web -------------------------------------------------------------
if have npm || have bun; then
  pm="npm"; have bun && pm="bun"
  mkdir -p "$L/node"
  ( cd "$L/node" && $pm init -y >/dev/null 2>&1 || true; \
    $pm install zod axios express fast-glob ignore chokidar minimatch ) || warn "node libs failed"
fi

ok "libraries installed under $L"
