# RCAOS AT proof — Revenue Capture & Appointment OS (D0–D7)

Proves the Sprint 2 demo path for **Revenue Capture & Appointment OS** against
`FakeGhlBackend` + Runtime + Postgres:

```text
D0 inject → D1 capture/dedupe → D2 opportunity (R2) → D3 qualify
  → D4 note/task/draft (R2) → D5 human book → D6 appointment.read + Outcome
  → D7 scorecard
```

Acceptance tests **AT-1…AT-7** map 1:1 to
`aion-docs/offers/revenue-capture-appointment-os/`.

Conversation send and appointment **create** stay disabled. D5 simulates human
booking via `FakeGhlBackend.seedAppointment` (not `crm.appointment.create`).

## Run

```bash
export MIGRATION_DATABASE_URL=postgresql://aion_migrator:aion_migrator@localhost:5432/aion_data
export DATABASE_URL=postgresql://aion_app:aion_app@localhost:5432/aion_data
export DATABASE_SSL=false
npm run proof:rcaos-at
```

Uses fake GHL when `GHL_*` keys are unset. Live Empire tenant is a separate
follow-up — this harness is fail-closed against live credentials.

Evidence JSON: `.proof-rcaos-at-evidence.json` (override with `RCAOS_EVIDENCE_PATH`).

## Matrix

| AT | Proof |
|---|---|
| AT-1 | Contact capture with persisted side-effect + execution audit |
| AT-2 | Re-inject same email/phone → same contactId; count unchanged |
| AT-3 | `demo-electrical-smb-v1` yields qualified / not_qualified / needs_human |
| AT-4 | `crm.message.draft` requires R2; RCAOS agent has no send; send unused |
| AT-5 | Human book (`seedAppointment`) → `crm.appointment.read` → Outcome |
| AT-6 | Scorecard six metrics written to evidence (synthetic limitations labeled) |
| AT-7 | `matchConfidence: 0.4` → `CONTACT_UPSERT_CONFIDENCE_TOO_LOW`; no partial write |

## Related

- Docs pack: `aion-docs/offers/revenue-capture-appointment-os/`
- Mission: MISSION-RCAOS-001
- Durable revenue path: `docs/revenue-workflow-durable-proof.md`
- AIO-17 adapter: `docs/ghl-aio17-lead-workflow.md`
