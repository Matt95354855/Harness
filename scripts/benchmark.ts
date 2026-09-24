import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createDemoAgent, HttpSearchProvider } from '../src/index.js';

// Measures local orchestration overhead and cache behavior, not LLM quality or latency.
const samples: number[] = [];
for (let iteration = 0; iteration < 110; iteration++) {
  const agent = createDemoAgent({ traceDir: undefined });
  const start = performance.now();
  await agent.process('Calcule 12 + 8');
  assert.equal(agent.getTrace()?.status, 'completed');
  assert.deepEqual(agent.getState().toolCalls[0]?.result?.data, { result: 20 });
  if (iteration >= 10) samples.push(performance.now() - start);
}
let requests = 0;
const search = new HttpSearchProvider({ endpoint: 'https://search.invalid/search', fetch: async () => { requests++; return Response.json({ results: [{ title: 'Fixture', url: 'https://example.org', snippet: 'Synthetic benchmark data' }] }); } });
for (let i = 0; i < 100; i++) await search.search({ query: 'repeat' });
assert.equal(requests, 1);
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ kind: 'offline-orchestration-only', node: process.version, runs: samples.length, medianMs: samples[Math.floor(samples.length * 0.5)], p95Ms: samples[Math.floor(samples.length * 0.95)], cache: search.getCacheStats(), underlyingRequests: requests }, null, 2));
