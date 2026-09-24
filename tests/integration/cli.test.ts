import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
  env: { ...process.env, LLM_PROVIDER: 'mock', LLM_MODEL: 'mock', SEARCH_PROVIDER: 'fixture', PERSIST_TRACES: 'false', PERSIST_MEMORY: 'false', ...env },
  timeout: 15000, maxBuffer: 1_000_000,
});
test('CLI help and version are available without valid provider configuration', async () => {
  assert.match((await run(['--help'], { LLM_PROVIDER: 'invalid' })).stdout, /Harness/);
  assert.equal((await run(['--version'])).stdout.trim(), '0.1.0');
});
test('CLI emits parseable JSON and deterministic demo ignores provider configuration', async () => {
  const { stdout } = await run(['demo', '--json'], { LLM_PROVIDER: 'invalid' });
  const parsed = JSON.parse(stdout) as { response: string; trace: { status: string; toolCalls: unknown[] } };
  assert.match(parsed.response, /démonstration/); assert.equal(parsed.trace.status, 'completed'); assert.equal(parsed.trace.toolCalls.length, 1);
  const regular = JSON.parse((await run(['run', 'Calcule 8 * 7', '--json'])).stdout) as { trace: { toolCalls: Array<{ result: { data: { result: number } } }> } };
  assert.equal(regular.trace.toolCalls[0]?.result.data.result, 56);
});
test('CLI doctor works offline, and invalid requests return nonzero exit codes', async () => {
  assert.equal((JSON.parse((await run(['doctor'])).stdout) as { ok: boolean }).ok, true);
  for (const args of [['run'], ['unknown'], ['demo', 'unexpected'], ['chat', '--json'], ['chat']]) {
    await assert.rejects(run(args), error => { assert.equal((error as { code?: number }).code, 1); return true; });
  }
  await assert.rejects(run(['doctor'], { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: '' }), /LLM_MODEL/);
});
