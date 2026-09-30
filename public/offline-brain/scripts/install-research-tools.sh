#!/usr/bin/env bash
# Technical research: self-hosted web search, offline docs and doc retrieval.
. "$(dirname "$0")/lib.sh"

R="$BRAIN_DATA/research-tools"
mkdir -p "$R"

# ---- self-hosted meta search (no cloud account needed) ----------------------
if have docker; then
  log "SearXNG runs from its official image; a compose file is written to research-tools/"
  cat > "$R/docker-compose.searxng.yml" <<'YAML'
services:
  searxng:
    image: searxng/searxng:latest
    ports: ["8888:8080"]
    volumes: ["./searxng:/etc/searxng:rw"]
    restart: unless-stopped
YAML
else
  warn "docker not found; SearXNG can be cloned and run with a venv instead"
fi

# ---- CLI search clients -----------------------------------------------------
pip_install "$R/cli" ddgr googler duckduckgo-search

# ---- offline documentation --------------------------------------------------
have tldr   || { have npm && npm install -g tldr || pkg_install tldr tldr || true; }
have cheat  || warn "cheat optional (offline cheatsheets)"
have zeal   || warn "zeal optional (offline docs browser, desktop)"

# DevDocs offline: fetch a docs bundle
if have docker; then
  log "DevDocs available as image: ghcr.io/freecodecamp/devdocs (optional)"
fi

# ---- doc/article extraction + knowledge capture -----------------------------
pip_install "$R/extract" trafilatura newspaper3k readability-lxml markdownify python-readability

ok "research tools installed under $R"
