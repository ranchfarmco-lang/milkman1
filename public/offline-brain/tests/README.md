# tests/

- `smoke.sh` — checks the package structure, JSON validity, script syntax, and
  (optionally) that a local model endpoint responds.

```bash
./tests/smoke.sh
# with a running local server:
OPENAI_BASE_URL=http://localhost:8000/v1 ./tests/smoke.sh
```

Freebuff's own test suites live in `../source/freebuff/agents/__tests__/`,
`../source/freebuff/agents/e2e/`, `../source/freebuff/freebuff/e2e/` and
`../source/freebuff/cli/src/__tests__/`; run them with `bun test` inside
`../source/freebuff/`.
