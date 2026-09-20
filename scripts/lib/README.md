# Proof safety (scripts/lib)

Every `proof:*` / acceptance / certification script **sources `proof-env.sh` first**. It runs `proof-guard.mjs`
(exit 3 = refused, before anything is built, migrated, started or sent) and then sets `AION_PROOF=1` and, for
fake-backend proofs, an **explicit `GHL_BACKEND=fake`**. Credentials never select live mode.

| Mode | Used by | Allowed only when |
|---|---|---|
| `fake` (default) | all proofs except the two below | no GHL credentials/`GHL_API_BASE_URL`/`GHL_BACKEND=live`, not `AION_ENVIRONMENT=production`, no production runtime URL, and any target DB has no production markers and no non-proof data |
| `live-capability`, `live-acceptance` | `proof:ghl-live-capability`, `proof:ghl-live-acceptance` | **all** of: `AION_PROOF_LIVE=1`, `GHL_BACKEND=live`, location in `AION_PROOF_GHL_TEST_LOCATIONS` (allowlist), `AION_PROOF_CREDENTIAL_SCOPE=test-location`, explicit `GHL_ACCEPTANCE_TENANT`/`_CONTACT_ID`/`_OPPORTUNITY_ID`/`_PRIOR_STAGE`/`_TARGET_STAGE` (no defaults), and none of them a known production identifier; `live-capability` also needs an explicit loopback/allowlisted `AION_RUNTIME_URL` |
| `live-aio17` | — | **never** (blocked pending an authorized test tenant) |

Known production identifiers are stored **only as SHA-256** in `production-ids.json` (tenants and runtime hosts in
clear — they are already public). `AION_PRODUCTION_*_SHA256` can add denied hashes, never remove one.
`AION_PROOF_DB_DISPOSABLE=1` (set job-wide in CI) skips only the "DB already holds non-proof rows" check, is honored
only when `GITHUB_ACTIONS=true`, and never skips production markers (`ol_metrics` schema, production-economic missions).

The runtime enforces the same intent independently: with `AION_PROOF=1`, `createGhlBackendFromEnv` throws unless
`GHL_BACKEND` is explicit (and `live` also needs `AION_PROOF_LIVE=1`). Outside a proof, behaviour is unchanged
(`GHL_BACKEND` unset + credentials => live) so deployed runtimes keep working until their `.env` sets it.

Tests: `npm run test:proof-safety` (backend selection + guard matrix incl. a capture server asserting zero requests
on every refusal, and a structural check that every proof script is guarded).
