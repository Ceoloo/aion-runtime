import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LiveGhlBackend, type FetchLike } from './live-ghl-backend.js';

describe('LiveGhlBackend task.create', () => {
  it('sends completed=false by default (LeadConnector requires boolean)', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init.body) bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 201,
        headers: { get: () => null },
        json: async () => ({ task: { id: 'task_1' } }),
        text: async () => '',
      };
    };

    const backend = new LiveGhlBackend({
      fetchImpl,
      resolveConnection: () => ({
        tenantId: 'aion-systems',
        apiKey: 'test-key-at-least-8',
        locationId: 'loc_test',
        apiVersion: '2021-07-28',
        baseUrl: 'https://services.leadconnectorhq.com',
        source: 'env',
      }),
    });

    const result = await backend.execute({
      action: 'task.create',
      tenantId: 'aion-systems',
      idempotencyKey: 'test-task-create-1',
      payload: {
        contactId: 'contact_1',
        title: 'Book appointment',
        body: 'follow up',
        dueDate: '2026-09-27T00:00:00.000Z',
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(bodies[0], {
      title: 'Book appointment',
      body: 'follow up',
      dueDate: '2026-09-27T00:00:00.000Z',
      completed: false,
    });
  });
});
