# Forge v0.2 → Runtime issue #73: trust bridge implementation

State: REVIEW ONLY; not deployed or production-authorized. Date: 2026-11-07.

## Invariant
Only the existing POST /v1/commands Runtime gateway handles Forge requests. The forge.session.launch and forge.session.launch@1 names are recognized as AUDIT-ONLY and ALWAYS return 409 forge_execution_disabled following a durable readback. No execution service, worker, terminal API or new privilege is registered.

The handler requires Keycloak provider with required auth, verifies tenant within the Sentinel-signed Principal's durable bindings, reloads the canonical Actor from Data, checks kind, revocation, explicit forge.session.launch grant, R3 ceiling and forbidden capabilities, and records a strict event with requestId, principalId, actorId, tenantId, workspaceId and template. The actor in the request body is only compared to the Principal actor ID; its grants and risk claims cannot elevate permissions. No token, prompt, command, raw path or shell output is written.

An audit failure returns a redacted HTTP 503 and no Runtime submission. Successful audit returns 409, still no execution. A cryptographic event UUID is deterministic for retries, while Data verifies fingerprint/readback. RunId and executionId are intentionally absent because NO work was started; a future registered R3 worker must correlate those IDs via independently reviewed audited events.

## Client compatibility
Forge PR #5 sends requestId forge-<UUID>, name ForgeSessionLaunch, serviceKey forge.session.launch, actor, payload with workspaceId and template, metadata with forgeRequestId/source and staging environment. Runtime accepts only that narrow shape; metadata must match and never grants authority. Registering a catalog service and runtime worker is explicitly deferred.

## Deployment grant fix
Runtime sql/grants.sql has a broad SELECT+INSERT+UPDATE grant on ALL public tables after migrations; this inadvertently would restore UPDATE on Forge audit evidence. This PR re-revokes UPDATE/DELETE on forge_audit_events after that grant. An isolated PostgreSQL test queries has_table_privilege for the actual aion_app role after applying Runtime's migration+grants sequence. This was a real cross-repository security gap.

## Cryptographically signed CI proof (NOT a live Keycloak server)
CI provisions disposable PostgreSQL 16, an RSA keypair, actual RS256-signed short-lived JWTs, Sentinel jose signature/claims verification with an injected local JWKS key resolver, and durable identity/actor bindings. It performs an actual Data audit insert and readback under nonowner app credentials. Negative tests include invalid signature, issuer, audience, azp, expiry, revoked binding, denied Actor grant, cross tenant, idempotent replay, RLS isolation, no UPDATE/DELETE and simulated audit outage. It never starts a session or worker.

Only run npm run proof:forge-trust in disposable GitHub Actions; the script refuses when GITHUB_ACTIONS or AION_PROOF_DB_DISPOSABLE=1 is missing, credentials overlap, or recognizable production providers occur. The test cleans synthetic records.

## Required actual staging evidence before activation
- [ ] Sentinel foundation PR #1 merged, signed artifact reviewed and repinned.
- [ ] AION Data PR #29 merged after independent migration review, audited migration 0016 applied ONLY to isolated staging, Runtime DATA_REF repinned to reviewed main.
- [ ] Real HTTPS Keycloak staging issuer, audience, client, operator-provisioned subject binding, MFA and signing-key rotation validated with actual access tokens (not CI synthetic token).
- [ ] Runtime signed identity → Data mapping → Actor → audit readback verified with requestId/eventId, tenant/principal/actor attribution; collect machine-readable evidence.
- [ ] Negative tests: invalid/expired tokens, wrong client/audience/issuer, disabled/compromised binding, revoked agent, cross-tenant, JWKS outage/rollover, DB outage, replay, privilege checks and audit conflict.
- [ ] Security reviewer plus maintainer/operator approve staging deployment, record rollback digest and no production secrets.
- [ ] Forge service catalog capability remains UNREGISTERED, Herdr/worker DISABLED until separate R3 approval and worker isolation.

CI GREEN IS NOT actual Keycloak staging proof or deployment authorization. AIO-111/GE-001 gates remain untouched.
