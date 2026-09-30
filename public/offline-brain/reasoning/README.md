# reasoning/

The layer that turns a model into a problem-solver: planning, decomposition,
multi-step reasoning, tool selection, verification and error correction.

Installed by `../scripts/install-reasoning.sh` into isolated environments:

- `langgraph/` — graph/state-machine agent loops, reflection, checkpoints.
- `structured/` — Instructor, Outlines, guidance: force valid tool calls and
  structured output; program-aided reasoning.
- `dspy/` — prompt/program optimisation to improve reasoning quality.
- `verify/` — Guardrails AI, pyright, pytest, hypothesis: verification and
  error correction.
- `semgrep/`, `ruff/`, `bandit/` — static analysis used for code review.
- `multiagent/` — AutoGen, CrewAI, PydanticAI, smolagents, Agno, CAMEL,
  MetaGPT, OpenAI Agents SDK: multi-agent debate and coordination.

Freebuff's own reasoning/planning code is in
`../source/freebuff/agents/thinker/`, `../source/freebuff/agents/base2/base2-plan.ts`
and `../source/freebuff/packages/agent-runtime/src/run-agent-step.ts`.
