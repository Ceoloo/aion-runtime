# Durable revenue workflow proof

Proves **one** AION revenue path end-to-end on Runtime + Postgres:

`Lead/Contact → Opportunity → Task/Note → agent execution → human gate →
outcome → execution record → cost/value measurement`

GoHighLevel (AIO-17) is the CRM plane for this proof — not a standalone
integration exercise. Conversation send and appointment create stay
`CAPABILITY_DISABLED`.

## Run

```bash
export MIGRATION_DATABASE_URL=postgresql://aion_migrator:…@localhost:5432/aion_data
export DATABASE_URL=postgresql://aion_app:…@localhost:5432/aion_data
export DATABASE_SSL=false
npm run proof:revenue-workflow
```

Uses `FakeGhlBackend` when `GHL_*` keys are unset (CI / local).

## Matrix

| Pass | Proof |
|---|---|
| A | Contact upsert (R2 → human approve) |
| B | Opportunity create (R2 → human approve) |
| C | Note + Task (R1 agent) + side-effect ledger |
| D | Stage update parks at human gate; handoff written |
| E | Runtime kill/restart; approval resume executes |
| F | Tenant workspace isolation |
| G | Durable Outcome `realized` with USD value |
| H | Execution cost units + `revenueAttributed` + scope economics |
| I | Execution ↔ side-effect audit |
| J | `conversation.read` still `CAPABILITY_DISABLED` (send/appt.create deferred) |

Telemetry lines answer: Did it work? Did a human intervene? What did it cost?
What business value did it create?

## Related

- Adapter fixtures: `docs/ghl-aio17-lead-workflow.md`
- Mission 009 GHL plane: `npm run proof:mission009`
- Platform DoD: `aion-docs/architecture/execution-platform-v1.md` §12
