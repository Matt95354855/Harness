import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Logger } from '../../src/utils/logger.js';

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-logger-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('logger filters severity, keeps a bounded buffer, and returns defensive copies', () => {
  const logger = new Logger('worker', { level: 'WARN', maxEntries: 2, console: false });
  logger.debug('hidden'); logger.info('hidden'); logger.warn('first'); logger.error('second', { nested: { value: 1 } }); logger.warn('third');
  assert.deepEqual(logger.getLogs().map(item => item.message), ['second', 'third']);
  const copy = logger.getLogs();
  (copy[0]!.data!.nested as { value: number }).value = 2;
  assert.deepEqual(logger.getLogs()[0]!.data, { nested: { value: 1 } });
  assert.equal(logger.getLogs()[0]!.component, 'worker');
  assert.equal(logger.getLogs()[0]!.level, 'ERROR');
  logger.clear(); assert.equal(logger.getLogs().length, 0);
});

test('logger recursively redacts known credential keys and common textual credentials', () => {
  const logger = new Logger('worker', { console: false });
  const source = { api_key: 'secret-one', Authorization: 'secret-two', nested: [{ password: 'secret-three', accessToken: 'secret-four', client_secret: 'secret-five', normal: 'kept' }], totalTokens: 12 };
  logger.info('token=secret-six Authorization: Bearer secret-seven key sk-abcdefghijklmnop', source);
  logger.warn('Authorization: Basic c2VjcmV0OnBhc3N3b3Jk');
  const serialized = JSON.stringify(logger.getLogs());
  for (const secret of ['secret-one', 'secret-two', 'secret-three', 'secret-four', 'secret-five', 'secret-six', 'secret-seven', 'sk-abcdefghijklmnop', 'c2VjcmV0OnBhc3N3b3Jk']) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /kept/);
  assert.equal(logger.getLogs()[0]!.data!.totalTokens, 12);
  assert.equal(source.api_key, 'secret-one');
});

test('logger handles cycles, big integers, error objects, and detached input', () => {
  const logger = new Logger('worker', { console: false });
  const data: Record<string, unknown> = { large: 123n, error: new Error('password=never-log-this'), nested: { count: 1 } };
  data.self = data;
  logger.info('entry', data);
  (data.nested as { count: number }).count = 9;
  assert.equal(logger.getLogs()[0]!.data!.self, '[Circular]');
  assert.equal(logger.getLogs()[0]!.data!.large, '123');
  assert.deepEqual(logger.getLogs()[0]!.data!.nested, { count: 1 });
  assert.equal(JSON.stringify(logger.getLogs()).includes('never-log-this'), false);
});

test('console logs go to stderr and zero maxEntries disables retention', t => {
  const chunks: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string) => { chunks.push(chunk); return true; });
  const logger = new Logger('cli', { level: 'DEBUG', maxEntries: 0 });
  logger.debug('debug'); logger.info('info'); logger.warn('warn'); logger.error('error');
  assert.deepEqual(chunks.map(chunk => (JSON.parse(chunk) as { level: string }).level), ['DEBUG', 'INFO', 'WARN', 'ERROR']);
  assert.equal(logger.getLogs().length, 0);
});

test('file logger creates private JSONL and rotates into one bounded backup', async t => {
  const root = await directory(t);
  const filePath = join(root, 'nested', 'events.jsonl');
  const logger = new Logger('worker', { console: false, filePath, maxFileBytes: 350 });
  for (let index = 0; index < 12; index++) logger.info(`message ${index}`, { token: 'must-not-leak' });
  assert.deepEqual((await readdir(join(root, 'nested'))).sort(), ['events.jsonl', 'events.jsonl.1']);
  for (const path of [filePath, `${filePath}.1`]) {
    const metadata = await stat(path);
    assert.ok(metadata.size <= 350);
    assert.equal(metadata.mode & 0o777, 0o600);
    const content = await readFile(path, 'utf8');
    assert.equal(content.includes('must-not-leak'), false);
    for (const line of content.trim().split('\n')) assert.equal((JSON.parse(line) as { component: string }).component, 'worker');
  }
  assert.match(await readFile(filePath, 'utf8'), /message 11/);
});

test('oversized log entries remain valid JSON and respect byte limits', async t => {
  const filePath = join(await directory(t), 'events.jsonl');
  const logger = new Logger('é'.repeat(100), { console: false, filePath, maxFileBytes: 256 });
  logger.info('x'.repeat(10000), { nested: 'y'.repeat(10000) });
  const content = await readFile(filePath, 'utf8');
  assert.ok(Buffer.byteLength(content) <= 256);
  assert.match((JSON.parse(content) as { message: string }).message, /exceeded maxFileBytes/);
});

test('file errors are explicit and invalid limits are rejected', async t => {
  const root = await directory(t);
  const path = join(root, 'parent-file');
  await writeFile(path, 'existing');
  assert.throws(() => new Logger('worker', { console: false, filePath: join(path, 'bad.jsonl') }).info('fail'));
  const initialMode = (await stat(root)).mode;
  assert.throws(() => new Logger('worker', { console: false, filePath: root }).info('fail'), /regular file/);
  assert.equal((await stat(root)).mode, initialMode);
  assert.throws(() => new Logger('worker', { maxEntries: -1 }), /maxEntries/);
  assert.throws(() => new Logger('worker', { maxFileBytes: 10 }), /maxFileBytes/);
});
