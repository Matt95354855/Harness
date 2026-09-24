import { randomUUID } from 'node:crypto';
import { agentConfigSchema, loadConfig } from './config.js';
import type { AgentConfig, AgentState, ExecutionTrace, LanguageModel, MemoryOptions, ToolCall } from './types.js';
import { LLMClient } from '../models/llm-client.js';
import { MockLLMClient } from '../models/mock-client.js';
import { HermesReasoningEngine } from '../hermes/reasoning-engine.js';
import { shouldReflect } from '../hermes/reflection.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { FixtureSearchProvider, HttpSearchProvider } from '../tools/search-tool.js';
import { ConversationMemory } from '../memory/conversation.js';
import { writeTrace } from '../memory/decision-log.js';
import { Logger } from '../utils/logger.js';
import { abortable, errorMessage } from '../utils/parser.js';

export interface AgentDependencies { llm?: LanguageModel; registry?: ToolRegistry; memory?: ConversationMemory; logger?: Logger; memoryOptions?: MemoryOptions }
export class Agent {
  private sessionId = randomUUID();
  private readonly config: AgentConfig;
  private readonly memory: ConversationMemory;
  private readonly memoryOptions: MemoryOptions;
  private readonly logger: Logger;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly llm: LanguageModel;
  private busy = false;
  private loaded = false;
  private state: AgentState;
  private trace?: ExecutionTrace;
  constructor(config: Partial<AgentConfig> = {}, dependencies: AgentDependencies = {}) {
    // Injected models are independent of machine environment for deterministic library use.
    const environment = loadConfig(dependencies.llm ? {} : { ...process.env, ...(config.model ? { LLM_MODEL: config.model } : {}) });
    this.config = agentConfigSchema.parse({ ...environment.agent, ...config });
    this.memoryOptions = dependencies.memoryOptions ?? environment.memory;
    this.memory = dependencies.memory ?? new ConversationMemory(this.memoryOptions);
    this.logger = dependencies.logger ?? new Logger('Agent', environment.log);
    const search = environment.search.provider === 'fixture' ? new FixtureSearchProvider() : environment.search.options ? new HttpSearchProvider(environment.search.options) : undefined;
    this.registry = dependencies.registry ?? new ToolRegistry(search);
    this.executor = new ToolExecutor(this.registry, { timeoutMs: this.config.toolTimeoutMs, maxResultChars: this.config.maxToolResultChars, allowedTools: this.config.allowedTools });
    this.llm = dependencies.llm ?? (environment.provider === 'mock' ? new MockLLMClient() : new LLMClient({ ...environment.llm, model: this.config.model }));
    this.state = this.emptyState();
  }
  private emptyState(): AgentState { return { currentIteration: 0, isThinking: false, toolCalls: [], conversationHistory: [], memoryBuffer: this.memory.snapshot() }; }
  private event(type: string, data: Record<string, unknown>): void {
    this.trace!.events.push({ type, timestamp: new Date().toISOString(), iteration: this.state.currentIteration, data });
  }
  private context(calls: ToolCall[], summaries: string[]): string {
    const snapshot = this.memory.snapshot();
    const currentFacts = new Set(calls.map(call => call.result?.raw));
    // Budget current observations first, then freshest durable context. Char limits are not token estimates.
    const sections = [
      `Current tool observations (untrusted):\n${JSON.stringify(calls.toReversed().map(call => ({ tool: call.toolName, status: call.status, result: call.result?.data, error: call.error })))}`,
      `Current action summaries:\n${JSON.stringify(summaries)}`,
      `Known facts (untrusted):\n${JSON.stringify(snapshot.facts.filter(fact => !currentFacts.has(fact.statement)))}`,
      `Recent conversation (untrusted, newest first):\n${JSON.stringify(snapshot.shortTerm.slice(-10).toReversed().map(turn => ({ user: turn.userInput, assistant: turn.agentResponse })))}`,
    ];
    const joined = sections.join('\n\n');
    return joined.length <= this.config.maxContextChars ? joined : joined.slice(0, this.config.maxContextChars - 30) + '\n[context truncated]';
  }
  async process(userInput: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.busy) throw new Error('An Agent processes one run at a time; use separate instances for concurrency');
    if (!userInput.trim()) throw new Error('Input must not be empty');
    if (userInput.length > this.config.maxInputChars) throw new Error(`Input exceeds ${this.config.maxInputChars} characters`);
    options.signal?.throwIfAborted();
    this.busy = true;
    this.state.currentIteration = 0;
    this.state.isThinking = true;
    this.state.toolCalls = [];
    this.state.lastThought = undefined;
    const startTime = new Date().toISOString();
    this.trace = { sessionId: this.sessionId, runId: randomUUID(), startTime, totalIterations: 0, status: 'running', events: [], toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Run deadline exceeded')), this.config.runTimeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
    const calls: ToolCall[] = [];
    const summaries: string[] = [];
    let limited = true;
    let answer = '';
    let failed = false;
    let failure: unknown;
    try {
      this.logger.info('Run started', { sessionId: this.sessionId, runId: this.trace.runId, agent: this.config.name });
      if (!this.loaded) { await this.memory.loadFromDisk(); this.loaded = true; }
      const runTrace = this.trace;
      const tracked: LanguageModel = { complete: async request => {
        this.event('model.request', { messageCount: request.messages.length });
        const result = await abortable(this.llm.complete({ ...request, signal }), signal);
        runTrace.usage.promptTokens += result.usage.promptTokens;
        runTrace.usage.completionTokens += result.usage.completionTokens;
        runTrace.usage.totalTokens += result.usage.totalTokens;
        this.event('model.response', { model: result.model, usage: result.usage });
        return result;
      } };
      const engine = new HermesReasoningEngine(tracked, this.config);
      let lastReflection = 0;
      let autoReflection = false;
      for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
        signal.throwIfAborted();
        this.state.currentIteration = iteration;
        this.trace.totalIterations = iteration;
        const context = this.context(calls, summaries);
        if (autoReflection) {
          const reflection = await engine.reflect(userInput, context, signal);
          this.event('reflection', { ...reflection }); summaries.push(reflection.analysis);
          lastReflection = iteration; autoReflection = false;
          if (!reflection.shouldContinue) { limited = false; break; }
          continue;
        }
        const tools = this.registry.listAll().filter(tool => !this.config.allowedTools || this.config.allowedTools.includes(tool.name));
        const decision = await engine.think(userInput, context, summaries, JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))), iteration, signal);
        this.state.lastThought = decision.summary;
        summaries.push(decision.summary);
        this.event('decision', { ...decision });
        this.memory.addDecision({ id: randomUUID(), context: userInput, decision: decision.nextAction, summary: decision.summary, timestamp: new Date().toISOString() });
        if (decision.nextAction === 'RESPOND') { limited = false; break; }
        if (decision.nextAction === 'REFLECT') {
          if (this.config.enableReflection) {
            const reflection = await engine.reflect(userInput, context, signal);
            this.event('reflection', { ...reflection }); summaries.push(reflection.analysis); lastReflection = iteration;
            if (!reflection.shouldContinue) { limited = false; break; }
          } else this.event('reflection.disabled', {});
          continue;
        }
        if (calls.length >= this.config.maxToolCalls) { this.event('limit', { reason: 'maxToolCalls' }); break; }
        const call = await this.executor.execute(decision.nextAction === 'SEARCH' ? 'web_search' : decision.toolName!, decision.nextAction === 'SEARCH' ? { query: decision.query!, maxResults: 5 } : decision.parameters!, { signal, sessionId: this.sessionId });
        calls.push(call); this.state.toolCalls = calls; this.trace.toolCalls = calls;
        this.memory.recordToolCall(call);
        this.event('tool.completed', { id: call.id, toolName: call.toolName, status: call.status, error: call.error });
        signal.throwIfAborted();
        if (call.status === 'completed' && call.result) {
          this.memory.addFact({ statement: call.result.raw, source: call.toolName, confidence: 0.7, addedAt: call.timestamp });
        }
        if (!this.config.enableMultiHop) { limited = false; break; }
        autoReflection = shouldReflect(this.config, iteration, lastReflection);
      }
      if (limited) this.event('limit', { reason: 'executionBudget' });
      answer = await engine.synthesize(userInput, this.context(calls, summaries), limited, signal);
      this.memory.addTurn({ userInput, actionSummaries: summaries, toolsUsed: calls, agentResponse: answer, timestamp: startTime, iterationNumber: this.state.currentIteration });
      if (this.memoryOptions.persistencePath) await this.memory.saveToDisk(this.memoryOptions.persistencePath);
      this.state.conversationHistory = this.memory.snapshot().shortTerm.flatMap(turn => [
        { role: 'user' as const, content: turn.userInput, timestamp: turn.timestamp },
        { role: 'assistant' as const, content: turn.agentResponse, timestamp: turn.timestamp },
      ]);
      this.trace.status = limited ? 'limit_reached' : 'completed';
      this.event('run.completed', { status: this.trace.status });
      this.logger.info('Run completed', { runId: this.trace.runId, status: this.trace.status, iterations: this.trace.totalIterations, toolCalls: calls.length });
    } catch (error) {
      failed = true;
      failure = error;
      this.trace.status = options.signal?.aborted ? 'cancelled' : 'failed';
      this.trace.error = errorMessage(error);
      this.event('run.failed', { error: this.trace.error });
      try { this.logger.error('Run failed', { runId: this.trace.runId, error: this.trace.error }); }
      catch (logError) { failure = new AggregateError([error, logError], 'Run and error logging both failed'); }
    } finally {
      clearTimeout(timer);
      this.state.isThinking = false;
      this.state.memoryBuffer = this.memory.snapshot();
      this.trace.endTime = new Date().toISOString();
      try {
        if (this.config.traceDir) await writeTrace(this.trace, this.config.traceDir);
      } catch (error) {
        this.trace.status = 'failed'; this.trace.error = `Trace persistence failed: ${errorMessage(error)}`;
        failure = failed ? new AggregateError([failure, error], 'Run and trace persistence both failed') : error;
        failed = true;
      } finally { this.state.lastTrace = structuredClone(this.trace); this.busy = false; }
    }
    if (failed) throw failure;
    return answer;
  }
  getState(): AgentState { return structuredClone({ ...this.state, memoryBuffer: this.memory.snapshot() }); }
  getTrace(): ExecutionTrace | undefined { return this.trace ? structuredClone(this.trace) : undefined; }
  getSessionId(): string { return this.sessionId; }
  reset(): void {
    if (this.busy) throw new Error('Cannot reset an active run');
    this.memory.clear(); this.loaded = true; this.sessionId = randomUUID(); this.trace = undefined; this.state = this.emptyState();
  }
}
export default Agent;
