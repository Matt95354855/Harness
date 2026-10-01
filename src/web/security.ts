import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import argon2 from 'argon2';
import * as OTPAuth from 'otpauth';

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
export function authenticator(secret: string, label = 'Administrateur'): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: 'Harness Local', label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}
export function totpCounter(secret: string, code: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Date.now();
  const delta = authenticator(secret).validate({ token: code, timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 30000) + delta;
}
export function vault(directory: string) {
  const path = join(directory, 'encryption.key');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('Invalid encryption key');
  return {
    encrypt(value: string): string {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt(value: string): string {
      const data = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
