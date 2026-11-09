# Twenty live acceptance (CRM-001 Gate C)

Disposable live proof against a **staging** Twenty v0.40 workspace.
**Not part of default CI** — requires explicit operator secrets.

## Fail-closed entry

```bash
# Matrix (no secrets): proves the harness refuses without live env
npm run check:twenty-live-failclosed

# Full disposable proof (operator / staging only)
export AION_PROOF_LIVE=1
export CRM_PROVIDER=twenty
export TWENTY_BACKEND=live
export TWENTY_API_BASE_URL=http://twenty-server:3000   # staging / internal
export TWENTY_API_KEY=…                                 # disposable workspace
export AION_PROOF_CREDENTIAL_SCOPE=disposable-twenty
export TWENTY_ACCEPTANCE_TENANT=aion-proof-synthetic
export AION_RUNTIME_URL=http://127.0.0.1:8107
export MIGRATION_DATABASE_URL=…
export DATABASE_URL=…
npm run proof:twenty-live-acceptance
```

Guard mode: `live-twenty` (`scripts/lib/proof-guard.mjs`). Refuses when:

- `AION_PROOF_LIVE` ≠ `1`
- `CRM_PROVIDER` ≠ `twenty` or `TWENTY_BACKEND` ≠ `live`
- staging URL/key missing
- GHL live credentials present
- production tenants / runtime hosts / Twenty record hashes match denylist

## What it proves

| Check | Evidence |
|---|---|
| Contact / opportunity / note / task via Runtime | `.proof-twenty-live-evidence.json` |
| Backend identity `twenty-live` | command output `backend` |
| Real CRM ids (no synthetic substitutes) | ledger `externalResourceId` |
| Synthetic write boundary | unit: `production-write-eligibility.test.ts`; optional live: `TWENTY_PROTECTED_CONTACT_ID` |
| No production GHL writes | guard refuses GHL credentials in `live-twenty` |

## Cross-tenant isolation

Gate C requires two staging tenant contexts. Choose one:

1. **Two-process (recommended, no Runtime redesign)**  
   Run `proof:twenty-live-acceptance` twice with distinct `TWENTY_API_KEY` values
   (workspace A then workspace B). On the B run, attempt a read/write of A's
   fixture ids and record denial. Keep both evidence files for sign-off.

2. **`TWENTY_API_KEY_B`**  
   Set a second staging key alongside the primary. The harness records that
   KEY_B is present; complete isolation by launching a second Runtime/process
   that boots with KEY_B and asserting it cannot access tenant A fixtures.
   Same-process dual-backend switching is intentionally out of scope for this
   scaffolding (avoids redesigning `createCrmBackendFromEnv`).

## Protected Twenty hashes

`scripts/lib/production-ids.json` → `sha256.twentyRecordIds` (starts empty).
Mirror into `PROTECTED_LIVE_TWENTY_RECORD_SHA256` when production Twenty
record ids are known. Additive overrides:
`AION_PRODUCTION_TWENTY_RECORD_SHA256`.

## Related

- Cutover sequence: aion-docs `roadmap/crm-001-cutover-sequence.md`
- Provider selection: `docs/crm-provider-selection.md`
- GHL live pattern this mirrors: `docs/ghl-acceptance.md`
