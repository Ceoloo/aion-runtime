# Production Operator Loop v1

## Acceptance mission

Run one real, tenant-bound Lead-to-Appointment mission from the Operator Console.
Use a real client, lead, GHL contact, pipeline and stage, and a registered
tenant agent that has the workflow permissions. The Console operator principal
needs `invoke`; its human approval principal needs `approve`. The mission objective
must describe the business change sought. The workflow reads the live GHL
contact, proposes a governed opportunity create/update, then creates a follow-up
task and note and proposes a governed message draft. Sending a message and
booking an appointment remain human actions outside this workflow.

The fixture preset is PRE-OL only. Production launch rejects its identifiers and
an `@example.invalid` lead email. Record a truthful outcome: zero USD is valid
when no economic value has yet been realized; a positive value needs a CRM record
or other evidence reference.

## Operator sequence

1. In Console `/missions/new`, select OL-001 Production, enter the real target,
   choose Lead-to-Appointment v1, confirm launch, and save the mission URL.
2. In the approval queue, inspect the capability, proposed action data, risk,
   reason, mission and execution links. Add a decision note, then approve or deny.
3. On approval, Runtime resumes the same gated run and continues remaining
   steps from the command snapshot. A later governed step appears as a new gate.
   On denial, the gated action does not execute and the mission must be closed
   with a documented exception or cancelled.
4. Inspect the execution tree, approval records, and external side effects.
   Confirm every expected automated step succeeded before a normal close.
5. Close the mission in Console with a factual outcome summary, USD value, and
   supporting reference for any positive value. Console creates a durable
   `mission.terminal` outcome and records the economics snapshot on the mission.
6. Prove the rejection branch with a separate real, low-impact governed request:
   deny it in Console and confirm the run is denied and no external side effect
   was recorded. A rejected gate cannot also produce a completed approved path
   in the same run.

## Evidence required to call the test passed

| Claim | Durable evidence |
|---|---|
| Real objective | Mission ID, tenant, objective and real GHL target IDs |
| Agent execution | Root execution ID and step executions with actor, capability, status and timestamps |
| Human gate | Approval ID, proposed command, risk, reason, requested time and Console screenshot/record |
| Decision changes behavior | Decider identity, note and `approval.granted` or `approval.rejected` audit entry; side effect exists only after approval |
| Resume | Same gated run ID completes, later steps share the root execution ID and retain parent lineage |
| Outcome | Durable outcome ID, status, summary, value, currency, evidence reference and mission terminal record |
| Audit | Execution audit traces, approval records and GHL side effect IDs / external resource IDs |
| Metrics | Mission economics `totalDurationMs`, `humanInterventions`, `failureCount`, `totalCostUnits`, attributed value; Console retry count from repeated step executions |

Keep the mission ID, execution root, approval IDs, outcome ID, external resource
IDs, and an export of the mission economics together as the acceptance record.
Do not substitute a local fixture result or a readiness check for this record.
Cost is currently measured in abstract units; a USD cost or financial ROI needs
a priced ledger before it can be claimed.

## Current operating boundary

Continuation occurs during the approval decision request. A crash after an
external side effect but before its execution row is saved needs operator
reconciliation before any retry; submitting the same step again can repeat a
write. Do not call this acceptance passed until the live record above exists.

## Roadmap after a passing live record

Operator Loop v1 → GHL Adapter → Client Tenant Provisioning → First Client
Workflow → Observability/ROI → Repeatable AION Installation.

Each stage should consume the preceding mission evidence. The immediate next
stage is adapter hardening for the real GHL actions observed here, followed by
tenant setup and the first repeatable client workflow.
