import { readFile, stat } from 'node:fs/promises';
import type { ConversationTurn, Decision, Fact, Memory, MemoryOptions, ToolCall } from '../core/types.js';
import { isMissingFile, writePrivateJson } from './storage.js';
import { assertDecision, assertFact, assertMemory, assertToolCall, assertTurn } from './validation.js';

const emptyMemory = (): Memory => ({ shortTerm: [], facts: [], decisions: [], toolsUsed: [] });
const MAX_PERSISTENCE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_STATS = 1000;

function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return result;
}

/** Bounded conversation state. Disk persistence is explicit and never starts in the constructor. */
export class ConversationMemory {
  private memory = emptyMemory();
  private readonly maxTurns: number;
  private readonly maxFacts: number;
  private readonly maxDecisions: number;
  private readonly factTtlMs: number | undefined;
  private readonly persistencePath: string | undefined;

  constructor(options: MemoryOptions = {}) {
    this.maxTurns = limit(options.maxTurns, 20, 'maxTurns');
    this.maxFacts = limit(options.maxFacts, 100, 'maxFacts');
    this.maxDecisions = limit(options.maxDecisions, 100, 'maxDecisions');
    this.factTtlMs = options.factTtlMs === undefined ? undefined : limit(options.factTtlMs, 0, 'factTtlMs');
    this.persistencePath = options.persistencePath;
  }

  addTurn(turn: ConversationTurn): void {
    assertTurn(turn);
    this.memory.shortTerm.push(structuredClone(turn));
    this.memory.shortTerm = this.maxTurns ? this.memory.shortTerm.slice(-this.maxTurns) : [];
  }

  addFact(fact: Fact): void {
    assertFact(fact);
    const stored = structuredClone(fact);
    if (!stored.expiresAt && this.factTtlMs !== undefined) {
      stored.expiresAt = new Date(Date.parse(stored.addedAt) + this.factTtlMs).toISOString();
    }
    this.memory.facts.push(stored);
    this.pruneFacts();
  }

  addDecision(decision: Decision): void {
    assertDecision(decision);
    this.memory.decisions.push(structuredClone(decision));
    this.memory.decisions = this.maxDecisions ? this.memory.decisions.slice(-this.maxDecisions) : [];
  }

  /** Call once for each finished tool execution; failed calls also contribute to latency. */
  recordToolCall(call: ToolCall): void {
    assertToolCall(call);
    if (call.status !== 'completed' && call.status !== 'failed') return;
    const succeeded = call.status === 'completed' && call.result?.success !== false;
    const stats = this.memory.toolsUsed.find(item => item.toolName === call.toolName);
    if (stats) {
      stats.averageExecutionTime = (stats.averageExecutionTime * stats.usageCount + call.executionTime) / (stats.usageCount + 1);
      stats.usageCount++;
      if (succeeded) stats.successCount++;
      if (Date.parse(call.timestamp) > Date.parse(stats.lastUsed)) stats.lastUsed = call.timestamp;
    } else {
      this.memory.toolsUsed.push({ toolName: call.toolName, usageCount: 1, successCount: succeeded ? 1 : 0, averageExecutionTime: call.executionTime, lastUsed: call.timestamp });
      if (this.memory.toolsUsed.length > MAX_TOOL_STATS) this.memory.toolsUsed.shift();
    }
  }

  snapshot(): Memory {
    this.pruneFacts();
    return structuredClone(this.memory);
  }

  getFormattedHistory(): string {
    return this.memory.shortTerm.map(turn => [
      `Turn ${turn.iterationNumber}:`,
      `User: ${turn.userInput}`,
      `Actions: ${turn.actionSummaries.join('; ')}`,
      ...(turn.toolsUsed.length ? [`Tools: ${turn.toolsUsed.map(tool => tool.toolName).join(', ')}`] : []),
      `Response: ${turn.agentResponse}`,
    ].join('\n')).join('\n---\n');
  }

  /** Case-insensitive substring retrieval, deliberately not semantic search. */
  getRelevantFacts(query: string): Fact[] {
    this.pruneFacts();
    return structuredClone(this.memory.facts.filter(fact => fact.statement.toLowerCase().includes(query.trim().toLowerCase())));
  }

  getLastSimilarDecision(context: string): Decision | undefined {
    const decision = this.memory.decisions.findLast(item => item.context.toLowerCase().includes(context.trim().toLowerCase()));
    return decision ? structuredClone(decision) : undefined;
  }

  getSummary(): { conversationTurns: number; knownFacts: number; decisions: number; toolsUsed: number } {
    this.pruneFacts();
    return { conversationTurns: this.memory.shortTerm.length, knownFacts: this.memory.facts.length, decisions: this.memory.decisions.length, toolsUsed: this.memory.toolsUsed.length };
  }

  clear(): void { this.memory = emptyMemory(); }

  async saveToDisk(path = this.persistencePath): Promise<void> {
    if (!path) throw new Error('A memory persistence path is required');
    const memory = this.snapshot();
    if (Buffer.byteLength(`${JSON.stringify(memory, null, 2)}\n`) > MAX_PERSISTENCE_BYTES) throw new Error('Memory exceeds the 16 MiB persistence limit');
    await writePrivateJson(path, memory);
  }

  /** Missing files are treated as a new session; invalid files leave current state untouched. */
  async loadFromDisk(): Promise<void> {
    if (!this.persistencePath) return;
    let content: string;
    try {
      if ((await stat(this.persistencePath)).size > MAX_PERSISTENCE_BYTES) throw new Error('Memory file exceeds the 16 MiB persistence limit');
      content = await readFile(this.persistencePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
      assertMemory(parsed);
    } catch (error) {
      throw new Error(`Invalid memory file: ${this.persistencePath}`, { cause: error });
    }
    this.memory = structuredClone(parsed);
    this.memory.shortTerm = this.maxTurns ? this.memory.shortTerm.slice(-this.maxTurns) : [];
    this.memory.decisions = this.maxDecisions ? this.memory.decisions.slice(-this.maxDecisions) : [];
    this.memory.toolsUsed = this.memory.toolsUsed.slice(-MAX_TOOL_STATS);
    this.pruneFacts();
  }

  private pruneFacts(): void {
    const now = Date.now();
    this.memory.facts = this.memory.facts
      .filter(fact => fact.expiresAt ? Date.parse(fact.expiresAt) > now : this.factTtlMs === undefined || Date.parse(fact.addedAt) + this.factTtlMs > now)
      .sort((a, b) => b.confidence - a.confidence || Date.parse(b.addedAt) - Date.parse(a.addedAt))
      .slice(0, this.maxFacts);
  }
}
