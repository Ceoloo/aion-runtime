# AIO-17 — GHL lead-workflow adapter (first slice)

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
| `crm.appointment.read` | Appointment read (Phase A) |

Contact upsert requires `matchConfidence ≥ 0.85`
(`CRM_CONTACT_UPSERT_MIN_CONFIDENCE`).

## Defined but disabled (AIO-17)

These are typed, payload-validated, and error-mapped. Calls return
`CAPABILITY_DISABLED` (explicit). Remaining enablement is a follow-up; OL-001’s
broader resume gate still needs them plus the model-provider dependency.

| Capability | Action |
|---|---|
| `crm.conversation.read` | Conversation read |
| `crm.conversation.send` | Conversation send |
| `crm.appointment.create` | Appointment create |

## Prerequisites

### Credentials (live)

| Env | Purpose |
|---|---|
| `GHL_API_KEY` (or `AION_GHL_API_KEY`) | Private Integration Token |
| `GHL_LOCATION_ID` (or `AION_GHL_LOCATION_ID`) | Tenant location binding |
| `GHL_API_VERSION` | Optional; defaults to pinned `2021-07-28` |
| `GHL_API_BASE_URL` | Optional LeadConnector host |

Phase A connection resolution refuses cross-location overrides (tenant
isolation). Multi-tenant connection store can replace env binding later without
changing the adapter port.

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
- Concurrent duplicates converge on one ledger row (`saveOnce`).
- Ambiguous write timeouts (`GHL_AMBIGUOUS_TIMEOUT` / `GHL_WRITE_TIMEOUT`) are
  recorded as failed+ambiguous and **refuse automatic repeat**
  (`AMBIGUOUS_WRITE_NOT_REPLAYED`).
- Rate limits surface as `GHL_RATE_LIMIT` with `retryable: true` (not recorded
  as success).

## Proofs

```bash
# Contract fixtures (validation, disabled caps, lead workflow, durability)
npm run test:aio17-ghl-fixtures

# Isolated Runtime matrix (fake backend; requires Postgres like other proofs)
npm run proof:aio17-ghl-lead-workflow
```

AIO-17 remains **partially complete** after this PR. OL-001 resume still needs
the remaining conversation/appointment write enablement and the separate
model-provider dependency.
