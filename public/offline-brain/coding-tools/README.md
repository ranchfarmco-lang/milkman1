# coding-tools/

The tools coding agents call to read, search, navigate, edit, build, test, lint
and format code. Installed by `../scripts/install-coding-tools.sh`.

- **Search**: `ripgrep` (fast text/code), `ast-grep` (structural/AST search),
  `fd` (file names), `fzf` (interactive), `ag`, `ugrep`.
- **Symbols / navigation**: `universal-ctags`, GNU `global`, `cscope`,
  `tree-sitter` CLI, plus language servers (`pyright`,
  `typescript-language-server`, `gopls`, `rust-analyzer`).
- **Diff / patch**: `diff`, `patch`, `git-delta`, `difftastic`.
- **Lint / format**: `ruff`, `bandit`, `eslint`, `prettier`, `biome`,
  `shellcheck`, `shfmt`, `clang-format`.
- **Build / test**: `make`, `cmake`, `ninja`, `just`, `hyperfine`.
- **Data plumbing**: `jq`, `yq`, `bat`.

Freebuff's tool implementations live in `../source/freebuff/sdk/src/tools/`:
`code-search.ts`, `glob.ts`, `list-directory.ts`, `read-files.ts`,
`change-file.ts`, `apply-patch.ts`, `run-terminal-command.ts`, `read-url.ts`, and
`../source/freebuff/sdk/src/native/ripgrep.ts`.
