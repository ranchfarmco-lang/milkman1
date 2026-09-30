# databases/

Local databases and engines used for storage, memory, task state and vector
search.

| Engine | Use | Install |
| --- | --- | --- |
| **SQLite** | task/agent state, memory, local metadata | `pkg_install sqlite3` |
| **PostgreSQL + pgvector** | memory/RAG at scale | distro package + `CREATE EXTENSION vector` |
| **DuckDB** | analytical queries over local files | `pip install duckdb` |
| **Redis** | caching, queues, short-term state | distro package |
| **Qdrant** | vector search server | `docker run qdrant/qdrant` |
| **Chroma** | embedded vector store | `pip install chromadb` |
| **Milvus** | large-scale vector search | Docker |
| **Weaviate** | vector + hybrid search | Docker |
| **LanceDB** | embedded columnar vector store | `pip install lancedb` |
| **FAISS** | in-process ANN index | `pip install faiss-cpu` |
| **Neo4j** | knowledge graph (cognee) | Docker |
| **LMDB / RocksDB** | embedded KV (optional) | distro package |

Python clients are installed into `$BRAIN_DATA/context/vectors/`. Containers are
optional; SQLite/Chroma/LanceDB/FAISS give a fully local setup with no daemon.
