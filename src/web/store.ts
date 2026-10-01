import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(directory: string): DatabaseSync {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'chat.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      totp TEXT NOT NULL, last_counter INTEGER NOT NULL DEFAULT -1, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS recovery (user_id TEXT NOT NULL REFERENCES users(id), hash TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL,
      created INTEGER NOT NULL, touched INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
      model TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, model TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), model TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS message_chat ON messages(chat_id, created);
    CREATE INDEX IF NOT EXISTS chat_user ON chats(user_id, updated);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, event TEXT NOT NULL, created INTEGER NOT NULL);
    UPDATE runs SET status='failed', error='Le serveur a redémarré. Vous pouvez renvoyer votre message.' WHERE status IN ('queued','running');
    DELETE FROM sessions WHERE created < (unixepoch()*1000 - 86400000);
    DELETE FROM audit WHERE created < (unixepoch()*1000 - 2592000000);
  `);
  return db;
}
