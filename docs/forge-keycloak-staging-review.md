# AION Forge — Keycloak interoperability, staging audit and approval record

**Scope:** Runtime [issue #73](https://github.com/Ceoloo/aion-runtime/issues/73) and draft [PR #74](https://github.com/Ceoloo/aion-runtime/pull/74). Status at authoring: **review and real deployment approval pending**.

## What was added

The pull-request-only GitHub Actions job `forge-keycloak-interop` starts a **real upstream Keycloak 26.8.2 container** on HTTPS loopback with a short-lived, ephemeral self-signed certificate. It provisions a disposable realm/client/user via the actual Keycloak Administration API; obtains a **Keycloak-issued OAuth access token** and passes it through the **real AION Runtime HTTP gateway**, which uses Sentinel's **remote HTTPS JWKS**. The Runtime's Data-backed Principal and Actor are provisioned in a throwaway PostgreSQL 16 database with a distinct migrator and non-owner `aion_app` credential.

The proof asserts: access-token issuer, audience, `azp`, signing-key JWKS; Runtime 409 execution-disabled after signed identity and durable audit readback; deterministic replay; cross-tenant HTTP and DB RLS denial; wrong client/audience and altered signature; disabled identity binding; missing Actor capability; post-migration app role no UPDATE/DELETE on audit and no INSERT on identity bindings; actual revoked database INSERT leads to fail-closed HTTP 503. No client keys, tokens, private signing keys or passwords are written into the evidence artifact.

**The job is intentionally a disposable, PR-only technical integration environment, not an approved deployment to AION's persistent staging infrastructure.** It runs Keycloak `start-dev` with ephemeral TLS for test isolation. That mode is strictly prohibited for any real network-exposed staging/production service.

## Evidence

GitHub Actions job: `forge-keycloak-interop`; artifact: `forge-real-keycloak-interop-evidence` (JSON), 14-day retention. The artifact contains a run SHA, synthetic IDs, test check results, and explicit booleans `approvedDeployment:false`, `realStagingDeployment:false`. Logs have no tokens or passwords. A passed run is evidence of CI interoperability **only**.

Keycloak version is deliberately pinned to 26.8.2, [upstream release 2026-11-05](https://github.com/keycloak/keycloak/releases/tag/26.8.2). The image tag is used only within GitHub's disposable runner. Before persistent staging, pin and independently verify the image digest and SBOM/vulnerability scan.

## Engineering security review (initial)

| Control | Code or evidence | Decision |
|---|---|---|
| JWT verification | Sentinel jose RS256; HTTPS JWKS, exact issuer/audience/client; max age | Security gate implemented, live Keycloak CI proof required |
| Principal-to-Actor | exact issuer+subject+client mapping, app SELECT-only; Actor read from Data | Trust source is durable Data, no auto-provisioning |
| Tenant scope | Principal tenantIds constrain header; Data RLS on forge audit | Negative HTTP and DB tests required |
| Audit record | event ID deterministic, append with committed ack/readback | Blocks on unavailable sink |
| Append-only | Data migration 0016 plus Runtime post-grants REVOKE UPDATE/DELETE | Verify actual app privilege after deployment |
| Invocation | ForgeSessionLaunch returns 409 after audit, no Orchestrator or Herdr | No execution authorized |
| Data provenance | Scoped fields only; no prompt, raw shell or bearer persisted | Log and negative test review required |
| Keycloak failure modes | unit-tested invalid/missing JWKS, issuer/aud/kid/exp | Remote JWKS outage, rollover and revocation SLA must be checked in real staging |
| Secrets | CI ephemeral cert, admin password, client secret; mask and cleanup | Credentials never commit to repo |
| Supply chain | Reviewed source refs required, image tag not yet digest pinned | BLOCK persistent staging until verified |

**Review concern:** JWT logout is not an instant revocation primitive; active signed access tokens are valid until expiry unless binding or Actor is disabled. Set policy and response time targets, and test binding disable across all runtime replicas.

**Review concern:** This audit-only endpoint currently records a `forge.session.requested` event and returns 409, with no Run/Execution IDs. This must never be misrepresented as an approved run. Registering `forge.session.launch` / Runtime worker is a separate R3 decision. Further harden request/identity rate limits and maximum concurrent JWKS refresh on a persistent environment.

**Review concern:** CI test users use password direct-grant solely to obtain reproducible tokens in disposable isolated Keycloak. Persistent staging MUST use the approved authorization-code/PKCE or appropriate workload identity flow with MFA/short token lifetimes and no password grant enabled.

## Real, persistent staging acceptance matrix — still required

1. [ ] **Approval to use environment**: operator identifies and approves exact staging deployment target, account/workspace, network segment, nonproduction database and rollback owner.
2. [ ] **Source gate**: Sentinel PR #1, Data PR #29 and Runtime PR #74 reviewed/merged in dependency order, pinned to approved immutable SHA/image digests; confirm source, dependencies, SBOM and CVE assessment.
3. [ ] **Data gate**: migration 0015+0016 executed only by authorized migrator in isolated staging. Test the real app credential: SELECT-only on bindings; SELECT+INSERT/no UPDATE/DELETE on Forge audit.
4. [ ] **Real Keycloak**: operator-owned HTTPS issuer (trusted certificate), dedicated realm/client, audience mapper, MFA for humans, least-privilege machine identity, approved token lifetime. No test password grant or `start-dev` in persistent staging.
5. [ ] **Security negatives**: tampered signing key, invalid audience/client/issuer, expired token, disabled/revoked binding, revoked agent, cross-tenant reads, signature rotation, remote JWKS outage and cache invalidation, DB outage/replay conflicts.
6. [ ] **End-to-end**: real Keycloak-issued access token → Runtime authenticated Principal/Actor → Data eventId/requestId/tenantId/principalId/actorId durable readback; capture 409 disabled outcome; no agent run/terminal.
7. [ ] **Rollback**: observed healthy/rollback serving digest, deployment revision, security gate logs, principal disabling, database forward-only migration policy and operator incident contact.
8. [ ] **Approvals**: independent security reviewer, deployment maintainer and operator sign off on the evidence before persistent staging activation or merge. Record dates and identifiers.

## Approval record — deliberately UNAPPROVED

| Field | Value |
|---|---|
| Decision | **BLOCKED / NOT APPROVED** |
| CI run | Pending latest GitHub Actions evidence |
| Keycloak source/immutable image digest | Pending review |
| Runtime and Data approved SHAs | Pending review |
| Persistent staging deployment URL/environment | Not identified or authorized |
| Verified real staging certificate chain | Pending |
| Security reviewer / time | Not assigned |
| Deployment maintainer / time | Not assigned |
| Operator approver / time | Not assigned |
| Rollback release digest / observed readback | Pending |
| v0.3 worker authorization | **Not authorized** |

This report is a review handoff, not a signature or release authorization. Do not promote a CI result to 'approved staging evidence' without the actual operator/maintainer sign-offs.
