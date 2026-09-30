#!/usr/bin/env bash
# Supporting software the rest of the stack needs: language runtimes, compilers,
# package managers, dev utilities and local databases/engines.
. "$(dirname "$0")/lib.sh"

# ---- base tools -------------------------------------------------------------
# Everything below (and every other installer) relies on these first.
log "base tools"
have curl || pkg_install curl curl
have git  || pkg_install git git
have tar  || pkg_install tar tar
have gzip || pkg_install gzip gzip
have xz   || pkg_install xz-utils xz
have python3 || pkg_install python3 python
if have apt-get; then sudo apt-get update -qq && sudo apt-get install -y ca-certificates || true; fi
# the venv module ships separately on Debian/Ubuntu
python3 -m venv --help >/dev/null 2>&1 || pkg_install python3-venv python3-venv || true

# ---- language runtimes / package managers -----------------------------------
log "language runtimes and package managers"
have pip3 || pkg_install python3-pip
have uv || { curl -LsSf https://astral.sh/uv/install.sh | sh; export_path "$HOME/.local/bin"; }
have pipx || python3 -m pip install --user -q -U pipx 2>/dev/null || warn "pipx optional (used only as a fallback)"
have node || pkg_install nodejs node
have bun || { curl -fsSL https://bun.sh/install | bash; export_path "$HOME/.bun/bin"; }
have deno || { curl -fsSL https://deno.land/install.sh | sh; export_path "$HOME/.deno/bin"; }
have rustc || { curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; . "$HOME/.cargo/env"; }
have go    || pkg_install golang go
have java  || warn "JDK not installed (optional; needed for Java language servers)"

# corepack gives pnpm/yarn without a separate install
have corepack && corepack enable 2>/dev/null || true

# ---- compilers / build systems ----------------------------------------------
log "compilers and build tools"
have cc     || pkg_install build-essential build-essential
have cmake  || pkg_install cmake cmake
have ninja  || pkg_install ninja-build ninja
have make   || pkg_install make make
have pkg-config || pkg_install pkg-config pkg-config
have just   || { have brew && brew install just || warn "install 'just' for task running (optional)"; }

# ---- version control / diff / patch -----------------------------------------
# git is already managed by your environment; do not reinstall it.
have git    || pkg_install git git
have patch  || pkg_install patch patch
have diff   || pkg_install diffutils diffutils

# ---- container runtime (optional) -------------------------------------------
# Docker (or Podman) is needed for SearXNG, Qdrant, Meilisearch, Open WebUI,
# DevDocs and the vector/search servers. Everything else runs natively.
if have docker || have podman; then
  ok "container runtime present"
  if have docker; then docker compose version >/dev/null 2>&1 || warn "docker compose plugin not found (needed by the compose files)"; fi
else
  warn "docker/podman not installed (optional): enables SearXNG, Qdrant, Meilisearch, Open WebUI, DevDocs and the vector/search servers"
fi

# ---- databases / engines ----------------------------------------------------
log "local databases and engines"
have sqlite3 || pkg_install sqlite3 sqlite
have psql    || warn "PostgreSQL not installed (optional; needed for pgvector server mode)"
have redis-server || warn "Redis not installed (optional)"
have duckdb  || pip_install "$BRAIN_DATA/runtimes/duckdb" duckdb

ok "supporting software step complete"
