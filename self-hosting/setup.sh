#!/usr/bin/env bash
# Put the whole hub on a machine you control, in containers.
#
#   HUB_PASSWORD='the-password-you-share' bash self-hosting/setup.sh
#
# What it does, in order:
#   1. makes the stack's `.env` (an instance secret, and the addresses) if there
#      is not one already;
#   2. starts the backend and its dashboard, and waits for the backend to answer;
#   3. makes an admin key and points this project at that backend;
#   4. installs the app's packages;
#   5. makes the signing keys and sets the family password;
#   6. pushes the hub's schema and functions into the backend;
#   7. builds the app against it and serves it.
#
# Nothing here talks to Freebuff or to any hosted service. When it finishes the
# hub runs on this machine, and nothing outside it can switch it off. It needs
# Docker and Bun.
#
# `self-hosting/own.sh` is the other road to the same place, and it needs no
# Docker at all: the Convex CLI runs the backend as an ordinary program. Use
# that one on a laptop, this one on a server that stays on.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/.." && pwd)"
cd "$app"

# The stack's own settings, which `docker compose` reads from an `.env` beside
# the compose file. Created once and then left alone: regenerating the instance
# secret would sign every device out.
env_file="$here/.env"
compose=(docker compose --env-file "$env_file" -f "$here/docker-compose.yml")

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# `%b`, so a message can lay itself out with `\n` and the caller stays readable.
die() { printf '\n%b\n' "$*" >&2; exit 1; }

# A deployment named in the environment takes precedence over the self-hosted
# one this script sets up below, and a deploy key names one without being asked.
# Neither can be allowed to win here, so both are cleared before anything runs;
# `.env.local`, written in step 3, is then what every command below reads.
unset CONVEX_DEPLOY_KEY CONVEX_DEPLOYMENT_TOKEN CONVEX_DEPLOYMENT \
  CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY

command -v docker >/dev/null 2>&1 || die "Docker is needed: https://docs.docker.com/engine/install/"
command -v bun >/dev/null 2>&1 || die "Bun is needed: https://bun.sh"
command -v curl >/dev/null 2>&1 || die "curl is needed, to wait for the backend to answer."

hub_url="${VITE_CONVEX_URL:-http://127.0.0.1:3210}"

say "1/7  The stack's settings"
if [ -f "$env_file" ]; then
  echo "$env_file is already there, and is left as it is."
else
  secret="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat >"$env_file" <<EOF
# Written by self-hosting/setup.sh. Holds the instance secret; keep it private.
INSTANCE_SECRET=$secret
CONVEX_CLOUD_ORIGIN=$hub_url
CONVEX_SITE_ORIGIN=${VITE_CONVEX_URL_SITE:-http://127.0.0.1:3211}
VITE_CONVEX_URL=$hub_url
HUB_PORT=${HUB_PORT:-8080}
HUB_PASSWORD=${HUB_PASSWORD:-}
EOF
  echo "Wrote $env_file — the instance secret in it is what keeps sessions valid across restarts."
  echo "If other devices reach this machine by name (a VPN address, say), put that"
  echo "name in VITE_CONVEX_URL there and run this again before the first build."
fi

say "2/7  Starting the backend (database + functions) and its dashboard"
"${compose[@]}" up -d backend dashboard

echo "Waiting for it to answer..."
ready=""
for _ in $(seq 1 90); do
  if curl -fsS "$hub_url/version" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || die "The backend did not come up. Its log:\n  ${compose[*]} logs backend"

say "3/7  Making an admin key and pointing this project at the backend"
admin_key="$("${compose[@]}" exec -T backend ./generate_admin_key.sh | tr -d '\r' | tail -n 1)"
[ -n "$admin_key" ] || die "Could not read the admin key from the backend container."

# The CLI reads these two to decide which deployment to talk to, and the app's
# dev server reads VITE_CONVEX_URL. As before, the previous file is kept.
if [ -f .env.local ] && [ ! -f .env.local.before-self-host ]; then
  cp .env.local .env.local.before-self-host
  echo "Kept the old .env.local as .env.local.before-self-host"
fi
cat >.env.local <<EOF
# Written by self-hosting/setup.sh — the backend on this machine.
CONVEX_SELF_HOSTED_URL=$hub_url
CONVEX_SELF_HOSTED_ADMIN_KEY=$admin_key
VITE_CONVEX_URL=$hub_url
EOF

say "4/7  Installing the app's packages"
bun install

say "5/7  Signing keys and the family password"
# A deployment without these answers every query, looks healthy, and then throws
# on the first sign-in, so this is the step that is easy to skip and hard to read.
bun scripts/generate-auth-keys.mjs
if [ -n "${HUB_PASSWORD:-}" ]; then
  bunx convex env set -- HUB_PASSWORD "$HUB_PASSWORD"
  echo "Family password set from HUB_PASSWORD."
else
  echo "No HUB_PASSWORD given, so the hub opens without a password, as it does by default."
  echo "To require one:  HUB_PASSWORD='the-password-you-share' bash self-hosting/setup.sh"
fi

say "6/7  Pushing the hub's functions into the backend"
bunx convex dev --once

say "7/7  Building and serving the app against it"
"${compose[@]}" up -d --build hub

printf '\nThe hub is at http://localhost:%s\n' "${HUB_PORT:-8080}"
printf 'The backend is %s and its dashboard is http://127.0.0.1:6791\n' "$hub_url"
printf 'Its data lives in the convex-data volume: `%s down` keeps it, `%s down -v` wipes it.\n' \
  "${compose[*]}" "${compose[*]}"
printf 'To copy the family'\''s existing data in, see backups/README.md.\n\n'
