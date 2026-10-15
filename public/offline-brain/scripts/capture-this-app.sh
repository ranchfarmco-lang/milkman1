#!/usr/bin/env bash
# Unpack *this app* — the hub's own source, every file of it — from the archive
# that ships inside this package.
#
# The brain in this folder is the system that reproduces an AI coding assistant;
# `source/app` is the hub itself, the web interface and the backend that serves
# it: every page, every Convex function, the shell, the desktop browser, the
# native host, NOVA OS, the scripts and the docs, exactly as it stood when this
# package was built.
#
# The archive travels *inside* the package as source/this-app-source.zip, so a
# downloaded copy unpacks it here and downloads nothing. There is deliberately no
# fallback fetch: the app changes, so fetching it would land a *different*
# version beside this package's installers and docs. If the archive is missing,
# take a fresh copy from the hub's own Control Room instead — it builds every
# download from the live app.
. "$(dirname "$0")/lib.sh"

SRC="$BRAIN_ROOT/source"
ARCHIVE="$SRC/this-app-source.zip"
DEST="$SRC/app"

unpack_archive() { # unpack_archive <archive> <destination>
  if have unzip; then
    unzip -q -o "$1" -d "$2"
  elif have python3; then
    python3 -m zipfile -e "$1" "$2"
  else
    return 1
  fi
}

# `-s`, not `-f`: an archive that exists but is empty is a failed unpack, and
# treating it as "present" would fail here rather than saying why.
if [ -d "$DEST" ]; then
  ok "this app's source is already unpacked at source/app"
elif [ -s "$ARCHIVE" ]; then
  log "unpacking source/this-app-source.zip from this package"
  unpack_archive "$ARCHIVE" "$SRC" ||
    die "could not unpack $ARCHIVE (unzip or python3 is needed)"
  [ -d "$DEST" ] || die "$ARCHIVE did not unpack to source/app"
  ok "unpacked to source/app — nothing was downloaded"
else
  warn "source/this-app-source.zip is missing or empty in this copy"
  warn "This is the hub's own app, so there is nowhere to fetch it from: take a"
  warn "fresh copy of the whole package from the hub's Offline Brain page, or"
  warn "the app alone from its Control Room (Tools & downloads)."
  exit 1
fi

# What it is and the three ways to run it, printed rather than assumed.
cat <<'NOTES'

The hub's own app is at source/app — the web interface plus the Convex
functions behind it. Nothing here needs it for the brain to work; it is in the
package because the package is meant to be the whole system, and a copy you
own should be a copy you can read and run.

  Read it            start with source/app/README.md and DEPLOY.md

  Run it here        cd source/app
                     bun install
                     bun run own
                     # its own Convex backend on this machine, its own database
                     # under .convex/local/default/, nothing outside it:
                     # self-hosting/README.md is the runbook

  Run it with Docker cd source/app   # needs the Docker kit from the Control
                     # Room's backup, which builds and serves the same app

To read the app without a terminal: its own Control Room serves every file as
text, and the AI Builder can read and change it in place.

The two generated halves of its own snapshot (src/convex/self_source.ts and
public/self-source.json) are already in the archive, so the copy types, builds
and serves without running anything first. Regenerate them after editing with:

  cd source/app && bun run snapshot:self
NOTES

ok "the hub's own app is in place"
