/** Browser-only fixture, never loaded by the production server; expires after five minutes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { openStore } from '../src/web/store.js';
import { createWebApp } from '../src/web/app.js';
import { hashPassword, vault, digest } from '../src/web/security.js';

const directory = mkdtempSync(join(tmpdir(), 'harness-ui-fixture-'));
const db = openStore(directory);
const id = randomUUID();
db.prepare('INSERT INTO users(id,username,password,totp) VALUES (?,?,?,?)').run(id, 'interface-test',
  await hashPassword('Temporary UI fixture password 2026!'), vault(directory).encrypt(new OTPAuth.Secret({ size: 20 }).base32));
db.prepare('INSERT INTO recovery(user_id,hash) VALUES (?,?)').run(id, digest('ui-fixture-recovery-once'));
const app = createWebApp({ db, directory, assets: resolve('web'), origin: 'http://127.0.0.1:3090', setupOrigin: 'http://127.0.0.1:3091', setupToken: 'unused',
  status: () => ({ active: 'gpt-oss', state: 'ready', queued: 0 }), cancel: () => {},
  enqueue: (run, chat) => {
    setTimeout(() => {
      db.prepare('INSERT INTO messages(id,chat_id,role,content,model,created) VALUES (?,?,?,?,?,?)').run(randomUUID(), chat.id, 'assistant', 'Réponse de test de l’interface. La mémoire et le choix du modèle sont enregistrés.', chat.model, Date.now());
      db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(run);
    }, 500);
  },
});
const server = app.listen(3090, '127.0.0.1', () => console.log('Disposable UI fixture: http://127.0.0.1:3090'));
function close() { server.close(); db.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); }
setTimeout(close, 300000);
process.on('SIGINT', close); process.on('SIGTERM', close);
