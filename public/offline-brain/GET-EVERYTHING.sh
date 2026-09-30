#!/usr/bin/env bash
# GET EVERYTHING onto this drive.
#
# Run this from the folder you extracted the package into — ideally on the
# external drive itself, so every model weight lands there and not on your main
# disk. It installs all the software this package needs, then downloads the
# open-weight models.
#
#   ./GET-EVERYTHING.sh              # every model (hundreds of GB)
#   MODEL_SET=recommended ./GET-EVERYTHING.sh   # ~80-150 GB
#   MODEL_SET=small ./GET-EVERYTHING.sh         # ~20-40 GB, laptop friendly
#   SKIP_MODELS=1 ./GET-EVERYTHING.sh           # software only
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Keep every download next to this script, so it stays on this drive.
export BRAIN_DATA="$HERE"
MODEL_SET="${MODEL_SET:-all}"
SKIP_MODELS="${SKIP_MODELS:-0}"
export MODEL_SET SKIP_MODELS

echo "=============================================================="
echo " offline-ai-coding-brain"
echo " Installing into: $HERE"
if [ "$SKIP_MODELS" = "1" ]; then
  echo " Model set:       (skipped — software only)"
else
  echo " Model set:       $MODEL_SET"
fi
echo "=============================================================="
echo

command -v bash >/dev/null || { echo "bash is required"; exit 1; }

chmod +x scripts/*.sh tests/*.sh 2>/dev/null || true

./scripts/setup-all.sh

echo
./scripts/verify.sh || true

# The brain is the part that actually runs: Python 3 and the standard library,
# so there is nothing to install for it. Importing it proves the whole thing is
# present and readable rather than merely unpacked.
echo
echo "==> The brain (python3 brain/brain.py)"
if command -v python3 >/dev/null; then
  if python3 brain/brain.py version; then
    echo "    ok   the brain runs — it needs nothing else"
  else
    echo "    WARN the brain did not run; see brain/README.md" >&2
  fi
else
  echo "    WARN python3 is missing, so the brain cannot run yet" >&2
fi

echo
echo "=============================================================="
echo " Done. Everything lives in: $HERE"
echo
echo " Next:"
echo "   1. Start the brain   python3 brain/brain.py serve"
echo "                        It prints the pairing token. Pair the hub's"
echo "                        Local Brain page with it once and the memory,"
echo "                        tools and diagnostics are all there."
echo "   2. Serve a model    ./scripts/serve-local-model.sh"
echo "                       (set MODEL= to the model you downloaded)"
echo "   3. Point agents at  export OPENAI_BASE_URL=http://localhost:8000/v1"
echo "   4. The Freebuff source is in source/freebuff — unpacked from the"
echo "      archive that came in this package, so nothing was downloaded"
echo "=============================================================="
