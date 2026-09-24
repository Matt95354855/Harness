import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent } from '../../src/core/agent.js';
import type { AgentConfig, LanguageModel, Parameters } from '../../src/core/types.js';
import { ScriptedLLMClient } from '../../src/models/mock-client.js';
import { FixtureSearchProvider } from '../../src/tools/search-tool.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { createDemoAgent } from '../../src/demo.js';

const decision = (nextAction: string, extra: Parameters = {}): string => JSON.stringify({ summary: `Action ${nextAction}`, nextAction, confidence: 0, ...extra });
function setup(outputs: Array<string | Error>, config: Partial<AgentConfig> = {}): { agent: Agent; llm: ScriptedLLMClient } {
  const llm = new ScriptedLLMClient(outputs);
  return { agent: new Agent({ traceDir: undefined, ...config }, { llm, registry: new ToolRegistry(new FixtureSearchProvider()) }), llm };
}
test('multi-hop uses refined queries and delivers current tool observations to synthesis', async () => {
  const { agent, llm } = setup([decision('SEARCH', { query: 'first topic' }), decision('SEARCH', { query: 'refined topic' }), decision('RESPOND'), 'Final answer']);
  assert.equal(await agent.process('Research this'), 'Final answer');
  const trace = agent.getTrace()!;
  assert.equal(trace.status, 'completed'); assert.equal(trace.totalIterations, 3);
  assert.deepEqual(trace.toolCalls.map(call => call.parameters.query), ['first topic', 'refined topic']);
  const synthesis = llm.requests.at(-1)!.messages.at(-1)!.content;
  assert.match(synthesis, /refined topic/); assert.match(synthesis, /example.org/);
  assert.equal(agent.getState().memoryBuffer.decisions.length, 3);
  assert.equal(agent.getState().memoryBuffer.toolsUsed[0]?.usageCount, 2);
  assert.equal(agent.getState().memoryBuffer.shortTerm[0]?.toolsUsed.length, 2);
});
test('generic tools execute and failed calls reach the model without becoming facts', async () => {
  const { agent, llm } = setup([decision('TOOL', { toolName: 'calculate', parameters: { expression: '(12+8)*3' } }), decision('TOOL', { toolName: 'missing', parameters: {} }), decision('RESPOND'), '60']);
  await agent.process('Calculate');
  assert.deepEqual(agent.getState().toolCalls[0]?.result?.data, { result: 60 });
  assert.equal(agent.getState().toolCalls[1]?.status, 'failed');
  assert.equal(agent.getState().memoryBuffer.facts.length, 1);
  assert.match(llm.requests.at(-1)!.messages.at(-1)!.content, /Unknown tool/);
});
test('explicit reflection can finish and disabled reflection performs no reflection request', async () => {
  const first = setup([decision('REFLECT'), JSON.stringify({ analysis: 'Enough evidence', improvements: [], shouldContinue: false }), 'Answer']);
  await first.agent.process('Question');
  assert.ok(first.agent.getTrace()?.events.some(event => event.type === 'reflection'));
  const second = setup([decision('REFLECT'), decision('RESPOND'), 'Answer'], { enableReflection: false });
  await second.agent.process('Question');
  assert.ok(second.llm.requests.every(request => !request.messages.at(-1)?.content.startsWith('HARNESS_REFLECT')));
});
test('scheduled reflection consumes an iteration and stops when evidence is enough', async () => {
  const { agent } = setup([decision('SEARCH', { query: 'one' }), JSON.stringify({ analysis: 'Sufficient', improvements: [], shouldContinue: false }), 'Answer'], { reflectionInterval: 1 });
  await agent.process('Question');
  assert.equal(agent.getTrace()?.totalIterations, 2);
  assert.equal(agent.getTrace()?.events.filter(event => event.type === 'reflection').length, 1);
});
test('iteration and tool budgets produce explicitly limited synthesis, reset per run', async () => {
  const { agent, llm } = setup([decision('SEARCH', { query: 'one' }), 'Limited answer', decision('RESPOND'), 'Second answer'], { maxIterations: 1 });
  await agent.process('First');
  assert.equal(agent.getTrace()?.status, 'limit_reached');
  assert.match(llm.requests[1]!.messages.at(-1)!.content, /"limited":true/);
  await agent.process('Second');
  assert.equal(agent.getTrace()?.status, 'completed'); assert.equal(agent.getTrace()?.totalIterations, 1);
  assert.equal(agent.getTrace()?.toolCalls.length, 0); assert.equal(agent.getState().toolCalls.length, 0);
  assert.equal(agent.getState().conversationHistory.length, 4);
  const bounded = setup([decision('TOOL', { toolName: 'calculate', parameters: { expression: '1+2' } }), 'No tools allowed'], { maxToolCalls: 0 });
  await bounded.agent.process('Question');
  assert.equal(bounded.agent.getTrace()?.toolCalls.length, 0); assert.equal(bounded.agent.getTrace()?.status, 'limit_reached');
});
test('single-hop mode synthesizes after one tool and allowlist is enforced at execution', async () => {
  const { agent } = setup([decision('TOOL', { toolName: 'calculate', parameters: { expression: '1+2' } }), 'Blocked'], { enableMultiHop: false, allowedTools: [] });
  await agent.process('Question');
  assert.equal(agent.getTrace()?.toolCalls[0]?.status, 'failed');
  assert.match(agent.getTrace()?.toolCalls[0]?.error ?? '', /not allowed/);
});
test('invalid structured output is repaired once, then fails explicitly', async () => {
  const repaired = setup(['not json', decision('RESPOND'), 'Recovered']);
  assert.equal(await repaired.agent.process('Question'), 'Recovered');
  assert.match(repaired.llm.requests[1]!.messages[0]!.content, /prior output failed/);
  const broken = setup([decision('SEARCH'), 'still invalid']);
  await assert.rejects(broken.agent.process('Question'), /after two attempts/);
  assert.equal(broken.agent.getState().isThinking, false); assert.equal(broken.agent.getTrace()?.status, 'failed');
  assert.equal(broken.agent.getState().memoryBuffer.shortTerm.length, 0);
});
test('all model calls use config values, account usage and retain confidence zero', async () => {
  const llm = new ScriptedLLMClient([
    { content: decision('RESPOND'), model: 'script', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
    { content: 'Answer', model: 'script', finishReason: 'stop', usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } },
  ]);
  const agent = new Agent({ traceDir: undefined, temperature: 0, topP: 0, maxTokens: 100, systemPrompt: 'Specific system instruction' }, { llm });
  await agent.process('Question');
  for (const request of llm.requests) { assert.equal(request.temperature, 0); assert.equal(request.topP, 0); assert.equal(request.maxTokens, 100); assert.match(request.messages[0]!.content, /Specific system instruction/); }
  assert.equal(agent.getTrace()?.usage.totalTokens, 12);
  assert.equal(agent.getTrace()?.events.find(event => event.type === 'decision')?.data.confidence, 0);
});
test('failure cleans up busy state and a later call can succeed', async () => {
  const { agent } = setup([new Error('Provider unavailable'), decision('RESPOND'), 'Recovered']);
  await assert.rejects(agent.process('First'), /Provider unavailable/);
  assert.equal(agent.getState().isThinking, false);
  assert.equal(await agent.process('Second'), 'Recovered');
});
test('run deadlines bound hung model adapters and prevent overlapping calls and reset', async () => {
  const hung: LanguageModel = { complete: async () => new Promise(() => {}) };
  const agent = new Agent({ traceDir: undefined, runTimeoutMs: 30 }, { llm: hung });
  const pending = agent.process('First');
  await assert.rejects(agent.process('Second'), /one run at a time/);
  assert.throws(() => agent.reset(), /active run/);
  await assert.rejects(pending, /deadline/);
  assert.equal(agent.getState().isThinking, false); assert.equal(agent.getTrace()?.status, 'failed');
});
test('external cancellation stops a hung adapter and is recorded separately', async () => {
  const controller = new AbortController();
  const agent = new Agent({ traceDir: undefined }, { llm: { complete: async () => new Promise(() => {}) } });
  const pending = agent.process('Question', { signal: controller.signal });
  controller.abort(new Error('User cancelled'));
  await assert.rejects(pending, /User cancelled/);
  assert.equal(agent.getTrace()?.status, 'cancelled');
});
test('input validation precedes execution and state snapshots cannot mutate the agent', async () => {
  const { agent } = setup([decision('RESPOND'), 'Answer'], { maxInputChars: 10 });
  await assert.rejects(agent.process(' '), /empty/); await assert.rejects(agent.process('x'.repeat(11)), /exceeds/);
  await agent.process('Question');
  const oldSession = agent.getSessionId();
  const state = agent.getState(); state.conversationHistory.length = 0; state.memoryBuffer.shortTerm.length = 0;
  assert.equal(agent.getState().conversationHistory.length, 2);
  agent.reset();
  assert.notEqual(agent.getSessionId(), oldSession); assert.equal(agent.getState().conversationHistory.length, 0); assert.equal(agent.getTrace(), undefined);
});
test('memory and trace persist, restore on a new instance, and disk errors fail the run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-agent-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memoryOptions = { persistencePath: join(directory, 'memory.json') };
  const traceDir = join(directory, 'traces');
  const agent = new Agent({ traceDir }, { llm: new ScriptedLLMClient([decision('RESPOND'), 'Remembered answer']), memoryOptions });
  await agent.process('Remember this');
  const files = await readdir(traceDir);
  const trace = JSON.parse(await readFile(join(traceDir, files[0]!), 'utf8')) as { status: string };
  assert.equal(trace.status, 'completed');
  const llm = new ScriptedLLMClient([decision('RESPOND'), 'Second answer']);
  const resumed = new Agent({ traceDir: undefined }, { llm, memoryOptions });
  await resumed.process('Follow up');
  assert.match(llm.requests[0]!.messages.at(-1)!.content, /Remembered answer/);
  assert.equal(resumed.getState().memoryBuffer.shortTerm.length, 2);
  const file = join(directory, 'not-a-directory'); await writeFile(file, 'content');
  const broken = setup([decision('RESPOND'), 'Answer'], { traceDir: file }).agent;
  await assert.rejects(broken.process('Question'));
  assert.equal(broken.getState().isThinking, false); assert.equal(broken.getTrace()?.status, 'failed');
});
test('demo calculates without a model and isolates independent sessions', async () => {
  const a = createDemoAgent({ traceDir: undefined }); const b = createDemoAgent({ traceDir: undefined });
  await a.process('Calcule (12 + 8) * 3');
  assert.deepEqual(a.getState().toolCalls[0]?.result?.data, { result: 60 });
  assert.equal(b.getState().memoryBuffer.shortTerm.length, 0);
});
