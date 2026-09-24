import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Tool } from '../core/types.js';

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:')) return true;
  if (!isIP(address)) return true;
  const parts = address.split('.').map(Number);
  return isIP(address) === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168));
}

async function safeUrl(input: unknown): Promise<URL> {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('url must contain at most 2048 characters');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) URLs are supported');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error('Private or unresolved network destinations are blocked');
  return url;
}

function readable(content: string, type: string): string {
  if (!type.includes('html')) return content;
  return content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ').replace(/<[^>]+>/gu, ' ').replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ').trim();
}

export class WebFetchTool implements Tool {
  readonly name = 'web_fetch';
  readonly description = 'Read a public HTTP(S) web page as bounded text. Private networks, credentials, unsafe content types and redirects to private hosts are blocked.';
  readonly parameters = [{ name: 'url', type: 'string' as const, description: 'Public HTTP(S) URL to read.', required: true }];
  async execute({ url }: Record<string, unknown>, context: { signal: AbortSignal }): Promise<ReturnType<Tool['execute']> extends Promise<infer R> ? R : never> {
    let current = await safeUrl(url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(current, { signal: context.signal, redirect: 'manual', headers: { 'User-Agent': 'Classcale-Harness/0.2' } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); if (!location || redirects === 3) throw new Error('Too many or invalid redirects');
        current = await safeUrl(new URL(location, current).toString()); continue;
      }
      if (!response.ok) throw new Error(`Web page returned HTTP ${response.status}`);
      const type = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!['text/', 'application/json', 'application/xml', 'application/xhtml+xml'].some(value => type.startsWith(value) || type.includes(value))) throw new Error(`Unsupported content type: ${type || 'unknown'}`);
      const declared = Number(response.headers.get('content-length') ?? 0); if (declared > 1_000_000) throw new Error('Web page exceeds 1000000 bytes');
      const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > 1_000_000) throw new Error('Web page exceeds 1000000 bytes');
      return { url: current.toString(), contentType: type, content: readable(new TextDecoder().decode(bytes), type).slice(0, 100_000) };
    }
    throw new Error('Unable to fetch page');
  }
}
