# research-tools/

Technical research that works offline. Installed by
`../scripts/install-research-tools.sh`.

- **Self-hosted web search**: `docker-compose.searxng.yml` runs **SearXNG** on
  `http://localhost:8888`. Point research agents here instead of a cloud search
  API, so search keeps working without an account.
- **CLI search**: `ddgr`, `googler`, `duckduckgo-search`.
- **Offline docs**: `tldr`, `cheat`; DevDocs bundle; `man` pages.
- **Doc/article extraction**: `trafilatura`, `newspaper3k`, `readability-lxml`,
  `markdownify`.

Freebuff's research agents are `../source/freebuff/agents/researcher/`
(`researcher-docs.ts`, `researcher-web.ts`) and the librarian is
`../source/freebuff/agents/librarian/`.
