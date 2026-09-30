# source/

Open-source code, **already in this package**. Nothing here is downloaded when
you install: the archive is part of the download you already have.

## `freebuff-source.zip` — the Freebuff (Codebuff) monorepo

Apache-2.0. TypeScript/Bun monorepo, the reference implementation of every layer
in this package. 1,773 files, 18.9 MB:

```
sha256  a930e0a5abb5e75ba9bd21476faefb5ad5f5b9f6534165cd307fe6184fea9855
from    https://codeload.github.com/CodebuffAI/freebuff/tar.gz/refs/heads/main
```

A zip, not the upstream `.tar.gz`, for one practical reason: a static server
answers a request for `*.gz` with `Content-Encoding: gzip` over bytes that are
already gzip, so a browser hands back a *tar* instead of the archive. A `.zip` is
served as ordinary bytes. The project that published this package rebuilds it
from a checkout of that tree (`scripts/pack-freebuff-source.mjs` *there*, not in
this folder).

Extract it here, into the folder it already sits in:

```bash
bash ../scripts/capture-freebuff-source.sh      # unzip, or python3 -m zipfile
```

That is what `scripts/install-agents.sh` runs during setup, so after a normal
install the tree is already at `source/freebuff/`. The archive extracts to
`freebuff/`, which is why the script unpacks it into `source/`.

`freebuff/` is what the rest of the package points at. Key locations:

```
agents/                     subagents and the base agent (base-chat, base2, base3)
  file-explorer/            file/context gathering, glob, code search
  editor/                   code editing
  thinker/                  planning and reasoning
  researcher/               docs + web research
  reviewer/                 code review
  librarian/                documentation
  basher.ts                 shell/command agent
  browser-use/              browser agent
  context-pruner.ts         context management
  general-agent/            general-purpose agent
sdk/src/tools/              read-files, change-file, apply-patch, code-search,
                            glob, list-directory, run-terminal-command, read-url
sdk/src/impl/               model-provider, llm, agent-runtime, database
sdk/src/agents/             load-agents, load-mcp-config (subagent + MCP loading)
sdk/src/native/             ripgrep integration
packages/agent-runtime/     the agent step loop, tool parsing, prompts
packages/code-map/          tree-sitter code maps
packages/llm-providers/     model providers
cli/src/                    the CLI: commands, router, reasoning, UI
common/src/tools/           tool definitions and params
docs/                       agents-and-tools.md, testing.md
freebuff/SPEC.md            how Freebuff is built from Codebuff
```

Anywhere else in the package that names `source/freebuff/...` is pointing at a
path inside the extracted tree.

Install its dependencies with `bun install` inside `source/freebuff/` — that is
the one step that reaches the network, it is optional, and it is only for the
source tree's own tooling. Reading the tree needs nothing at all.
