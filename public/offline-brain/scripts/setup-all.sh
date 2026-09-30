#!/usr/bin/env bash
# Run the whole offline stack install in order. Every step is idempotent, so it
# is safe to re-run after a failure.
#
#   ./scripts/setup-all.sh                 # recommended models
#   MODEL_SET=small ./scripts/setup-all.sh # light install for a laptop
#   SKIP_MODELS=1 ./scripts/setup-all.sh   # software only, weights later
. "$(dirname "$0")/lib.sh"

HERE="$(dirname "$0")"
run() { log "=== $* ==="; "$HERE/$1" || warn "$1 reported problems (continuing)"; }

run install-supporting.sh
run install-runtimes.sh
run install-coding-tools.sh
run install-terminal-tools.sh
run install-file-tools.sh
run install-browser-tools.sh
run install-research-tools.sh
run install-reasoning.sh
run install-orchestration.sh
run install-context-memory.sh
run install-libraries.sh
run install-agents.sh
[ "${SKIP_MODELS:-0}" = "1" ] || run download-models.sh

log "verifying"
"$HERE/verify.sh" || true

ok "offline stack setup finished. See README.md for how to serve models and run agents."
