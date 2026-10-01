#!/bin/sh
# One command that starts the whole hub.
#
# The app is two processes, and only one of them is a web server:
#
#   * the Convex backend, which holds everything shared — the family, the
#     messenger, the calendar, both AI boxes and every memory;
#   * Vite, which serves the UI.
#
# Starting only Vite produces a page that can never finish loading. Every screen
# behind sign-in waits for the backend, Convex never resolves, and the result is
# a spinner on a black page with nothing on it to say why. So `bun run dev`
# starts both, and one command is all anybody needs to have the app running.
#
# Two deliberate choices:
#
#   * Convex runs in the background and Vite is `exec`'d, so Vite is the process
#     the runner supervises. If the backend cannot start, that must not take the
#     page down with it: the parts of this system that need no database at all —
#     the Local Brain and the Offline Brain downloads — are reachable exactly
#     when the backend is not, and they are what someone in that situation
#     needs. Its output goes to a log rather than the terminal for the same
#     reason, so a crash loop cannot bury the address Vite prints.
#   * If a backend is already answering, none is started. A second `convex dev`
#     would fight the first over the same port and could take down a dev process
#     this machine did not start.
#
# Check the log if the shared half of the app never loads:
#
#   tail -f .vly-run/convex-dev.log
#
# One more thing is started before Vite, and it is not a process: the signing
# keys. A deployment issues its own session tokens, so one created without
# `JWT_PRIVATE_KEY` and `JWKS` answers every query, looks perfectly healthy, and
# then throws the moment somebody signs in — which is the same dead end as a
# missing backend, reached later and with a worse message. A local deployment is
# always created without them, so on this machine that is not an edge case but
# the default state, and it is fixed here rather than left as a step to
# remember. See scripts/generate-auth-keys.mjs.

set -u

BACKEND="${VITE_CONVEX_URL:-http://127.0.0.1:3210}"
LOG_DIR=".vly-run"
LOG="$LOG_DIR/convex-dev.log"

# Is the backend already up? Health is a plain GET that needs no auth, so this is
# safe to probe and says exactly what the browser is about to try.
if command -v curl >/dev/null 2>&1 &&
  curl -s -o /dev/null --max-time 3 "${BACKEND%/}/version"; then
  echo "dev: Convex is already answering on ${BACKEND}"
else
  mkdir -p "$LOG_DIR"
  echo "dev: starting the Convex backend; its output goes to $LOG"
  bunx convex dev >>"$LOG" 2>&1 &
  # A moment of grace, so a backend that fails to start has written why to the
  # log before Vite fills the terminal with its own output. Not a wait for
  # readiness — Vite comes up either way, on purpose.
  sleep 1
fi

# Only the local backend is configured from here. A remote deployment's keys are
# set once, from a machine that can authenticate against it, and never by
# whoever happens to run the dev server; and chasing a name this script cannot
# log in to would only add a wait to every start.
case "$BACKEND" in
  *127.0.0.1* | *localhost*)
    if command -v curl >/dev/null 2>&1; then
      # The backend was started a moment ago and is not listening yet. Waiting
      # for it here is bounded on purpose: if it never comes up, the keys cannot
      # be set, and Vite still comes up below with the rest of the app — the
      # pages that need no database are exactly the ones worth reaching then.
      #
      # This wait comes before the file is looked for, not after: the config is
      # written by the CLI as it creates the deployment, so on a first run it
      # does not exist yet, and checking for it while the backend is still
      # starting would skip the keys on exactly the run that needs them.
      tries=0
      while [ "$tries" -lt 30 ] &&
        ! curl -s -o /dev/null --max-time 2 "${BACKEND%/}/version"; do
        tries=$((tries + 1))
        sleep 0.5
      done

      if [ -f .convex/local/default/config.json ]; then
        bun scripts/generate-auth-keys.mjs --local ||
          echo "dev: sign-in may fail — the local signing keys could not be set (see above)"

        # The AI keys, for the same reason: this backend is a different
        # deployment from the one the family configured, so without them every
        # AI box falls back to a model on this machine and answers nothing.
        bun scripts/sync-dev-ai-keys.mjs ||
          echo "dev: the AI keys could not be copied from the deployment (see above)"
      fi
    fi
    ;;
esac

exec bunx vite
