# Approval-decision identity (POST /v1/approvals/:id/decision)

**Rule (auth mode `required`, i.e. every staging/production deployment):** the approver is *derived on the server* from the authenticated principal.

```
Bearer token ──authn──▶ Principal (principalId, kind, actorId, tenantIds, roles)
                              │  role `approve` required
                              ▼
                 approvals.decided_by = principal.actorId   (FK → actors; must be a registered HUMAN actor)
```
- The body needs only `approve` (and optional `note`). `decidedBy` may be omitted; if sent it must equal `principal.actorId`, else `403 approver_mismatch`.
  A client-supplied `actor` object is never used (not to identify, not to register): a different `actorId` is `403 approver_mismatch`; the same id is ignored.
- The approver actor is **not** created from the request. If `principal.actorId` is not a registered human actor → `403 actor_not_registered` (register it out of band).
- **Tenant boundary:** the request's `x-aion-tenant-id` must be one of `principal.tenantIds`, and the approval's own tenant (`approvals.tenant_id`, else its execution's tenant, else the command's)
  must be that tenant. Unknown/undeterminable tenant → `403 tenant_forbidden`. (Before this change the route did not check the approval's tenant at all — an operator bound to tenant A could decide tenant B's approval.)
- Unchanged: a worker cannot approve its own gate; only human actors approve; a decided approval cannot be re-decided (`409`); a *rejection* is answered `403` with body `status: denied`.
- `mode=open` (local proofs only) keeps the legacy contract (body identifies the approver).

## Audit attribution
`approvals.decided_by` = the approver actor id. The execution audit trace event `approval.granted|rejected` now records `{approvalId, decidedBy, principalId, principalKind, identitySource:"derived"}`,
and the `gateway_approval_decided` log adds `principal_id`; denied attempts log `gateway_approval_decision_denied` (code, principal).

## What the identity means
A principal is a **credential**. If several people share one operator token, `decided_by` identifies that **operator account**, not a uniquely authenticated person. To attribute to a person, issue one principal
(and one registered human actor) per person, or put the person's name in `note` and treat it as asserted. `act_human_ops_1` in `.env.example` is a template value, not a verified identity.

## Tests
`npm run test:decision-identity` (10 unit tests, mutation-checked) and an end-to-end run against a real process + an isolated Postgres restored from production (impersonation, cross-tenant, unauthorized, unregistered, repeat, authorized approve/reject).
