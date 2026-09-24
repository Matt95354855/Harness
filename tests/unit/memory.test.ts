import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ConversationTurn, Decision, ExecutionTrace, Fact, ToolCall } from '../../src/core/types.js';
import { ConversationMemory } from '../../src/memory/conversation.js';
import { DecisionLog, writeTrace } from '../../src/memory/decision-log.js';

const timestamp = '2026-01-01T12:00:00.000Z';
const fact = (statement: string, confidence = 0.5): Fact => ({ statement, confidence, source: 'test', addedAt: timestamp });
const turn = (index: number): ConversationTurn => ({ userInput: `question ${index}`, actionSummaries: ['Search docs'], toolsUsed: [], agentResponse: `answer ${index}`, timestamp, iterationNumber: index });
const decision = (index: number): Decision => ({ id: String(index), context: 'search docs', decision: `choice ${index}`, summary: 'Use local docs', timestamp });
const toolCall = (duration: number, status: ToolCall['status'] = 'completed'): ToolCall => ({ id: String(duration), toolName: 'search', parameters: { query: 'question' }, timestamp, executionTime: duration, status });
const trace = (): ExecutionTrace => ({ sessionId: 'session-1', runId: 'run-1', startTime: timestamp, totalIterations: 1, status: 'completed', events: [], toolCalls: [], usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-memory-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('memory evicts oldest turns and decisions, retaining strongest facts', () => {
  const memory = new ConversationMemory({ maxTurns: 2, maxDecisions: 2, maxFacts: 2 });
  for (const index of [1, 2, 3]) { memory.addTurn(turn(index)); memory.addDecision(decision(index)); }
  memory.addFact(fact('reliable', 0.9));
  memory.addFact(fact('weak', 0.1));
  memory.addFact(fact('strong', 0.8));
  assert.deepEqual(memory.snapshot().shortTerm.map(item => item.iterationNumber), [2, 3]);
  assert.deepEqual(memory.snapshot().decisions.map(item => item.id), ['2', '3']);
  assert.deepEqual(memory.getRelevantFacts('').map(item => item.statement), ['reliable', 'strong']);
  assert.deepEqual(memory.getSummary(), { conversationTurns: 2, knownFacts: 2, decisions: 2, toolsUsed: 0 });
});

test('zero limits disable each bounded collection', () => {
  const memory = new ConversationMemory({ maxTurns: 0, maxFacts: 0, maxDecisions: 0 });
  memory.addTurn(turn(1)); memory.addFact(fact('ignored')); memory.addDecision(decision(1));
  assert.deepEqual(memory.getSummary(), { conversationTurns: 0, knownFacts: 0, decisions: 0, toolsUsed: 0 });
});

test('tool statistics remain bounded across distinct failed tool names', () => {
  const memory = new ConversationMemory();
  for (let index = 0; index < 1005; index++) memory.recordToolCall({ ...toolCall(1, 'failed'), toolName: `unknown_${index}` });
  assert.equal(memory.snapshot().toolsUsed.length, 1000);
  assert.equal(memory.snapshot().toolsUsed[0]?.toolName, 'unknown_5');
});

test('facts expire during retrieval without another insertion', t => {
  let now = Date.parse(timestamp);
  t.mock.method(Date, 'now', () => now);
  const memory = new ConversationMemory({ factTtlMs: 1000 });
  memory.addFact(fact('temporary'));
  memory.addFact({ ...fact('explicit expiry'), expiresAt: new Date(now + 2000).toISOString() });
  assert.equal(memory.snapshot().facts.length, 2);
  now += 1000;
  assert.deepEqual(memory.getRelevantFacts('').map(item => item.statement), ['explicit expiry']);
  now += 1000;
  assert.equal(memory.getSummary().knownFacts, 0);
});

test('memory detaches added values and all mutable returned values', () => {
  const memory = new ConversationMemory();
  const inputTurn = turn(1);
  inputTurn.toolsUsed.push(toolCall(1));
  memory.addTurn(inputTurn);
  inputTurn.toolsUsed[0]!.parameters.query = 'changed';
  const inputFact = fact('Agent runtime');
  memory.addFact(inputFact); inputFact.statement = 'changed';
  const inputDecision = decision(1);
  memory.addDecision(inputDecision); inputDecision.context = 'changed';
  const snapshot = memory.snapshot();
  snapshot.shortTerm[0]!.toolsUsed[0]!.parameters.query = 'changed snapshot';
  memory.getRelevantFacts('agent')[0]!.statement = 'changed result';
  memory.getLastSimilarDecision('DOCS')!.summary = 'changed result';
  assert.equal(memory.snapshot().shortTerm[0]!.toolsUsed[0]!.parameters.query, 'question');
  assert.equal(memory.getRelevantFacts('AGENT')[0]!.statement, 'Agent runtime');
  assert.equal(memory.getLastSimilarDecision('docs')!.summary, 'Use local docs');
  assert.equal(memory.getLastSimilarDecision('unrelated'), undefined);
});

test('tool usage counts terminal calls and averages success/failure duration', () => {
  const memory = new ConversationMemory();
  memory.recordToolCall(toolCall(10));
  memory.recordToolCall(toolCall(30, 'failed'));
  memory.recordToolCall(toolCall(100, 'pending'));
  assert.deepEqual(memory.snapshot().toolsUsed, [{ toolName: 'search', usageCount: 2, successCount: 1, averageExecutionTime: 20, lastUsed: timestamp }]);
  memory.clear();
  assert.deepEqual(memory.snapshot(), { shortTerm: [], facts: [], decisions: [], toolsUsed: [] });
});

test('formatted history uses action summaries and tool names', () => {
  const memory = new ConversationMemory();
  memory.addTurn({ ...turn(1), toolsUsed: [toolCall(1)] });
  memory.addTurn(turn(2));
  const history = memory.getFormattedHistory();
  assert.match(history, /Actions: Search docs/);
  assert.match(history, /Tools: search/);
  assert.match(history, /Response: answer 2/);
  assert.match(history, /\n---\n/);
});

test('disk persistence round-trips JSON, creates parents, and uses private permissions', async t => {
  const root = await directory(t);
  const persistencePath = join(root, 'nested', 'memory.json');
  const original = new ConversationMemory({ persistencePath });
  original.addTurn(turn(1)); original.addFact(fact('local first')); original.addDecision(decision(1)); original.recordToolCall(toolCall(10));
  await original.saveToDisk();
  const restored = new ConversationMemory({ persistencePath });
  await restored.loadFromDisk();
  assert.deepEqual(restored.snapshot(), original.snapshot());
  assert.equal((await stat(persistencePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, 'nested')), ['memory.json']);
});

test('missing persistence file is okay; malformed or invalid memory leaves state untouched', async t => {
  const path = join(await directory(t), 'memory.json');
  const memory = new ConversationMemory({ persistencePath: path });
  memory.addFact(fact('preserve me'));
  await memory.loadFromDisk();
  for (const value of ['{broken', '{}', JSON.stringify({ ...memory.snapshot(), facts: [{ ...fact('bad date'), addedAt: '2026-02-31T00:00:00Z' }] }), JSON.stringify({ ...memory.snapshot(), facts: [{ ...fact('bad confidence'), confidence: 2 }] })]) {
    await writeFile(path, value);
    await assert.rejects(memory.loadFromDisk(), /Invalid memory file/);
    assert.equal(memory.snapshot().facts[0]!.statement, 'preserve me');
  }
});

test('loading applies configured collection limits and fact TTL', async t => {
  const persistencePath = join(await directory(t), 'memory.json');
  const now = Date.parse(timestamp);
  t.mock.method(Date, 'now', () => now + 1000);
  const original = new ConversationMemory({ persistencePath });
  original.addTurn(turn(1)); original.addTurn(turn(2)); original.addDecision(decision(1)); original.addFact(fact('old'));
  await original.saveToDisk();
  const restored = new ConversationMemory({ persistencePath, maxTurns: 1, maxDecisions: 0, factTtlMs: 1000 });
  await restored.loadFromDisk();
  assert.equal(restored.snapshot().shortTerm[0]!.iterationNumber, 2);
  assert.equal(restored.snapshot().decisions.length, 0);
  assert.equal(restored.snapshot().facts.length, 0);
});

test('save failures are explicit and clean temporary files', async t => {
  const root = await directory(t);
  const path = join(root, 'existing-directory');
  await mkdir(path);
  const memory = new ConversationMemory();
  await assert.rejects(memory.saveToDisk(), /persistence path/);
  await memory.loadFromDisk();
  await assert.rejects(memory.saveToDisk(path));
  assert.deepEqual(await readdir(root), ['existing-directory']);
});

test('input validation rejects bad limits and malformed timestamps', () => {
  assert.throws(() => new ConversationMemory({ maxFacts: -1 }), /non-negative/);
  assert.throws(() => new ConversationMemory({ maxTurns: 1.5 }), /safe integer/);
  assert.throws(() => new ConversationMemory().addFact({ ...fact('bad'), addedAt: 'yesterday' }), /fact.addedAt/);
  assert.throws(() => new ConversationMemory().addTurn({ ...turn(1), iterationNumber: -1 }), /iterationNumber/);
  assert.throws(() => new ConversationMemory().recordToolCall({ ...toolCall(1), executionTime: NaN }), /executionTime/);
});

test('trace writer uses safe identifiers, atomic private files, and explicit I/O errors', async t => {
  const root = await directory(t);
  const path = await writeTrace(trace(), root);
  assert.equal(path, join(root, 'session-1-run-1.json'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), trace());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await new DecisionLog(root).write(trace()), path);
  await assert.rejects(writeTrace({ ...trace(), runId: '../escape' }, root), /safe identifiers/);
  await assert.rejects(writeTrace(trace(), path));
  assert.deepEqual(await readdir(root), ['session-1-run-1.json']);
});
