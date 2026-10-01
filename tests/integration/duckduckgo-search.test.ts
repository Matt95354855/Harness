import test from 'node:test';
import assert from 'node:assert/strict';
import { DuckDuckGoSearchProvider } from '../../src/tools/duckduckgo-search.js';

test('DuckDuckGo provider normalizes keyless HTML results and redirect links', async () => {
  let requested = '';
  const html = `<div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdocs">Example &amp; docs</a>
    <a class="result__snippet">A useful <b>official</b> result.</a>
  </div>`;
  const provider = new DuckDuckGoSearchProvider(async input => {
    requested = String(input);
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  });
  const response = await provider.search({ query: 'local agents', maxResults: 3, language: 'fr', safeSearch: true });
  assert.match(requested, /q=local\+agents/u);
  assert.equal(response.results[0]?.url, 'https://example.org/docs');
  assert.equal(response.results[0]?.title, 'Example & docs');
  assert.equal(response.results[0]?.snippet, 'A useful official result.');
});

test('DuckDuckGo provider rejects empty and oversized searches', async () => {
  const provider = new DuckDuckGoSearchProvider(async () => new Response(''));
  await assert.rejects(provider.search({ query: '' }));
  await assert.rejects(provider.search({ query: 'ok', maxResults: 11 }));
});
