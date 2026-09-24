import assert from 'node:assert/strict';
import test from 'node:test';
import { agentConfigSchema, loadConfig, validateConfig } from '../../src/core/config.js';
import { PrismAdapter } from '../../src/models/prism-adapter.js';
import { parseJsonObject } from '../../src/utils/parser.js';

test('configuration defaults are offline and retain explicit zero values', () => {
  const config = loadConfig({ TEMPERATURE: '0', TOP_P: '0', MAX_TOOL_CALLS: '0', PERSIST_TRACES: 'false' });
  assert.equal(config.provider, 'mock'); assert.equal(config.search.provider, 'fixture');
  assert.equal(config.agent.temperature, 0); assert.equal(config.agent.topP, 0);
  assert.equal(config.agent.maxToolCalls, 0); assert.equal(config.agent.traceDir, undefined);
  assert.equal(config.memory.persistencePath, undefined);
});
test('local provider requires a model but no API key and defaults to no search', () => {
  const config = loadConfig({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'local-test' });
  assert.equal(config.llm.apiKey, undefined); assert.equal(config.search.provider, 'none');
  assert.equal(config.llm.endpoint, 'http://127.0.0.1:11434/v1');
  assert.throws(() => loadConfig({ LLM_PROVIDER: 'openai-compatible' }), /LLM_MODEL/);
});
test('configuration rejects invalid numbers, switches and unsupported endpoints early', () => {
  const invalid: NodeJS.ProcessEnv[] = [{ MAX_ITERATIONS: '0' }, { MAX_ITERATIONS: '2.5' }, { MAX_ITERATIONS: 'oops' }, { TEMPERATURE: '' }, { TEMPERATURE: '3' }, { TOP_P: '-1' }, { PERSIST_MEMORY: 'yes' }, { LLM_PROVIDER: 'missing' }, { SEARCH_PROVIDER: 'http' }, { LLM_ENDPOINT: 'file:///tmp/test' }, { LOG_LEVEL: 'trace' }, { LLM_MAX_RETRIES: '6' }];
  for (const env of invalid) assert.ok(validateConfig(env).length > 0, JSON.stringify(env));
  assert.deepEqual(validateConfig({}), []);
  assert.throws(() => agentConfigSchema.parse({ runTimeoutMs: 0 }));
});
test('configuration supports explicit allowlists, persistence and live search', () => {
  const config = loadConfig({ ALLOWED_TOOLS: 'calculate, web_search', PERSIST_MEMORY: 'true', SEARCH_PROVIDER: 'searxng', SEARCH_ENDPOINT: 'https://search.example.org/search', LOG_FILE: '.harness/log.jsonl' });
  assert.deepEqual(config.agent.allowedTools, ['calculate', 'web_search']);
  assert.deepEqual(loadConfig({ ALLOWED_TOOLS: '' }).agent.allowedTools, []);
  assert.equal(config.memory.persistencePath, '.harness/memory.json');
  assert.equal(config.search.options?.format, 'searxng');
});
test('templates require declared variables, perform literal one-pass substitution and snapshot metadata', () => {
  const templates = new PrismAdapter();
  templates.registerTemplate({ name: 'test', version: '1', variables: ['first', 'second'], template: '{{first}} then {{ second }} and {{first}}' });
  const rendered = templates.render('test', { first: '$& {{second}}', second: { value: 2 } });
  assert.equal(rendered.formatted, '$& {{second}} then {"value":2} and $& {{second}}');
  assert.throws(() => templates.render('test', { first: 1 }), /Missing/);
  assert.throws(() => templates.render('missing', {}), /not found/);
  assert.throws(() => templates.registerTemplate({ name: 'bad', version: '1', variables: [], template: '{{secret}}' }), /Undeclared/);
  const snapshot = templates.getTemplate('test')!; snapshot.template = 'corrupted';
  assert.notEqual(templates.getTemplate('test')?.template, 'corrupted');
  assert.equal(templates.listTemplates().length, 5);
});
test('JSON parsing accepts one fenced object and rejects ambiguous text and non-objects', () => {
  assert.deepEqual(parseJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  for (const text of ['prefix {"ok":true}', '{"a":1} {"b":2}', '[]', 'null', '"string"']) assert.throws(() => parseJsonObject(text));
});
