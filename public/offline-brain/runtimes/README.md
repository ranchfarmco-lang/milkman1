# runtimes/

Language runtimes that the agents and tools run on. Installed by
`../scripts/install-supporting.sh`.

| Runtime | Purpose |
| --- | --- |
| **Python + uv** | agents, reasoning frameworks, embeddings |
| **Node.js** | agents and tools shipped as npm packages |
| **Bun** | the Freebuff/Codebuff runtime and fast JS tooling |
| **Deno** | sandboxed TypeScript execution |
| **Rust (rustup)** | building llama.cpp helpers, `difftastic`, cargo tools |
| **Go** | `gopls`, Go tooling |
| **JDK** | Java language servers |
| **{cc, cmake, ninja, make, pkg-config}** | compiling native runtimes |
| **corepack** | pnpm/yarn without separate installs |

Python virtual environments created by the installers live under
`$BRAIN_DATA/` (`runtimes/`, `reasoning/`, `agents/`, `context/`, ...), so they
never conflict with your system Python.
