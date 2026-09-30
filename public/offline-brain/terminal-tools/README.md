# terminal-tools/

Terminal, shell, process and log tooling that agents drive. Installed by
`../scripts/install-terminal-tools.sh`.

- **Multiplexers / shells**: `tmux`, `zellij`, `screen`, `expect`, `script`.
- **Process inspection**: `htop`, `btop`, `procs`, `lsof`, `pgrep`, `timeout`.
- **Debugging**: `gdb` (and `lldb` on macOS), `strace`.
- **Logs / text**: `jq`, `less`, `tail`, `watch`, `entr`, `asciinema`.
- **Wrangling**: `awk`, `sed`, `xargs`, `perl`.
- **Sandboxing**: `script`, `timeout`, `socat`.

Freebuff's command execution is
`../source/freebuff/sdk/src/tools/run-terminal-command.ts`, with the shell agent
in `../source/freebuff/agents/basher.ts`.
