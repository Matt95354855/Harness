import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionContent, finalContent } from '../../src/web/model-output.js';
test('Only the final Harmony channel is exposed', () => {
  assert.equal(finalContent('<|channel|>analysis<|message|>private draft<|end|><|start|>assistant<|channel|>final <|constrain|>JSON<|message|>{"answer":60}<|return|>'), '{"answer":60}');
  assert.throws(() => finalContent('<|channel|>analysis<|message|>unfinished draft'));
  assert.equal(finalContent('Bonjour !'), 'Bonjour !');
});
test('Native GPT-OSS Harmony tool calls become Harness decisions', () => {
  const raw = '<|channel|>analysis<|message|>search needed<|end|><|start|>assistant<|channel|>commentary to=web_search <|constrain|>json<|message|>{"query":"OpenAI official site","maxResults":5}';
  assert.deepEqual(JSON.parse(decisionContent(raw)), {
    summary: 'Use web_search.', nextAction: 'TOOL', confidence: 1, toolName: 'web_search', parameters: { query: 'OpenAI official site', maxResults: 5 },
  });
});
