#!/usr/bin/env bash
# Code intelligence tooling used by the agents: search, symbol search, diffs,
# patches, linting, formatting, build/test runners and language servers.
. "$(dirname "$0")/lib.sh"

# ---- fast text + code search ------------------------------------------------
have rg        || pkg_install ripgrep ripgrep
have fd        || pkg_install fd-find fd
have ag        || pkg_install silversearcher-ag the_silver_searcher
have ugrep     || warn "ugrep optional (grep/ripgrep already cover search)"
have ast-grep  || { have npm && npm install -g @ast-grep/cli || warn "ast-grep via npm not installed"; }
have fzf       || pkg_install fzf fzf

# ---- symbol search / cross references / code maps ---------------------------
have ctags     || pkg_install universal-ctags universal-ctags
have gtags     || pkg_install global global
have cscope    || pkg_install cscope cscope
have tree-sitter || { have npm && npm install -g tree-sitter-cli || warn "tree-sitter CLI not installed"; }

# ---- diff / patch -----------------------------------------------------------
have diff      || pkg_install diffutils diffutils
have patch     || pkg_install patch gpatch
have delta     || { have brew && brew install git-delta || warn "git-delta optional (nicer diffs)"; }
have difft     || { have brew && brew install difftastic || warn "difftastic optional"; }

# ---- git helpers (git itself is provided by your environment) ---------------
have lazygit   || warn "lazygit optional (TUI git)"

# ---- lint / format ----------------------------------------------------------
have shellcheck || pkg_install shellcheck shellcheck
have shfmt      || { have brew && brew install shfmt || warn "shfmt optional"; }
have clang-format || pkg_install clang-format clang-format || true
have prettier   || { have npm && npm install -g prettier || warn "prettier optional"; }
have biome      || { have npm && npm install -g @biomejs/biome || warn "biome optional"; }

# ---- build / test runners ---------------------------------------------------
have make   || pkg_install make make
have cmake  || pkg_install cmake cmake
have ninja  || pkg_install ninja-build ninja
have hyperfine || warn "hyperfine optional (benchmarking commands)"
have tokei  || warn "tokei optional (code statistics)"

# ---- language servers (used by editors + agents for navigation) -------------
have pyright       || pip_install "$BRAIN_DATA/coding-tools/lsp" pyright
have typescript-language-server || { have npm && npm install -g typescript typescript-language-server || warn "tsserver optional"; }
have gopls         || warn "gopls: install with 'go install golang.org/x/tools/gopls@latest'"
have rust-analyzer || warn "rust-analyzer: install via 'rustup component add rust-analyzer'"

# ---- JSON/YAML/HTML processing (agent plumbing) -----------------------------
have jq   || pkg_install jq jq
have yq   || { have brew && brew install yq || warn "yq optional"; }
have bat  || pkg_install bat bat || true
have eza  || warn "eza/exa optional (directory listing)"

ok "coding tools installed"
