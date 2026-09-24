import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMClient } from '../../src/models/llm-client.js';
import type { LLMRequest } from '../../src/core/types.js';

const request: LLMRequest = { messages: [{ role: 'user', content: 'Hello', timestamp: '2026-09-24T00:00:00.000Z' }] };
const completion = { model: 'test-model', choices: [{ message: { content: 'Hello back' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const client = (fetcher: typeof fetch, options: Partial<ConstructorParameters<typeof LLMClient>[0]> = {}): LLMClient => new LLMClient({ endpoint: 'http://127.0.0.1:11434/v1/', model: 'test-model', fetch: fetcher, ...options });

function fragmentedStream(text: string, widths: number[] = [1, 2, 5]): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let position = 0;
      let chunk = 0;
      while (position < bytes.length) {
        const width = widths[chunk++ % widths.length]!;
        controller.enqueue(bytes.slice(position, position + width));
        position += width;
      }
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('LLM serializes endpoint, model, zero temperature and message roles without timestamps', async () => {
  let receivedUrl = '';
  let received: RequestInit | undefined;
  const llm = client(async (url, options) => {
    receivedUrl = String(url);
    received = options;
    return jsonResponse(completion);
  }, { apiKey: 'test-secret' });
  const response = await llm.complete({ ...request, temperature: 0, topP: 0, maxTokens: 32 });
  assert.equal(receivedUrl, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(received?.method, 'POST');
  assert.equal(received?.redirect, 'error');
  assert.equal(new Headers(received?.headers).get('Authorization'), 'Bearer test-secret');
  assert.deepEqual(JSON.parse(received?.body as string), {
    model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], temperature: 0, top_p: 0, max_tokens: 32, stream: false,
  });
  assert.deepEqual(response, { content: 'Hello back', model: 'test-model', finishReason: 'stop', usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } });
});

test('LLM omits authorization when no key is configured and tolerates missing usage', async () => {
  const llm = client(async (_url, options) => {
    assert.equal(new Headers(options?.headers).has('Authorization'), false);
    return jsonResponse({ choices: [{ message: { content: 'Minimal response' } }] });
  });
  assert.deepEqual(await llm.complete(request), {
    content: 'Minimal response', model: 'test-model', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
});

test('LLM computes a missing usage total from available counts', async () => {
  const llm = client(async () => jsonResponse({ ...completion, usage: { prompt_tokens: 3, completion_tokens: 5 } }));
  assert.equal((await llm.complete(request)).usage.totalTokens, 8);
});

test('LLM retries 429 and 503 before returning a successful completion', async () => {
  let calls = 0;
  const llm = client(async () => {
    calls++;
    if (calls <= 2) return new Response('Transient failure', { status: calls === 1 ? 429 : 503 });
    return jsonResponse(completion);
  });
  assert.equal((await llm.complete(request)).content, 'Hello back');
  assert.equal(calls, 3);
});

test('LLM does not retry authentication failures or expose their response body', async () => {
  let calls = 0;
  const llm = client(async () => { calls++; return new Response('Sensitive provider body', { status: 401 }); });
  await assert.rejects(llm.complete(request), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /Sensitive/);
    return true;
  });
  assert.equal(calls, 1);
});

test('LLM obeys maxRetries and supports disabling retries', async () => {
  let calls = 0;
  const llm = client(async () => { calls++; return new Response('Unavailable', { status: 503 }); }, { maxRetries: 0 });
  await assert.rejects(llm.complete(request), /HTTP 503/);
  assert.equal(calls, 1);
});

test('LLM retries a recognized transient network failure', async () => {
  let calls = 0;
  const llm = client(async () => {
    if (++calls === 1) throw new TypeError('fetch failed');
    return jsonResponse(completion);
  });
  assert.equal((await llm.complete(request)).content, 'Hello back');
  assert.equal(calls, 2);
});

test('LLM sends a deadline signal and propagates timeout without retry', async () => {
  let calls = 0;
  const llm = client(async (_url, options) => {
    calls++;
    const signal = options?.signal;
    assert.ok(signal);
    return await new Promise<Response>((resolve, reject) => {
      // The referenced timer also keeps Node alive while AbortSignal.timeout fires.
      const timer = setTimeout(() => resolve(jsonResponse(completion)), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }, { timeoutMs: 15 });
  await assert.rejects(llm.complete(request), error => error instanceof Error && error.name === 'TimeoutError');
  assert.equal(calls, 1);
});

test('LLM rejects a pre-cancelled request without sending it', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('Stopped by caller'));
  const llm = client(async () => { calls++; return jsonResponse(completion); });
  await assert.rejects(llm.complete({ ...request, signal: controller.signal }), /Stopped by caller/);
  assert.equal(calls, 0);
});

test('LLM rejects malformed JSON, malformed choices, empty content and invalid usage', async () => {
  const cases = [
    () => new Response('not-json'),
    () => jsonResponse({ choices: [] }),
    () => jsonResponse({ choices: [{ message: { content: '' } }] }),
    () => jsonResponse({ ...completion, usage: { prompt_tokens: -1 } }),
  ];
  for (const response of cases) {
    let calls = 0;
    const llm = client(async () => { calls++; return response(); });
    await assert.rejects(llm.complete(request));
    assert.equal(calls, 1);
  }
});

test('LLM rejects completions explicitly truncated by the model', async () => {
  const llm = client(async () => jsonResponse({ ...completion, choices: [{ message: { content: 'Partial answer' }, finish_reason: 'length' }] }));
  await assert.rejects(llm.complete(request), /truncated/);
});

test('LLM counts HTTP response bytes, including multibyte text', async () => {
  const response = { choices: [{ message: { content: 'é'.repeat(50) } }] };
  const serialized = JSON.stringify(response);
  const llm = client(async () => new Response(serialized), { maxResponseBytes: serialized.length + 1 });
  await assert.rejects(llm.complete(request), /size limit/);
});

test('LLM lists model IDs from the configured base endpoint', async () => {
  const llm = client(async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/v1/models');
    assert.equal(options?.method, 'GET');
    return jsonResponse({ data: [{ id: 'one' }, { id: 'two' }] });
  });
  assert.deepEqual(await llm.listModels(), ['one', 'two']);
  await assert.rejects(client(async () => jsonResponse({ data: [{ name: 'wrong' }] })).listModels());
});

test('LLM decodes fragmented SSE with CRLF, multibyte text and DONE marker', async () => {
  const text = ': keepalive\r\n\r\n'
    + 'data: {"choices":[{"delta":{"content":"Café "}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{"content":"☕"},"finish_reason":"stop"}]}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n';
  const chunks: string[] = [];
  const llm = client(async (_url, options) => {
    assert.equal(JSON.parse(options?.body as string).stream, true);
    return fragmentedStream(text);
  });
  await llm.stream(request, chunk => chunks.push(chunk));
  assert.deepEqual(chunks, ['Café ', '☕']);
});

test('LLM rejects incomplete or malformed SSE without replaying partial output', async () => {
  for (const suffix of ['', 'data: {invalid}\n\n']) {
    let calls = 0;
    const chunks: string[] = [];
    const llm = client(async () => {
      calls++;
      return fragmentedStream('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n' + suffix);
    });
    await assert.rejects(llm.stream(request, chunk => chunks.push(chunk)));
    assert.deepEqual(chunks, ['Partial']);
    assert.equal(calls, 1);
  }
});

test('LLM rejects truncated and oversized SSE streams', async () => {
  const truncated = client(async () => fragmentedStream('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
  await assert.rejects(truncated.stream(request, () => {}), /truncated/);
  const oversized = client(async () => fragmentedStream('data: {"choices":[{"delta":{"content":"Long stream content"}}]}\n\ndata: [DONE]\n\n'), { maxResponseBytes: 20 });
  await assert.rejects(oversized.stream(request, () => {}), /size limit/);
});

test('LLM rejects invalid endpoints and request bounds at construction', () => {
  const fetcher: typeof fetch = async () => jsonResponse(completion);
  for (const endpoint of ['file:///tmp/model', 'http://user:password@localhost/v1', 'http://localhost/v1?secret=value', 'http://localhost/v1#fragment']) {
    assert.throws(() => client(fetcher, { endpoint }));
  }
  for (const invalid of [{ maxRetries: -1 }, { maxRetries: 6 }, { timeoutMs: 0 }, { maxResponseBytes: 0 }, { model: '  ' }]) {
    assert.throws(() => client(fetcher, invalid));
  }
});

test('LLM bounds transports and response streams that ignore cancellation', async () => {
  const hungFetch = client(async () => new Promise(() => {}), { timeoutMs: 20 });
  await assert.rejects(hungFetch.complete(request), /deadline/);
  const hungBody = (): Response => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
  await assert.rejects(client(async () => hungBody(), { timeoutMs: 20 }).complete(request), /deadline/);
  await assert.rejects(client(async () => hungBody(), { timeoutMs: 20 }).stream(request, () => {}), /deadline/);
});
