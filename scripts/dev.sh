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

# The backend a development run uses is always this machine's own — the address
# `src/lib/backend.ts` calls `DEV_BACKEND`, probes before anything is drawn, and
# carries calls through the dev server when the page is read from somewhere
# else. It is written down here rather than read from the environment on
# purpose: in a development run `VITE_CONVEX_URL` is only the *fallback* for a
# backend that is not answering, so an address taken from it would point the
# page at whatever deployment the project is configured with — this project's
# was one that had hit a usage limit and refused every call — while the backend
# this script is about to start sat unused.
BACKEND="http://127.0.0.1:3210"
LOG_DIR=".vly-run"
LOG="$LOG_DIR/convex-dev.log"

# Is the backend already up? Health is a plain GET that needs no auth, so this is
# safe to probe and says exactly what the browser is about to try.
if command -v curl >/dev/null 2>&1 &&
  curl -s -o /dev/null --max-time 3 "${BACKEND%/}/version"; then
  echo "dev: Convex is already answering on ${BACKEND}"
else
  mkdir -p "$LOG_DIR"
  echo "dev: starting this machine's Convex backend; its output goes to $LOG"

  # The deployment this machine already made, when there is one: naming it keeps
  # the CLI from having to choose, and from making a second backend beside the
  # first. Read with `sed` so this needs nothing but the shell.
  LOCAL_NAME=""
  if [ -f .convex/local/default/config.json ]; then
    LOCAL_NAME="$(sed -n 's/.*"deploymentName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' .convex/local/default/config.json)"
  fi

  # Account-free, and by name — not the same thing as running `convex dev`
  # plainly, and the difference is why the page once sat waiting for a backend
  # that never started. `.env.local` names a deployment; the CLI reads that file
  # too, and without an account it then stops at "Welcome to developing with
  # Convex, let's get you logged in", which a non-interactive run cannot answer
  # (that exact line is in the log for this branch). `CONVEX_AGENT_MODE=anonymous`
  # asks for the backend on this machine instead, and the deploy-key variables
  # are taken out of the environment so a hosted deployment cannot be chosen
  # over it. The same recipe `self-hosting/own.sh` uses: a value set here beats
  # the file, because the file is loaded without overriding what is already in
  # the environment.
  #
  # Which backend build runs is worth a word, because the CLI's default choice
  # is not always one a machine can run. The backend is a program the CLI
  # downloads, and a *newest* build can need a newer C library than an older
  # machine has — on this machine the newest cached build does, and the loader
  # says so on the binary's first line (`GLIBC_2.38 not found`). Unpinned, that
  # is the build the CLI reaches for, and the start dies there.
  #
  # So when the newest cached build is one this machine cannot execute, the
  # version is pinned — through the CLI's own `--local-backend-version` — to the
  # newest cached build that does run, each candidate being asked to run its own
  # `--help` (a build that cannot load fails that on its first line). The flag
  # does work without a Convex account, but only together with the rest of this
  # recipe: it wants a local deployment selected, which is what
  # `CONVEX_AGENT_MODE=anonymous` plus the deployment's own name provides.
  # Without the name it refuses with "can only be used when developing with a
  # local deployment", and that refusal is worth knowing if this ever stops
  # working. `OWN_BACKEND_VERSION` still overrides the probe, for a machine
  # whose cache holds a build the probe dislikes.
  #
  # When the newest cached build runs — the usual case, and the case while the
  # cache is still empty — nothing is pinned and the CLI chooses, including
  # downloading something newer than anything cached here.
  PIN_VERSION="${OWN_BACKEND_VERSION:-}"
  if [ -z "$PIN_VERSION" ]; then
    seen_broken=""
    for name in $(ls -1 "$HOME/.cache/convex/binaries" 2>/dev/null | sort -r); do
      binary="$HOME/.cache/convex/binaries/$name/convex-local-backend"
      [ -f "$binary" ] || continue
      if "$binary" --help >/dev/null 2>&1; then
        [ -n "$seen_broken" ] && PIN_VERSION="$name"
        break
      fi
      seen_broken="1"
    done
  fi

  if [ -n "$PIN_VERSION" ]; then
    echo "dev: backend build pinned to $PIN_VERSION — the newest cached one cannot run on this machine"
    env -u CONVEX_DEPLOY_KEY -u CONVEX_DEPLOYMENT_TOKEN -u CONVEX_DEPLOYMENT \
      -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
      ${LOCAL_NAME:+"CONVEX_DEPLOYMENT=$LOCAL_NAME"} \
      CONVEX_AGENT_MODE=anonymous \
      bunx convex dev --local-backend-version "$PIN_VERSION" >>"$LOG" 2>&1 &
  else
    env -u CONVEX_DEPLOY_KEY -u CONVEX_DEPLOYMENT_TOKEN -u CONVEX_DEPLOYMENT \
      -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
      ${LOCAL_NAME:+"CONVEX_DEPLOYMENT=$LOCAL_NAME"} \
      CONVEX_AGENT_MODE=anonymous \
      bunx convex dev >>"$LOG" 2>&1 &
  fi
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
