#!/usr/bin/env bash
# Terminal, shell, process and log tooling the agents drive.
. "$(dirname "$0")/lib.sh"

# ---- shells / multiplexers --------------------------------------------------
have tmux    || pkg_install tmux tmux
have zellij  || warn "zellij optional (tmux already installed)"
have screen  || pkg_install screen screen || true
have expect  || pkg_install expect expect || true
have socat   || pkg_install socat socat || true
have direnv  || warn "direnv optional"

# ---- process / resource inspection ------------------------------------------
have htop    || pkg_install htop htop
have lsof    || pkg_install lsof lsof
have strace  || pkg_install strace strace
have gdb     || pkg_install gdb gdb || true
have pgrep   || pkg_install procps procps || true
have btop    || warn "btop optional"
have procs   || warn "procs optional"

# ---- log / text inspection --------------------------------------------------
have jq      || pkg_install jq jq
have less    || pkg_install less less || true
have tail    || pkg_install coreutils coreutils
have watch   || pkg_install procps procps || true
have entr    || warn "entr optional (re-run on file change)"
have asciinema || warn "asciinema optional (record terminal sessions)"

# ---- scripting / data wrangling ---------------------------------------------
have awk     || pkg_install gawk gawk
have xargs   || pkg_install findutils findutils
have sed     || pkg_install sed gnu-sed || true
have perl    || pkg_install perl perl || true

# ---- command execution sandbox ----------------------------------------------
have script  || pkg_install bsdutils util-linux || true
have timeout || pkg_install coreutils coreutils || true

ok "terminal tools installed"
