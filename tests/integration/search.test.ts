import assert from 'node:assert/strict';
import type { Parameters } from '../../src/core/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { FixtureSearchProvider, HttpSearchProvider } from '../../src/tools/search-tool.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { PidevTool } from '../../src/tools/pidev-tool.js';

const endpoint = 'https://search.example.test/search';
const item = { url: 'https://example.org/valid', title: 'Valid source', snippet: 'Useful snippet' };
const json = (value: unknown, status = 200): Response => Response.json(value, { status });
const fakeFetch = (handler: (url: URL, init: RequestInit | undefined) => Promise<Response> | Response): typeof globalThis.fetch => async (url, init) => handler(new URL(String(url)), init);

test('generic provider maps options, authorization, normalization and cache isolation', async () => {
  let requests = 0;
  const provider = new HttpSearchProvider({ endpoint, apiKey: 'test-only-token', fetch: fakeFetch((url, init) => {
    requests++;
    assert.equal(url.pathname, '/search');
    assert.deepEqual(Object.fromEntries(url.searchParams), { q: 'hello world', num: '2', lang: 'fr', safe: 'false', tbs: 'qdr:w' });
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-only-token');
    assert.equal(init?.redirect, 'error');
    return json({ organic: [{ link: item.url, title: item.title, description: item.snippet }], totalResults: 9 });
  }) });
  const query = { query: ' hello world ', maxResults: 2, language: 'fr', safeSearch: false, timeRange: 'week' as const };
  const first = await provider.search(query);
  assert.equal(first.cached, false);
  assert.equal(first.results[0]?.source, 'custom');
  assert.equal(first.totalResults, 9);
  first.results[0]!.title = 'mutated';
  const second = await provider.search(query);
  assert.equal(second.cached, true);
  assert.equal(second.results[0]?.title, item.title);
  assert.equal(requests, 1);
  assert.deepEqual(provider.getCacheStats(), { size: 1, hits: 1, misses: 1 });
  provider.clearCache();
  assert.equal(provider.getCacheStats().size, 0);
});

test('SearXNG request uses native parameters and content fields', async () => {
  const provider = new HttpSearchProvider({ endpoint, format: 'searxng', fetch: fakeFetch((url) => {
    assert.deepEqual(Object.fromEntries(url.searchParams), { q: 'harness', format: 'json', language: 'en', safesearch: '1', time_range: 'month' });
    return json({ results: [{ ...item, snippet: undefined, content: 'SearXNG content' }], number_of_results: 27 });
  }) });
  const result = await provider.search({ query: 'harness', timeRange: 'month' });
  assert.equal(result.results[0]?.source, 'searxng');
  assert.equal(result.results[0]?.snippet, 'SearXNG content');
  assert.equal(result.totalResults, 27);
});

test('provider discards malformed, unsafe and duplicate result URLs and bounds fields', async () => {
  const provider = new HttpSearchProvider({ endpoint, fetch: fakeFetch(() => json({ results: [
    null, { ...item, url: 'javascript:alert(1)' }, { ...item, url: 'file:///etc/passwd' }, { ...item, url: '/relative' },
    { ...item, url: 'https://user:password@example.org/' }, { ...item, title: '' }, { ...item, snippet: 4 },
    item, item, { ...item, url: 'https://example.org/second', title: 'x'.repeat(1000), snippet: 'y'.repeat(3000) },
  ], totalResults: -1 })) });
  const response = await provider.search({ query: 'safe' });
  assert.equal(response.results.length, 2);
  assert.equal(response.results[1]?.title.length, 300);
  assert.equal(response.results[1]?.snippet.length, 2000);
  assert.equal(response.totalResults, 2);
  assert.deepEqual(response.results.map((result) => result.rank), [1, 2]);
});

test('query validation prevents invalid requests from reaching fetch', async () => {
  let called = false;
  const provider = new HttpSearchProvider({ endpoint, fetch: fakeFetch(() => { called = true; return json({ results: [] }); }) });
  for (const query of [{ query: '' }, { query: 'x'.repeat(2001) }, { query: 'ok', maxResults: 1.5 }, { query: 'ok', maxResults: 11 }, { query: 'ok', language: 'en&key=secret' }]) await assert.rejects(provider.search(query));
  assert.equal(called, false);
});

test('search cache implements LRU eviction, TTL expiry and disabled caching', async () => {
  let calls = 0;
  const fetch = fakeFetch(() => { calls++; return json({ results: [item] }); });
  const provider = new HttpSearchProvider({ endpoint, maxCacheEntries: 2, fetch });
  await provider.search({ query: 'a' }); await provider.search({ query: 'b' });
  await provider.search({ query: 'a' }); await provider.search({ query: 'c' });
  assert.equal((await provider.search({ query: 'a' })).cached, true);
  assert.equal((await provider.search({ query: 'b' })).cached, false);
  assert.equal(calls, 4);
  const expiring = new HttpSearchProvider({ endpoint, cacheTtlMs: 2, fetch });
  await expiring.search({ query: 'ttl' }); await delay(5);
  assert.equal((await expiring.search({ query: 'ttl' })).cached, false);
  const disabled = new HttpSearchProvider({ endpoint, cacheTtlMs: 0, fetch });
  await disabled.search({ query: 'none' });
  assert.equal((await disabled.search({ query: 'none' })).cached, false);
  assert.equal(disabled.getCacheStats().size, 0);
});

test('transient errors retry; ordinary HTTP errors and malformed responses do not', async () => {
  let attempts = 0;
  const retrying = new HttpSearchProvider({ endpoint, maxRetries: 1, fetch: fakeFetch(() => ++attempts === 1 ? json({}, 503) : json({ results: [item] })) });
  assert.equal((await retrying.search({ query: 'retry' })).results.length, 1);
  assert.equal(attempts, 2);
  for (const response of [() => json({}, 401), () => new Response('{invalid'), () => json({ unexpected: true })]) {
    attempts = 0;
    const provider = new HttpSearchProvider({ endpoint, fetch: fakeFetch(() => { attempts++; return response(); }) });
    await assert.rejects(provider.search({ query: 'fail' }));
    assert.equal(attempts, 1);
    assert.equal(provider.getCacheStats().size, 0);
  }
});

test('search bounds both declared and streamed response sizes', async () => {
  const payload = JSON.stringify({ results: [{ ...item, snippet: 'x'.repeat(500) }] });
  for (const headers of [{ 'content-length': String(payload.length) }, undefined]) {
    const provider = new HttpSearchProvider({ endpoint, maxResponseBytes: 200, fetch: fakeFetch(() => new Response(payload, { headers })) });
    await assert.rejects(provider.search({ query: 'large' }), /exceeds 200 bytes/);
  }
});

test('deadline applies even to fetch implementations and response bodies that never settle', async () => {
  const stalled = new HttpSearchProvider({ endpoint, timeoutMs: 15, maxRetries: 0, fetch: fakeFetch(() => new Promise<Response>(() => {})) });
  await assert.rejects(stalled.search({ query: 'hang' }), /timed out/);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const streaming = new HttpSearchProvider({ endpoint, timeoutMs: 15, maxRetries: 0, fetch: fakeFetch(() => new Response(body)) });
  await assert.rejects(streaming.search({ query: 'hang body' }), /timed out/);
  await delay(0);
  assert.equal(cancelled, true);
});

test('one cancelled search cannot cancel another search for the same query or populate its cache', async () => {
  const provider = new HttpSearchProvider({ endpoint, fetch: fakeFetch(async () => { await delay(10); return json({ results: [item] }); }) });
  const controller = new AbortController();
  const first = provider.search({ query: 'same' }, controller.signal);
  const second = provider.search({ query: 'same' });
  controller.abort(new Error('Only first caller stopped'));
  await assert.rejects(first, /Only first caller stopped/);
  assert.equal((await second).results.length, 1);
  assert.equal((await provider.search({ query: 'same' })).cached, true);
  await assert.rejects(provider.search({ query: 'same' }, controller.signal), /Only first caller stopped/);
});

test('search tool participates in executor validation and labels offline fixtures', async () => {
  const registry = new ToolRegistry(new FixtureSearchProvider());
  const executor = new ToolExecutor(registry);
  const successful = await executor.execute('web_search', { query: 'agent harness', maxResults: 2 });
  assert.equal(successful.status, 'completed');
  assert.match(successful.result!.raw, /DEMO FIXTURE/);
  assert.match(successful.result!.raw, /"source":"fixture"/);
  for (const parameters of [{ query: 'ok', timeRange: 'decade' }, { query: 'ok', maxResults: 0 }, { query: 'ok', maxResults: 1.5 }] as Parameters[]) assert.equal((await executor.execute('web_search', parameters)).status, 'failed');
  assert.equal(PidevTool, HttpSearchProvider);
});

test('provider rejects unsupported endpoints and invalid resource options', () => {
  for (const options of [{ endpoint: 'file:///tmp/search' }, { endpoint: 'https://user:pass@example.org/search' }, { endpoint, timeoutMs: 0 }, { endpoint, maxRetries: 6 }, { endpoint, maxCacheEntries: -1 }, { endpoint, cacheTtlMs: NaN }]) assert.throws(() => new HttpSearchProvider(options));
});

test('SearXNG rejects an unsupported weekly filter before sending a request', async () => {
  const provider = new HttpSearchProvider({ endpoint, format: 'searxng', fetch: async () => { throw new Error('Must not request'); } });
  await assert.rejects(provider.search({ query: 'topic', timeRange: 'week' }), /week is not supported/);
});

test('search tool validates domain constraints before calling custom providers', async () => {
  let calls = 0;
  const registry = new ToolRegistry({ search: async ({ query }) => { calls++; return { query, results: [], totalResults: 0, cached: false, executionTime: 0 }; } });
  const executor = new ToolExecutor(registry);
  assert.equal((await executor.execute('web_search', { query: ' ' })).status, 'failed');
  assert.equal((await executor.execute('web_search', { query: 'test', maxResults: 1.5 })).status, 'failed');
  assert.equal(calls, 0);
});
