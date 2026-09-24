import type { ConversationTurn, Decision, Fact, Memory, ToolCall, ToolUsageStats } from '../core/types.js';

function invalid(field: string): never {
  throw new TypeError(`Invalid memory field: ${field}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): void {
  if (typeof value !== 'string') invalid(field);
}

function number(value: unknown, field: string, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) invalid(field);
}

export function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') invalid(field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid(field);
  const [, year, month, day, hour, minute, second, offset] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid(field);
  if (offset !== 'Z' && (Number(offset?.slice(1, 3)) > 23 || Number(offset?.slice(4)) > 59)) invalid(field);
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

export function assertJson(value: unknown, field: string, ancestors = new Set<unknown>(), depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value) || depth > 64) invalid(field);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid(field);
  ancestors.add(value);
  for (const item of Object.values(value)) assertJson(item, field, ancestors, depth + 1);
  ancestors.delete(value);
}

export function assertToolCall(value: unknown): asserts value is ToolCall {
  const call = object(value, 'toolCall');
  string(call.id, 'toolCall.id');
  string(call.toolName, 'toolCall.toolName');
  object(call.parameters, 'toolCall.parameters');
  assertJson(call.parameters, 'toolCall.parameters');
  assertTimestamp(call.timestamp, 'toolCall.timestamp');
  number(call.executionTime, 'toolCall.executionTime');
  if (!['pending', 'executing', 'completed', 'failed'].includes(String(call.status))) invalid('toolCall.status');
  if (call.error !== undefined) string(call.error, 'toolCall.error');
  if (call.result !== undefined) {
    const result = object(call.result, 'toolCall.result');
    if (typeof result.success !== 'boolean') invalid('toolCall.result.success');
    assertJson(result.data, 'toolCall.result.data');
    string(result.raw, 'toolCall.result.raw');
    const metadata = object(result.metadata, 'toolCall.result.metadata');
    string(metadata.toolName, 'toolCall.result.metadata.toolName');
    number(metadata.executionTime, 'toolCall.result.metadata.executionTime');
    assertTimestamp(metadata.timestamp, 'toolCall.result.metadata.timestamp');
  }
}

export function assertTurn(value: unknown): asserts value is ConversationTurn {
  const turn = object(value, 'turn');
  string(turn.userInput, 'turn.userInput');
  string(turn.agentResponse, 'turn.agentResponse');
  array(turn.actionSummaries, 'turn.actionSummaries').forEach(item => string(item, 'turn.actionSummaries[]'));
  array(turn.toolsUsed, 'turn.toolsUsed').forEach(assertToolCall);
  number(turn.iterationNumber, 'turn.iterationNumber', true);
  assertTimestamp(turn.timestamp, 'turn.timestamp');
}

export function assertFact(value: unknown): asserts value is Fact {
  const fact = object(value, 'fact');
  string(fact.statement, 'fact.statement');
  string(fact.source, 'fact.source');
  number(fact.confidence, 'fact.confidence');
  if (Number(fact.confidence) > 1) invalid('fact.confidence');
  assertTimestamp(fact.addedAt, 'fact.addedAt');
  if (fact.expiresAt !== undefined) assertTimestamp(fact.expiresAt, 'fact.expiresAt');
}

export function assertDecision(value: unknown): asserts value is Decision {
  const decision = object(value, 'decision');
  for (const field of ['id', 'context', 'decision', 'summary']) string(decision[field], `decision.${field}`);
  if (decision.outcome !== undefined) string(decision.outcome, 'decision.outcome');
  assertTimestamp(decision.timestamp, 'decision.timestamp');
}

function assertStats(value: unknown): asserts value is ToolUsageStats {
  const stats = object(value, 'toolsUsed');
  string(stats.toolName, 'toolsUsed.toolName');
  number(stats.usageCount, 'toolsUsed.usageCount', true);
  number(stats.successCount, 'toolsUsed.successCount', true);
  if (Number(stats.successCount) > Number(stats.usageCount)) invalid('toolsUsed.successCount');
  number(stats.averageExecutionTime, 'toolsUsed.averageExecutionTime');
  assertTimestamp(stats.lastUsed, 'toolsUsed.lastUsed');
}

export function assertMemory(value: unknown): asserts value is Memory {
  const memory = object(value, 'memory');
  array(memory.shortTerm, 'shortTerm').forEach(assertTurn);
  array(memory.facts, 'facts').forEach(assertFact);
  array(memory.decisions, 'decisions').forEach(assertDecision);
  array(memory.toolsUsed, 'toolsUsed').forEach(assertStats);
}
