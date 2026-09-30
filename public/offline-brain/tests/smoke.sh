#!/usr/bin/env bash
# Structural smoke test. Safe to run anywhere; does not install or download.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

echo "== directory structure =="
for d in models model-runtimes reasoning agents orchestration coding-tools \
         terminal-tools file-tools browser-tools research-tools context memory \
         embeddings search databases runtimes libraries source documentation \
         scripts configuration tests brain brain/src brain/tests; do
  if [ -d "$ROOT/$d" ]; then echo "  ok   $d"; else echo "  MISS $d"; fail=1; fi
done

echo "== json validity =="
for f in "$ROOT"/models/manifest.json "$ROOT"/configuration/catalog.json; do
  if python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then
    echo "  ok   ${f#$ROOT/}"
  else
    echo "  BAD  ${f#$ROOT/}"; fail=1
  fi
done

echo "== script syntax =="
for s in "$ROOT"/scripts/*.sh "$ROOT"/tests/*.sh; do
  if bash -n "$s" 2>/dev/null; then echo "  ok   ${s#$ROOT/}"; else echo "  BAD  ${s#$ROOT/}"; fail=1; fi
done

echo "== the brain =="
# The one component that runs on its own: it must import, and it must be able to
# describe itself, without installing anything.
if command -v python3 >/dev/null 2>&1; then
  # A throwaway home and workspace, so a structural test leaves nothing in the
  # real one — it says it installs nothing, and it should keep that promise.
  BRAIN_TMP="$(mktemp -d)"
  export BRAIN_HOME="$BRAIN_TMP/data"
  export BRAIN_WORKSPACE="$BRAIN_TMP/workspace"
  if python3 "$ROOT/brain/brain.py" version >/dev/null 2>&1; then
    echo "  ok   brain/brain.py runs (nothing to install)"
  else
    echo "  BAD  brain/brain.py did not run"; fail=1
  fi
  if python3 "$ROOT/brain/brain.py" caps --json >/dev/null 2>&1; then
    echo "  ok   brain capability discovery"
  else
    echo "  BAD  capability discovery failed"; fail=1
  fi
  if python3 -m unittest discover -s "$ROOT/brain/tests" >/dev/null 2>&1; then
    echo "  ok   brain test suite"
  else
    echo "  BAD  brain test suite failed"; fail=1
  fi
  [ -n "$BRAIN_TMP" ] && rm -rf "$BRAIN_TMP"
  unset BRAIN_HOME BRAIN_WORKSPACE
else
  echo "  skip (python3 is not installed)"
fi

echo "== freebuff reference source =="
# The archive of the upstream tree is *in* the package, so a complete download
# always has it: missing is a failure, not a skip. It only unpacks when the
# installers run (`scripts/capture-freebuff-source.sh` unpacks it onto the
# drive), so a tree that is absent is "not unpacked yet" — but a tree that exists
# and is incomplete means the unpack went wrong, and that is a failure.
# `-s`, not `-f`: a zero-byte archive means the unpack of the installer went
# wrong, which is exactly what this test exists to catch.
if [ -s "$ROOT/source/freebuff-source.zip" ]; then
  echo "  ok   source/freebuff-source.zip (ships in the package)"
else
  echo "  MISS source/freebuff-source.zip"; fail=1
fi
if [ ! -d "$ROOT/source/freebuff" ]; then
  echo "  --   source/freebuff not unpacked yet (scripts/capture-freebuff-source.sh)"
else
  for p in source/freebuff/agents source/freebuff/sdk/src/tools \
           source/freebuff/packages/agent-runtime source/freebuff/cli/src \
           source/freebuff/common/src/tools; do
    if [ -e "$ROOT/$p" ]; then echo "  ok   $p"; else echo "  MISS $p"; fail=1; fi
  done
fi

echo "== optional: local model endpoint =="
if [ -n "${OPENAI_BASE_URL:-}" ]; then
  if curl -sS -m 5 "${OPENAI_BASE_URL%/}/models" >/dev/null 2>&1; then
    echo "  ok   ${OPENAI_BASE_URL} responds"
  else
    echo "  warn ${OPENAI_BASE_URL} did not respond"
  fi
else
  echo "  skip (set OPENAI_BASE_URL to test a running server)"
fi

echo
if [ "$fail" -eq 0 ]; then echo "smoke: PASS"; else echo "smoke: FAIL"; fi
exit "$fail"
