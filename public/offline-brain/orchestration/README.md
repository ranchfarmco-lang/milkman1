# orchestration/

Connects `MODEL → REASONING → AGENTS → TOOLS → FILES → TERMINAL → TESTING → REVIEW`.

Installed by `../scripts/install-orchestration.sh`:

- `mcp/` — Model Context Protocol SDK + FastMCP: standard tool calling and
  agent-to-agent communication. `mcpo` exposes MCP tools as an OpenAPI service.
- `litellm/` — one endpoint in front of many models; model + context routing.
- `parallel/` — Ray, Celery, Dask: run many agents concurrently.
- `workflows/` + `schedule/` — Prefect, Dagster, Airflow, APScheduler: task
  management and long-running pipelines.
- `docker-compose.openwebui.yml` — local agent workspace UI.

Freebuff's orchestration equivalents:
`../source/freebuff/packages/agent-runtime/src/run-agent-step.ts` (agent step
loop + tool selection), `../source/freebuff/sdk/src/agents/load-agents.ts`
(subagent loading) and `../source/freebuff/common/src/tools/` (tool registry).
