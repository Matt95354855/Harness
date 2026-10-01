import type { SearchProvider, SearchQuery, SearchResponse, SearchResult } from '../core/types.js';

const MAX_RESPONSE_BYTES = 1_000_000;

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/giu, (_match, name: string) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[name.toLowerCase()]!)
    .replace(/\s+/gu, ' ')
    .trim();
}

function resultUrl(value: string): string | undefined {
  try {
    const url = new URL(decodeHtml(value), 'https://html.duckduckgo.com/');
    const redirected = url.hostname.endsWith('duckduckgo.com') ? url.searchParams.get('uddg') : null;
    const target = redirected ? new URL(redirected) : url;
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return undefined;
    return target.toString();
  } catch { return undefined; }
}

/** Keyless public-web search. Queries are sent to DuckDuckGo's HTML search endpoint. */
export class DuckDuckGoSearchProvider implements SearchProvider {
  constructor(private readonly fetcher: typeof globalThis.fetch = globalThis.fetch) {}

  async search(input: SearchQuery, externalSignal?: AbortSignal): Promise<SearchResponse> {
    const query = input.query?.trim();
    if (!query || query.length > 500) throw new Error('Search query must contain 1 to 500 characters');
    const maxResults = input.maxResults ?? 5;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10) throw new Error('maxResults must be an integer from 1 to 10');
    const endpoint = new URL('https://html.duckduckgo.com/html/');
    endpoint.searchParams.set('q', query);
    if (input.language) endpoint.searchParams.set('kl', input.language.toLowerCase());
    if (input.safeSearch !== false) endpoint.searchParams.set('kp', '1');
    if (input.timeRange) endpoint.searchParams.set('df', ({ day: 'd', week: 'w', month: 'm', year: 'y' })[input.timeRange]);
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new DOMException('Web search timed out', 'TimeoutError')), 15_000);
    const started = performance.now();
    try {
      const response = await this.fetcher(endpoint, { signal, redirect: 'error', headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; Harness/0.2; local agent)' } });
      if (!response.ok) throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_RESPONSE_BYTES) throw new Error('Search response is too large');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Search response is too large');
      const html = new TextDecoder().decode(bytes);
      const links = [...html.matchAll(/<a(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")(?=[^>]*\bhref="([^"]+)")[^>]*>([\s\S]*?)<\/a>/giu)];
      const results: SearchResult[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < links.length && results.length < maxResults; index++) {
        const match = links[index]!;
        const url = resultUrl(match[1]!);
        const title = decodeHtml(match[2]!);
        if (!url || !title || seen.has(url)) continue;
        const section = html.slice((match.index ?? 0) + match[0].length, links[index + 1]?.index ?? html.length);
        const snippetMatch = section.match(/<(?:a|div)[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/iu);
        seen.add(url);
        results.push({ url, title: title.slice(0, 300), snippet: decodeHtml(snippetMatch?.[1] ?? '').slice(0, 2000), rank: results.length + 1, source: 'custom' });
      }
      if (!results.length) throw new Error('Web search returned no readable results');
      return { query, results, totalResults: results.length, executionTime: performance.now() - started, cached: false };
    } finally { clearTimeout(timeout); }
  }
}
