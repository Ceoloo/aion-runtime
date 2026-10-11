import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AT3_FIXTURES,
  qualifyDemoElectricalSmbV1,
} from './demo-electrical-smb-v1.js';

test('demo-electrical-smb-v1 forces each AT-3 label', () => {
  const labels = AT3_FIXTURES.map((f) => qualifyDemoElectricalSmbV1(f));
  assert.deepEqual(labels, ['qualified', 'not_qualified', 'needs_human']);
});

test('low match confidence always needs_human', () => {
  assert.equal(
    qualifyDemoElectricalSmbV1({
      fixtureId: 'low-conf',
      email: 'x@example.invalid',
      phone: '+15165550999',
      serviceArea: '11530',
      jobType: 'panel',
      matchConfidence: 0.4,
    }),
    'needs_human',
  );
});
