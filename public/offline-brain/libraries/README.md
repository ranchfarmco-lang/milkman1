# libraries/

Common libraries shared across the stack. Installed by
`../scripts/install-libraries.sh`.

- `python/` — requests, httpx, pydantic, pyyaml, rich, typer, numpy, pandas,
  tiktoken, tenacity, gitpython, pathspec.
- `prompts/` — jinja2 templating and LLM client SDKs (`openai`, `anthropic`,
  `google-genai`, `ollama`, `llama-cpp-python`).
- `parsing/` — `tree-sitter` + `tree-sitter-language-pack` for parsing many
  languages.
- `node/` — zod, axios, express, fast-glob, ignore, chokidar, minimatch.

These are the building blocks the agents, tools and reasoning frameworks import.
The Freebuff source tree brings its own dependencies via `bun install`
(`../source/freebuff/package.json`).
