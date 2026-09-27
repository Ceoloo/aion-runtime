# OL-001 incident: synthetic evidence crossed the production write boundary

**Status:** open. Runtime ledger and the live CRM note are preserved.
**CRM cleanup:** not performed. This record documents the authorizing path.
Delete the live note only after that path is reviewed, using the cleanup
section below. Do not treat this file as the deletion.

## What crossed the boundary

A CRM note whose body is:

> Synthetic qualification snapshot (test data, not a real prospect)

was written through the live LeadConnector API onto the real Annfiera
contact in the AION Empire location (the ModernRelx / OL-001 client
record). The note labels itself as test data. The live API does not
store that label as a separate evidence class. It stores a note on a
client contact. Later agents, operators, analytics, memory retrieval,
and automations can read it as customer intelligence.

The run was reported as 11/11 governed tasks executed. That result is
consistent with the execution gate: each task was authorized on
capability, risk, tenant, and approval. `crm.note.create` is R1, so the
note did not stop for a human gate. Nothing in that path asked whether
the payload was eligible to become client CRM state.

## Authorizing path

Two entry points reach the same write:

1. `POST /v1/commands` → `submitCommand` in `src/gateway.ts`.
2. `POST /v1/missions/run` → `runMission` → `MissionOrchestrator`, which
   submits each workflow step through the same orchestrator.

For a note, the sequence is:

1. The caller supplies `serviceKey=crm.note.create@1` (or the mission
   step `crm-note`) with `payload.contactId` set to the existing client
   contact and `payload.body` set to the synthetic snapshot text.
   Operator Console production launches set `metadata.synthetic=false`
   and still copy the step body through unchanged
   (`workforce-control` `NewMission` `crm-note` payload). A proof or
   agent can send the incident sentence directly.
2. `submitCommand` builds an `AuthorizationRequest` and calls
   `PolicyEngine.authorize`. Grants, tenant, risk ceiling, and approval
   are checked. Caller-supplied permissions are not authority.
3. `src/control-plane.ts` classifies `crm.note.create` as **R1**. R1
   does not require approval. The decision is **ALLOW**. The same
   decision is what “11/11 governed tasks executed” records: governance
   of execution succeeded.
4. The orchestrator invokes `GhlAdapter.execute`. Until this incident,
   the adapter validated the payload shape, then called the selected
   backend. It did not classify the body.
5. With `GHL_BACKEND=live` (or production credentials inferring live),
   the backend is `LiveGhlBackend` (`name = 'ghl-live'`). `note.create`
   sends `POST /contacts/{contactId}/notes` to
   `https://services.leadconnectorhq.com` with the body unchanged.

`scripts/lib/proof-guard.mjs` refuses proof scripts that target known
production record ids, but only when a proof script sources it
(`AION_PROOF=1`). The production gateway does not run that guard. A
governed OL-001 task on the live runtime never consulted it.

Known production record ids are stored only as SHA-256 in
`scripts/lib/production-ids.json` (`sha256.ghlRecordIds`). This
document does not repeat raw contact or opportunity ids.

## Why the label was not a control

`synthetic=false` on a mission, `valueKind=synthetic` on a proof
report, and the words “test data, not a real prospect” inside the note
are all annotations. The write path persisted `payload.body` as the
CRM note. Downstream readers of the contact do not see the runtime
metadata unless they also have the execution ledger.

## What is preserved

Do not delete, as part of cleanup or as part of the code change:

- the OL-001 mission row and its `metadata` (cohort, launch mode,
  production-economic flag)
- execution objects, approvals, and `external_side_effects` rows for
  that run
- the live CRM note, until the deliberate cleanup below is done and
  its provider id is recorded here

Those rows are the incident artifact. They show which actor, capability,
and idempotency key were allowed to call the live API.

## Control added

`GhlAdapter.execute` now calls `assessLiveCustomerWrite` after the
idempotent-replay short-circuit and **before** `backend.execute` when
the backend is `ghl-live`.

A live customer-intelligence write (`note.create`, `task.create`,
`message.draft`, `message.send`, `contact.update`, `contact.enrich`)
is synthetic when any of these hold:

- the payload text matches synthetic / test-data / “not a real
  prospect” (and the same phrases for customer, client, and lead) or
  an `@example.invalid` address
- `metadata.synthetic === true`, `valueKind` is `synthetic` or `test`,
  or `dataClass` is `synthetic`, `test`, `validation`, or `fixture`
- `metadata.proof` is set (proof commands are test evidence)

Synthetic evidence is eligible only when:

- the target contact or opportunity id was returned earlier in this
  process from a fixture contact create (`@example.invalid`, no
  caller-supplied contact id), or
- the action itself is that fixture create

It is refused with `SYNTHETIC_EVIDENCE_PRODUCTION_BOUNDARY` when the
target is anything else, and always when the target id hashes to
`PROTECTED_LIVE_GHL_RECORD_SHA256` (kept equal to
`production-ids.json`). The refusal does not call LeadConnector and
does not insert a succeeded side-effect row.

Reads are unchanged. A stage-only `opportunity.update` whose payload
is not synthetic text stays eligible, including the live-acceptance
restart path, because that command is not customer-intelligence text.
A stage update that carries the incident sentence is refused.

Fake-backend writes stay eligible. They never reach GHL.

`ghl-live-capability-proof` now creates an `@example.invalid` contact
and writes its note there. Reads of the configured client contact
remain read-only.

## CRM cleanup (not done)

This environment has no GHL credential and must not guess the note id.
After review of this path, an operator with location access should:

1. Open the Annfiera contact notes in the live location.
2. Delete only the note whose body is the sentence at the top of this
   file (or that sentence plus a timestamp suffix). Leave every other
   note.
3. Append here: provider note id, UTC time, and the operator identity.
   Record the contact id as its SHA-256, not the raw id.
4. Leave the OL-001 mission, executions, approvals, and side-effect
   ledger in place.

Until that append exists, the live note is still on the client record
on purpose.
