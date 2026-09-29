import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MassClassificationTools } from '../src/tools/mass-classification.js';
import type { JsonValue } from '../src/core/types.js';

const endpoint = 'http://127.0.0.1:8000';
const key = process.env.MASS_CLASSIFICATION_API_KEY!;
const adapter = await MassClassificationTools.create({ endpoint, apiKey: key, inputRoots: [resolve('fixtures')], enableFeedback: true });
const context = { signal: AbortSignal.timeout(300_000), sessionId: 'e2e' };
const tools = adapter.tools();
const call = async (name: string, params: Record<string, string | number | boolean>) => {
  const result = await tools.find(t => t.name === name)!.execute(params, context);
  return result as Record<string, JsonValue>;
};
await call('mass_capabilities', {});
for (const extension of ['pdf', 'docx']) {
  const profile = await call('mass_profile_document', { path: resolve(`fixtures/sample.${extension}`) });
  assert.equal(profile.format, `.${extension}`);
  const uploaded = await call('mass_submit_document', { path: resolve(`fixtures/sample.${extension}`) });
  assert.equal(typeof uploaded.id, 'string');
  const result = await adapter.waitForDocument(String(uploaded.id), { timeoutMs: 240_000 });
  assert.equal((result as Record<string, unknown>).status, 'ready', JSON.stringify(result));
  assert.ok(!('content' in (result as object)));
  const raw = await fetch(`${endpoint}/v1/documents/${uploaded.id}`, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json());
  assert.match(raw.content, /ORION/u, 'Image text must be recovered by real OCR');
  assert.match(raw.content, /1250/u, 'Table amount must survive extraction');
  assert.equal(raw.metadata.preprocessing, 'ocr_first');
  assert.equal(raw.metadata.input_profile.sha256, profile.sha256);
  assert.equal(raw.metadata.input_profile.native_text_present, true);
  assert.ok(raw.metadata.input_profile.images >= 1);
  if (extension === 'docx') assert.equal(raw.metadata.input_profile.tables, 1);
  else assert.equal(raw.metadata.input_profile.pages, 1);
  assert.equal(raw.analysis.labels.method, 'rules:v1');
  const duplicate = await call('mass_submit_document', { path: resolve(`fixtures/sample.${extension}`) });
  assert.equal(duplicate.id, uploaded.id); assert.equal(duplicate.duplicate, true);
  await call('mass_submit_feedback', { documentId: String(uploaded.id), label: 'banking', accepted: true });
  console.log(`${extension}: upload, OCR, analysis, deduplication, feedback PASS`);
}
const evidence = await call('mass_search_evidence', { query: 'ORION virement 1250 EUR', limit: 10 });
assert.ok(Array.isArray(evidence) && evidence.length >= 2);
assert.ok(evidence.some(item => /ORION/u.test(String(item.text))));
assert.equal((await fetch(`${endpoint}/v1/capabilities`)).status, 401);
console.log('Vector evidence search and unauthenticated rejection PASS');
