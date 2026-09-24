import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Agent, HttpSearchProvider, LLMClient, ToolRegistry } from '../../src/index.js';

test('real loopback HTTP transports complete search, model planning and synthesis end to end', async t => {
  const requests: Array<{ url: string; body: string; authorization: string | undefined }> = [];
  let decisions = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push({ url: request.url!, body, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'local-fixture' }] })); return; }
    if (request.url?.startsWith('/search?')) {
      response.end(JSON.stringify({ results: [{ url: 'https://example.org/evidence', title: 'Local HTTP fixture', snippet: 'Evidence transported through a real loopback connection.' }] })); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end('{}'); return; }
    const input = JSON.parse(body) as { messages: Array<{ content: string }> };
    const prompt = input.messages.at(-1)!.content;
    const content = prompt.startsWith('HARNESS_DECIDE')
      ? JSON.stringify(decisions++ === 0 ? { summary: 'Look up evidence', nextAction: 'SEARCH', query: 'loopback evidence', confidence: 1 } : { summary: 'Sufficient evidence', nextAction: 'RESPOND', confidence: 1 })
      : 'Verified with local HTTP fixture: https://example.org/evidence';
    response.end(JSON.stringify({ model: 'local-fixture', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const llm = new LLMClient({ endpoint: `${base}/v1`, model: 'local-fixture', apiKey: 'fixture-key' });
  assert.deepEqual(await llm.listModels(), ['local-fixture']);
  const registry = new ToolRegistry(new HttpSearchProvider({ endpoint: `${base}/search`, maxRetries: 0 }));
  const agent = new Agent({ traceDir: undefined }, { llm, registry });
  assert.match(await agent.process('Find evidence'), /example.org\/evidence/);
  assert.equal(agent.getTrace()?.usage.totalTokens, 45);
  assert.equal(agent.getTrace()?.toolCalls[0]?.status, 'completed');
  const completions = requests.filter(request => request.url.endsWith('/chat/completions'));
  assert.equal(completions.length, 3);
  assert.ok(completions.every(request => request.authorization === 'Bearer fixture-key'));
  assert.match(completions.at(-1)!.body, /Evidence transported through a real loopback connection/);
  assert.ok(requests.some(request => request.url.includes('q=loopback+evidence')));
});
