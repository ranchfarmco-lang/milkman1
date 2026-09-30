#!/usr/bin/env bash
# Context + memory: codebase indexing, semantic search, vector stores, reranking,
# conversation/project memory and task state.
. "$(dirname "$0")/lib.sh"

V="$BRAIN_DATA/context"

# ---- codebase indexing ------------------------------------------------------
have ctags || pkg_install universal-ctags universal-ctags
pip_install "$V/index" tree-sitter tree-sitter-language-pack "llama-index" "llama-index-vector-stores-chroma" \
  "llama-index-retrievers-bm25" "llama-index-postprocessor-flag-embedding-reranker"

# ---- embeddings + rerankers -------------------------------------------------
pip_install "$V/embeddings" sentence-transformers "FlagEmbedding" fastembed optimum "transformers[torch]"

# ---- vector stores ----------------------------------------------------------
pip_install "$V/vectors" chromadb qdrant-client lancedb faiss-cpu weaviate-client pymilvus
have docker && log "Qdrant/Milvus/Weaviate can also run as containers; see databases/README.md"

# ---- lexical / hybrid search ------------------------------------------------
pip_install "$V/search" bm25s rank-bm25 whoosh tantivy
have meilisearch || { have docker && log "Meilisearch available as image getmeili/meilisearch"; }
have typesense   || { have docker && log "Typesense available as image typesense/typesense"; }

# ---- retrieval frameworks / RAG --------------------------------------------
pip_install "$V/rag" haystack-ai txtai ragflow-sdk-private 2>/dev/null || pip_install "$V/rag" haystack-ai txtai

# ---- project / conversation memory -----------------------------------------
pip_install "$V/memory" mem0ai letta cognee zep-cloud 2>/dev/null || pip_install "$V/memory" mem0ai letta cognee

# ---- task state -------------------------------------------------------------
pip_install "$V/tasks" "langgraph-checkpoint-sqlite" sqlite-utils

# ---- self-hosted code search engines (source) -------------------------------
fetch_repo() {
  local owner_repo="$1" dest="$V/$2"
  [ -d "$dest" ] && { ok "$2 present"; return; }
  mkdir -p "$dest"
  curl -sSL "https://codeload.github.com/$owner_repo/tar.gz/refs/heads/main" | tar xz -C "$dest" --strip-components=1 \
    || warn "failed to fetch $owner_repo"
}
fetch_repo sourcegraph/zoekt zoekt
fetch_repo sourcegraph/livegrep livegrep
fetch_repo zilliztech/GPTCache GPTCache

ok "context + memory software installed under $V"
