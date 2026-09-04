# aion-runtime — Design Specs

Forward-looking **composition** designs. `aion-runtime` composes Core + Data into
a running service and owns the deployable image; it does not redefine contracts,
schema, or policy
([ADR-002](https://github.com/Ceoloo/aion-docs/blob/main/adr/ADR-002-runtime-host-ownership.md),
dependency rule #7). These specs describe how forthcoming platform capabilities
are **wired** here — nothing more.

| Spec | Drives | Priority | Status |
|---|---|---|---|
| [execution-gateway-composition.md](execution-gateway-composition.md) | [ADR-003](https://github.com/Ceoloo/aion-docs/blob/main/adr/ADR-003-execution-gateway-and-evidence.md) | P0 | Design |

## Ground rules

- **Compose, don't redefine.** New capability is wired as Core ports backed by
  Data adapters; no orchestration logic, schema, or provider SDK enters here.
- **The deployment contract is stable.** Wiring changes must not alter the
  provider-neutral workload behavior or break the portability check.
- **No secrets, no payloads in logs.** Operational logs carry references, hashes,
  and outcomes — never arguments or credentials.
