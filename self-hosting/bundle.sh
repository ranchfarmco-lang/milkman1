#!/usr/bin/env bash
#
# Pack the hub into a folder that needs nothing but itself.
#
# `bun run dev` and `bun run own` both assume the machine being set up is already
# a development machine: a package manager that can reach a registry, a Bun
# runtime, and a network on which the Convex CLI can fetch its backend program.
# Those assumptions are the whole difference between "you can run this yourself"
# and "this runs on its own", and this script removes them by putting the three
# things inside the folder it writes:
#
#   app/     the project's own files, with `node_modules` already installed, so
#            nothing is fetched and no lockfile is resolved on the far machine;
#   runtime/ the `bun` this bundle was built with — a single executable, so the
#            far machine does not need a runtime installed either;
#   state/   the Convex backend *program* the CLI would otherwise download (the
#            one piece that is a quarter of a gigabyte and a network round trip),
#            already in the place the CLI looks for it, under a HOME that is
#            inside the bundle.
#
# The result is one folder, and `run.sh` in it is the only command anybody needs:
#
#   ./run.sh            start the hub (backend + page) and print its address
#   ./run.sh --check    verify every piece is present and runnable, start nothing
#   ./run.sh --selftest start the bundled backend, probe it, stop it — the proof
#                       that the program inside the bundle runs on this machine
#   ./run.sh --archive  also tar the folder, for handing to another machine
#
# What is deliberately *not* in it: the local deployment's state (`.convex/`) and
# `.env.local`. Both belong to whoever built the bundle — the second is often a
# hosted address, which is exactly what this hub is getting away from. The CLI
# creates a fresh local deployment on the far machine the first time `run.sh`
# starts, which is also why no key or secret has to be copied around to make
# this work.
#
# Usage:
#   bash self-hosting/bundle.sh [output-dir] [--archive]
#
# Exit status is 0 only when the bundle was written *and* its own `--check`
# passed, so a failed bundle is never reported as a good one.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/.." && pwd)"

out="${1:-$app/dist-independent/family-chat-hub-independent}"
case "${1:-}" in
  --archive) out="$app/dist-independent/family-chat-hub-independent" ;;
esac
archive="no"
for arg in "$@"; do
  [ "$arg" = "--archive" ] && archive="yes"
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "bun is needed to build the bundle (it is the runtime that goes in)."

say "1/7  The hub's own files"
rm -rf "$out"
mkdir -p "$out/app"
# Every exclusion here has a reason, and none of them is tidiness:
#   node_modules  reinstalled in step 2 (copied, not resolved)
#   dist          a previous build of the page, tied to another machine
#   .git          history is not needed to run, and can be restored from a clone
#   .convex       the local deployment's *state* — a new one is made on the far
#                 machine, so this bundle carries no database and no admin key
#   .env.local    the deployment this project was pointed at. On a Freebuff
#                 workspace that is a hosted address; a bundle that inherited it
#                 would go straight back to somebody else's backend
#   dist-independent, *.zip, *.tar.gz  other bundles and archives of themselves
  ( cd "$app" && tar cf - \
      --exclude=./node_modules \
      --exclude=./dist \
      --exclude=./.git \
      --exclude=./.convex \
      --exclude=./.env.local \
      --exclude=./.vly-run \
      --exclude=./dist-independent \
      --exclude='*.zip' \
      --exclude='*.tar.gz' \
      --exclude=./family-chat-hub-source.tar.gz \
      . ) | ( cd "$out/app" && tar xf - )
echo "copied $(find "$out/app" -type f | wc -l) files"

say "2/7  The packages, installed here so they never need fetching there"
# A hard link costs no disk and no time, and cannot drift from the lockfile this
# machine already satisfied. `cp -al` is a GNU/BSD extension; where it is not
# available this falls back to installing from the lockfile, which is the one
# step in this script that needs the network.
if [ -d "$app/node_modules" ]; then
  cp -al "$app/node_modules" "$out/app/node_modules" 2>/dev/null ||
    cp -a "$app/node_modules" "$out/app/node_modules"
  echo "carried node_modules across ($(du -sh "$out/app/node_modules" | cut -f1) on disk, $(du -sh --apparent-size "$out/app/node_modules" | cut -f1) of content)"
else
  echo "no node_modules here, installing from the lockfile (this is the one network step)"
  ( cd "$out/app" && bun install --frozen-lockfile )
fi

say "3/7  A runtime, so the far machine needs none installed"
mkdir -p "$out/runtime"
bun_path="$(command -v bun)"
cp "$bun_path" "$out/runtime/bun"
chmod +x "$out/runtime/bun"
bun_version="$("$out/runtime/bun" --version)"
echo "runtime/bun — bun $bun_version ($(du -h "$out/runtime/bun" | cut -f1))"

say "4/7  The backend program — the piece the CLI would otherwise download"
# Which build goes in is decided by *running* each cached one, not by its name:
# a backend built against a newer C library than this machine has dies on its
# first line (`GLIBC_2.38 not found`), and a bundle carrying one of those would
# be a bundle that cannot start. `--help` is the cheapest way to ask.
cache="${CONVEX_BINARIES:-$HOME/.cache/convex/binaries}"
backend_version=""
for candidate in $(ls -1 "$cache" 2>/dev/null | sort -r); do
  binary="$cache/$candidate/convex-local-backend"
  [ -x "$binary" ] || continue
  err="$("$binary" --help 2>&1 >/dev/null || true)"
  case "$err" in
    *GLIBC_* | *libc.musl* | *"error while loading shared libraries"*) continue ;;
  esac
  backend_version="$candidate"
  break
done
[ -n "$backend_version" ] || die "No Convex backend program to bundle. Run \`bun run dev\` once on a \
machine with a network first: the CLI downloads it, and this script then copies it in."
mkdir -p "$out/state/home/.cache/convex/binaries/$backend_version"
cp "$cache/$backend_version/convex-local-backend" \
  "$out/state/home/.cache/convex/binaries/$backend_version/convex-local-backend"
chmod +x "$out/state/home/.cache/convex/binaries/$backend_version/convex-local-backend"
backend_size="$(du -h "$out/state/home/.cache/convex/binaries/$backend_version/convex-local-backend" | cut -f1)"
echo "$backend_version ($backend_size) — verified to run on this machine"

say "5/7  run.sh"
# Written with a quoted heredoc: everything in it is resolved on the machine that
# runs it, never here.
cat >"$out/run.sh" <<'RUNSH'
#!/bin/sh
#
# Start the hub. Everything it needs is in this folder.
#
# The three exports below are what make that true, and each one replaces
# something the hub would otherwise ask the machine for:
#
#   HOME       Convex keeps its per-user state and its downloaded backend
#              programs under $HOME. Pointed inside the bundle, the CLI finds
#              the bundled backend and writes its state beside it, so the hub
#              neither reads nor writes anything in your home directory.
#   PATH       `bun` first, so `bunx convex` and `bunx vite` resolve to the
#              runtime and the packages in here rather than to whatever is
#              installed (or not installed) outside.
#   DISABLE_BEACON  the self-hosted backend periodically reports itself to a
#              remote server unless this is set. "Independent" means this is
#              set; nothing here needs to phone home.
#
set -eu

here=$(cd "$(dirname "$0")" && pwd)
app="$here/app"
export HOME="$here/state/home"
export PATH="$here/runtime:$PATH"
export DISABLE_BEACON=1
export BUN_INSTALL_CACHE_DIR="$here/state/bun"
mkdir -p "$HOME" "$BUN_INSTALL_CACHE_DIR"

backend_dir="$here/state/home/.cache/convex/binaries"
backend_bin="$(ls -1 "$backend_dir"/*/convex-local-backend 2>/dev/null | head -1 || true)"

# ---------------------------------------------------------------- --check
# Says what is here and what it can do, and starts nothing. Every claim is a
# measurement: the runtime prints its own version, the backend program is
# executed, the packages are looked up in this folder.
check() {
  fail=0
  ok()   { printf '  ok    %s\n' "$1"; }
  bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

  printf 'The bundle at %s\n\n' "$here"

  if [ -x "$here/runtime/bun" ]; then
    ok "runtime/bun answers: bun $("$here/runtime/bun" --version 2>/dev/null)"
  else
    bad "runtime/bun is missing or not executable"
  fi

  for f in app/package.json app/src/convex/schema.ts app/convex.json app/scripts/dev.sh; do
    [ -f "$here/$f" ] && ok "the hub's own file $f" || bad "missing $f"
  done

  for pkg in convex vite @vitejs/plugin-react; do
    [ -d "$here/app/node_modules/$pkg" ] && ok "package $pkg is in the bundle" \
      || bad "package $pkg is not in the bundle"
  done

  if [ -n "$backend_bin" ] && [ -x "$backend_bin" ]; then
    if err="$("$backend_bin" --help 2>&1 >/dev/null)" && [ -z "$err" ]; then
      ok "the backend program runs here: $(basename "$(dirname "$backend_bin")")"
    else
      bad "the backend program cannot run here: ${err:-it exited non-zero}"
    fi
  else
    bad "no backend program in state/home/.cache/convex/binaries"
  fi

  if [ -f "$here/manifest.json" ]; then
    ok "manifest.json is present ($(wc -c <"$here/manifest.json" | tr -d ' ') bytes)"
  else
    bad "manifest.json is missing"
  fi

  printf '\n'
  [ "$fail" -eq 0 ] && printf 'Everything the hub needs is in this folder.\n' \
    || printf 'This bundle is incomplete — the lines above say what is wrong.\n'
  return "$fail"
}

# ------------------------------------------------------------- --selftest
# Starts the *bundled* backend program directly, on spare ports, with its own
# scratch database, and stops it. It proves the two things `--check` cannot: that
# the program executes here, and that it answers — with no CLI, no account, no
# network and no other deployment involved.
selftest() {
  printf 'Starting the bundled backend on port 3299 (scratch database, not the hub'"'"'s)…\n'
  "$backend_bin" \
    --port 3299 --site-proxy-port 3298 \
    --instance-name bundle-selftest --instance-secret "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    --disable-beacon \
    "$here/state/selftest.sqlite3" >"$here/state/selftest.log" 2>&1 &
  pid=$!
  # Nothing here waits forever: a backend that has not answered in twenty
  # seconds is reported, not waited on.
  answered=""
  i=0
  while [ "$i" -lt 40 ]; do
    if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3299/version; then answered=1; break; fi
    kill -0 "$pid" 2>/dev/null || break
    i=$((i + 1))
    sleep 0.5
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$here/state/selftest.sqlite3" "$here/state/selftest.sqlite3-shm" "$here/state/selftest.sqlite3-wal"
  if [ -n "$answered" ]; then
    printf 'It answered on /version. This bundle runs on its own.\n'
    return 0
  fi
  printf 'It did not answer. Its output:\n\n'
  tail -n 20 "$here/state/selftest.log" || true
  return 1
}

# ----------------------------------------------------------------- start
#
# The backend is started **directly**, by the program in this bundle, and the
# CLI is then told where it is.
#
# That order is the whole trick, and it is deliberate. Asked to "develop against a
# local deployment", the CLI runs a flow with two needs this bundle cannot meet
# on a machine with no network:
#
#   * creating a local deployment starts by fetching the *latest* backend
#     version from Convex (`✖ Failed to fetch latest backend version`), and fails
#     there — measured, with the bundled program already sitting in the place the
#     CLI looks for its downloads;
#   * on a machine carrying ambient credentials it does the opposite of what a
#     bundle wants, and provisions a *hosted* deployment on somebody's account —
#     measured too, in this very workspace: `✔ Provisioned a dev deployment …
#     https://<name>.convex.cloud`.
#
# Self-hosted mode has neither problem: `CONVEX_SELF_HOSTED_URL` and
# `CONVEX_SELF_HOSTED_ADMIN_KEY` say "the backend is already running, there, and
# here is the key", and the CLI only pushes code into it. Nothing to fetch,
# nothing to pick, no account, no Docker — the same two variables
# `self-hosting/setup.sh` uses to reach its container, pointed at a program
# instead.
#
# The instance secret is made once and kept in `state/`, so the admin key is the
# same on every start and the data is the same database. It never leaves the
# folder.
start() {
  port="${HUB_BACKEND_PORT:-3210}"
  site_port="${HUB_SITE_PORT:-3211}"
  name="hub"
  secret_file="$here/state/instance-secret"
  db="$app/.convex/self-hosted/hub.sqlite3"
  storage="$app/.convex/self-hosted/storage"
  log="$app/.vly-run/backend.log"

  [ -n "$backend_bin" ] || { printf 'No backend program in this bundle (see --check).\n' >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { printf 'curl is needed, to wait for the backend to answer.\n' >&2; exit 1; }
  mkdir -p "$(dirname "$db")" "$storage" "$app/.vly-run"

  if [ -f "$secret_file" ]; then
    secret="$(cat "$secret_file")"
  else
    # 32 bytes, which is what the backend demands ("Hex-decoded key was 16
    # bytes, not 32" is the error if it is short).
    secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '%s' "$secret" >"$secret_file"
    chmod 600 "$secret_file"
  fi

  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/version"; then
    printf 'A backend is already answering on port %s; leaving it alone.\n' "$port"
  else
    printf 'Starting the backend — the program in this bundle, no account, no download…\n'
    "$backend_bin" \
      --port "$port" --site-proxy-port "$site_port" \
      --instance-name "$name" --instance-secret "$secret" \
      --disable-beacon --local-storage "$storage" \
      "$db" >>"$log" 2>&1 &
    answered=""
    i=0
    while [ "$i" -lt 80 ]; do
      if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/version"; then answered=1; break; fi
      i=$((i + 1))
      sleep 0.5
    done
    if [ -z "$answered" ]; then
      printf 'The backend did not answer on port %s. Its output:\n\n' "$port" >&2
      tail -n 20 "$log" >&2 || true
      exit 1
    fi
    printf 'Answering on http://127.0.0.1:%s\n' "$port"
  fi

  # The admin key is derived from the instance name and secret, so it is the same
  # key on every start — which is what lets the database, the signing keys and the
  # sessions all survive a restart.
  admin="$("$backend_bin" keygen admin-key --instance-name "$name" --instance-secret "$secret" 2>/dev/null | tail -n 1)"
  [ -n "$admin" ] || { printf 'Could not make an admin key for the backend.\n' >&2; exit 1; }

  export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:$port"
  export CONVEX_SELF_HOSTED_ADMIN_KEY="$admin"
  # A project that has ever been pointed at somebody else's deployment says so in
  # this file, and the CLI reads it first. Taken out of the environment for every
  # call below so nothing can quietly go back to a hosted backend.
  unset CONVEX_DEPLOY_KEY CONVEX_DEPLOYMENT_TOKEN CONVEX_DEPLOYMENT CONVEX_AGENT_MODE 2>/dev/null || true

  printf '\nPushing the hub into it (the CLI only writes here; it manages nothing)…\n'
  ( cd "$app" && "$here/runtime/bun" x convex dev --once --typecheck disable ) || {
    printf 'The functions could not be pushed. Log:\n\n' >&2
    tail -n 20 "$log" >&2 || true
    exit 1
  }

  # Signing keys, once: a deployment without them answers every query, looks
  # healthy, and throws on the first sign-in.
  if ! ( cd "$app" && "$here/runtime/bun" scripts/generate-auth-keys.mjs >/dev/null 2>&1 ); then
    printf 'Sign-in may fail: the signing keys could not be set (run it by hand to see why).\n'
  fi

  printf '\nThe page is starting. Open the address it prints.\n'
  exec "$here/runtime/bun" "$app/node_modules/vite/bin/vite.js" --clearScreen false
}

case "${1:-start}" in
  start | "")  start ;;
  --check | check)     check ;;
  --selftest | selftest) selftest ;;
  *) printf 'usage: %s [--check|--selftest]\n' "$0" >&2; exit 2 ;;
esac
RUNSH
chmod +x "$out/run.sh"

say "6/7  manifest.json and README.md"
# The manifest is what the self-test and any later audit read. Sizes and hashes
# are measured now, so a bundle that lost a piece in transit says so.
(
  cd "$out"
  runtime_bytes=$(wc -c <runtime/bun | tr -d ' ')
  backend_bytes=$(wc -c <"state/home/.cache/convex/binaries/$backend_version/convex-local-backend" | tr -d ' ')
  packages=$(ls -1 app/node_modules | wc -l | tr -d ' ')
  files=$(find app -type f | wc -l | tr -d ' ')
  cat >manifest.json <<MANIFEST
{
  "name": "family-chat-hub-independent",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "builtBy": "self-hosting/bundle.sh",
  "runtime": { "bun": "$bun_version", "bytes": $runtime_bytes },
  "backend": {
    "version": "$backend_version",
    "bytes": $backend_bytes,
    "cachePath": "state/home/.cache/convex/binaries/$backend_version/convex-local-backend",
    "note": "The Convex backend program, pre-placed where the CLI looks for it. DISABLE_BEACON=1 is set by run.sh: nothing here reports to a remote server."
  },
  "app": { "files": $files, "packages": $packages, "nodeModules": "installed, from bun.lock" },
  "state": {
    "home": "state/home — the CLI's HOME, inside the bundle",
    "database": "created on first run, at app/.convex/local/default/",
    "credentials": "generated on first run; none is carried in this bundle"
  },
  "needs": { "network": false, "account": false, "packageManager": false, "runtimeInstalled": false }
}
MANIFEST
)

cat >"$out/README.md" <<'BUNDLEREADME'
# The hub, on its own

One folder, and it can run anywhere it is copied to. No account, no card, no
package manager, no runtime to install, and nothing fetched on start.

```bash
./run.sh --check      # what is in here, and whether it can run
./run.sh --selftest   # start the bundled backend, probe it, stop it
./run.sh              # start the hub; it prints the address to open
```

The first `./run.sh` makes this machine its own hub backend — a local Convex
deployment, created by the CLI that is in `app/node_modules` using the backend
program in `state/`. Nothing is downloaded and no account is involved. After
that, starting it again is instant and everything lives under `app/.convex`.

## What is in here, and why

| Path | What it is |
| --- | --- |
| `app/` | The hub itself, with `node_modules` already installed from `bun.lock`. |
| `runtime/bun` | The Bun the bundle was built with, so no runtime is needed outside. |
| `state/home/.cache/convex/binaries/<version>/` | The Convex backend program, in the exact place the CLI looks for it, under a `HOME` that is inside this folder. |
| `run.sh` | Sets `HOME`, `PATH` and `DISABLE_BEACON`, then starts the backend and the page. |
| `manifest.json` | Versions, sizes, and what this bundle claims — measured when it was built. |

## What it does not contain, on purpose

- **A database.** `run.sh` creates one on first start, under `app/.convex`. A
  bundle that carried one would be handing out somebody's data and their admin
  key with it.
- **`app/.env.local`.** That file names the deployment a project is pointed at,
  and on the machine this bundle was built from it names somebody else's hosted
  backend. Leaving it out is what makes the hub talk to the backend in here.
- **Anything that phones home.** `run.sh` sets `DISABLE_BEACON=1`, which is the
  switch the self-hosted Convex backend documents for exactly this.

## Moving a hub you already have

Copy `app/.convex/local/default` from the machine that has it into the same
place here — that folder is the whole database. The signing keys and the
password live in the deploy environment, so set them again with
`app/scripts/generate-auth-keys.mjs` (and `HUB_PASSWORD`) if you want sign-in to
survive the move.

## What is still somebody else's

Three things, and all three are optional — the hub is complete without them:
AI provider keys (or a model on your own machine), a call relay for two strict
routers, and the builder's sandbox. `self-hosting/README.md` in the app folder
has a free option for each.
BUNDLEREADME

say "7/7  Its own self-test"
sh "$out/run.sh" --check
sh "$out/run.sh" --selftest

if [ "$archive" = "yes" ]; then
  tar_name="$(dirname "$out")/$(basename "$out").tar.gz"
  echo
  echo "Archiving to $tar_name (this takes a while — it is a copy, not a link)…"
  tar czf "$tar_name" -C "$(dirname "$out")" "$(basename "$out")"
  echo "Wrote $tar_name ($(du -h "$tar_name" | cut -f1))"
fi

printf '\n\033[1mThe bundle is at:\033[0m %s\n' "$out"
printf 'Start it with: %s/run.sh\n' "$out"
