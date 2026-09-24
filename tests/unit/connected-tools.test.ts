import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GoogleDriveTools } from '../../src/tools/google-drive.js';
import { LocalFileTools } from '../../src/tools/local-files.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { WebFetchTool } from '../../src/tools/web-fetch.js';
import { McpConnections } from '../../src/tools/mcp-client.js';
import { createConfiguredToolRuntime } from '../../src/tools/configured-runtime.js';

function executor(tools: ReturnType<LocalFileTools['tools']> | ReturnType<GoogleDriveTools['tools']> | WebFetchTool[]): ToolExecutor {
  const registry = new ToolRegistry(); for (const tool of tools) registry.register(tool); return new ToolExecutor(registry);
}

test('local file tools read, list and search only inside authorized roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-files-')); const outside = await mkdtemp(join(tmpdir(), 'harness-outside-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await Promise.all([rm(root, { recursive: true }), rm(outside, { recursive: true })]); });
  await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs', 'note.txt'), 'Bonjour Harness\nMCP prêt');
  await writeFile(join(outside, 'secret.txt'), 'secret'); await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  const run = executor((await LocalFileTools.create([root])).tools());
  assert.equal((await run.execute('local_read', { path: join(root, 'docs', 'note.txt') })).status, 'completed');
  assert.match(JSON.stringify((await run.execute('local_search', { path: root, query: 'MCP' })).result?.data), /note\.txt/u);
  assert.match((await run.execute('local_read', { path: join(root, 'escape.txt') })).error!, /outside/u);
});

test('web fetch rejects loopback and credential-bearing URLs before requesting them', async () => {
  const run = executor([new WebFetchTool()]);
  assert.match((await run.execute('web_fetch', { url: 'http://127.0.0.1/private' })).error!, /Private/u);
  assert.match((await run.execute('web_fetch', { url: 'https://user:pass@example.com/' })).error!, /credential-free/u);
});

test('Google Drive tools search and read documents with bearer authentication', async () => {
  const requests: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.includes('fields=id')) return new Response(JSON.stringify({ id: 'abcdefghij', name: 'Plan', mimeType: 'application/vnd.google-apps.document' }));
    if (url.includes('/export?')) return new Response('Contenu du plan');
    return new Response(JSON.stringify({ files: [{ id: 'abcdefghij', name: 'Plan' }] }));
  }) as typeof fetch;
  const run = executor(new GoogleDriveTools('test-token', fakeFetch).tools());
  assert.equal((await run.execute('drive_search', { query: 'plan', maxResults: 5 })).status, 'completed');
  assert.match(JSON.stringify((await run.execute('drive_read', { fileId: 'abcdefghij' })).result?.data), /Contenu du plan/u);
  assert.ok(requests.every(request => request.auth === 'Bearer test-token'));
  assert.ok(requests[0]!.url.startsWith('https://www.googleapis.com/drive/v3/'));
});

test('MCP client discovers and invokes tools from a stdio server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-mcp-')); const config = join(root, 'mcp.json');
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true }); });
  await writeFile(config, JSON.stringify({ servers: { fixture: { command: process.execPath, args: ['--import', 'tsx', 'tests/fixtures/mcp-server.ts'], cwd: process.cwd() } } }));
  const connections = new McpConnections(); t.after(() => connections.close());
  const tools = await connections.connectFile(config); const run = executor(tools);
  assert.deepEqual(tools.map(tool => tool.name), ['mcp_fixture_echo']);
  assert.deepEqual((await run.execute('mcp_fixture_echo', { text: 'bonjour' })).result?.data, { echoed: 'bonjour' });
});

test('an explicit allowlist does not initialize unrelated configured connections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-disabled-mcp-')); const config = join(root, 'mcp.json');
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true }); });
  await writeFile(config, JSON.stringify({ servers: { github: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer $MISSING_TOKEN' } } } }));
  const runtime = await createConfiguredToolRuntime({ LLM_PROVIDER: 'mock', LLM_MODEL: 'mock', SEARCH_PROVIDER: 'none', PERSIST_TRACES: 'false', WEB_ACCESS: 'true', ALLOWED_TOOLS: 'web_fetch', MCP_CONFIG_PATH: config });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.capabilities, ['web']);
  assert.deepEqual(runtime.registry.listAll().map(tool => tool.name), ['calculate', 'web_fetch']);
});
