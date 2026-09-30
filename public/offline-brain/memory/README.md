# memory/

Project and conversation memory so an agent keeps context across turns and
sessions. Installed by `../scripts/install-context-memory.sh` into
`$BRAIN_DATA/context/memory/`.

- **mem0** — extract and store durable facts/preferences.
- **Letta (MemGPT)** — long-term memory with self-editing memory blocks.
- **cognee** — build a knowledge graph from your project.
- **GPTCache** (source fetched into `../context/`) — cache model responses.

Backed by the vector stores in `../context/` and the databases in
`../databases/`. Conversation history and task state use LangGraph's SQLite
checkpointer (`../context/tasks/`).

Freebuff keeps project context via its project-profile and file-reading
machinery: `../source/freebuff/sdk/src/project-profile.ts`,
`../source/freebuff/packages/agent-runtime/src/project-profile.ts`.
