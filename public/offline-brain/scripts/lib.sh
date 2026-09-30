#!/usr/bin/env bash
# Shared helpers for the offline-ai-coding-brain installer scripts.
# Source this file from any script in this directory:  . "$(dirname "$0")/lib.sh"

set -euo pipefail

# ---- roots -----------------------------------------------------------------
BRAIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export BRAIN_ROOT

# Where large downloads land. Override with BRAIN_DATA if you keep weights on
# another disk, e.g.  BRAIN_DATA=/mnt/models ./scripts/download-models.sh
BRAIN_DATA="${BRAIN_DATA:-$BRAIN_ROOT}"
export BRAIN_DATA
mkdir -p "$BRAIN_DATA/models" "$BRAIN_DATA/.cache"

# ---- logging ---------------------------------------------------------------
if [ -t 1 ]; then C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_OFF=$'\033[0m'; else C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_OFF=''; fi
log()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
ok()   { printf '%s ok %s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%serr %s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# ---- environment detection -------------------------------------------------
OS="$(uname -s)"           # Linux | Darwin
ARCH="$(uname -m)"         # x86_64 | arm64 | aarch64
export OS ARCH

have() { command -v "$1" >/dev/null 2>&1; }

# Require a command, or fail with an actionable message.
need() {
  have "$1" || die "missing required command: $1${2:+ ($2)}"
}

# Pick the first available package-manager style installer helper.
pkg_install() {
  # pkg_install <apt-name> [brew-name]
  local apt_name="$1" brew_name="${2:-$1}"
  if have apt-get; then
    sudo apt-get update -qq && sudo apt-get install -y "$apt_name"
  elif have brew; then
    brew install "$brew_name"
  elif have dnf; then
    sudo dnf install -y "$apt_name"
  elif have pacman; then
    sudo pacman -S --noconfirm "$apt_name"
  else
    die "no supported package manager found to install $apt_name"
  fi
}

# Ensure the Hugging Face CLI is available (used to pull model weights).
ensure_hf_cli() {
  if have hf; then return 0; fi
  if have huggingface-cli; then return 0; fi
  log "installing huggingface_hub CLI"
  if have uv; then
    uv tool install "huggingface_hub[cli]"
  elif have pipx; then
    pipx install "huggingface_hub[cli]"
  elif have python3; then
    python3 -m pip install --user -U "huggingface_hub[cli]"
  else
    die "need python3/uv/pipx to install the huggingface CLI"
  fi
  export PATH="$HOME/.local/bin:$PATH"
}

# hf_download <repo_id> [--include glob] [--local-dir dir]
hf_download() {
  ensure_hf_cli
  local cli="huggingface-cli"; have hf && cli="hf"
  "$cli" download "$@"
}

ensure_python_venv() {
  # ensure_python_venv <dir>
  local dir="$1"
  [ -d "$dir" ] || python3 -m venv "$dir"
  # shellcheck disable=SC1091
  . "$dir/bin/activate"
  python -m pip install -q -U pip setuptools wheel
}

# pip_install <venv-dir> <packages...>
pip_install() {
  local dir="$1"; shift
  ensure_python_venv "$dir"
  "$dir/bin/python" -m pip install -q -U "$@"
  ok "installed into $dir: $*"
}

# Add a directory to PATH for the current shell and persist a line in env.sh.
export_path() {
  export PATH="$1:$PATH"
  printf 'export PATH="%s:$PATH"\n' "$1" >> "$BRAIN_ROOT/configuration/env.sh"
}

is_apple_silicon() { [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; }

gpu_kind() {
  if have nvidia-smi; then echo cuda
  elif is_apple_silicon; then echo metal
  elif have rocminfo; then echo rocm
  else echo cpu; fi
}
export -f gpu_kind 2>/dev/null || true
