# Design Spec — Composing the Execution Gateway

- **Drives:** aion-docs
  [ADR-003](https://github.com/Ceoloo/aion-docs/blob/main/adr/ADR-003-execution-gateway-and-evidence.md)
- **Priority:** P0 (wire when the gateway ports land in Core + Data)
- **Status:** Design — not yet implemented

`aion-runtime` **composes**; it does not redefine
([ADR-002](https://github.com/Ceoloo/aion-docs/blob/main/adr/ADR-002-runtime-host-ownership.md),
dependency rule #7). The Execution Gateway's guarantees are defined in Core
([contracts + ports](https://github.com/Ceoloo/aion-core/blob/main/docs/design/execution-gateway.md))
and made durable in Data
([tables + repositories](https://github.com/Ceoloo/aion-data/blob/main/docs/design/economics-and-idempotency.md)).
This repo's only job is to **wire the concrete stores into the composition root**,
exactly as it already wires the run repository, event sink, approval store, and
telemetry sink.

## What changes here (and what does not)

Today `src/control-plane.ts` builds a Core `Orchestrator` over AION Data's
Postgres adapters. When the gateway ports exist, that wiring gains two
dependencies and **nothing else**:

```
Orchestrator({
  policyEngine, registry, approvalGate,
  runRepository, events, telemetry,
  idempotencyStore: dataLayer.idempotencyStore(),   // NEW — Core port, Data impl
  receiptSink:      dataLayer.receiptSink(),         // NEW — Core port, Data impl
})
```

- **No new orchestration logic in runtime.** The claim → dispatch → receipt flow
  lives in Core; runtime only supplies the two adapters, both backed by the same
  Postgres pool already used for runs/events/approvals/telemetry.
- **No schema knowledge in runtime.** Whether receipts and idempotency claims are
  one table or two is Data's concern; runtime imports `@aion/data`'s factory, not
  SQL.
- **No provider SDK.** The gateway adds a DB-backed read/write on the hot path;
  it introduces no cloud dependency, so the
  [deployment contract](https://github.com/Ceoloo/aion-infra/blob/main/contracts/deployment-contract.md)
  and portability check are unaffected.

## Migration entrypoint

The gateway's durable tables arrive as the next aion-data migration. Runtime's
existing migration entrypoint (`node dist/migrate.js`, which runs aion-data's
authoritative runner under the admin role) applies them with **no change** — it
already runs whatever pending migrations Data ships. The gateway tables are
additive, so the migration is forward-only and safe under load
([migration policy](https://github.com/Ceoloo/aion-data/blob/main/migrations/README.md)).

## Boot self-check

The optional boot self-check (one controlled, non-destructive Core lifecycle)
should, once the gateway lands, exercise a **read-only (R0)** capability so it
never writes a receipt or claims a key — the self-check must remain free of side
effects (it exists to prove wiring, not to perform work). If a future check
wants to prove the gateway end-to-end, it uses a dedicated
`selfcheck.*` capability whose idempotency key is scoped to the boot id and whose
adapter is a no-op, so repeated boots are provably at-most-once and leave a
clean, attributable trail.

## Readiness

Gateway stores share the existing Postgres pool, so `GET /health/ready` already
covers their availability (it checks DB connectivity). No new readiness probe is
needed; a gateway store outage *is* a DB outage, surfaced as `503` and recovered
without redeploy, exactly as today.

## Observability

Runtime continues to emit structured JSON logs with the observability spine
([infra observability](https://github.com/Ceoloo/aion-infra/blob/main/docs/observability.md)).
Gateway steps add `idempotency` outcome fields (`fresh`/`replay`/`conflict`) to
the per-run telemetry Core emits; runtime logs the operational complement
(e.g. `operation:"execution.replayed"`) with **no arguments and no payloads** —
only the hash and the outcome, consistent with the no-secrets/no-payloads rule.

## What this spec deliberately does NOT do

- Does not define the gateway contracts, ports, or enforcement — that is Core.
- Does not define the tables — that is Data.
- Does not add a cloud dependency or change the deployment contract.
- Does not hold policy: the runtime host composes; it does not decide.
