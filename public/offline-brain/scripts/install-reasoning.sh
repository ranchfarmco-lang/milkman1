#!/usr/bin/env bash
# The reasoning layer: planning, task decomposition, multi-step reasoning,
# tool selection, verification, error correction and code-review engines.
. "$(dirname "$0")/lib.sh"

V="$BRAIN_DATA/reasoning"

# ---- graph / state-machine reasoning & agent loops --------------------------
pip_install "$V/langgraph" langgraph langgraph-checkpoint-sqlite langchain langchain-core langchain-community

# ---- structured output, constrained decoding, program-aided reasoning --------
pip_install "$V/structured" "instructor[anthropic,google-genai]" pydantic "outlines[transformers]" guidance jsonschema

# ---- prompt/program optimisation (reasoning improvement) ---------------------
pip_install "$V/dspy" dspy-ai

# ---- reflection / self-verification / self-consistency -----------------------
pip_install "$V/verify" "guardrails-ai" pyright basedpyright pytest hypothesis

# ---- code review / static analysis engines ----------------------------------
have reviewdog || { curl -sfL https://raw.githubusercontent.com/reviewdog/reviewdog/master/install.sh | sh -s -- -b "$V/bin"; }
have semgrep   || pip_install "$V/semgrep" semgrep
have ruff      || pip_install "$V/ruff" ruff
have bandit    || pip_install "$V/bandit" bandit
have eslint    || warn "eslint: install per-project via npm/bun (already in the template)"
have clang-tidy|| warn "clang-tidy not installed (optional, C/C++ review)"

# ---- multi-agent reasoning / collaboration frameworks ------------------------
pip_install "$V/multiagent" "autogen-agentchat" "autogen-ext[openai]" "crewai[tools]" "pydantic-ai" "smolagents[toolkit]" \
  "agno" "atomic-agents" "camel-ai" "metagpt" "openai-agents"

ok "reasoning layer installed under $V"
