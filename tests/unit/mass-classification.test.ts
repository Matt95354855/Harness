import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConfiguredToolRuntime } from '../../src/tools/configured-runtime.js';
import { MassClassificationTools } from '../../src/tools/mass-classification.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

const documentId = '11111111-1111-4111-8111-111111111111';

test('Mass adapter bounds responses, hides error bodies and disables feedback by default', async () => {
  for (const response of [new Response('secret-server-body', { status: 403 }), new Response('x'.repeat(2048))]) {
    const adapter = await MassClassificationTools.create({ endpoint: 'https://mass.example.test', apiKey: 'mc_secret', maxResponseBytes: 1024, fetch: (async () => response) as typeof fetch });
    assert.ok(!adapter.tools().some(tool => tool.name === 'mass_submit_feedback'));
    const call = await execute(adapter.tools()).execute('mass_capabilities', {});
    assert.equal(call.status, 'failed');
    assert.ok(!call.error?.includes('secret'));
  }
});

test('Mass wait can be cancelled even when transport ignores the signal', async () => {
  const adapter = await MassClassificationTools.create({ endpoint: 'https://mass.example.test', apiKey: 'mc_test', fetch: (() => new Promise(() => {})) as typeof fetch });
  const controller = new AbortController();
  const waiting = adapter.waitForDocument(documentId, { signal: controller.signal });
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(waiting, /cancelled by caller/u);
});

function execute(tools: ReturnType<MassClassificationTools['tools']>): ToolExecutor {
  const registry = new ToolRegistry(); for (const tool of tools) registry.register(tool); return new ToolExecutor(registry);
}

test('Mass Classification tools submit authorized PDF and expose bounded asynchronous results', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mass-input-')); const outside = await mkdtemp(join(tmpdir(), 'mass-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true }), rm(outside, { recursive: true })]));
  const pdf = join(root, 'case.pdf'); await writeFile(pdf, '%PDF-1.4 synthetic');
  await writeFile(join(root, 'bad.txt'), 'not supported'); await writeFile(join(outside, 'outside.pdf'), '%PDF-1.4 outside');
  const requests: Array<{ url: string; method: string; auth: string | null; body?: BodyInit | null }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: init?.body });
    if (url.endsWith('/v1/capabilities')) return Response.json({ version: 'classification-capabilities:v1', inputs: ['.pdf', '.docx'] });
    if (url.endsWith('/v1/documents') && init?.method === 'POST') {
      assert.ok(init.body instanceof FormData); assert.equal((init.body.get('file') as File).name, 'case.pdf');
      assert.equal(init.body.get('source_json'), '{"case":"D-17"}');
      return Response.json({ id: documentId, job_id: 'job-1', status: 'queued', duplicate: false }, { status: 202 });
    }
    if (url.endsWith(`/v1/documents/${documentId}`)) return Response.json({ id: documentId, status: 'ready', content: 'sensitive raw text', analysis: { labels: { review_priority: 20 } } });
    if (url.endsWith('/v1/search')) return Response.json([{ document_id: documentId, text: 'preuve', similarity: 0.9 }]);
    if (url.endsWith(`/v1/documents/${documentId}/feedback`)) return Response.json({ id: 'feedback-1' }, { status: 201 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const tools = await MassClassificationTools.create({ endpoint: 'https://mass.example.test', apiKey: 'mc_test', inputRoots: [root], fetch: fakeFetch, enableFeedback: true });
  const run = execute(tools.tools());
  assert.equal((await run.execute('mass_capabilities', {})).status, 'completed');
  assert.equal((await run.execute('mass_submit_document', { path: pdf, source: { case: 'D-17' } })).status, 'completed');
  const result = (await run.execute('mass_get_document', { documentId })).result?.data;
  assert.equal(JSON.stringify(result).includes('sensitive raw text'), false); assert.match(JSON.stringify(result), /contentOmitted/u);
  assert.equal((await run.execute('mass_search_evidence', { query: 'virement', limit: 3 })).status, 'completed');
  assert.equal((await run.execute('mass_submit_feedback', { documentId, label: 'finance', accepted: true, comment: 'confirmé' })).status, 'completed');
  assert.match((await run.execute('mass_submit_document', { path: join(outside, 'outside.pdf') })).error!, /outside MASS_INPUT_ROOTS/u);
  assert.match((await run.execute('mass_submit_document', { path: join(root, 'bad.txt') })).error!, /Only PDF and DOCX/u);
  assert.ok(requests.every(request => request.auth === 'Bearer mc_test'));
  assert.ok(requests.every(request => !JSON.stringify(request.body ?? null).includes('mc_test')));
});

test('Mass Classification validates configuration and runtime allowlists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mass-runtime-')); t.after(() => rm(root, { recursive: true }));
  await assert.rejects(() => MassClassificationTools.create({ endpoint: 'https://user:pass@example.test', apiKey: 'mc_test' }), /without credentials/u);
  await assert.rejects(() => MassClassificationTools.create({ endpoint: 'https://mass.example.test', apiKey: 'invalid' }), /must start with mc_/u);
  const runtime = await createConfiguredToolRuntime({
    LLM_PROVIDER: 'mock', LLM_MODEL: 'mock', SEARCH_PROVIDER: 'none', PERSIST_TRACES: 'false',
    MASS_CLASSIFICATION_URL: 'https://mass.example.test', MASS_CLASSIFICATION_API_KEY: 'mc_test', MASS_INPUT_ROOTS: root,
    ALLOWED_TOOLS: 'mass_capabilities,mass_get_document',
  });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.capabilities, ['mass-classification']);
  assert.deepEqual(runtime.registry.listAll().map(tool => tool.name), ['calculate', 'mass_capabilities', 'mass_get_document']);
});

test('programmatic wait polls queued documents until ready', async () => {
  let calls = 0;
  const fakeFetch = (async () => Response.json(++calls === 1 ? { id: documentId, status: 'processing' } : { id: documentId, status: 'ready', content: 'raw', analysis: {} })) as typeof fetch;
  const tools = await MassClassificationTools.create({ endpoint: 'https://mass.example.test', apiKey: 'mc_test', fetch: fakeFetch });
  const result = await tools.waitForDocument(documentId, { intervalMs: 100, timeoutMs: 1000 });
  assert.equal((result as Record<string, unknown>).status, 'ready');
  assert.equal(JSON.stringify(result).includes('raw'), false);
  assert.equal(calls, 2);
});
