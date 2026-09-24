import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry, LoggerOptions, LogLevel } from '../core/types.js';

const LEVELS: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const REDACTED = '[REDACTED]';

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, REDACTED)
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|client[-_ ]?secret|token|authorization)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, `$1${REDACTED}`);
}

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return /password|passwd|credential|secret|(?:authorization|apikey|accesskey|privatekey|token)$/.test(normalized);
}

/** Best-effort credential redaction; arbitrary secrets in natural language are not detectable. */
export function redact(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth > 32) return '[Depth limit]';
  if (ancestors.has(value)) return '[Circular]';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date';
  ancestors.add(value);
  let result: unknown;
  if (value instanceof Error) {
    result = { name: redactText(value.name), message: redactText(value.message), stack: value.stack ? redactText(value.stack) : undefined };
  } else if (Array.isArray(value)) {
    result = value.map(item => redact(item, ancestors, depth + 1));
  } else {
    result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? REDACTED : redact(item, ancestors, depth + 1)]));
  }
  ancestors.delete(value);
  return result;
}

/** Instance-local logger. All console output uses stderr so CLI stdout stays machine-readable. */
export class Logger {
  private readonly component: string;
  private readonly options: Required<Omit<LoggerOptions, 'filePath'>> & Pick<LoggerOptions, 'filePath'>;
  private entries: LogEntry[] = [];

  constructor(component: string, options: LoggerOptions = {}) {
    this.component = redactText(component);
    this.options = {
      level: options.level ?? 'INFO', console: options.console ?? true,
      maxFileBytes: options.maxFileBytes ?? 1024 * 1024, maxEntries: options.maxEntries ?? 1000,
      filePath: options.filePath,
    };
    if (!(this.options.level in LEVELS)) throw new TypeError('Unknown log level');
    if (!Number.isSafeInteger(this.options.maxEntries) || this.options.maxEntries < 0) throw new RangeError('maxEntries must be a non-negative safe integer');
    if (!Number.isSafeInteger(this.options.maxFileBytes) || this.options.maxFileBytes < 256) throw new RangeError('maxFileBytes must be an integer of at least 256 bytes');
  }

  debug(message: string, data?: Record<string, unknown>): void { this.log('DEBUG', message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.log('INFO', message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.log('WARN', message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.log('ERROR', message, data); }

  getLogs(): LogEntry[] { return structuredClone(this.entries); }
  clear(): void { this.entries = []; }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.options.level]) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(), level, component: this.component,
      message: redactText(message),
      ...(data ? { data: redact(data) as Record<string, unknown> } : {}),
    };
    // Normalize data once to match the representation stored in JSONL (e.g. undefined).
    const serialized = `${JSON.stringify(entry)}\n`;
    const normalized = JSON.parse(serialized) as LogEntry;
    if (this.options.maxEntries > 0) {
      this.entries.push(normalized);
      if (this.entries.length > this.options.maxEntries) this.entries.shift();
    }
    if (this.options.console) process.stderr.write(serialized);
    if (this.options.filePath) this.writeFile(serialized, entry);
  }

  private writeFile(serialized: string, entry: LogEntry): void {
    const path = this.options.filePath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Oversize entries become a valid small JSON record; the file never exceeds its cap.
    let line = serialized;
    if (Buffer.byteLength(line) > this.options.maxFileBytes) {
      line = `${JSON.stringify({ timestamp: entry.timestamp, level: entry.level, component: this.component.slice(0, 32), message: '[Entry exceeded maxFileBytes; details omitted]' })}\n`;
      // Multibyte or escaped component names may themselves exceed the smallest cap.
      if (Buffer.byteLength(line) > this.options.maxFileBytes) line = `${JSON.stringify({ timestamp: entry.timestamp, level: entry.level, message: '[Entry exceeded maxFileBytes; details omitted]' })}\n`;
    }
    if (existsSync(path)) {
      const metadata = statSync(path);
      if (!metadata.isFile()) throw new Error('Log path must be a regular file');
      chmodSync(path, 0o600);
      if (metadata.size + Buffer.byteLength(line) > this.options.maxFileBytes) renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
  }
}

export default Logger;
