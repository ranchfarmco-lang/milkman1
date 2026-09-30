# agents/

Downloadable, locally-runnable coding agents and their frameworks. Installed by
`../scripts/install-agents.sh`; each gets its own venv/project directory under
`$BRAIN_DATA/agents/<name>` and a launcher symlink in this folder.

| Agent | Role |
| --- | --- |
| **aider** | terminal pair-programmer; edits a git repo |
| **OpenHands** | full autonomous software-agent platform |
| **SWE-agent** | autonomous issue/PR solving |
| **Goose** | extensible local coding agent |
| **Cline** / **Roo-Code** / **Continue** | IDE agents |
| **Plandex** | large multi-file task agent |
| **gpt-engineer** / **gptme** / **smol-developer** | build/coding agents |
| **open-interpreter** / **shell-gpt** | natural-language shell + code execution |
| **Tabby** | self-hosted code completion server |
| **codex-cli** / **gemini-cli** / **opencode** | CLI coding agents |
| **Devika** / **mentat** | research + coding agents |

Point them at your local model with `OPENAI_BASE_URL=http://localhost:8000/v1`.

The reference implementation of all of this — subagents for context gathering,
planning, editing, research, tools and review — is the downloaded Freebuff tree:
`../source/freebuff/agents/` (`file-explorer`, `editor`, `thinker`, `researcher`,
`reviewer`, `librarian`, `basher`, `context-pruner`, `browser-use`,
`general-agent`).
