import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createWebApp } from '../../src/web/app.js';
import { openStore } from '../../src/web/store.js';
import { authenticator, token, verifyPassword } from '../../src/web/security.js';

test('Web security: local-only enrollment, mandatory MFA, replay/CSRF/ownership protection and revocable sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-web-test-'));
  const db = openStore(directory);
  const setupToken = token();
  const settings = { db, directory, assets: join(directory, 'assets'), origin: 'https://chat.example.test', setupOrigin: 'http://127.0.0.1:3081', setupToken,
    status: () => ({ state: 'ready' }), enqueue: () => {}, cancel: () => {} };
  const setupApp = createWebApp(settings, true).listen(0, '127.0.0.1');
  const publicApp = createWebApp(settings).listen(0, '127.0.0.1');
  const trustedOrigin = 'http://127.0.0.1:3082';
  const trustedApp = createWebApp({ ...settings, origin: trustedOrigin, trustedLocal: true }).listen(0, '127.0.0.1');
  await Promise.all([once(setupApp, 'listening'), once(publicApp, 'listening'), once(trustedApp, 'listening')]);
  const port = (server: typeof setupApp) => (server.address() as { port: number }).port;
  async function request(path: string, method = 'GET', body?: object, headers: Record<string, string> = {}, target: 'public' | 'setup' | 'trusted' = 'public') {
    const origin = target === 'setup' ? settings.setupOrigin : target === 'trusted' ? trustedOrigin : settings.origin;
    const server = target === 'setup' ? setupApp : target === 'trusted' ? trustedApp : publicApp;
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${port(server)}${path}`, { method,
        headers: { Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json', ...headers } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: responseHeaders }));
        });
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  try {
    const localBootstrap = await (await request('/api/bootstrap', 'GET', undefined, {}, 'trusted')).json() as { initialized: boolean; localTrusted: boolean };
    assert.deepEqual(localBootstrap, { setup: false, initialized: true, localTrusted: true });
    const localIdentity = await (await request('/api/me', 'GET', undefined, {}, 'trusted')).json() as { csrf: string; localTrusted: boolean };
    assert.equal(localIdentity.localTrusted, true);
    assert.equal((await request('/api/chats', 'POST', { model: 'qwen' }, { 'X-CSRF-Token': localIdentity.csrf }, 'trusted')).status, 201);
    const publicBootstrapResponse = await request('/api/bootstrap');
    assert.equal(publicBootstrapResponse.status, 200);
    const publicBootstrap = await publicBootstrapResponse.json() as { initialized: boolean };
    assert.equal(publicBootstrap.initialized, false);
    assert.equal((await request('/api/chats')).status, 401);
    assert.equal((await request('/api/setup/begin', 'POST', {})).status, 401);
    assert.equal((await request('/api/setup/begin', 'POST', {}, {}, 'setup')).status, 403);
    assert.equal((await request('/api/setup/begin', 'POST', {}, { Host: 'evil.test', 'X-Setup-Token': setupToken }, 'setup')).status, 421);
    const enrollment = await (await request('/api/setup/begin', 'POST', {}, { 'X-Setup-Token': setupToken }, 'setup')).json() as { secret: string };
    const password = 'a long unique test password 492!';
    const setupResponse = await request('/api/setup/finish', 'POST', { username: 'shadow', password, code: authenticator(enrollment.secret).generate() }, { 'X-Setup-Token': setupToken }, 'setup');
    assert.equal(setupResponse.status, 200);
    const recovery = (await setupResponse.json() as { recoveryCodes: string[] }).recoveryCodes;
    assert.equal(recovery.length, 8);
    assert.equal((await request('/api/setup/begin', 'POST', {}, { 'X-Setup-Token': setupToken }, 'setup')).status, 403);
    assert.equal((await request('/api/login', 'POST', { username: 'shadow', password, code: '000000' })).status, 401);
    const login = await request('/api/login', 'POST', { username: 'shadow', password, code: recovery[0] });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie')!;
    assert.match(setCookie, /__Host-harness=/); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!; const { csrf } = await login.json() as { csrf: string };
    assert.equal((await request('/api/login', 'POST', { username: 'shadow', password, code: recovery[0] })).status, 401);
    assert.equal((await request('/api/chats', 'POST', {}, { Cookie: cookie })).status, 403);
    assert.equal((await request('/api/chats', 'POST', {}, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://evil.test' })).status, 403);
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
    assert.equal((await (await request('/api/chats', 'GET', undefined, headers)).json() as unknown[]).length, 1, 'local chats transfer to the public account');
    const created = await request('/api/chats', 'POST', { model: 'qwen' }, headers); assert.equal(created.status, 201);
    const chat = await created.json() as { id: string };
    assert.equal((await request(`/api/chats/${chat.id}`, 'PATCH', { notes: 'Remember the project name.', model: 'gpt-oss' }, headers)).status, 200);
    const stored = await (await request(`/api/chats/${chat.id}`, 'GET', undefined, headers)).json() as { notes: string; model: string };
    assert.equal(stored.notes, 'Remember the project name.'); assert.equal(stored.model, 'gpt-oss');
    const otherUser = randomUUID();
    db.prepare('INSERT INTO users(id,username,password,totp) VALUES (?,?,?,?)').run(otherUser, 'other', 'unused', 'unused');
    const otherChat = randomUUID(); db.prepare('INSERT INTO chats(id,user_id,title,model,updated) VALUES (?,?,?,?,?)').run(otherChat, otherUser, 'private', 'qwen', Date.now());
    assert.equal((await request(`/api/chats/${otherChat}`, 'GET', undefined, headers)).status, 404);
    assert.equal((await request(`/api/chats/${otherChat}/messages`, 'POST', { model: 'qwen', content: 'hi' }, headers)).status, 404);
    assert.equal((await request('/api/logout-all', 'POST', {}, headers)).status, 200);
    assert.equal((await request('/api/chats', 'GET', undefined, headers)).status, 401);
    // A valid TOTP cannot be reused, even in another login with the correct password.
    db.prepare('UPDATE users SET last_counter=-1 WHERE username=?').run('shadow');
    const code = authenticator(enrollment.secret).generate();
    const renewed = await request('/api/login', 'POST', { username: 'shadow', password, code });
    assert.equal(renewed.status, 200);
    assert.equal((await request('/api/login', 'POST', { username: 'shadow', password, code })).status, 401);
    const record = db.prepare('SELECT password,totp FROM users WHERE username=?').get('shadow') as { password: string; totp: string };
    assert.match(record.password, /^\$argon2id\$/); assert.ok(!record.totp.includes(enrollment.secret));
    const renewedCsrf = (await renewed.json() as { csrf: string }).csrf;
    const renewedHeaders = { Cookie: renewed.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': renewedCsrf };
    assert.equal((await request('/api/password', 'POST', { currentPassword: 'incorrect', newPassword: 'another long password 782!', code }, renewedHeaders)).status, 403);
    const nextCode = authenticator(enrollment.secret).generate({ timestamp: Date.now() + 30000 });
    assert.equal((await request('/api/password', 'POST', { currentPassword: password, newPassword: 'another long password 782!', code: nextCode }, renewedHeaders)).status, 200);
    assert.equal((await request('/api/me', 'GET', undefined, renewedHeaders)).status, 401);
    const changed = db.prepare('SELECT password FROM users WHERE username=?').get('shadow') as { password: string };
    assert.ok(await verifyPassword(changed.password, 'another long password 782!'));
  } finally { setupApp.close(); publicApp.close(); trustedApp.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
