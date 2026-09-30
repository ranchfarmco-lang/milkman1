# context/

Codebase indexing, context gathering, retrieval and task state. Installed by
`../scripts/install-context-memory.sh`.

- `index/` — tree-sitter + language pack, ctags, LlamaIndex retrievers (dense +
  BM25 hybrid) and a rerank postprocessor.
- `embeddings/` — sentence-transformers, FlagEmbedding, fastembed, optimum,
  Transformers.
- `vectors/` — Chroma, Qdrant, LanceDB, FAISS, Weaviate, Milvus clients.
- `search/` — `bm25s`, `rank-bm25`, `whoosh`, `tantivy` for lexical retrieval.
- `rag/` — Haystack, txtai for retrieval-augmented pipelines.
- `tasks/` — LangGraph SQLite checkpointing, `sqlite-utils`: maintain task and
  agent state across steps.
- `zoekt/`, `livegrep/` — self-hosted code search engines (source).

Freebuff's context layer: `../source/freebuff/packages/code-map/` (tree-sitter
code maps), `../source/freebuff/agents/file-explorer/` (file/context picking) and
`../source/freebuff/agents/context-pruner.ts`.
