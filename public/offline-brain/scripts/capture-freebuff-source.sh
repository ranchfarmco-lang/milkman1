#!/usr/bin/env bash
# Unpack the Freebuff source tree (Apache-2.0) — the reference implementation
# of the model -> reasoning -> agents -> tools -> files -> terminal -> review
# loop that everything else in this package reproduces.
#
# The archive travels *inside* the package as source/freebuff-source.zip, so a
# downloaded copy unpacks it here and downloads nothing. The fetch at the bottom
# is a fallback for a copy that somehow lost the archive, not the normal path.
. "$(dirname "$0")/lib.sh"

SRC="$BRAIN_ROOT/source"
mkdir -p "$SRC"
ARCHIVE="$SRC/freebuff-source.zip"

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
# treating it as "present" would fail here instead of falling back below.
if [ -d "$SRC/freebuff" ]; then
  ok "freebuff source already unpacked at source/freebuff"
elif [ -s "$ARCHIVE" ]; then
  log "unpacking source/freebuff-source.zip from this package"
  unpack_archive "$ARCHIVE" "$SRC" ||
    die "could not unpack $ARCHIVE (unzip or python3 is needed)"
  [ -d "$SRC/freebuff" ] || die "$ARCHIVE did not unpack to source/freebuff"
  ok "unpacked to source/freebuff — nothing was downloaded"
else
  [ -e "$ARCHIVE" ] && rm -f "$ARCHIVE"
  warn "source/freebuff-source.zip is missing or empty in this copy; fetching the tree instead"
  TARBALL="$SRC/freebuff-source.tar.gz"
  curl -sSL -o "$TARBALL" \
    "https://codeload.github.com/CodebuffAI/freebuff/tar.gz/refs/heads/main"
  [ -s "$TARBALL" ] || die "download failed"
  tar xzf "$TARBALL" -C "$SRC"
  mv "$SRC/freebuff-main" "$SRC/freebuff"
  ok "extracted to source/freebuff"
fi

# Dependencies used by the source tree itself. This is the one step here that
# needs the network, and it is optional: the tree can be read without it.
if have bun; then
  log "installing freebuff source dependencies with bun (this can take a while)"
  ( cd "$SRC/freebuff" && bun install ) || warn "bun install failed; run it manually in source/freebuff"
else
  warn "bun not found; run 'bun install' inside source/freebuff to install its dependencies"
fi

ok "freebuff source in place"
