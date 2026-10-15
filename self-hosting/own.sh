#!/usr/bin/env bash
# Run the whole hub on this computer — its own database, its own files, its own
# icon on the home screen, and nobody else's deployment underneath it.
#
#   bash self-hosting/own.sh
#
# Why this exists. A hub's shared half — the family, the messenger, the
# calendar, both AI boxes, every memory — lives in a Convex backend. While that
# backend is somebody else's deployment, somebody else's switch decides whether
# the app works at all: a usage limit, a lapsed card, a service that shuts down.
# When it happens, the app is not broken and nothing is lost — it simply cannot
# read or write anything shared — and every screen waits on a black page for an
# answer that is never coming.
#
# Convex is open source, and its own command line can run that same backend as an
# ordinary program on this machine. That is what this script does:
#
#   1. the packages the hub is made of;
#   2. this machine's own backend, with the hub's schema and functions pushed
#      into it (no account, no card, no Docker — the CLI brings its own backend);
#   3. that backend started and left running;
#   4. the signing keys, without which the first sign-in fails on a deployment
#      that otherwise looks perfectly healthy;
#   5. the family password, and any AI keys this shell has;
#   6. the hub built against it and served.
#
# Afterwards the database is a file on this disk (`.convex/local/default/`), and
# there is no dashboard anywhere holding a limit over it. Run it again to start
# it again: the backend, the database, the signing keys and the password are all
# left exactly as they are.
#
# Options, all optional:
#
#   HUB_PASSWORD='…'        require the family password (see README → Getting in)
#   OWN_PORT=8080           where the hub is served
#   OWN_BACKEND_VERSION=…   pin the Convex backend version. The CLI refuses
#                           this flag without an account (see the README), so
#                           the Docker kit is the account-free route
#
# Point it at a copy of the family's existing data afterwards with
# `bunx convex import --replace-all <snapshot.zip>` — no flags needed, because
# the deployment this machine owns is the one every command here selects.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/.." && pwd)"
cd "$app"

port="${OWN_PORT:-8080}"
log_dir="$app/.vly-run"
log="$log_dir/own-backend.log"
config="$app/.convex/local/default/config.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "Bun is needed to run the hub: https://bun.sh"
command -v curl >/dev/null 2>&1 || die "curl is needed, to wait for the backend to answer."

# --------------------------------------------------------------- which backend
#
# `bunx convex` decides which backend to talk to from `.env.local` first, and a
# project that has ever been pointed at somebody else's deployment still says so
# there. So this script does not rely on the file at all:
#
#   * the deploy-key variables are taken out of the environment
#     (`CONVEX_DEPLOY_KEY` and friends) — those are what name a hosted
#     deployment without being asked, which is exactly what must not happen;
#   * `CONVEX_AGENT_MODE=anonymous` asks for the local backend by name: the one
#     this machine runs itself, which needs no account and no login;
#   * `CONVEX_DEPLOYMENT` is then given that deployment's own name, and a value
#     exported here beats a value in `.env.local`, because the file is loaded
#     without overriding what is already in the environment.
#
# Nothing in here writes to `.env.local`, so a project that is still pointed at
# another deployment keeps that address where it is until you decide otherwise.
UNSET_AMBIENT=(
  -u CONVEX_DEPLOY_KEY
  -u CONVEX_DEPLOYMENT_TOKEN
  -u CONVEX_DEPLOYMENT
  -u CONVEX_SELF_HOSTED_URL
  -u CONVEX_SELF_HOSTED_ADMIN_KEY
)

LOCAL_NAME=""

run_owned() {
  local prefix=(env "${UNSET_AMBIENT[@]}" CONVEX_AGENT_MODE=anonymous)
  if [ -n "$LOCAL_NAME" ]; then
    prefix+=("CONVEX_DEPLOYMENT=$LOCAL_NAME")
  fi
  "${prefix[@]}" bunx convex "$@"
}

# The deployment this project created on this machine, and the port it answers
# on: both read from the config the CLI wrote when it made it, never guessed.
read_config() {
  node -e 'const c=require(process.argv[1]);process.stdout.write(String(process.argv[2]==="port"?c.ports.cloud:c.deploymentName||""))' \
    "$config" "$1"
}

backend_name() { [ -f "$config" ] && read_config name || true; }
backend_port() { [ -f "$config" ] && read_config port || echo 3210; }

# ---------------------------------------------------------------- 1/6 packages
say "1/6  The packages the hub is made of"
bun install

# ------------------------------------------------- 2/6 this machine's backend
say "2/6  This machine's own Convex backend, and the hub's functions in it"
if [ -f "$config" ]; then
  LOCAL_NAME="$(backend_name)"
  echo "It already exists here ($LOCAL_NAME), and is left exactly as it is."
  echo "Whatever it holds now stays: this never wipes or replaces a backend."
else
  echo "There is none on this machine yet, so one is being made now."
  echo "No account, no card and no Docker: the Convex CLI brings its own backend."
fi

# `--once` pushes the schema and every function and then stops; it is the same
# work the watching process does on start, done here where its output can be
# read. The first run also downloads the backend program (about a minute).
mkdir -p "$log_dir"
if ! run_owned dev --once ${OWN_BACKEND_VERSION:+--local-backend-version "$OWN_BACKEND_VERSION"} >>"$log_dir/own-push.log" 2>&1; then
  printf '\nThe backend could not be started or pushed to. Its own output:\n\n'
  tail -n 20 "$log_dir/own-push.log" >&2 || true
  printf '\nIf it says a GLIBC or GLIBCXX version is not found, the backend program\n'
  printf 'this CLI fetched is newer than this machine. Its own flag for pinning an\n'
  printf 'older one is refused without a Convex account (see the README), so the\n'
  printf 'account-free route is the Docker kit:\n\n'
  printf '  bun run self-host   # docker, brings its own C library\n\n'
  exit 1
fi
LOCAL_NAME="$(backend_name)"
[ -n "$LOCAL_NAME" ] || die "No local deployment was created (see $log_dir/own-push.log)."

# ------------------------------------------------------- 3/6 started and left
say "3/6  Starting it, and leaving it running"
mkdir -p "$log_dir"
backend_url="http://127.0.0.1:$(backend_port)"
if curl -s -o /dev/null --max-time 3 "$backend_url/version"; then
  echo "A backend is already answering on $backend_url; leaving it alone."
else
  # The backend is a process, and this is the half that has to outlive the page.
  # `nohup`, so closing the terminal does not take the hub's database with it.
  nohup env "${UNSET_AMBIENT[@]}" CONVEX_AGENT_MODE=anonymous \
    "CONVEX_DEPLOYMENT=$LOCAL_NAME" \
    bunx convex dev >>"$log" 2>&1 &
  ready=""
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null --max-time 2 "$backend_url/version"; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ -z "$ready" ]; then
    printf '\nThe backend did not answer on %s. Its log:\n\n' "$backend_url"
    tail -n 20 "$log" >&2 || true
    exit 1
  fi
  echo "Answering on $backend_url, and its output goes to $log"
fi

# ------------------------------------------------------------ 4/6 signing keys
say "4/6  The signing keys, without which nobody can sign in"
# A deployment issues its own session tokens, so one without `JWT_PRIVATE_KEY`
# and `JWKS` answers every query, looks healthy, and then throws on the first
# sign-in. It runs once and does nothing after that; `--force` replaces them,
# which signs every device out.
bun scripts/generate-auth-keys.mjs --local

# ------------------------------------------------- 5/6 password, and AI keys
say "5/6  The family password, and any AI keys this shell has"
if [ -n "${HUB_PASSWORD:-}" ]; then
  run_owned env set -- HUB_PASSWORD "$HUB_PASSWORD"
  echo "Set: a device must answer it before it can see anything shared."
else
  echo "Not set, so the hub opens the way it is configured to — guests-only,"
  echo "no password, as it was before a password existed. To require one:"
  echo "  HUB_PASSWORD='the-password-you-share' bash self-hosting/own.sh"
fi

# Every AI key exported in this shell is copied to this machine's backend, so
# the assistant and the builder answer with a real model instead of only the
# free public systems. Only names are ever printed; the values go straight to
# the backend and are not written down here.
for name in \
  XAI_API_KEY GROK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY \
  GOOGLE_API_KEY GEMINI_API_KEY GROQ_API_KEY DEEPSEEK_API_KEY \
  OPENROUTER_API_KEY MISTRAL_API_KEY TOGETHER_API_KEY \
  TAVILY_API_KEY BRAVE_API_KEY \
  LIVEKIT_API_KEY LIVEKIT_API_SECRET DAYTONA_API_KEY; do
  value="$(printenv "$name" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    run_owned env set -- "$name" "$value"
  fi
done

# And the keys the deployment this project was pointed at already had, when
# there is one that still answers: the hub's own script reads them there and
# writes only the ones this backend has not got, printing nothing but names.
bun scripts/sync-dev-ai-keys.mjs ||
  echo "No keys were copied from another deployment (none reachable, or it has none)."

# ------------------------------------------------------------- 6/6 built and served
say "6/6  Building the hub against this machine's backend, and serving it"
# Baked in at build time, on purpose: the browser is what connects, so the
# address has to be in the JavaScript. This one answer is the whole difference
# between the hub running here and the hub running on somebody's limit.
export VITE_CONVEX_URL="$backend_url"
bun run build

printf '\nThe hub is at http://localhost:%s\n' "$port"
printf 'Its backend is %s, its database is %s\n' "$backend_url" "$app/.convex/local/default"
printf 'Back the hub up by copying that folder; its log is %s\n' "$log"
printf 'Ctrl-C stops the page. The backend keeps running, so starting again is instant.\n\n'

exec bunx vite preview --port "$port" --strictPort --host 127.0.0.1
