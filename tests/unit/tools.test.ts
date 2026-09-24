import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { JsonValue, Parameters, Tool } from '../../src/core/types.js';
import { calculate } from '../../src/tools/calculate.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { FixtureSearchProvider } from '../../src/tools/search-tool.js';

test('calculator respects precedence, right-associative powers and unary signs', () => {
  for (const [expression, expected] of [['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['2 ^ 3 ^ 2', 512], ['-2**2', -4], ['2^-2', 0.25], ['1.5e2 + .5', 150.5], ['7 % 3', 1], ['4 / 2 - -2', 4]] as const) {
    assert.equal(calculate(expression), expected, expression);
  }
});

test('calculator rejects code, malformed input, non-finite values and large expressions', () => {
  for (const expression of ['', ' ', 'process.exit()', 'globalThis.secret', '1;2', 'Math.sqrt(2)', '2 3', '(2+3', '1/0', '0%0', '10^1000', '1e999', '1+'.repeat(130), '1'.repeat(1025)]) {
    assert.throws(() => calculate(expression), expression);
  }
});

test('registry exposes only explicit capabilities and protects metadata from mutation', () => {
  const registry = new ToolRegistry();
  assert.deepEqual(registry.listAll().map((tool) => tool.name), ['calculate']);
  const tool = registry.get('calculate')!;
  tool.parameters[0]!.required = false;
  assert.equal(registry.get('calculate')!.parameters[0]!.required, true);
  assert.throws(() => registry.register(tool), /already registered/);
  assert.match(registry.getFormattedDescription(), /expression/);
  assert.equal(new ToolRegistry(new FixtureSearchProvider()).get('web_search')?.name, 'web_search');
});

function checkedRegistry(): { registry: ToolRegistry; invocations: () => number } {
  let count = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'checked', description: 'A validation test tool.',
    parameters: [
      { name: 'mode', type: 'string', description: 'Mode', required: true, enum: ['a', 'b'] },
      { name: 'count', type: 'number', description: 'Count', required: false, minimum: 1, maximum: 3 },
      { name: 'enabled', type: 'boolean', description: 'Enabled', required: false },
      { name: 'items', type: 'array', description: 'Items', required: false },
      { name: 'options', type: 'object', description: 'Options', required: false },
    ],
    execute: async (params) => { count++; return params; },
  });
  return { registry, invocations: () => count };
}

test('executor rejects invalid parameters before invoking a tool', async () => {
  const { registry, invocations } = checkedRegistry();
  const executor = new ToolExecutor(registry);
  const invalid: Parameters[] = [{}, { mode: 'c' }, { mode: 1 }, { mode: 'a', count: 0 }, { mode: 'b', count: 4 }, { mode: 'a', enabled: 'yes' }, { mode: 'a', items: {} }, { mode: 'b', options: [] }, { mode: 'a', options: null }, { mode: 'a', other: true }, { mode: 'a', count: NaN }];
  for (const parameters of invalid) {
    const call = await executor.execute('checked', parameters);
    assert.equal(call.status, 'failed');
    assert.equal(call.result?.success, false);
    assert.ok(call.error);
  }
  assert.equal(invocations(), 0);
  assert.equal((await executor.execute('checked', { mode: 'a', count: 2, enabled: true, items: [1], options: {} })).status, 'completed');
  assert.equal(invocations(), 1);
});

test('executor reports unknown tools and enforces an empty allowlist', async () => {
  const registry = new ToolRegistry();
  assert.match((await new ToolExecutor(registry).execute('missing', {})).error!, /Unknown tool/);
  assert.match((await new ToolExecutor(registry, { allowedTools: [] }).execute('calculate', { expression: '1+2' })).error!, /not allowed/);
});

test('executor snapshots input, passes execution context and records bounded output metadata', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'context', description: 'Context tool', parameters: [{ name: 'nested', type: 'object', description: 'Object', required: true }], execute: async (parameters, context) => {
    assert.equal(context.sessionId, 'test-session');
    assert.equal(context.signal.aborted, false);
    (parameters.nested as Record<string, JsonValue>).value = 99;
    return { answer: 42 };
  } });
  const input = { nested: { value: 1 } };
  const call = await new ToolExecutor(registry).execute('context', input, { sessionId: 'test-session' });
  assert.equal(call.status, 'completed');
  assert.deepEqual(call.parameters, input);
  assert.deepEqual(input, { nested: { value: 1 } });
  assert.deepEqual(call.result?.data, { answer: 42 });
  assert.equal(call.result?.raw, '{"answer":42}');
  assert.ok(call.executionTime >= 0);
  assert.equal(call.result?.metadata.toolName, 'context');
  assert.ok(Number.isFinite(Date.parse(call.timestamp)));
});

test('invalid, circular and oversized outputs fail without retaining output', async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of ['x'.repeat(100), Infinity, undefined, cycle, new Date()]) {
    const registry = new ToolRegistry();
    registry.register({ name: 'bad', description: 'Bad output', parameters: [], execute: async () => value as JsonValue });
    const call = await new ToolExecutor(registry, { maxResultChars: 50 }).execute('bad', {});
    assert.equal(call.status, 'failed');
    assert.equal(call.result?.data, null);
    assert.equal(call.result?.raw, '');
  }
});

test('executor converts thrown errors into failed calls', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'throws', description: 'Throw', parameters: [], execute: async () => { throw new Error('Expected failure'); } });
  assert.equal((await new ToolExecutor(registry).execute('throws', {})).error, 'Expected failure');
});

test('timeout aborts the tool and returns even when the tool ignores cancellation', async () => {
  const registry = new ToolRegistry();
  let observed: AbortSignal | undefined;
  registry.register({ name: 'hang', description: 'Never resolves', parameters: [], execute: async (_, context) => { observed = context.signal; return new Promise<JsonValue>(() => {}); } });
  const executor = new ToolExecutor(registry, { timeoutMs: 15, maxConcurrency: 1 });
  const call = await executor.execute('hang', {});
  assert.equal(call.status, 'failed');
  assert.match(call.error!, /timed out/);
  assert.equal(observed?.aborted, true);
  // A timed-out but still running custom tool retains its slot, preventing unbounded work.
  assert.match((await executor.execute('calculate', { expression: '2+2' })).error!, /timed out/);
});

test('executor honors pre-abort and active cancellation', async () => {
  const { registry, invocations } = checkedRegistry();
  const controller = new AbortController(); controller.abort(new Error('User cancelled'));
  assert.match((await new ToolExecutor(registry).execute('checked', { mode: 'a' }, { signal: controller.signal })).error!, /User cancelled/);
  assert.equal(invocations(), 0);
  registry.register({ name: 'wait', description: 'Wait for abort', parameters: [], execute: async (_, context) => { await delay(1000, undefined, { signal: context.signal }); return null; } });
  const active = new AbortController();
  const pending = new ToolExecutor(registry).execute('wait', {}, { signal: active.signal });
  active.abort(new Error('Stop now'));
  assert.equal((await pending).status, 'failed');
});

test('parallel execution preserves order and caps global concurrency', async () => {
  const registry = new ToolRegistry();
  let active = 0; let maximum = 0;
  registry.register({ name: 'work', description: 'Track concurrency', parameters: [{ name: 'id', type: 'number', description: 'ID', required: true }], execute: async ({ id }) => {
    active++; maximum = Math.max(maximum, active);
    await delay(Number(id) % 2 ? 2 : 8);
    active--;
    return id!;
  } });
  const executor = new ToolExecutor(registry, { maxConcurrency: 2 });
  const first = executor.executeParallel(Array.from({ length: 6 }, (_, id) => ({ toolName: 'work', parameters: { id } })));
  const second = executor.execute('work', { id: 10 });
  const [results, extra] = await Promise.all([first, second]);
  assert.equal(maximum, 2);
  assert.deepEqual(results.map((result) => result.result?.data), [0, 1, 2, 3, 4, 5]);
  assert.equal(extra.result?.data, 10);
});

test('registry rejects ambiguous or malformed capability schemas', () => {
  const tool: Tool = { name: 'valid', description: 'Valid tool', parameters: [], execute: async () => null };
  const registry = new ToolRegistry();
  assert.throws(() => registry.register({ ...tool, name: '../shell' }), /name/);
  assert.throws(() => registry.register({ ...tool, parameters: [{ name: 'x', type: 'number', description: '', required: true, minimum: 2, maximum: 1 }] }), /minimum/);
  assert.throws(() => registry.register({ ...tool, parameters: [{ name: 'x', type: 'number', description: '', required: true, enum: ['a'] }] }), /enum/);
});

test('executor rejects invalid resource limits at construction', () => {
  for (const options of [{ timeoutMs: 0 }, { maxConcurrency: 0 }, { maxConcurrency: 65 }, { maxResultChars: NaN }]) assert.throws(() => new ToolExecutor(new ToolRegistry(), options));
});
