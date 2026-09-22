# Sourced by EVERY proof / acceptance script, before anything else:
#   source "$(dirname "$0")/lib/proof-env.sh" [fake|live-capability|live-acceptance]
# 1) runs the fail-closed guard against the caller's ORIGINAL environment (exit 3 on refusal), then
# 2) marks the process tree as a proof (AION_PROOF=1) and, for fake mode, EXPLICITLY selects the fake GHL backend.
# Live selection is never set here: it must already be explicit in the caller's environment and pass the guard.
_proof_mode="${1:-fake}"
_proof_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "${_proof_lib}/proof-guard.mjs" --mode "${_proof_mode}" || exit 3
# Live modes: prove the credential is isolated to the designated test location (read-only probes) before anything runs.
case "${_proof_mode}" in live-*) node "${_proof_lib}/proof-credential-scope.mjs" || exit 3 ;; esac
export AION_PROOF=1
[ "${_proof_mode}" = fake ] && export GHL_BACKEND=fake
unset _proof_mode _proof_lib
