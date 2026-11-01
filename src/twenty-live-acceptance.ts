/**
 * Gate C — disposable Twenty live acceptance (CRM-001).
 *
 * Fails closed unless proof-guard already admitted live-twenty mode
 * (AION_PROOF_LIVE=1, CRM_PROVIDER=twenty, TWENTY_BACKEND=live, staging URL/key).
 * Never invoked from default CI — secrets must be operator-supplied.
 *
 * Happy path (disposable workspace):
 *   create contact → opportunity → note → task via Runtime
 *   assert backend evidence is twenty-live
 *
 * Cross-tenant isolation:
 *   - Preferred: set TWENTY_API_KEY_B (second staging workspace) and complete
 *     isolation via a second process with that key.
 *   - Alternative: two-process — run this script twice with distinct keys and
 *     compare evidence offline (documented in docs/twenty-live-acceptance.md).
 */
import {
  createAgentActor,
  createHumanActor,
  capability,
  formatServiceKey,
  newRequestId,
} from '@aion/core';
import { resolveTwentyConnection } from './adapters/crm/live-twenty-backend.js';
import { RuntimeClient } from './clients/runtime-client.js';
import {
  SYNTHETIC_BUSINESS_VALUE_USD,
  type CommandResponse,
  approveIfNeeded,
  assertPersistedSideEffect,
  awaiting,
  backendOf,
  errorCode,
  externalId,
  fail,
  ok,
  succeeded,
} from './ghl-acceptance-helpers.js';

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[proof] ${name} must be set explicitly (no default)`);
    process.exit(3);
  }
  return v;
}

const BASE_URL =
  process.env.AION_RUNTIME_URL ?? `http://127.0.0.1:${process.env.PORT ?? '8107'}`;
const TENANT = requiredEnv('TWENTY_ACCEPTANCE_TENANT');
const EVIDENCE_PATH =
  process.env.TWENTY_LIVE_EVIDENCE_PATH ?? '.proof-twenty-live-evidence.json';

const PERMS = [
  capability('crm.contact.read'),
  capability('crm.contact.search'),
  capability('crm.contact.update'),
  capability('crm.opportunity.read'),
  capability('crm.opportunity.create'),
  capability('crm.opportunity.update'),
  capability('crm.pipeline.read'),
  capability('crm.note.create'),
  capability('crm.task.create'),
];

function requireLiveConfig(): void {
  if (process.env.AION_PROOF_LIVE !== '1') {
    fail('CONFIG', 'live-twenty fails closed: AION_PROOF_LIVE=1 required');
  }
  if ((process.env.CRM_PROVIDER ?? '').trim().toLowerCase() !== 'twenty') {
    fail('CONFIG', 'live-twenty fails closed: CRM_PROVIDER=twenty required');
  }
  if ((process.env.TWENTY_BACKEND ?? '').trim().toLowerCase() !== 'live') {
    fail('CONFIG', 'live-twenty fails closed: TWENTY_BACKEND=live required');
  }
  if (!resolveTwentyConnection(process.env)) {
    fail(
      'CONFIG',
      'live-twenty fails closed: TWENTY_API_BASE_URL and TWENTY_API_KEY required',
    );
  }
  if (process.env.AION_PROOF_CREDENTIAL_SCOPE !== 'disposable-twenty') {
    fail(
      'CONFIG',
      'live-twenty fails closed: AION_PROOF_CREDENTIAL_SCOPE=disposable-twenty required',
    );
  }
}

async function submitAndApprove(
  client: RuntimeClient,
  human: ReturnType<typeof createHumanActor>,
  proposed: CommandResponse,
  note: string,
): Promise<CommandResponse> {
  if (awaiting(proposed)) {
    return approveIfNeeded(client, proposed, human, note);
  }
  return proposed;
}

async function requireLedger(
  client: RuntimeClient,
  pass: string,
  res: CommandResponse,
): Promise<void> {
  await assertPersistedSideEffect(client, TENANT, pass, {
    sideEffectId: String(res.result?.output?.['sideEffectId'] ?? ''),
    executionId: res.execution?.executionId ?? '',
  });
}

async function main(): Promise<void> {
  requireLiveConfig();

  const client = new RuntimeClient({ baseUrl: BASE_URL, tenantId: TENANT });
  const primary = createAgentActor({
    name: 'TwentyLiveAcceptanceAgent',
    purpose: 'Disposable Twenty live acceptance (Gate C)',
    owner: 'aion-runtime/proof',
    domain: 'revenue',
    role: 'copilot',
    tenantId: TENANT,
    companyId: 'co_aion',
    permissions: PERMS,
    maxRiskLevel: 'R3',
    autonomyLevel: 'L2',
  });
  const human = createHumanActor({
    name: 'Twenty Live Approver',
    permissions: [
      capability('crm.contact.update'),
      capability('crm.opportunity.create'),
      capability('crm.opportunity.update'),
    ],
  });

  const evidence: Record<string, unknown> = {
    mode: 'live-twenty',
    gate: 'C',
    valueKind: 'synthetic',
    tenant: TENANT,
    crmProvider: 'twenty',
    twentyBackend: 'live',
    syntheticBusinessValueUsd: SYNTHETIC_BUSINESS_VALUE_USD,
    crossTenant: {
      mode: process.env.TWENTY_API_KEY_B?.trim()
        ? 'same-process-TWENTY_API_KEY_B'
        : 'two-process-or-unset',
      documentedIn: 'docs/twenty-live-acceptance.md',
    },
    startedAt: new Date().toISOString(),
  };

  const runTag = Date.now();
  evidence['runTag'] = runTag;

  // --- contact create (fixture email) ---
  let contactRes = (await client.submitCommand({
    name: 'twenty-live-contact-create',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.contact.update', 1),
    payload: {
      email: `aion.twenty.live.${runTag}@example.invalid`,
      firstName: 'AionTwenty',
      lastName: `Live${runTag}`,
      upsert: true,
      matchConfidence: 0.95,
      idempotencyKey: `twenty-live-contact-${runTag}`,
    },
    metadata: {
      tenantId: TENANT,
      proof: 'twenty-live-acceptance',
      synthetic: true,
    },
  })) as CommandResponse;
  contactRes = await submitAndApprove(
    client,
    human,
    contactRes,
    'approve twenty disposable contact',
  );
  if (!succeeded(contactRes)) {
    fail('A', `contact create failed: ${errorCode(contactRes)}`);
  }
  if (backendOf(contactRes) !== 'twenty-live') {
    fail('A', `expected backend twenty-live, got ${backendOf(contactRes)}`);
  }
  const contactId = externalId(contactRes);
  if (!contactId) fail('A', 'contact create returned no external id');
  await requireLedger(client, 'A', contactRes);
  ok('A', `fixture contact created id=${contactId.slice(0, 8)}…`);

  // --- opportunity create ---
  let oppRes = (await client.submitCommand({
    name: 'twenty-live-opp-create',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.opportunity.create', 1),
    payload: {
      contactId,
      name: `AION Twenty disposable ${runTag}`,
      stage: 'NEW',
      idempotencyKey: `twenty-live-opp-${runTag}`,
    },
    metadata: {
      tenantId: TENANT,
      proof: 'twenty-live-acceptance',
      synthetic: true,
    },
  })) as CommandResponse;
  oppRes = await submitAndApprove(
    client,
    human,
    oppRes,
    'approve twenty disposable opportunity',
  );
  if (!succeeded(oppRes)) {
    fail('B', `opportunity create failed: ${errorCode(oppRes)}`);
  }
  const opportunityId = externalId(oppRes);
  if (!opportunityId) fail('B', 'opportunity create returned no external id');
  await requireLedger(client, 'B', oppRes);
  ok('B', `fixture opportunity created id=${opportunityId.slice(0, 8)}…`);

  // --- note.create (body, not bodyV2) on fixture ---
  let noteRes = (await client.submitCommand({
    name: 'twenty-live-note-create',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.note.create', 1),
    payload: {
      contactId,
      body: `AION Twenty live acceptance synthetic note ${runTag}`,
      idempotencyKey: `twenty-live-note-${runTag}`,
    },
    metadata: {
      tenantId: TENANT,
      proof: 'twenty-live-acceptance',
      synthetic: true,
    },
  })) as CommandResponse;
  noteRes = await submitAndApprove(client, human, noteRes, 'approve twenty disposable note');
  if (!succeeded(noteRes)) {
    fail('C', `note create failed: ${errorCode(noteRes)}`);
  }
  await requireLedger(client, 'C', noteRes);
  ok('C', 'note.create succeeded on fixture contact (body field path)');

  // --- task.create on fixture ---
  let taskRes = (await client.submitCommand({
    name: 'twenty-live-task-create',
    actor: primary,
    requestId: newRequestId(),
    serviceKey: formatServiceKey('crm.task.create', 1),
    payload: {
      contactId,
      title: `AION Twenty live task ${runTag}`,
      idempotencyKey: `twenty-live-task-${runTag}`,
    },
    metadata: {
      tenantId: TENANT,
      proof: 'twenty-live-acceptance',
      synthetic: true,
    },
  })) as CommandResponse;
  taskRes = await submitAndApprove(client, human, taskRes, 'approve twenty disposable task');
  if (!succeeded(taskRes)) {
    fail('D', `task create failed: ${errorCode(taskRes)}`);
  }
  await requireLedger(client, 'D', taskRes);
  ok('D', 'task.create succeeded on fixture contact');

  // --- protected-hash deny (optional stand-in / known production Twenty id) ---
  const protectedContactId = process.env.TWENTY_PROTECTED_CONTACT_ID?.trim();
  if (protectedContactId) {
    const denyRes = (await client.submitCommand({
      name: 'twenty-live-protected-deny',
      actor: primary,
      requestId: newRequestId(),
      serviceKey: formatServiceKey('crm.note.create', 1),
      payload: {
        contactId: protectedContactId,
        body: 'Synthetic qualification snapshot (test data, not a real prospect)',
        idempotencyKey: `twenty-live-protected-deny-${runTag}`,
      },
      metadata: {
        tenantId: TENANT,
        proof: 'twenty-live-acceptance',
        synthetic: true,
        cohort: 'OL-001',
      },
    })) as CommandResponse;
    if (succeeded(denyRes)) {
      fail('E', 'protected Twenty contact accepted synthetic OL-001 note — must DENY');
    }
    if (errorCode(denyRes) !== 'SYNTHETIC_TO_PRODUCTION_DENIED') {
      ok(
        'E',
        `protected contact write refused (code=${errorCode(denyRes) || denyRes.status})`,
      );
    } else {
      ok('E', 'SYNTHETIC_TO_PRODUCTION_DENIED on protected Twenty contact');
    }
    evidence['protectedHashDeny'] = {
      exercised: true,
      code: errorCode(denyRes) || denyRes.status,
    };
  } else {
    evidence['protectedHashDeny'] = {
      exercised: false,
      note: 'Set TWENTY_PROTECTED_CONTACT_ID (id whose sha256 is in sha256.twentyRecordIds or AION_PRODUCTION_TWENTY_RECORD_SHA256) to exercise live deny',
    };
    ok('E', 'protected-hash live deny skipped (TWENTY_PROTECTED_CONTACT_ID unset)');
  }

  // --- cross-tenant note ---
  if (process.env.TWENTY_API_KEY_B?.trim()) {
    evidence['crossTenant'] = {
      ...(evidence['crossTenant'] as object),
      keyBPresent: true,
      note: 'Runtime boots with TWENTY_API_KEY only; KEY_B marks a second workspace for a follow-up process. Record both process evidences for Gate C sign-off.',
    };
    ok(
      'F',
      'TWENTY_API_KEY_B present — complete isolation by second-process deny probe (see docs)',
    );
  } else {
    ok(
      'F',
      'cross-tenant: run two-process with distinct TWENTY_API_KEY (or set TWENTY_API_KEY_B)',
    );
  }

  evidence['contactId'] = contactId;
  evidence['opportunityId'] = opportunityId;
  evidence['completedAt'] = new Date().toISOString();
  evidence['result'] = 'PASS';

  const { writeFileSync } = await import('node:fs');
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  console.log(`[twenty-live] evidence written → ${EVIDENCE_PATH}`);
}

main().catch((err) => {
  console.error('[twenty-live] fatal', err);
  process.exit(1);
});
