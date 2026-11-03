import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UhpHarnessProvider, type FetchLike } from './uhp-harness-provider.js';

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('UhpHarnessProvider (ADR-011)', () => {
  it('fails closed when the kill switch is off — no network', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, {});
    };
    const provider = new UhpHarnessProvider({
      baseUrl: 'http://hr.test/api/harness',
      apiKey: 'test-key',
      enabled: false,
      fetchImpl,
      harnesses: [{ id: 'codex', kind: 'codex' }],
    });

    assert.equal(await provider.supports('codex'), false);
    const result = await provider.run({
      harnessId: 'codex',
      input: 'hello',
      riskLevel: 'R1',
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'HARNESS_DISABLED');
    assert.equal(calls, 0);
  });

  it('POSTs /v1/responses with harness_id, model, and Idempotency-Key', async () => {
    const seen: { url?: string; init?: Parameters<FetchLike>[1] } = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seen.url = url;
      seen.init = init;
      return jsonResponse(200, {
        id: 'resp_1',
        status: 'completed',
        model: 'gpt-5.4-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'it works.' }],
          },
        ],
        usage: { total_tokens: 42 },
        metadata: { session_id: 'hsess_1' },
      });
    };

    const provider = new UhpHarnessProvider({
      baseUrl: 'http://hr.test/api/harness/',
      apiKey: 'secret',
      fetchImpl,
      harnesses: [{ id: 'codex', kind: 'codex' }],
    });

    const result = await provider.run({
      harnessId: 'codex',
      model: 'gpt-5.4-mini',
      input: 'Reply with exactly: it works.',
      riskLevel: 'R1',
      idempotencyKey: 'req_abc',
      runId: 'run_1' as never,
    });

    assert.equal(seen.url, 'http://hr.test/api/harness/v1/responses');
    assert.equal(seen.init?.headers['Authorization'], 'Bearer secret');
    assert.equal(seen.init?.headers['Idempotency-Key'], 'req_abc');
    const body = JSON.parse(seen.init?.body ?? '{}') as {
      input: string;
      model: string;
      metadata: { harness_id: string };
      stream: boolean;
    };
    assert.equal(body.input, 'Reply with exactly: it works.');
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.metadata.harness_id, 'codex');
    assert.equal(body.stream, false);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.sessionId, 'hsess_1');
    assert.equal(result.model, 'gpt-5.4-mini');
    assert.equal(result.transcriptRef, 'uhp:response:resp_1');
    assert.equal(result.usage?.tokens, 42);
    assert.equal((result.output as { text?: string })?.text, 'it works.');
  });

  it('maps definite 404 harness_not_found to failed', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(404, {
        error: {
          type: 'invalid_request_error',
          code: 'harness_not_found',
          message: "No harness with id 'missing'.",
        },
      });
    const provider = new UhpHarnessProvider({
      baseUrl: 'http://hr.test/api/harness',
      apiKey: 'k',
      fetchImpl,
    });
    const result = await provider.run({
      harnessId: 'missing',
      input: 'x',
      riskLevel: 'R0',
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'harness_not_found');
    assert.equal(result.error?.retryable, false);
  });

  it('maps transport loss and 503 to indeterminate', async () => {
    const flaky: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    const provider = new UhpHarnessProvider({
      baseUrl: 'http://hr.test/api/harness',
      apiKey: 'k',
      fetchImpl: flaky,
    });
    const lost = await provider.run({
      harnessId: 'codex',
      input: 'x',
      riskLevel: 'R0',
      idempotencyKey: 'idem_1',
    });
    assert.equal(lost.status, 'indeterminate');
    assert.equal(lost.error?.code, 'HARNESS_TRANSPORT_LOST');
    assert.equal(lost.error?.retryable, true);

    const provider503 = new UhpHarnessProvider({
      baseUrl: 'http://hr.test/api/harness',
      apiKey: 'k',
      fetchImpl: async () => jsonResponse(503, { error: { message: 'unavailable' } }),
    });
    const soft = await provider503.run({
      harnessId: 'codex',
      input: 'x',
      riskLevel: 'R0',
    });
    assert.equal(soft.status, 'indeterminate');
  });

  it('cancels via /v1/responses/{id}/cancel using the last response id', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (url.endsWith('/v1/responses') && init.method === 'POST') {
        return jsonResponse(200, {
          id: 'resp_99',
          status: 'completed',
          model: 'm',
          output: [],
          metadata: { session_id: 'hsess_9' },
        });
      }
      return jsonResponse(200, {});
    };
    const provider = new UhpHarnessProvider({
      baseUrl: 'http://hr.test/api/harness',
      apiKey: 'k',
      fetchImpl,
    });
    await provider.run({
      harnessId: 'codex',
      input: 'x',
      riskLevel: 'R0',
      runId: 'run_z' as never,
    });
    await provider.cancel({ runId: 'run_z' });
    assert.ok(calls.some((c) => c === 'POST http://hr.test/api/harness/v1/responses/resp_99/cancel'));
  });
});
