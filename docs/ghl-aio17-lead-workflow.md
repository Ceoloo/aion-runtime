# AIO-17 — GHL lead-workflow adapter (enabled CRM revenue slice)

**Completion wording:** AIO-17 means the **enabled CRM revenue slice is
complete**; **live acceptance is tracked separately**
(`npm run proof:ghl-live-acceptance`). Conversation reads (and send) plus
appointment create remain deferred.

External CRM I/O goes through the Runtime `GhlAdapter`. AION Core stays
vendor-agnostic; GoHighLevel owns CRM state; AION owns governance truth
(identity, tenant, permission, risk, approval, cost, lineage, audit).

## Pinned API version

| Constant | Value |
|---|---|
| `GHL_API_VERSION` | `2021-07-28` |
| Default base URL | `https://services.leadconnectorhq.com` |

Live calls send the LeadConnector `Version` header from
`resolveGhlConnection()` (env override `GHL_API_VERSION` allowed; fixtures pin
`2021-07-28`).

## Enabled in this slice

| Capability | Action |
|---|---|
| `crm.contact.read` / `search` / `enrich` / `update` | Contact get + upsert |
| `crm.opportunity.read` / `search` / `create` / `update` | Opportunity create + stage update |
| `crm.note.create` | Note create |
| `crm.task.create` | Task create |
| `crm.pipeline.read` | Pipeline / stage read |
| `crm.appointment.read` | Appointment read (Phase A; not part of acceptance happy path) |

Contact upsert requires `matchConfidence ≥ 0.85`
(`CRM_CONTACT_UPSERT_MIN_CONFIDENCE`).

## Deferred (explicit `CAPABILITY_DISABLED`)

These are typed, payload-validated, and error-mapped. Calls return
`CAPABILITY_DISABLED` with **zero provider calls**. Remaining enablement is a
follow-up; OL-001’s broader resume still needs them plus the model-provider
dependency.

| Capability | Action |
|---|---|
| `crm.conversation.read` | Conversation read |
| `crm.conversation.send` | Conversation send |
| `crm.appointment.create` | Appointment create |

Also deferred (not in this slice): messaging delivery/webhooks, calendar
availability/conflicts, additional Custom Field/Tag operations.

## Prerequisites

### Credentials (live)

| Env | Purpose |
|---|---|
| `GHL_API_KEY` (or `AION_GHL_API_KEY`) | Private Integration Token |
| `GHL_LOCATION_ID` (or `AION_GHL_LOCATION_ID`) | Tenant location binding |
| `GHL_API_VERSION` | Optional; defaults to pinned `2021-07-28` |
| `GHL_API_BASE_URL` | Optional LeadConnector host |
| `GHL_ACCEPTANCE_PIPELINE_ID` | Required for live acceptance synthetic opp |
| `GHL_ACCEPTANCE_STAGE_NEW` | Required — initial stage for synthetic opp |
| `GHL_ACCEPTANCE_STAGE_QUALIFIED` | Required — target stage after R2 gate |

Live mode **fails closed** if credentials or fixture configuration are missing.
Backend evidence must identify `ghl-live`.

### Tenant / location

- Every CRM call requires `tenantId` (command metadata or actor).
- `workspaceId` must equal `tenantId` or start with `{tenantId}:`.
- Live location is the env-bound `GHL_LOCATION_ID`.

### Pipeline / stage

- Opportunity create accepts `pipelineId` + `stage` / `stageId` /
  `pipelineStageId`.
- Stage updates go through `crm.opportunity.update` (R2 → approval when policy
  requires it).

### Assignee

- Task create accepts optional assignee fields in payload; GHL task `dueDate`
  defaults to +24h when omitted on the live backend.

## Durability contract

- Successful mutations record an `ExternalSideEffect` keyed by idempotency.
- Completed-operation replay returns `idempotentReplay: true` without a second
  provider write.
- Concurrent duplicates converge on one ledger row (`saveOnce`) **and** one
  provider object (assert write count + object count, not only the ledger).
- Ambiguous write timeouts (`GHL_AMBIGUOUS_TIMEOUT` / `GHL_WRITE_TIMEOUT`) are
  recorded as failed+ambiguous and **refuse automatic repeat**
  (`AMBIGUOUS_WRITE_NOT_REPLAYED`).
- Rate limits surface as `GHL_RATE_LIMIT` with `retryable: true` (not recorded
  as success). Auth failures surface as `GHL_AUTH_DENIED` (not retryable).

## Proofs

```bash
# Contract fixtures (validation, disabled caps, lead workflow, durability)
npm run test:aio17-ghl-fixtures

# Isolated adapter fixtures (fake backend; no Runtime/Postgres)
npm run proof:aio17-ghl-lead-workflow

# End-to-end durable revenue workflow on Runtime + Postgres
npm run proof:revenue-workflow

# Acceptance fixtures (synthetic happy path + failure injection on fake;
# restart, strict Postgres ledger asserts)
npm run proof:ghl-acceptance-fixtures

# Live location synthetic acceptance (fails closed without creds + fixture
# config; separate evidence file; three R2 gates + restart)
npm run proof:ghl-live-acceptance
```

### Acceptance fixture matrix

| Fixture | Assertion |
|---|---|
| Synthetic happy path | One contact, opportunity, note, task; relationships + final stage |
| Invalid input / confidence | Missing fields + low confidence fail before provider writes |
| Tenant/location mismatch | Cross-tenant fails before provider access |
| Permission / approval | Denied → zero writes; pending R2 stays parked |
| Completed replay | Same key → original result, no second write (incl. after restart) |
| Concurrent duplicate | Provider write count + object count (not only one ledger row) |
| Rate limit / auth failure | Normalized errors; no false success |
| Ambiguous write | Auto-replay refused pending reconciliation |
| Deferred capabilities | Conversation read/send + appointment create → `CAPABILITY_DISABLED` |

Value telemetry labels **synthetic** business value separately from attributed
EV and realized outcome so they are never double-counted. Local baseline from
`proof:revenue-workflow`: success YES, human intervention YES (3 R2 gates),
cost 4 units, synthetic business value $1,500.

AIO-17’s enabled CRM revenue slice is complete under this wording. Live
acceptance remains a separate tracked run. Model-provider enablement is
separate.
