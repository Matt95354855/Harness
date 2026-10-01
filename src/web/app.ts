import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { digest, token, equal, hashPassword, verifyPassword, vault, totpCounter, authenticator } from './security.js';
import { models, isModel, type ModelId } from './models.js';

export interface User { id: string; username: string; password: string; totp: string; last_counter: number; failures: number; locked_until: number }
export interface Chat { id: string; user_id: string; title: string; model: ModelId; notes: string; updated: number }
export interface ChatMessage { id: string; role: string; content: string; model: string; created: number }
interface Session { hash: string; user_id: string; csrf: string; created: number; touched: number }
export interface WebOptions {
  db: DatabaseSync; directory: string; assets: string; origin: string; setupOrigin: string; setupToken: string;
  trustedLocal?: boolean;
  status: () => unknown;
  enqueue: (runId: string, chat: Chat, input: string) => void;
  cancel: (runId: string) => void;
}
const credentials = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9._@-]{3,100}$/), password: z.string().min(1).max(256), code: z.string().min(6).max(64) });
export function createWebApp(options: WebOptions, setup = false) {
  const { db } = options;
  const secrets = vault(options.directory);
  const app = express();
  const origin = setup ? options.setupOrigin : options.origin;
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-harness' : 'harness-local';
  let enrollment: { secret: string; expires: number } | undefined;
  let setupBusy = false;
  const localUsername = '__local__';
  const publicUser = () => db.prepare('SELECT id,username FROM users WHERE username<>? LIMIT 1').get(localUsername) as { id: string; username: string } | undefined;
  if (options.trustedLocal && !publicUser() && !db.prepare('SELECT id FROM users WHERE username=?').get(localUsername)) {
    db.prepare('INSERT INTO users(id,username,password,totp) VALUES (?,?,?,?)').run(randomUUID(), localUsername, token(), secrets.encrypt(new OTPAuth.Secret({ size: 20 }).base32));
  }
  const localCsrf = token();
  const dummyHash = hashPassword(token());
  const audit = (event: string) => db.prepare('INSERT INTO audit(event,created) VALUES (?,?)').run(event, Date.now());
  app.disable('x-powered-by');
  // No proxy-derived client identity is trusted. Rate limits below also apply globally/account-wide.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: secure ? [] : null } },
    strictTransportSecurity: secure ? { maxAge: 31536000 } : false }));
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.headers.host !== new URL(origin).host) { res.status(421).json({ error: 'Hôte non autorisé.' }); return; }
    // Every write requires a same-origin JSON request, including login and local enrollment.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (req.headers.origin !== origin || !req.is('application/json'))) {
      res.status(403).json({ error: 'Origine ou format non autorisé.' }); return;
    }
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, keyGenerator: () => 'global', standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(express.json({ limit: '24kb', strict: true }));
  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/bootstrap', (_req, res) => {
    res.json({ setup, initialized: options.trustedLocal || Boolean(publicUser()), localTrusted: Boolean(options.trustedLocal) });
  });
  if (setup) {
    app.use('/api/setup', rateLimit({ windowMs: 900000, limit: 20, keyGenerator: () => 'setup' }));
    app.use('/api/setup', (req, res, next) => {
      if (!equal(req.get('X-Setup-Token') ?? '', options.setupToken) || publicUser()) {
        res.status(403).json({ error: 'Initialisation indisponible ou clé locale invalide.' }); return;
      }
      next();
    });
    app.post('/api/setup/begin', async (_req, res) => {
      enrollment = { secret: new OTPAuth.Secret({ size: 20 }).base32, expires: Date.now() + 600000 };
      const uri = authenticator(enrollment.secret).toString();
      res.json({ qr: await QRCode.toDataURL(uri), secret: enrollment.secret });
    });
    app.post('/api/setup/finish', async (req, res) => {
      const parsed = credentials.extend({ password: z.string().min(15).max(256) }).safeParse(req.body);
      const pending = enrollment;
      if (setupBusy) { res.status(409).json({ error: 'Initialisation en cours.' }); return; }
      if (!parsed.success || !pending || pending.expires < Date.now()) { res.status(400).json({ error: 'Choisissez un identifiant valide, un mot de passe de 15 caractères minimum et un code valide.' }); return; }
      const counter = totpCounter(pending.secret, parsed.data.code);
      if (counter === null) { res.status(400).json({ error: 'Code de double authentification invalide.' }); return; }
      setupBusy = true;
      try {
        const password = await hashPassword(parsed.data.password);
        const id = randomUUID(); const codes = Array.from({ length: 8 }, () => randomBytes(12).toString('hex'));
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO users(id,username,password,totp,last_counter) VALUES (?,?,?,?,?)').run(id, parsed.data.username, password, secrets.encrypt(pending.secret), counter);
          for (const code of codes) db.prepare('INSERT INTO recovery(user_id,hash) VALUES (?,?)').run(id, digest(code));
          const local = db.prepare('SELECT id FROM users WHERE username=?').get(localUsername) as { id: string } | undefined;
          if (local) {
            db.prepare('UPDATE chats SET user_id=? WHERE user_id=?').run(id, local.id);
            db.prepare('UPDATE runs SET user_id=? WHERE user_id=?').run(id, local.id);
            db.prepare('DELETE FROM users WHERE id=?').run(local.id);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        enrollment = undefined; audit('account.created');
        res.json({ recoveryCodes: codes, loginUrl: options.origin });
      } finally { setupBusy = false; }
    });
  } else {
    app.post('/api/login', rateLimit({ windowMs: 900000, limit: 30, keyGenerator: () => 'login', message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' } }), async (req, res) => {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success) { res.status(401).json({ error: 'Identifiants ou code incorrects.' }); return; }
      const { username, password, code } = parsed.data;
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as unknown as User | undefined;
      if (user && user.locked_until > Date.now()) { res.status(401).json({ error: 'Connexion refusée. Vérifiez vos identifiants ou réessayez plus tard.' }); return; }
      const passwordOk = await verifyPassword(user?.password ?? await dummyHash, password);
      // Re-read after the asynchronous hash check: prevents concurrent TOTP/recovery replay.
      const fresh = user ? db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as unknown as User : undefined;
      const counter = fresh && passwordOk ? totpCounter(secrets.decrypt(fresh.totp), code) : null;
      const recovery = fresh && passwordOk ? db.prepare('SELECT hash FROM recovery WHERE user_id=? AND hash=?').get(fresh.id, digest(code)) : undefined;
      if (!fresh || !passwordOk || fresh.locked_until > Date.now() || (!(counter !== null && counter > fresh.last_counter) && !recovery)) {
        if (fresh) db.prepare('UPDATE users SET failures=failures+1, locked_until=CASE WHEN failures>=4 THEN ? ELSE locked_until END WHERE id=?').run(Date.now() + 900000, fresh.id);
        audit('login.failed'); res.status(401).json({ error: 'Identifiants ou code incorrects. Après 5 échecs, attendez 15 minutes.' }); return;
      }
      if (recovery) db.prepare('DELETE FROM recovery WHERE user_id=? AND hash=?').run(fresh.id, digest(code));
      else db.prepare('UPDATE users SET last_counter=? WHERE id=?').run(counter!, fresh.id);
      db.prepare('UPDATE users SET failures=0, locked_until=0 WHERE id=?').run(fresh.id);
      // Rotate rather than adopt any supplied session identifier.
      const old = readCookie(req, cookieName);
      if (old) db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(old));
      const session = token(); const csrf = token(); const now = Date.now();
      db.prepare('INSERT INTO sessions(hash,user_id,csrf,created,touched) VALUES (?,?,?,?,?)').run(digest(session), fresh.id, csrf, now, now);
      res.cookie(cookieName, session, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: 86400000 });
      audit(recovery ? 'login.recovery' : 'login.success'); res.json({ username: fresh.username, csrf });
    });
    app.use('/api', (req, res, next) => {
      if (options.trustedLocal) {
        const owner = publicUser() ?? db.prepare('SELECT id,username FROM users WHERE username=?').get(localUsername) as { id: string; username: string } | undefined;
        if (!owner) { res.status(503).json({ error: 'Compte local indisponible.' }); return; }
        if (req.method !== 'GET' && !equal(req.get('X-CSRF-Token') ?? '', localCsrf)) { res.status(403).json({ error: 'Jeton de sécurité invalide. Rechargez la page.' }); return; }
        res.locals.session = { hash: 'local', user_id: owner.id, csrf: localCsrf, created: Date.now(), touched: Date.now() } satisfies Session;
        res.locals.localTrusted = true;
        next(); return;
      }
      const cookie = readCookie(req, cookieName);
      const session = cookie ? db.prepare('SELECT * FROM sessions WHERE hash=?').get(digest(cookie)) as unknown as Session | undefined : undefined;
      if (!session || Date.now() - session.created > 86400000 || Date.now() - session.touched > 1800000) {
        if (session) db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);
        res.status(401).json({ error: 'Connectez-vous pour continuer.' }); return;
      }
      if (req.method !== 'GET' && !equal(req.get('X-CSRF-Token') ?? '', session.csrf)) { res.status(403).json({ error: 'Jeton de sécurité invalide. Rechargez la page.' }); return; }
      // Background polling does not keep an unattended browser session alive forever.
      if (!req.path.startsWith('/runs/') && req.path !== '/models') db.prepare('UPDATE sessions SET touched=? WHERE hash=?').run(Date.now(), session.hash);
      res.locals.session = session; next();
    });
    app.get('/api/me', (_req, res) => {
      const session = res.locals.session as Session;
      const user = db.prepare('SELECT username FROM users WHERE id=?').get(session.user_id);
      res.json({ ...user, username: res.locals.localTrusted ? 'Local' : (user as { username: string }).username, csrf: session.csrf, localTrusted: Boolean(res.locals.localTrusted) });
    });
    app.post('/api/logout', (_req, res) => { if (!res.locals.localTrusted) db.prepare('DELETE FROM sessions WHERE hash=?').run(res.locals.session.hash); res.clearCookie(cookieName, { path: '/', secure, sameSite: 'strict' }); res.json({ ok: true }); });
    app.post('/api/logout-all', (_req, res) => { if (!res.locals.localTrusted) { db.prepare('DELETE FROM sessions WHERE user_id=?').run(res.locals.session.user_id); audit('sessions.revoked'); } res.clearCookie(cookieName, { path: '/', secure, sameSite: 'strict' }); res.json({ ok: true }); });
    app.post('/api/password', rateLimit({ windowMs: 900000, limit: 5, keyGenerator: () => 'password-change' }), async (req, res) => {
      if (res.locals.localTrusted) { res.status(403).json({ error: 'Utilisez le site public pour modifier le compte.' }); return; }
      const parsed = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(15).max(256), code: z.string().regex(/^\d{6}$/) }).strict().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Mot de passe ou code invalide.' }); return; }
      const id = String(res.locals.session.user_id);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as User;
      if (!await verifyPassword(user.password, parsed.data.currentPassword)) { res.status(403).json({ error: 'Mot de passe ou code incorrect.' }); return; }
      const password = await hashPassword(parsed.data.newPassword);
      const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as User;
      const counter = totpCounter(secrets.decrypt(fresh.totp), parsed.data.code);
      if (fresh.password !== user.password || counter === null || counter <= fresh.last_counter) { res.status(403).json({ error: 'Code invalide ou déjà utilisé. Attendez le code suivant.' }); return; }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE users SET password=?,last_counter=? WHERE id=?').run(password, counter, id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      audit('password.changed'); res.clearCookie(cookieName, { path: '/', secure, sameSite: 'strict' }); res.json({ ok: true });
    });
    app.get('/api/models', (_req, res) => { res.json(options.status()); });
    app.get('/api/chats', (_req, res) => { res.json(db.prepare('SELECT id,title,model,updated FROM chats WHERE user_id=? ORDER BY updated DESC LIMIT 500').all(res.locals.session.user_id)); });
    app.post('/api/chats', (req, res) => {
      const model = isModel(req.body.model) ? req.body.model : models[0].id;
      const id = randomUUID();
      db.prepare('INSERT INTO chats(id,user_id,title,model,updated) VALUES (?,?,?,?,?)').run(id, res.locals.session.user_id, 'Nouvelle conversation', model, Date.now());
      res.status(201).json({ id });
    });
    const ownChat = (req: Request, res: Response, next: NextFunction) => {
      const chat = db.prepare('SELECT * FROM chats WHERE id=? AND user_id=?').get(String(req.params.id), res.locals.session.user_id) as unknown as Chat | undefined;
      if (!chat) { res.status(404).json({ error: 'Conversation introuvable.' }); return; }
      res.locals.chat = chat; next();
    };
    app.get('/api/chats/:id', ownChat, (_req, res) => {
      const chat = res.locals.chat as Chat;
      res.json({ ...chat, messages: db.prepare('SELECT * FROM (SELECT id,role,content,model,created FROM messages WHERE chat_id=? ORDER BY created DESC, rowid DESC LIMIT 200) ORDER BY created ASC').all(chat.id),
        runs: db.prepare('SELECT id,status,error,model FROM runs WHERE chat_id=? ORDER BY created DESC LIMIT 1').all(chat.id) });
    });
    app.patch('/api/chats/:id', ownChat, (req, res) => {
      const parsed = z.object({ title: z.string().trim().min(1).max(100).optional(), notes: z.string().max(1500).optional(), model: z.enum(['gpt-oss', 'qwen']).optional() }).strict().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Modification invalide.' }); return; }
      const chat = res.locals.chat as Chat;
      db.prepare('UPDATE chats SET title=?,notes=?,model=?,updated=? WHERE id=?').run(parsed.data.title ?? chat.title, parsed.data.notes ?? chat.notes, parsed.data.model ?? chat.model, Date.now(), chat.id);
      res.json({ ok: true });
    });
    app.delete('/api/chats/:id', ownChat, (_req, res) => {
      const chat = res.locals.chat as Chat;
      if (db.prepare("SELECT id FROM runs WHERE chat_id=? AND status IN ('queued','running')").get(chat.id)) { res.status(409).json({ error: 'Arrêtez la réponse avant de supprimer la conversation.' }); return; }
      db.prepare('DELETE FROM chats WHERE id=?').run(chat.id); res.json({ ok: true });
    });
    app.post('/api/chats/:id/messages', ownChat, (req, res) => {
      const parsed = z.object({ content: z.string().trim().min(1).max(3000), model: z.enum(['gpt-oss', 'qwen']) }).strict().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Message invalide (3 000 caractères maximum).' }); return; }
      const chat = res.locals.chat as Chat;
      if (db.prepare("SELECT id FROM runs WHERE chat_id=? AND status IN ('queued','running')").get(chat.id)) { res.status(409).json({ error: 'Une réponse est déjà en cours dans cette conversation.' }); return; }
      const waiting = db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running')").get() as { n: number };
      if (waiting.n >= 4) { res.status(429).json({ error: 'Le moteur est occupé. Réessayez après la réponse en cours.' }); return; }
      const id = randomUUID(); const now = Date.now();
      db.prepare('INSERT INTO messages(id,chat_id,role,content,model,created) VALUES (?,?,?,?,?,?)').run(randomUUID(), chat.id, 'user', parsed.data.content, parsed.data.model, now);
      db.prepare('UPDATE chats SET title=?,model=?,updated=? WHERE id=?').run(chat.title === 'Nouvelle conversation' ? parsed.data.content.slice(0, 65) : chat.title, parsed.data.model, now, chat.id);
      db.prepare("INSERT INTO runs(id,chat_id,user_id,model,status,created) VALUES (?,?,?,?,'queued',?)").run(id, chat.id, chat.user_id, parsed.data.model, now);
      options.enqueue(id, { ...chat, model: parsed.data.model }, parsed.data.content); res.status(202).json({ id });
    });
    app.get('/api/runs/:id', (req, res) => {
      const run = db.prepare('SELECT id,status,error,model,chat_id FROM runs WHERE id=? AND user_id=?').get(String(req.params.id), res.locals.session.user_id);
      if (!run) { res.status(404).json({ error: 'Réponse introuvable.' }); return; } res.json({ ...run, engine: options.status() });
    });
    app.post('/api/runs/:id/cancel', (req, res) => {
      const run = db.prepare("SELECT id FROM runs WHERE id=? AND user_id=? AND status IN ('queued','running')").get(String(req.params.id), res.locals.session.user_id);
      if (!run) { res.status(404).json({ error: 'Réponse introuvable.' }); return; }
      options.cancel(String(req.params.id)); res.json({ ok: true });
    });
  }
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Route introuvable.' }); });
  app.use(express.static(options.assets, { index: 'index.html', dotfiles: 'deny', etag: false }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 500;
    if (!res.headersSent) res.status(status).json({ error: status === 413 ? 'Requête trop volumineuse.' : 'Erreur interne. Réessayez ou consultez le journal local.' });
    // Never log passwords, cookies, request bodies, or model conversations.
    audit('request.error');
  });
  return app;
}
function readCookie(req: Request, name: string): string | undefined {
  const value = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
