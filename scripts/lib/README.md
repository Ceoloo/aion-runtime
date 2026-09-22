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

### Live proofs verify credential ISOLATION, not just an attestation
`AION_PROOF_CREDENTIAL_SCOPE=test-location` is only an acknowledgement. Before any live proof runs, `proof-credential-scope.mjs`
proves isolation with read-only calls: the designated location is reachable, and a random location, agency-level search and
every **production** location are *denied* (real GHL answers a foreign location with 403 "The token does not have access to
this location"). Production location ids come from `/opt/aion/.env` on the host or `AION_PROOF_PRODUCTION_LOCATION_IDS`
supplied at run time; with neither, the check refuses. The GHL base URL is a constant (no override); unexpected statuses
(200 where denial is required, 404, 5xx, network error) refuse. Output is names + HTTP statuses only.

## CRM backend selection in the runtime itself (normal execution, not proofs)
`src/adapters/ghl/backend-policy.ts` is the single decision point, validated at startup by `loadConfig` (clean
`config_invalid` exit) and reported in the startup log and `/health/ready` (`crm_backend`).
| `AION_ENVIRONMENT` | `GHL_BACKEND` | credentials | result |
|---|---|---|---|
| production | unset | yes | **live** (legacy; warning `crm_backend_inferred` — set `GHL_BACKEND=live`) |
| production | `live` | yes | live |
| production | unset / blank | no | **refuses to start** (never falls back to fake) |
| production | `live` | no | **refuses to start** |
| production | `fake` | any | **refuses** unless `AION_ACK_FAKE_CRM=1` (image boot-certification only); then logged at error level, `crm_backend=fake` |
| non-production | unset | yes / no | live / fake (unchanged) |
| any | other value | any | refuses |
`npm run` demo of every row against the real process: `scripts/demo-crm-backend-behavior.mjs`.

The runtime enforces the same intent independently for proofs: with `AION_PROOF=1`, `createGhlBackendFromEnv` throws unless
`GHL_BACKEND` is explicit (and `live` also needs `AION_PROOF_LIVE=1`). Outside a proof, behaviour is unchanged
(`GHL_BACKEND` unset + credentials => live) so deployed runtimes keep working until their `.env` sets it.

Tests: `npm run test:proof-safety` (backend selection + guard matrix incl. a capture server asserting zero requests
on every refusal, and a structural check that every proof script is guarded).
