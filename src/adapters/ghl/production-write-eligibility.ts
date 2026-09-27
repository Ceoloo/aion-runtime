/**
 * Live CRM write eligibility.
 *
 * Execution policy (capability, risk, approval) can ALLOW a governed task
 * while the payload is still synthetic test evidence aimed at a real client
 * record. A label inside the note does not make that write safe: the live
 * API stores it as ordinary CRM state.
 *
 * Synthetic customer evidence may land on a contact this process just created
 * as a fixture (`@example.invalid`, no pre-existing contact id). It may not
 * land on any other live contact, and never on a known production record id
 * (SHA-256 denylist, same set as scripts/lib/production-ids.json).
 */
import { createHash } from 'node:crypto';
import type { GhlMutationKind } from './types.js';

/** SHA-256 of known production GHL record ids. Do not store the raw ids here. */
export const PROTECTED_LIVE_GHL_RECORD_SHA256: readonly string[] = [
  '51b6c4c1a93b12306bdd1c33f652460c1917e7c91ce75aa811af65682a8da4b4',
  'a039c1ec9f433c0cc7e990e6159b3824f6ddfc116e2ec64da185864a3735d39e',
  'ab751547162e82975bcdfa892cded02afa21e1f758d07fc82f6fc88d2309f5ad',
  'cdfa9019ea6a704d8e098d6a1ff8afe93187d2f328b8973857d485cf066992ef',
];

export const SYNTHETIC_TO_PRODUCTION_DENIED = 'SYNTHETIC_TO_PRODUCTION_DENIED';

/**
 * Writes that become customer intelligence on a contact: notes, tasks,
 * messages, and contact field updates. Pipeline stage changes are not in
 * this set; they are still refused when their payload text is synthetic
 * and the target is not an in-process fixture.
 */
const CUSTOMER_INTELLIGENCE_ACTIONS: ReadonlySet<GhlMutationKind> = new Set([
  'contact.update',
  'contact.enrich',
  'note.create',
  'task.create',
  'message.draft',
  'message.send',
]);

const SYNTHETIC_TEXT =
  /\bsynthetic\b|\btest data\b|not a real prospect|not a real customer|not a real client|not a real lead|@example\.invalid\b/i;

const fixtureRecordIds = new Set<string>();

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function rememberLiveFixtureRecord(id: string): void {
  if (id.length > 0) fixtureRecordIds.add(id);
}

export function clearLiveFixtureRecords(): void {
  fixtureRecordIds.clear();
}

export function isLiveFixtureRecord(id: string): boolean {
  return fixtureRecordIds.has(id);
}

export function isProtectedLiveGhlRecord(
  id: string,
  protectedHashes: readonly string[] = PROTECTED_LIVE_GHL_RECORD_SHA256,
): boolean {
  return protectedHashes.includes(sha256Hex(id));
}

export interface LiveWriteEligibilityInput {
  backendName: string;
  action: GhlMutationKind;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Defaults to the production denylist. Tests pass a stand-in set. */
  protectedHashes?: readonly string[];
}

/**
 * `defer-to-policy` means this boundary does not decide the write.
 * Policy already ran; a non-synthetic payload stays on that decision.
 * `allow-fixture` is the narrow exception for a contact this process
 * just created. `deny` stops the write before the live API is called.
 */
export type LiveWriteDisposition = 'defer-to-policy' | 'allow-fixture' | 'deny';

export interface LiveWriteEligibility {
  eligible: boolean;
  disposition: LiveWriteDisposition;
  code?: string;
  message?: string;
  /** After a successful create, store the provider id as a fixture target. */
  rememberResource: boolean;
}

export function assessLiveCustomerWrite(
  input: LiveWriteEligibilityInput,
): LiveWriteEligibility {
  if (input.backendName !== 'ghl-live') {
    return defer();
  }
  if (isRead(input.action)) {
    return defer();
  }

  const metadata = input.metadata ?? {};
  const synthetic = isSyntheticEvidence(input.action, input.payload, metadata);
  if (!synthetic) {
    return defer();
  }

  const protectedHashes = new Set(
    input.protectedHashes ?? PROTECTED_LIVE_GHL_RECORD_SHA256,
  );
  const targets = targetIds(input.payload);
  if (targets.some((id) => protectedHashes.has(sha256Hex(id)))) {
    return refuse(
      `${input.action} carries synthetic or test evidence and targets a known production CRM record. ` +
        'That write is not eligible for the live API.',
    );
  }

  const email = stringField(input.payload, 'email');
  if (
    input.action === 'contact.update' &&
    !stringField(input.payload, 'contactId') &&
    email !== undefined &&
    isFixtureEmail(email)
  ) {
    return {
      eligible: true,
      disposition: 'allow-fixture',
      rememberResource: true,
    };
  }

  if (targets.length > 0 && targets.every((id) => fixtureRecordIds.has(id))) {
    return {
      eligible: true,
      disposition: 'allow-fixture',
      rememberResource:
        input.action === 'opportunity.create' || input.action === 'contact.update',
    };
  }

  return refuse(
    `${input.action} carries synthetic or test evidence and is not aimed at a fixture contact created in this process. ` +
      'A synthetic label does not make the payload eligible for a live client CRM record.',
  );
}

function defer(): LiveWriteEligibility {
  return {
    eligible: true,
    disposition: 'defer-to-policy',
    rememberResource: false,
  };
}

function refuse(message: string): LiveWriteEligibility {
  return {
    eligible: false,
    disposition: 'deny',
    code: SYNTHETIC_TO_PRODUCTION_DENIED,
    message,
    rememberResource: false,
  };
}

function isRead(action: GhlMutationKind): boolean {
  return (
    action.endsWith('.read') ||
    action === 'contact.search' ||
    action === 'opportunity.search'
  );
}

export function isSyntheticEvidence(
  action: GhlMutationKind,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
): boolean {
  if (payloadContainsSyntheticText(payload)) return true;
  if (!CUSTOMER_INTELLIGENCE_ACTIONS.has(action)) return false;
  if (metadata['synthetic'] === true) return true;
  const valueKind = metadata['valueKind'];
  if (valueKind === 'synthetic' || valueKind === 'test') return true;
  const dataClass = metadata['dataClass'] ?? metadata['data_class'];
  if (
    typeof dataClass === 'string' &&
    /^(synthetic|test|validation|fixture)$/i.test(dataClass)
  ) {
    return true;
  }
  return typeof metadata['proof'] === 'string' && metadata['proof'].length > 0;
}

function payloadContainsSyntheticText(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (typeof value === 'string') return SYNTHETIC_TEXT.test(value);
  if (Array.isArray(value)) {
    return value.some((item) => payloadContainsSyntheticText(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      payloadContainsSyntheticText(item, depth + 1),
    );
  }
  return false;
}

function targetIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ['contactId', 'opportunityId'] as const) {
    const id = stringField(payload, key);
    if (id) ids.push(id);
  }
  return ids;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isFixtureEmail(email: string): boolean {
  return email.toLowerCase().endsWith('@example.invalid');
}
