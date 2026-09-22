/**
 * Approval-decision identity — the approver is derived from the authenticated principal, never the request body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlane } from '../control-plane.js';
import type { Principal } from './types.js';
import { resolveDecisionIdentity, approvalTenantId } from './decision-identity.js';

const ops: Principal = { principalId: 'principal_ops', kind: 'operator', actorId: 'act_human_fixture_1', tenantIds: ['tenant_a'], roles: ['invoke', 'approve'] };
const svc: Principal = { principalId: 'principal_svc', kind: 'service', actorId: 'act_service_fixture', tenantIds: ['tenant_a'], roles: ['invoke'] };
const humanActor = { actorId: 'act_human_fixture_1', actorType: 'human' } as never;

function cpWith(opts: { actors?: Record<string, unknown>; approval?: unknown; execTenant?: string }): ControlPlane {
  return {
    dataLayer: {
      actors: { async get(id: string) { return opts.actors?.[id]; } },
      approvals: { async get() { return opts.approval; } },
      executions: { async getByRunId() { return opts.execTenant ? { tenantId: opts.execTenant } : undefined; } },
    },
  } as unknown as ControlPlane;
}
const approvalIn = (tenant?: string) => ({ approvalId: 'apr_1', runId: 'run_1', ...(tenant ? { tenantId: tenant } : {}), command: { actor: { actorId: 'act_agent' } } });
const base = { approvalId: 'apr_1', bodyDecidedBy: undefined as unknown, bodyActor: undefined, tenantHeader: 'tenant_a' as string | undefined };
const never = async () => { throw new Error('legacy resolver must not run in required mode'); };
const run = (cp: ControlPlane, p: Principal | null, over: Partial<typeof base> = {}) =>
  resolveDecisionIdentity(cp, { ...base, ...over }, p, 'required', never as never);

test('authorized: decidedBy is derived from the principal; body may omit it', async () => {
  const r = await run(cpWith({ actors: { act_human_fixture_1: humanActor }, approval: approvalIn('tenant_a') }), ops);
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.decidedBy, 'act_human_fixture_1'); assert.equal(r.identitySource, 'derived'); assert.equal(r.principal?.principalId, 'principal_ops'); }
});

test('a body decidedBy that merely restates the derived id is accepted', async () => {
  const r = await run(cpWith({ actors: { act_human_fixture_1: humanActor }, approval: approvalIn('tenant_a') }), ops, { bodyDecidedBy: 'act_human_fixture_1' });
  assert.equal(r.ok, true);
});

test('impersonation: a different decidedBy (even a registered human) is denied', async () => {
  const cp = cpWith({ actors: { act_human_fixture_1: humanActor, act_human_other: { actorId: 'act_human_other', actorType: 'human' } }, approval: approvalIn('tenant_a') });
  const r = await run(cp, ops, { bodyDecidedBy: 'act_human_other' });
  assert.equal(r.ok, false); if (!r.ok) { assert.equal(r.status, 403); assert.equal(r.code, 'approver_mismatch'); }
});

test('impersonation: a body actor object for someone else is denied and is never used to register', async () => {
  const r = await run(cpWith({ actors: {}, approval: approvalIn('tenant_a') }), ops, { bodyActor: { actorId: 'act_human_forged', actorType: 'human' } as never });
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, 'approver_mismatch');
});

test('unauthenticated and non-approver principals are denied', async () => {
  const cp = cpWith({ actors: { act_human_fixture_1: humanActor }, approval: approvalIn('tenant_a') });
  const a = await run(cp, null); assert.equal(a.ok, false); if (!a.ok) assert.equal(a.status, 401);
  const b = await run(cp, svc); assert.equal(b.ok, false); if (!b.ok) assert.equal(b.code, 'approve_forbidden');
});

test('an unregistered principal actor is denied — required mode never registers it from the request', async () => {
  const r = await run(cpWith({ actors: {}, approval: approvalIn('tenant_a') }), ops, { bodyActor: humanActor });
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, 'actor_not_registered');
});

test('a registered non-human actor cannot approve', async () => {
  const r = await run(cpWith({ actors: { act_human_fixture_1: { actorId: 'act_human_fixture_1', actorType: 'agent' } }, approval: approvalIn('tenant_a') }), ops);
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, 'approver_not_human');
});

test('tenant boundary: header outside the principal, approval in another tenant, or undeterminable tenant → denied', async () => {
  const actors = { act_human_fixture_1: humanActor };
  const h = await run(cpWith({ actors, approval: approvalIn('tenant_a') }), ops, { tenantHeader: 'tenant_b' });
  assert.equal(h.ok, false); if (!h.ok) assert.equal(h.code, 'tenant_forbidden');
  const noHeader = await run(cpWith({ actors, approval: approvalIn('tenant_a') }), ops, { tenantHeader: undefined });
  assert.equal(noHeader.ok, false);
  const other = await run(cpWith({ actors, approval: approvalIn('tenant_b') }), ops);
  assert.equal(other.ok, false); if (!other.ok) assert.equal(other.code, 'tenant_forbidden');
  const unknown = await run(cpWith({ actors, approval: approvalIn(undefined) }), ops);
  assert.equal(unknown.ok, false); if (!unknown.ok) assert.equal(unknown.code, 'tenant_forbidden');
});

test('tenant is resolved from the execution when the approval row has none (legacy rows)', async () => {
  const cp = cpWith({ actors: { act_human_fixture_1: humanActor }, approval: approvalIn(undefined), execTenant: 'tenant_a' });
  assert.equal((await run(cp, ops)).ok, true);
  assert.equal(await approvalTenantId(cp, approvalIn(undefined) as never), 'tenant_a');
});

test('mode=open keeps the legacy resolver (local proofs) and never consults the principal', async () => {
  let called = 0;
  const legacy = async () => { called++; return { ok: true as const, decidedBy: 'legacy', actor: humanActor, principal: null, identitySource: 'claimed' as const }; };
  const r = await resolveDecisionIdentity(cpWith({}), base, null, 'open', legacy);
  assert.equal(r.ok, true); assert.equal(called, 1);
});
