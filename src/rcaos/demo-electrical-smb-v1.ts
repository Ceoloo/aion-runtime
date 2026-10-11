/**
 * Deterministic qualification ruleset for Revenue Capture & Appointment OS demo.
 * Ruleset ID: demo-electrical-smb-v1 (aion-docs Sprint 1 lock).
 *
 * No model provider — pure function for AT-3 / D3.
 */

export type QualificationLabel = 'qualified' | 'not_qualified' | 'needs_human';

export interface DemoInquiry {
  /** Fixture id for evidence / scorecard rows. */
  fixtureId: string;
  email: string;
  phone: string;
  firstName?: string;
  lastName?: string;
  /** ZIP or city label used for service-area check. */
  serviceArea: string;
  /** Job type free-text / enum-ish. */
  jobType: string;
  /** True when inquiry looks like spam / non-buyer. */
  spam?: boolean;
  /** Ambiguous address / commercial / insurance complexity / angry tone. */
  ambiguousAddress?: boolean;
  commercialOrInsurance?: boolean;
  angryTone?: boolean;
  /** Soft identity match confidence when updating an existing contact. */
  matchConfidence?: number;
}

const SERVICE_AREAS = new Set([
  '11501',
  '11530',
  '11590',
  'nassau',
  'queens',
  'long island',
]);

const SUPPORTED_JOBS = new Set([
  'service call',
  'service',
  'install',
  'installation',
  'panel',
  'panel upgrade',
]);

/**
 * Qualify an inbound inquiry under demo-electrical-smb-v1.
 *
 * Order: needs_human signals → not_qualified → qualified.
 */
export function qualifyDemoElectricalSmbV1(
  inquiry: DemoInquiry,
): QualificationLabel {
  const confidence = inquiry.matchConfidence ?? 1;
  if (confidence < 0.85) return 'needs_human';
  if (inquiry.ambiguousAddress) return 'needs_human';
  if (inquiry.commercialOrInsurance) return 'needs_human';
  if (inquiry.angryTone) return 'needs_human';

  if (inquiry.spam) return 'not_qualified';
  const area = inquiry.serviceArea.trim().toLowerCase();
  if (!SERVICE_AREAS.has(area)) return 'not_qualified';
  const job = inquiry.jobType.trim().toLowerCase();
  if (!SUPPORTED_JOBS.has(job)) return 'not_qualified';

  return 'qualified';
}

/** Three fixtures that force each qualification label (AT-3). */
export const AT3_FIXTURES: readonly DemoInquiry[] = [
  {
    fixtureId: 'at3-qualified',
    email: 'rcaos.qualified+demo@example.invalid',
    phone: '+15165550101',
    firstName: 'Qualified',
    lastName: 'Demo',
    serviceArea: '11530',
    jobType: 'panel',
    matchConfidence: 0.95,
  },
  {
    fixtureId: 'at3-not-qualified',
    email: 'rcaos.notqual+demo@example.invalid',
    phone: '+15165550102',
    firstName: 'Outside',
    lastName: 'Area',
    serviceArea: '90210',
    jobType: 'panel',
    matchConfidence: 0.95,
  },
  {
    fixtureId: 'at3-needs-human',
    email: 'rcaos.needshuman+demo@example.invalid',
    phone: '+15165550103',
    firstName: 'Ambiguous',
    lastName: 'Address',
    serviceArea: '11530',
    jobType: 'install',
    ambiguousAddress: true,
    matchConfidence: 0.95,
  },
];
