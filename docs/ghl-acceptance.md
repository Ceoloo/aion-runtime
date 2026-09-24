# GHL acceptance proofs

## Deterministic fixtures (`proof:ghl-acceptance-fixtures`)

Runtime + Postgres + `FakeGhlBackend`. Covers the full fixture table with
failure injection, restart, and **strict** Postgres side-effect asserts
(output `sideEffectId` alone is never enough).

## Live acceptance (`proof:ghl-live-acceptance`)

Fails closed unless all are set:

- `GHL_API_KEY`, `GHL_LOCATION_ID`
- `GHL_ACCEPTANCE_PIPELINE_ID`
- `GHL_ACCEPTANCE_STAGE_NEW`
- `GHL_ACCEPTANCE_STAGE_QUALIFIED`

Creates **synthetic** contact → opportunity → note → task on the live
location, retains three R2 gates, parks stage for Runtime restart, resumes
once, asserts ledger rows, and writes
`.proof-ghl-live-evidence.json` (override with `GHL_LIVE_EVIDENCE_PATH`).

Backend evidence must be `ghl-live`. Values are labeled `valueKind=synthetic`
and kept distinct from attributed EV / realized outcome.

Deferred (not exercised as success): conversation read/send, appointment
create, messaging delivery/webhooks, calendar availability, extra custom
fields/tags. Appointment **read** exists in Phase A but is out of this path.
