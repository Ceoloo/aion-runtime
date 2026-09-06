# aion-runtime

**The AION runtime host — the platform composition root.**

`aion-runtime` is the one process that turns [AION Core](https://github.com/Ceoloo/aion-core)
(a kernel) and [AION Data](https://github.com/Ceoloo/aion-data) (a persistence
package) into a running, health-checked, observable service, and packages it as
the single **provider-neutral container image** every deployment profile runs.

Established by [aion-docs ADR-002](https://github.com/Ceoloo/aion-docs/blob/main/adr/ADR-002-runtime-host-ownership.md).
It satisfies the runtime side of aion-infra's
[deployment contract](https://github.com/Ceoloo/aion-infra/blob/main/contracts/deployment-contract.md).

```
AION Core (kernel) ─┐
                    ├─▶ aion-runtime (this repo) ─▶ one image ─▶ VPS / AWS / GCP
AION Data (adapters)┘        composition root         (aion-infra profiles deploy it)
```

## What it does

1. validates configuration and **fails fast** if required config is missing/malformed;
2. initializes **AION Core** over **AION Data**'s durable Postgres adapters;
3. connects to PostgreSQL as the least-privileged **`aion_app`** role;
4. exposes **liveness** (`/health/live`) and **readiness** (`/health/ready`, which checks DB connectivity);
5. exposes the **Execution Gateway** HTTP surface on this same process (not a second gateway):
   `POST /v1/commands`, `GET /v1/runs/:id`, `POST /v1/approvals/:id/decision`,
   `GET /v1/executions/:id`, `GET /v1/executions/by-run/:id` — creating canonical
   Execution Objects (`aion_execution`) with agent identity fields;
6. emits **structured JSON logs** to stdout/stderr with release metadata;
7. optionally runs **one controlled, non-destructive Core lifecycle** as a boot self-check;
8. **shuts down gracefully** on `SIGTERM`;
9. provides a separate **migration entrypoint** (`node dist/migrate.js`) that runs aion-data's authoritative runner and applies the least-privilege grants.

## Boundaries (ADR-002)

- Depends **downward** on `@aion/core` + `@aion/data` (allowed — same direction as products).
- Imports **no** cloud/provider SDK — provider specifics live only in aion-infra's provider profiles.
- `aion-infra` consumes this repo's **image**, never its code — no cycle.
- Owns composition only: no orchestration policy (aion-core), no schema/migration *content* (aion-data), no provisioning (aion-infra), no product logic (aion-products).

Core and Data are consumed as the **real** packages, vendored at pinned commits
(`scripts/setup-deps.mjs`, mirroring aion-data's `setup-core.mjs`) so canonical
contracts are never forked.

## The deployment interface (contract)

| Aspect | Contract |
|---|---|
| Port | `$PORT` (default `8080`), HTTP. |
| Liveness | `GET /health/live` → `200` while healthy; no dependency work. |
| Readiness | `GET /health/ready` → `200` only when the DB is reachable; else `503`. |
| Release info | `GET /` → `{ git_sha, service_version, build_time, environment }`. |
| Execution Gateway | Same process. `POST /v1/commands` submits governed work; `GET /v1/runs/:id` / `GET /v1/executions/:id` read state; `POST /v1/approvals/:id/decision` resumes gated runs. Creates durable `aion_execution` records. |
| Config | env only: `DATABASE_URL` (required), `AION_ENVIRONMENT`, `PORT`, `LOG_LEVEL`, `DATABASE_SSL`, release vars. |
| Credentials | app role only. Must **never** receive `MIGRATION_DATABASE_URL`. |
| Migrations | not run by the long-running host; use `node dist/migrate.js` (migration job). |
| Logs | structured JSON, stdout/stderr, no secrets. |
| Signals | drains and exits `0` on `SIGTERM`. |

## Build & run

```bash
npm run setup:deps    # vendor + build pinned @aion/core and @aion/data
npm install
npm run typecheck && npm run build
# migration job (migrator credential):
MIGRATION_DATABASE_URL=... node dist/migrate.js
# long-running host (app credential):
DATABASE_URL=... AION_ENVIRONMENT=staging node dist/index.js
```

Container (the one image all providers deploy):

```bash
docker build -t ghcr.io/ceoloo/aion-runtime:<git-sha> .
```

Multi-stage, non-root, no dev deps, no secrets baked in. The same image runs both
the service and the migration job (the job overrides the command).

## Verification

- `npm run portability-check` — no cloud SDK; env-based secrets; stdout logs;
  neutral health; `DATABASE_URL`-driven (no hardcoded DB host).
- `npm run acceptance` — migrate → boot (app role) → readiness → smoke against a
  PostgreSQL given by `DATABASE_URL`/`MIGRATION_DATABASE_URL`.

CI (`.github/workflows/ci.yml`) runs typecheck, build, portability-check, and the
acceptance suite against an ephemeral Postgres, then builds and publishes the
image.

## Provenance

Seeded by extracting the Phase 3 reference host from `aion-infra/runtime/`
unchanged. See ADR-002 for the decision and migration path.
