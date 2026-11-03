# UHP / HarnessRouter execution provider (ADR-011)

Runtime ships a `UhpHarnessProvider` that implements Core’s
`HarnessExecutionProvider` port against a self-hosted or Cloud
[HarnessRouter](https://github.com/HarnessRouter/harnessrouter) instance
(Unified Harness Protocol — OpenAI Responses-compatible).

## Trust boundary

- **Not authority.** PolicyEngine / Execution Gateway authorize first; the
  provider only runs work that already cleared policy.
- **Fail-closed activation.** Off by default. A missing flag, URL, or API key
  never silently enables the executor.
- **Idempotency.** `requestId` is forwarded as `Idempotency-Key` so retries after
  an indeterminate outcome reconcile instead of re-executing shell/fs/git.
- **Indeterminate ≠ failed.** Transport loss / 502–504 map to `indeterminate`
  so operators reconcile before treating the run as terminal.

Harness × model **optimization** (Arena-style: success gate → cost → latency)
lives in `@aion/core` as `recommendHarnessConfiguration`. Runtime does not
auto-switch traffic; the composition root / operator applies a recommendation
to `metadata.harnessId` + `metadata.model` for a task class.

## Configuration

| Env | Meaning |
|---|---|
| `HARNESSROUTER_ENABLED` | `true` to register the adapter (default: off) |
| `HARNESSROUTER_BASE_URL` | e.g. `http://127.0.0.1:3000/api/harness` |
| `HARNESSROUTER_API_KEY` | CE / Cloud API key (secret store — never commit) |

When `HARNESSROUTER_ENABLED=true`, both URL and key are required or boot fails.

## Dispatch

Commands that set `metadata.harnessId` are claimed by `HarnessExecutionAdapter`
(`uhp-harness:<id>`). Optional `metadata.model` and `metadata.sessionId`
(previous response id) are forwarded on the UHP request.

## Local HarnessRouter

```bash
docker run -d --name harnessrouter \
  -p 127.0.0.1:3000:3000 \
  -v harnessrouter:/data \
  harnessrouter/harnessrouter
```

Create an API key in the Console, then set the env vars above on Runtime.
Runner egress remains an infra deny-by-default concern (ADR-011).
