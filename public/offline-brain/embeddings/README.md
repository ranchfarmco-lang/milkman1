# embeddings/

Embedding models and servers for semantic search over code and docs.

- **Models** (in `../models/`, see `manifest.json`): `bge-m3`,
  `bge-large-en-v1.5`, `e5-large-v2`, `nomic-embed-text-v1.5`,
  `all-MiniLM-L6-v2`, `jina-embeddings-v3`.
- **Servers / libraries** (`$BRAIN_DATA/context/embeddings/`): the HF
  `transformers` runtime, **HF TEI** (Text Embeddings Inference, container),
  `sentence-transformers`, `FlagEmbedding`, `fastembed`, `optimum`.
- **Rerankers**: `bge-reranker-v2-m3`, `bge-reranker-large`,
  `mxbai-rerank-large-v1`.

Download the embedding set with `MODEL_SET=embeddings ../scripts/download-models.sh`
(and `MODEL_SET=rerank` for rerankers). Serve with TEI or use in-process.
