#!/usr/bin/env bash
# Orchestration: model -> reasoning -> agents -> tools -> files -> terminal ->
# testing -> review. Tool calling, agent communication, parallel agents, task and
# workspace management, model and context routing.
. "$(dirname "$0")/lib.sh"

O="$BRAIN_DATA/orchestration"

# ---- tool calling / MCP -----------------------------------------------------
pip_install "$O/mcp" mcp "mcp[cli]" fastmcp
have mcpo || pip_install "$O/mcpo" mcpo

# ---- model routing (one local endpoint, many models) ------------------------
pip_install "$O/litellm" "litellm[proxy]" "llm" "openai" "anthropic"
have ollama && ok "ollama can serve as a local routing backend"

# ---- parallel agents / distributed execution --------------------------------
pip_install "$O/parallel" ray "celery" "dask[distributed]"

# ---- task / workflow scheduling --------------------------------------------
pip_install "$O/workflows" prefect dagster apache-airflow 2>/dev/null || pip_install "$O/workflows" prefect dagster
pip_install "$O/schedule" apscheduler

# ---- local agent UI / workspaces -------------------------------------------
if have docker; then
  cat > "$O/docker-compose.openwebui.yml" <<'YAML'
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports: ["3000:8080"]
    environment:
      - OPENAI_API_BASE_URL=http://host.docker.internal:11434/v1
      - OPENAI_API_KEY=local
    volumes: ["./open-webui:/app/backend/data"]
    restart: unless-stopped
YAML
fi

ok "orchestration installed under $O"
