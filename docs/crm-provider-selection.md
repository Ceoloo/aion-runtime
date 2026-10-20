# CRM provider selection (CRM-001 / ADR-019)

Runtime selects the CRM system-of-engagement backend at boot.

| Env | Meaning | Production default |
|---|---|---|
| `CRM_PROVIDER` unset / `ghl` | GoHighLevel via existing adapter | **Required until Twenty proofs pass** |
| `CRM_PROVIDER=twenty` | Twenty SoE (`twenty-fake` or `twenty-live` stub) | Forbidden until CRM-001 gate |
| `GHL_BACKEND` | fake \| live for GHL | `live` |
| `TWENTY_BACKEND` | fake \| live when provider=twenty | explicit required in proof/prod |
| `TWENTY_API_BASE_URL` / `TWENTY_API_KEY` | Live Twenty connection | Internal URL e.g. `http://twenty-server:3000` |

## Rules

1. **Unset `CRM_PROVIDER` keeps production GHL behavior identical** to pre-CRM-001.
2. Do not set `CRM_PROVIDER=twenty` in production until workflow, isolation,
   governance, and rollback tests pass.
3. Agents never receive Twenty/GHL credentials — only Runtime adapters.
4. Live Twenty mutation dispatch is intentionally stubbed
   (`TWENTY_LIVE_NOT_IMPLEMENTED`) until the HTTP mapping slice lands; use
   `TWENTY_BACKEND=fake` for proofs.

## Code

- Port: `src/adapters/crm/types.ts` (`CrmBackend`)
- Factory: `src/adapters/crm/create-backend.ts`
- GHL leaf: `src/adapters/ghl/` (unchanged HTTP client)
