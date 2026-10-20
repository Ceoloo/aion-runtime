import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveTwentyBackend, type FetchLike } from './live-twenty-backend.js';

function mockFetch(handler: (url: string, method: string, body?: string) => unknown): FetchLike {
  return async (url, init) => {
    const payload = handler(url, init.method, init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'req_test' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

const ENV = {
  TWENTY_API_BASE_URL: 'http://twenty-server:3000',
  TWENTY_API_KEY: 'test-key',
} as NodeJS.ProcessEnv;

test('contact.update creates a person via POST /rest/people', async () => {
  const calls: string[] = [];
  const backend = new LiveTwentyBackend({
    env: ENV,
    fetchImpl: mockFetch((url, method, body) => {
      calls.push(`${method} ${url}`);
      assert.equal(method, 'POST');
      assert.match(url, /\/rest\/people$/);
      const parsed = JSON.parse(body ?? '{}') as { emails?: { primaryEmail?: string } };
      assert.equal(parsed.emails?.primaryEmail, 'lead@example.invalid');
      return {
        data: {
          createPerson: {
            id: 'person_1',
            name: { firstName: 'Ada', lastName: 'Lovelace' },
            emails: { primaryEmail: 'lead@example.invalid' },
          },
        },
      };
    }),
  });

  const result = await backend.execute({
    tenantId: 't1',
    action: 'contact.update',
    payload: {
      email: 'lead@example.invalid',
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
    idempotencyKey: 'ik_1',
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.externalResourceId, 'person_1');
    assert.equal(result.body['email'], 'lead@example.invalid');
  }
  assert.deepEqual(calls, ['POST http://twenty-server:3000/rest/people']);
});

test('opportunity.create maps contactId to pointOfContactId', async () => {
  const backend = new LiveTwentyBackend({
    env: ENV,
    fetchImpl: mockFetch((_url, method, body) => {
      assert.equal(method, 'POST');
      const parsed = JSON.parse(body ?? '{}') as {
        pointOfContactId?: string;
        stage?: string;
      };
      assert.equal(parsed.pointOfContactId, 'person_1');
      assert.equal(parsed.stage, 'SCREENING');
      return {
        data: {
          createOpportunity: {
            id: 'opp_1',
            name: 'Demo',
            stage: 'SCREENING',
            pointOfContactId: 'person_1',
          },
        },
      };
    }),
  });

  const result = await backend.execute({
    tenantId: 't1',
    action: 'opportunity.create',
    payload: {
      contactId: 'person_1',
      name: 'Demo',
      stage: 'SCREENING',
    },
    idempotencyKey: 'ik_2',
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.externalResourceId, 'opp_1');
    assert.equal(result.body['stage'], 'SCREENING');
  }
});

test('create responses without id fail closed (no synthetic substitute)', async () => {
  const backend = new LiveTwentyBackend({
    env: ENV,
    fetchImpl: mockFetch(() => ({ data: { createPerson: { name: { firstName: 'NoId' } } } })),
  });

  const result = await backend.execute({
    tenantId: 't1',
    action: 'contact.update',
    payload: { firstName: 'NoId' },
    idempotencyKey: 'ik_noid',
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, 'TWENTY_MISSING_ID');
});

test('note.create uses body (v0.40) and links NoteTarget when contactId present', async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const backend = new LiveTwentyBackend({
    env: ENV,
    fetchImpl: mockFetch((url, _method, body) => {
      const path = new URL(url).pathname;
      const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
      calls.push({ path, body: parsed });
      if (path === '/rest/notes') {
        assert.equal(parsed['body'], 'hello');
        assert.equal(parsed['bodyV2'], undefined);
        return { data: { createNote: { id: 'note_1', title: 'AION note' } } };
      }
      if (path === '/rest/noteTargets') {
        assert.equal(parsed['noteId'], 'note_1');
        assert.equal(parsed['personId'], 'person_1');
        return { data: { createNoteTarget: { id: 'nt_1', noteId: 'note_1', personId: 'person_1' } } };
      }
      throw new Error(`unexpected path ${path}`);
    }),
  });

  const note = await backend.execute({
    tenantId: 't1',
    action: 'note.create',
    payload: { body: 'hello', contactId: 'person_1' },
    idempotencyKey: 'ik_n',
  });

  assert.equal(note.ok, true);
  if (note.ok) {
    assert.equal(note.externalResourceId, 'note_1');
    assert.equal(note.body['noteTargetId'], 'nt_1');
  }
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/rest/notes', '/rest/noteTargets'],
  );
});

test('task.create links TaskTarget when opportunityId present', async () => {
  const paths: string[] = [];
  const backend = new LiveTwentyBackend({
    env: ENV,
    fetchImpl: mockFetch((url, _method, body) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/rest/tasks') {
        return { data: { createTask: { id: 'task_1', title: 'follow up' } } };
      }
      if (path === '/rest/taskTargets') {
        const parsed = JSON.parse(body ?? '{}') as {
          taskId?: string;
          opportunityId?: string;
        };
        assert.equal(parsed.taskId, 'task_1');
        assert.equal(parsed.opportunityId, 'opp_1');
        return {
          data: {
            createTaskTarget: { id: 'tt_1', taskId: 'task_1', opportunityId: 'opp_1' },
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    }),
  });

  const task = await backend.execute({
    tenantId: 't1',
    action: 'task.create',
    payload: { title: 'follow up', opportunityId: 'opp_1' },
    idempotencyKey: 'ik_t',
  });

  assert.equal(task.ok, true);
  if (task.ok) assert.equal(task.body['taskTargetId'], 'tt_1');
  assert.deepEqual(paths, ['/rest/tasks', '/rest/taskTargets']);
});

test('note.create without relation ids skips NoteTarget', async () => {
  const paths: string[] = [];
  const backend = new LiveTwentyBackend({
    env: ENV,
    fetchImpl: mockFetch((url) => {
      paths.push(new URL(url).pathname);
      return { data: { createNote: { id: 'note_2', title: 'n' } } };
    }),
  });

  const note = await backend.execute({
    tenantId: 't1',
    action: 'note.create',
    payload: { body: 'orphan ok' },
    idempotencyKey: 'ik_n2',
  });

  assert.equal(note.ok, true);
  assert.deepEqual(paths, ['/rest/notes']);
});

test('deferred messaging actions fail closed without HTTP', async () => {
  let called = false;
  const backend = new LiveTwentyBackend({
    env: ENV,
    fetchImpl: async () => {
      called = true;
      throw new Error('should not fetch');
    },
  });
  const result = await backend.execute({
    tenantId: 't1',
    action: 'message.send',
    payload: {},
    idempotencyKey: 'ik_m',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, 'TWENTY_CAPABILITY_DEFERRED');
  assert.equal(called, false);
});

test('missing credentials return TWENTY_CONNECTION_MISSING', async () => {
  const backend = new LiveTwentyBackend({ env: {} as NodeJS.ProcessEnv });
  const result = await backend.execute({
    tenantId: 't1',
    action: 'contact.read',
    payload: { contactId: 'x' },
    idempotencyKey: 'ik_x',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, 'TWENTY_CONNECTION_MISSING');
});
