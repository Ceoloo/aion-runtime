# CRM provider selection (CRM-001 / ADR-019)

Runtime selects the CRM system-of-engagement backend at boot.

| Env | Meaning | Production default |
|---|---|---|
| `CRM_PROVIDER` unset / `ghl` | GoHighLevel via existing adapter | **Required until Twenty proofs pass** |
| `CRM_PROVIDER=twenty` | Twenty SoE (`twenty-fake` or `twenty-live`) | Forbidden until CRM-001 Gate D |
| `GHL_BACKEND` | fake \| live for GHL | `live` |
| `TWENTY_BACKEND` | fake \| live when provider=twenty | explicit required in proof/prod |
| `TWENTY_API_BASE_URL` / `TWENTY_API_KEY` | Live Twenty connection | Internal URL e.g. `http://twenty-server:3000` |

## Rules

1. **Unset `CRM_PROVIDER` keeps production GHL behavior identical** to pre-CRM-001.
2. Do not set `CRM_PROVIDER=twenty` in production until workflow, isolation,
   governance, and rollback tests pass (Gate D).
3. Agents never receive Twenty/GHL credentials — only Runtime adapters.
4. Live Twenty HTTP mapping is implemented (`LiveTwentyBackend` →
   `/rest/people|opportunities|notes|tasks`). Use `TWENTY_BACKEND=fake` for
   Gate B proofs; disposable live proofs need `TWENTY_BACKEND=live` plus
   `AION_PROOF_LIVE=1` (see `docs/twenty-live-acceptance.md`).

## Cutover sequence

1. Non-prod Twenty compose (`--profile twenty`)
2. `npm run proof:rcaos-at-twenty` (fake) — Gate B
3. Live HTTP adapter against disposable workspace (`TWENTY_BACKEND=live`) — Gate C
4. Cutover gate (workflow + isolation + governance + rollback) — then production `CRM_PROVIDER=twenty`

See aion-docs `roadmap/crm-001-cutover-sequence.md`.

## Code

- Port: `src/adapters/crm/types.ts` (`CrmBackend`)
- Factory: `src/adapters/crm/create-backend.ts`
- Live Twenty: `src/adapters/crm/live-twenty-backend.ts` (`/rest/people|opportunities|notes|tasks`)
- Fake Twenty proof: `npm run proof:rcaos-at-twenty`
- Disposable live proof (manual / staging only): `npm run proof:twenty-live-acceptance`
- GHL leaf: `src/adapters/ghl/` (unchanged HTTP client; production default)
- Protected record hashes: `scripts/lib/production-ids.json` (`sha256.ghlRecordIds`, `sha256.twentyRecordIds`)
