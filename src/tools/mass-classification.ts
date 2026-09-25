import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonValue, Tool, ToolContext } from '../core/types.js';
import { abortable } from './runtime.js';

const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUPPORTED = new Map([['.pdf', 'application/pdf'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]);

export interface MassClassificationOptions {
  endpoint: string;
  apiKey: string;
  inputRoots?: string[];
  maxUploadBytes?: number;
  maxResponseBytes?: number;
  enableFeedback?: boolean;
  fetch?: typeof fetch;
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Mass Classification endpoint must be an HTTP(S) URL without credentials, query or fragment');
  }
  return value.replace(/\/+$/u, '');
}

function object(value: JsonValue | undefined, name: string): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function text(value: JsonValue | undefined, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must contain 1 to ${max} characters`);
  return value;
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolveWait, reject) => {
    const cancelled = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolveWait(); }, ms);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}

export class MassClassificationTools {
  private constructor(private readonly options: Required<Omit<MassClassificationOptions, 'inputRoots'>>, private readonly roots: string[]) {}

  static async create(options: MassClassificationOptions): Promise<MassClassificationTools> {
    if (!options.apiKey.trim() || !options.apiKey.startsWith('mc_')) throw new Error('Mass Classification API key must start with mc_');
    const maxUploadBytes = options.maxUploadBytes ?? 50 * 1024 * 1024;
    const maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1 || maxUploadBytes > 500 * 1024 * 1024) throw new Error('Invalid Mass Classification upload limit');
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 10_000_000) throw new Error('Invalid Mass Classification response limit');
    const roots = await Promise.all((options.inputRoots ?? []).map(root => realpath(resolve(root))));
    return new MassClassificationTools({ endpoint: endpoint(options.endpoint), apiKey: options.apiKey, maxUploadBytes, maxResponseBytes, enableFeedback: options.enableFeedback ?? false, fetch: options.fetch ?? fetch }, roots);
  }

  private async response(response: Response): Promise<JsonValue> {
    if (!response.ok) throw new Error(`Mass Classification returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > this.options.maxResponseBytes) throw new Error('Mass Classification response is too large');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > this.options.maxResponseBytes) { await reader.cancel(); throw new Error('Mass Classification response is too large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.byteLength) return {};
    try { return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue; }
    catch { throw new Error('Mass Classification returned invalid JSON'); }
  }

  private request(path: string, context: ToolContext, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${this.options.apiKey}`);
    return this.options.fetch(`${this.options.endpoint}${path}`, { ...init, headers, signal: context.signal, redirect: 'error' });
  }

  private async json(path: string, context: ToolContext, method: 'POST', payload: Record<string, JsonValue>): Promise<JsonValue> {
    return this.response(await this.request(path, context, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
  }

  private async allowedFile(value: JsonValue | undefined): Promise<{ path: string; name: string; mime: string; bytes: Uint8Array }> {
    if (!this.roots.length) throw new Error('MASS_INPUT_ROOTS is required to submit documents');
    const input = text(value, 'path', 4096);
    const canonical = await realpath(resolve(input));
    if (!this.roots.some(root => inside(canonical, root))) throw new Error('Path is outside MASS_INPUT_ROOTS');
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error('Path is not a file');
    if (info.size < 1 || info.size > this.options.maxUploadBytes) throw new Error(`File must contain 1 to ${this.options.maxUploadBytes} bytes`);
    const extension = extname(canonical).toLowerCase(); const mime = SUPPORTED.get(extension);
    if (!mime) throw new Error('Only PDF and DOCX documents are supported');
    const handle = await open(canonical, 'r');
    try {
      const signature = Buffer.alloc(8); await handle.read(signature, 0, signature.length, 0);
      const valid = extension === '.pdf' ? signature.subarray(0, 4).toString() === '%PDF' : signature[0] === 0x50 && signature[1] === 0x4b;
      if (!valid) throw new Error('File signature does not match its extension');
      const buffer = Buffer.alloc(Math.min(info.size + 1, this.options.maxUploadBytes + 1));
      let count = 0;
      while (count < buffer.length) {
        const result = await handle.read(buffer, count, buffer.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count !== info.size) throw new Error('File changed during upload preparation');
      return { path: canonical, name: basename(canonical), mime, bytes: buffer.subarray(0, count) };
    } finally { await handle.close(); }
  }

  tools(): Tool[] {
    const tools: Tool[] = [
      {
        name: 'mass_capabilities', description: 'Read the installed PDF/DOCX classification, OCR and model capabilities before planning a classification run.', parameters: [],
        execute: async (_parameters, context) => this.response(await this.request('/v1/capabilities', context)),
      },
      {
        name: 'mass_get_document', description: 'Read the asynchronous status and bounded analysis metadata for a submitted Mass Classification document. Raw document content is omitted.',
        parameters: [{ name: 'documentId', type: 'string', description: 'Document UUID returned by mass_submit_document.', required: true }],
        execute: async ({ documentId }, context) => {
          const id = text(documentId, 'documentId', 100); if (!DOCUMENT_ID.test(id)) throw new Error('Invalid documentId');
          const result = await this.response(await this.request(`/v1/documents/${id}`, context));
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Mass Classification document response');
          const safe = { ...result }; delete safe.content;
          return { ...safe, contentOmitted: 'content' in result } as JsonValue;
        },
      },
      {
        name: 'mass_search_evidence', description: 'Search classified passages and return evidence with document provenance.',
        parameters: [{ name: 'query', type: 'string', description: 'Evidence query, 2 to 1000 characters.', required: true }, { name: 'limit', type: 'number', description: 'Maximum 1 to 20 passages.', required: false, minimum: 1, maximum: 20 }],
        execute: async ({ query, limit }, context) => this.json('/v1/search', context, 'POST', { query: text(query, 'query', 1000), limit: typeof limit === 'number' ? limit : 5 }),
      },
      {
        name: 'mass_submit_feedback', description: 'Record an explicit human review for one classified document.',
        parameters: [
          { name: 'documentId', type: 'string', description: 'Reviewed document UUID.', required: true },
          { name: 'label', type: 'string', description: 'Reviewed label, 1 to 100 characters.', required: true },
          { name: 'accepted', type: 'boolean', description: 'Whether the human reviewer accepts the label.', required: true },
          { name: 'comment', type: 'string', description: 'Optional review note, at most 2000 characters.', required: false },
        ],
        execute: async ({ documentId, label, accepted, comment }, context) => {
          const id = text(documentId, 'documentId', 100); if (!DOCUMENT_ID.test(id)) throw new Error('Invalid documentId');
          if (typeof accepted !== 'boolean') throw new Error('accepted must be a boolean');
          const note = comment === undefined ? '' : typeof comment === 'string' && comment.length <= 2000 ? comment : (() => { throw new Error('comment must contain at most 2000 characters'); })();
          return this.json(`/v1/documents/${id}/feedback`, context, 'POST', { label: text(label, 'label', 100), accepted, comment: note });
        },
      },
    ];
    if (this.roots.length) tools.push({
      name: 'mass_profile_document', description: 'Inspect a local PDF/DOCX before upload: bounded file size, basic signature and SHA-256. Structural profiling is performed by the service before OCR.',
      parameters: [{ name: 'path', type: 'string', description: 'PDF/DOCX inside MASS_INPUT_ROOTS.', required: true }],
      execute: async ({ path }) => {
        const file = await this.allowedFile(path);
        return { version: 'local-document-profile:v1', format: extname(file.name).toLowerCase(), bytes: file.bytes.byteLength,
          sha256: createHash('sha256').update(file.bytes).digest('hex'), mime: file.mime,
          validation: 'signature_only', structure: 'pending_server_validation', ocrRequired: true,
          language: 'unknown', ocrQuality: 'not_measured', sensitivity: 'not_assessed' };
      },
    });
    if (this.roots.length) tools.splice(1, 0, {
      name: 'mass_submit_document', description: 'Submit one PDF or DOCX from an explicitly authorized local root for asynchronous OCR-first classification.',
      parameters: [{ name: 'path', type: 'string', description: 'Absolute PDF or DOCX path inside MASS_INPUT_ROOTS.', required: true }, { name: 'source', type: 'object', description: 'Optional small provenance metadata object.', required: false }],
      execute: async ({ path, source }, context) => {
        const file = await this.allowedFile(path); const provenance = object(source, 'source');
        const encoded = JSON.stringify(provenance); if (encoded.length > 4096) throw new Error('source must serialize to at most 4096 characters');
        const body = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
        const form = new FormData(); form.set('source_json', encoded); form.set('file', new Blob([body], { type: file.mime }), file.name);
        return this.response(await this.request('/v1/documents', context, { method: 'POST', body: form }));
      },
    });
    return tools.filter(tool => tool.name !== 'mass_submit_feedback' || this.options.enableFeedback);
  }

  /** Poll outside the agent loop for programmatic consumers that need one bounded wait. */
  async waitForDocument(documentId: string, options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<JsonValue> {
    if (!DOCUMENT_ID.test(documentId)) throw new Error('Invalid documentId');
    const timeoutMs = options.timeoutMs ?? 120_000; const intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 || !Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error('Invalid polling limits');
    const timeout = AbortSignal.timeout(timeoutMs); const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const context: ToolContext = { signal, sessionId: 'mass-wait' };
    while (true) {
      signal.throwIfAborted();
      const result = await abortable(this.request(`/v1/documents/${documentId}`, context).then(response => this.response(response)), signal);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Mass Classification document response');
      if (result.status === 'ready' || result.status === 'failed') {
        const safe = { ...result }; delete safe.content;
        return { ...safe, contentOmitted: 'content' in result } as JsonValue;
      }
      if (result.status !== 'queued' && result.status !== 'processing') throw new Error('Invalid document status');
      await pause(intervalMs, signal);
    }
  }
}
