#!/usr/bin/env bash
# Put a snapshot of the family's data into the backend this machine owns.
#
#   bun run restore -- backups/convex-snapshot-neat-crane-777-2026-10-11.zip
#
# Why this is a script and not just one import command. `bunx convex import`
# picks a deployment from `.env.local`, and on a machine that has ever been
# pointed at somebody else's deployment that is still what it would pick. An
# import is not always harmless: `--replace-all` clears whatever it is aimed at
# before it writes, so aiming it at the wrong backend is not a small mistake.
# This aims it at the local backend explicitly, by name, with every ambient
# deploy key taken out of the environment first — and it refuses to run at all
# when that backend is not answering, because "nothing answered" is exactly when
# a wrong aim would go unnoticed.
#
# The snapshot has to be a Convex export — `bunx convex export` writes one, and
# `backups/` holds one already. Afterwards the accounts carried over still need
# the signing keys and the family password to sign in: `bun run own` sets both,
# and does not touch the data.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/.." && pwd)"
cd "$app"

config="$app/.convex/local/default/config.json"
snapshot="${1:-}"

# `%b`, so a message can lay itself out with `\n` and the caller stays readable.
die() { printf '\n%b\n' "$*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "Bun is needed: https://bun.sh"
command -v curl >/dev/null 2>&1 || die "curl is needed, to check the backend is answering."

[ -n "$snapshot" ] ||
  die "Which snapshot? For example:\n  bash self-hosting/restore.sh backups/convex-snapshot-neat-crane-777-2026-10-11.zip"
[ -f "$snapshot" ] || die "No such file: $snapshot"
[ -f "$config" ] ||
  die "There is no backend on this machine yet. Run \`bun run own\` once — it makes one — and then this again."

name="$(node -e 'process.stdout.write(require(process.argv[1]).deploymentName||"")' "$config")"
port="$(node -e 'process.stdout.write(String(require(process.argv[1]).ports?.cloud||3210))' "$config")"
[ -n "$name" ] || die "$config does not name a deployment; run \`bun run own\` to make one properly."

# The check that keeps a wrong aim from going unnoticed: the backend has to be
# up, on the port the CLI recorded for it, right now.
curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$port/version" ||
  die "The backend on this machine is not answering on 127.0.0.1:$port.\nStart it with \`bun run own\` — its backend keeps running after you stop the page."

printf '\nImporting %s\ninto %s on 127.0.0.1:%s — this replaces everything that backend holds now.\n\n' \
  "$snapshot" "$name" "$port"

env -u CONVEX_DEPLOY_KEY -u CONVEX_DEPLOYMENT_TOKEN -u CONVEX_DEPLOYMENT \
  -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
  CONVEX_AGENT_MODE=anonymous "CONVEX_DEPLOYMENT=$name" \
  bunx convex import --replace-all -y "$snapshot"

printf '\nDone. Sign-in needs two more things, and both are on this backend already\n'
printf 'if you have run `bun run own` since making it: the signing keys\n'
printf '(`bun scripts/generate-auth-keys.mjs --local`) and the family password\n'
printf '(`HUB_PASSWORD=… bun run own`). Then sign in as before.\n\n'
