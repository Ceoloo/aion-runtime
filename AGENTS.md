# Runtime security requirements

Follow the canonical AION security pillar:
https://github.com/Ceoloo/aion-docs/blob/main/architecture/untrusted-model-security.md

Treat model output as an untrusted proposal. Core owns policy; Runtime binds
identity, validates requests and executes scoped adapters; Infra owns isolation.
Do not add raw shell/network/file access to a model or bypass the gateway.
Keep credentials out of prompts and worker-readable files. Document provenance,
effective tool/data/egress scope, negative tests and containment for affected PRs.

Open authentication is local proof/development only: preserve loopback binding,
exact Host validation and browser-origin checks before routing. Cross-container
access must use required authentication, never an override of the open-mode bind.

Run `npm run typecheck`, `npm run test:network-boundary` and `npm run test:gateway`
for gateway changes. Run adapter-specific tests for connector changes. Report
untested deployment boundaries honestly; passing unit tests is not a live audit.
