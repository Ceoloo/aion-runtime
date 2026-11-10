# Keycloak Gateway Integration — Sentinel Identity v0.2 (DRAFT)

AION Runtime ADR-005 remains authoritative. AION Data owns durable Actor
and aion_auth identity mapping. Sentinel only verifies a signed token and
resolves a pre-provisioned identity. This feature is **opt-in and disabled
until an authorized staging/prod rollout**.

**Verification plan (normative gate checklist):** see aion-docs
`architecture/sentinel-runtime-data-trust-boundary-verification.md`
(TechOps Monday Brief 2026-11-09; Linear AIO-121 / AIO-122). CI green and this
draft do **not** authorize persistent staging or production cutover.

## Configuration

| Variable | Default | Keycloak mode |
| --- | --- | --- |
| AION_AUTH_PROVIDER | api-key | keycloak |
| AION_AUTH_MODE | local: open, off-local: required | **required** |
| AION_KEYCLOAK_ISSUER | unset | required exact HTTPS realm URL |
| AION_KEYCLOAK_AUDIENCE | unset | required aion-runtime audience |
| AION_KEYCLOAK_ALLOWED_CLIENTS | unset | comma-separated exact client IDs |
| AION_GATEWAY_API_KEYS | existing config | **must be empty** |

Example placeholder (never a production configuration):
```sh
AION_AUTH_PROVIDER=keycloak
AION_AUTH_MODE=required
AION_KEYCLOAK_ISSUER=https://auth.example.test/realms/aion
AION_KEYCLOAK_AUDIENCE=aion-runtime
AION_KEYCLOAK_ALLOWED_CLIENTS=aion-console
```

## Authenticated request flow

Bearer JWT -> pinned Sentinel Keycloak RS256 verification -> current AION
Data `aion_auth.principal_bindings` lookup by exact iss/sub/azp -> durable
`actors` lookup -> Runtime Principal -> **existing** tenant + policy +
human approval gates. No self-provisioning or dynamic grants from token roles,
email, groups, tool output or request headers.

A signing key rotation, invalid audience/issuer, missing binding, Actor
revocation, missing Data/IdP, or failed verification must deny access.
Existing API key path stays unchanged until provider explicitly switched.

## Deployment sequence

1. Data [PR #28](https://github.com/Ceoloo/aion-data/pull/28) approved,
   migration 0015 applied only via authorized migrator in disposable staging;
   confirm aion_app SELECT only and no writes on aion_auth.
2. Sentinel [PR #2](https://github.com/Ceoloo/AION-SENTINEL/pull/2)
   approved and pinned; verify package checksum/source and negative tests.
3. Configure a Keycloak staging realm with audience mapper and real client,
   strict TLS, short-lived access tokens and MFA; no real customer identities.
4. Provision test bindings through an operator-controlled, auditable admin
   route **outside Runtime**; default bindings are disabled.
5. Test login, expiry, wrong client/issuer/audience, JWKS rollover, disabled
   bindings, human approval, cross-tenant access, backchannel logout and
   Keycloak/Data outage. Beware: JWT session logout alone does not invalidate
   already-issued signed tokens; disable binding or use introspection policy.
6. Run independent Cloudflare-derived source security review and evidence
   recording, then obtain human authorization to stage Runtime config change.
7. Rollback means switch AION_AUTH_PROVIDER back to api-key, restore last
   trusted image and revoke test bindings. Database migration is forward-only
   and remains (do not drop data without approved follow-up migration).

## Current limitations

This code has unit tests and uses pinned dependencies but does **not**
demonstrate Keycloak interoperability, immediate server-side token logout,
rollout rollback evidence, or production security approval. It must not be
merged on the strength of CI alone. Existing GE-001/AIO-111 deployment gates
are unaffected.

The mapping/schema repository source pins in `scripts/setup-deps.mjs` are
**draft commit SHAs**, not released supply-chain artifacts. After Data and
Sentinel PRs merge, refresh the pins to independently reviewed main commits
and rerun the full acceptance/image pipeline.

## Pull-request image smoke

The draft Runtime branch now also runs a GitHub Actions **PR-only image boot
check** after the full verify job. The image is loaded locally on the CI runner
and never pushed to any registry. It exercises the same ephemeral PostgreSQL
migration and non-root Runtime boot as `scripts/image-boot-check.sh`. It
validates packaging and default API-key boot, **not** Keycloak interoperability
or production readiness. Real Keycloak staging remains a separate human gate.
