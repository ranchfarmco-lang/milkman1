#!/usr/bin/env bash
# Filesystem tooling: read/write/edit, traversal, search, archive and sync.
. "$(dirname "$0")/lib.sh"

# ---- core file operations ---------------------------------------------------
have find  || pkg_install findutils findutils
have tree  || pkg_install tree tree
have file  || pkg_install file file
have stat  || pkg_install coreutils coreutils

# ---- fast search / traversal ------------------------------------------------
have rg    || pkg_install ripgrep ripgrep
have fd    || pkg_install fd-find fd
have fzf   || pkg_install fzf fzf
have sd    || { have brew && brew install sd || warn "sd optional (stream editing)"; }
have moreutils || warn "moreutils optional (sponge, vipe, chronic)"

# ---- archives / compression -------------------------------------------------
have tar   || pkg_install tar tar
have unzip || pkg_install unzip unzip
have zip   || pkg_install zip zip
have zstd  || pkg_install zstd zstd
have xz    || pkg_install xz-utils xz
have 7z    || pkg_install p7zip-full p7zip || true

# ---- transfer / sync / fetch ------------------------------------------------
have curl  || pkg_install curl curl
have wget  || pkg_install wget wget
have rsync || pkg_install rsync rsync
have rclone || { curl -fsSL https://rclone.org/install.sh | sudo bash; } || warn "rclone optional"

# ---- file watching ----------------------------------------------------------
have inotifywait || pkg_install inotify-tools inotify-tools || true

ok "file tools installed"
