/**
 * IE-002 acceptance matrix against live Runtime HTTP.
 *
 * Proves provisioning is a governed state machine and that
 * activation_ready ≠ active (approvedBy required).
 *
 * Invoked by scripts/ie002-proof-matrix.sh.
 */
import { ACTIVATION_REQUIRED_STEPS } from '@aion/core';
import { RuntimeApiError } from './clients/runtime-client.js';

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8102'}`;
const TENANT_A = 'aion-systems';
const TENANT_B = 'aion-media';

function fail(name: string, msg: string): never {
  console.error(`[FAIL ${name}] ${msg}`);
  process.exit(1);
}

function ok(name: string, msg: string): void {
  console.log(`[PASS ${name}] ${msg}`);
}

async function api(
  method: string,
  path: string,
  tenantId: string | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (tenantId) headers['x-aion-tenant-id'] = tenantId;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

function caseIdOf(json: Record<string, unknown>): string {
  const c = json['case'] as Record<string, unknown> | undefined;
  const id = c?.['caseId'];
  if (typeof id !== 'string') {
    throw new Error(`missing caseId in response: ${JSON.stringify(json)}`);
  }
  return id;
}

function deliveryOf(json: Record<string, unknown>): string {
  const c = json['case'] as Record<string, unknown> | undefined;
  return String(c?.['deliveryStatus'] ?? '');
}

async function createCase(tenantId: string, clientRef: string): Promise<string> {
  const res = await api('POST', '/v1/implementations', tenantId, {
    clientRef,
    clientName: `IE002 ${clientRef}`,
    ownerId: 'ops-proof',
    commercialStatus: 'paid',
  });
  if (res.status !== 201) {
    fail('create', `expected 201 got ${res.status}: ${JSON.stringify(res.json)}`);
  }
  return caseIdOf(res.json);
}

async function toBlueprintApproved(tenantId: string, clientRef: string): Promise<string> {
  const id = await createCase(tenantId, clientRef);
  let res = await api('POST', `/v1/implementations/${id}/intake`, tenantId, {
    businessContext: 'leads drop after inquiry',
    primaryBottleneck: 'leads_lost_inquiry_followup',
    measurableProblem: 'no follow-up SLA',
    namedOwner: 'ops-proof',
    accessReady: true,
    approvedScope: true,
    deliveryCapacityFeasible: true,
  });
  if (res.status !== 200) fail('intake', JSON.stringify(res.json));
  res = await api('POST', `/v1/implementations/${id}/blueprint`, tenantId, {
    packageKey: 'revenue_os',
    deliveryOwner: 'ops-proof',
  });
  if (res.status !== 200) fail('blueprint', JSON.stringify(res.json));
  res = await api('POST', `/v1/implementations/${id}/blueprint/approve`, tenantId, {
    approvedBy: 'ops-proof',
  });
  if (res.status !== 200 || deliveryOf(res.json) !== 'blueprint_approved') {
    fail('approve', JSON.stringify(res.json));
  }
  return id;
}

async function verifyAllSteps(tenantId: string, caseId: string): Promise<void> {
  for (const key of ACTIVATION_REQUIRED_STEPS) {
    const res = await api(
      'POST',
      `/v1/implementations/${caseId}/provisioning/steps/${key}`,
      tenantId,
      {
        status: 'verified',
        evidence: `proof-${key}`,
        completedBy: 'ops-proof',
      },
    );
    if (res.status !== 200) {
      fail(`verify:${key}`, JSON.stringify(res.json));
    }
  }
}

async function main(): Promise<void> {
  // ── Start before blueprint approval → Reject ───────────────────────────
  {
    const id = await createCase(TENANT_A, `early-${Date.now()}`);
    const res = await api(
      'POST',
      `/v1/implementations/${id}/provisioning/start`,
      TENANT_A,
      { startedBy: 'ops-proof' },
    );
    if (res.status !== 409) {
      fail('start-before-blueprint', `expected 409 got ${res.status}`);
    }
    ok('start-before-blueprint', 'rejected before blueprint approval');
  }

  // ── Happy path through activation_ready + approvedBy gate ──────────────
  const caseId = await toBlueprintApproved(TENANT_A, `gate-${Date.now()}`);
  {
    let res = await api(
      'POST',
      `/v1/implementations/${caseId}/provisioning/start`,
      TENANT_A,
      { startedBy: 'ops-proof' },
    );
    if (res.status !== 200 || deliveryOf(res.json) !== 'provisioning') {
      fail('start-provisioning', JSON.stringify(res.json));
    }
    ok('start-provisioning', 'blueprint_approved → provisioning');

    // Verify without evidence
    res = await api(
      'POST',
      `/v1/implementations/${caseId}/provisioning/steps/ghl_connection`,
      TENANT_A,
      { status: 'verified', completedBy: 'ops-proof' },
    );
    if (res.status !== 409) {
      fail('verify-no-evidence', `expected 409 got ${res.status}`);
    }
    ok('verify-no-evidence', 'rejected');

    // Verify without completedBy
    res = await api(
      'POST',
      `/v1/implementations/${caseId}/provisioning/steps/ghl_connection`,
      TENANT_A,
      { status: 'verified', evidence: 'loc connected' },
    );
    if (res.status !== 409) {
      fail('verify-no-completedBy', `expected 409 got ${res.status}`);
    }
    ok('verify-no-completedBy', 'rejected');

    // Ready with missing step
    res = await api(
      'POST',
      `/v1/implementations/${caseId}/activation/ready`,
      TENANT_A,
      { markedBy: 'ops-proof' },
    );
    if (res.status !== 409) {
      fail('ready-incomplete', `expected 409 got ${res.status}`);
    }
    ok('ready-incomplete', 'rejected with missing steps');

    await verifyAllSteps(TENANT_A, caseId);
    res = await api(
      'POST',
      `/v1/implementations/${caseId}/activation/ready`,
      TENANT_A,
      { markedBy: 'ops-proof' },
    );
    if (res.status !== 200 || deliveryOf(res.json) !== 'activation_ready') {
      fail('activation-ready', JSON.stringify(res.json));
    }
    ok('activation-ready', 'all steps verified → activation_ready');

    res = await api('POST', `/v1/implementations/${caseId}/activate`, TENANT_A, {});
    if (res.status !== 400 || res.json['error'] !== 'approved_by_required') {
      fail(
        'activate-no-approvedBy',
        `expected 400 approved_by_required got ${res.status} ${JSON.stringify(res.json)}`,
      );
    }
    ok('activate-no-approvedBy', '400 approved_by_required');

    res = await api('POST', `/v1/implementations/${caseId}/activate`, TENANT_A, {
      approvedBy: 'ops-proof',
    });
    if (res.status !== 200 || deliveryOf(res.json) !== 'active') {
      fail('activate-with-approval', JSON.stringify(res.json));
    }
    ok('activate-with-approval', 'active');

    // Re-activate idempotent
    res = await api('POST', `/v1/implementations/${caseId}/activate`, TENANT_A, {
      approvedBy: 'ops-other',
    });
    if (res.status !== 200 || deliveryOf(res.json) !== 'active') {
      fail('reactivate-idempotent', JSON.stringify(res.json));
    }
    const meta = (res.json['case'] as Record<string, unknown>)['metadata'] as
      | Record<string, unknown>
      | undefined;
    if (meta?.['activatedBy'] !== 'ops-proof') {
      fail('reactivate-idempotent', 'activatedBy should remain original ops-proof');
    }
    ok('reactivate-idempotent', 'already-active returns same activation');
  }

  // ── Tenant isolation ───────────────────────────────────────────────────
  {
    const res = await api(
      'GET',
      `/v1/implementations/${caseId}`,
      TENANT_B,
    );
    if (res.status !== 403 || res.json['error'] !== 'tenant_isolation_denied') {
      fail(
        'tenant-isolation',
        `expected 403 tenant_isolation_denied got ${res.status} ${JSON.stringify(res.json)}`,
      );
    }
    ok('tenant-isolation', 'Tenant B cannot read Tenant A case');
  }

  // ── Commercial paid alone never activates ──────────────────────────────
  {
    const id = await createCase(TENANT_A, `commercial-only-${Date.now()}`);
    const res = await api('POST', `/v1/implementations/${id}/activate`, TENANT_A, {
      approvedBy: 'ops-proof',
    });
    if (res.status !== 409) {
      fail('commercial-only', `expected 409 got ${res.status}`);
    }
    const get = await api('GET', `/v1/implementations/${id}`, TENANT_A);
    if (deliveryOf(get.json) !== 'draft') {
      fail('commercial-only', `delivery drifted to ${deliveryOf(get.json)}`);
    }
    ok('commercial-only', 'paid commercial status alone never activates');
  }

  console.log('[PASS IE-002] acceptance matrix green');
}

main().catch((err) => {
  if (err instanceof RuntimeApiError) {
    fail('runtime', `${err.status} ${err.code}: ${err.message}`);
  }
  console.error(err);
  process.exit(1);
});
