/** Explicit hardware smoke test. Uses an isolated temporary account/database and both real models. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { authenticator } from '../src/web/security.js';

const directory = mkdtempSync(join(tmpdir(), 'harness-web-hardware-'));
const child = spawn(process.execPath, [resolve('dist/src/web/server.js')], { windowsHide: true,
  env: { ...process.env, HARNESS_WEB_DATA: directory, HARNESS_WEB_ORIGIN: 'http://127.0.0.1:3080' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk));
let cookie = ''; let csrf = '';
async function request(path: string, method = 'GET', body?: object, setup = false) {
  const origin = `http://127.0.0.1:${setup ? 3081 : 3080}`;
  const result = await fetch(`${origin}/api${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
    Cookie: cookie, 'X-CSRF-Token': csrf, ...(setup ? { 'X-Setup-Token': readFileSync(join(directory, 'setup.token'), 'utf8') } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (result.headers.get('set-cookie')) cookie = result.headers.get('set-cookie')!.split(';')[0]!;
  const data = await result.json() as Record<string, unknown>;
  if (!result.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
}
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://127.0.0.1:3080/healthz')).ok) { ready = true; break; } } catch { /* startup */ }
    if (child.exitCode !== null) throw new Error('Server exited'); await delay(500);
  }
  assert.ok(ready, 'Server ready');
  const enrollment = await request('/setup/begin', 'POST', {}, true);
  const password = 'Temporary smoke test password 4829!';
  const account = await request('/setup/finish', 'POST', { username: 'smoke-test', password, code: authenticator(String(enrollment.secret)).generate() }, true);
  const login = await request('/login', 'POST', { username: 'smoke-test', password, code: (account.recoveryCodes as string[])[0] }); csrf = String(login.csrf);
  const chat = await request('/chats', 'POST', { model: 'gpt-oss' });
  async function run(model: string, content: string) {
    const run = await request(`/chats/${chat.id}/messages`, 'POST', { model, content });
    for (let i = 0; i < 300; i++) {
      await delay(2000);
      const state = await request(`/runs/${run.id}`);
      if (['failed', 'cancelled'].includes(String(state.status))) throw new Error(`${model}: ${state.error}`);
      if (state.status === 'completed') {
        const history = await request(`/chats/${chat.id}`);
        const messages = history.messages as { content: string }[];
        const answer = messages.at(-1)!.content;
        console.log(`SMOKE ${model}: ${answer}`); return answer;
      }
    }
    throw new Error('Smoke timed out');
  }
  const first = await run('gpt-oss', 'Le code de mon projet est ORION-42. Retiens-le pour cette conversation et confirme brièvement.');
  assert.match(first, /ORION.?42/i);
  const second = await run('qwen', 'Quel est le code de mon projet mentionné plus haut ? Ensuite calcule (12 + 8) * 3 avec l’outil calculate.');
  assert.match(second, /ORION.?42/i); assert.match(second, /60/);
  console.log('PASS: login + MFA, persisted chat, GPT-OSS, Qwen, cross-model memory and Harness calculator.');
} catch (error) {
  try { console.error(readFileSync(join(directory, 'model.log'), 'utf8').split('\n').slice(-25).join('\n')); } catch { /* no model log yet */ }
  throw error;
} finally {
  if (child.exitCode === null) {
    writeFileSync(join(directory, 'stop.request'), 'stop');
    await Promise.race([once(child, 'exit'), delay(20000)]);
    if (child.exitCode === null) child.kill();
  }
  rmSync(directory, { recursive: true, force: true });
}
