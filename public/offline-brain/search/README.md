# search/

Lexical, structural and vector search engines used for codebase and document
retrieval.

- **Code/text search**: `ripgrep`, `fd`, `ast-grep` (see `../coding-tools/`).
- **Self-hosted code search**: `zoekt`, `livegrep` (source in `../context/`).
- **Document search engines**: Meilisearch, Typesense, OpenSearch/Elasticsearch
  (Docker images / packages; see `../databases/`).
- **Lexical ranking**: `bm25s`, `rank-bm25`, `whoosh`, `tantivy`
  (`$BRAIN_DATA/context/search/`).
- **Vector search**: Chroma, Qdrant, LanceDB, FAISS, Weaviate, Milvus
  (`$BRAIN_DATA/context/vectors/`).

Typical pipeline: lexical/bm25 shortlist → vector recall → cross-encoder rerank
(`bge-reranker-v2-m3`) → feed top-k into the agent's context.
