import { randomUUID } from 'node:crypto';
import type { Parameters, Tool, ToolCall } from '../core/types.js';
import type { ToolRegistry } from './tool-registry.js';
import { abortable, abortError, boundedJson, positiveInteger } from './runtime.js';

export interface ToolExecutorOptions { timeoutMs?: number; maxResultChars?: number; allowedTools?: string[]; maxConcurrency?: number }
export interface ExecutionContext { signal?: AbortSignal; sessionId?: string }

export class ToolExecutor {
  private readonly timeoutMs: number;
  private readonly maxResultChars: number;
  private readonly maxConcurrency: number;
  private readonly allowedTools?: ReadonlySet<string>;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, 'timeoutMs');
    this.maxResultChars = positiveInteger(options.maxResultChars ?? 12_000, 'maxResultChars');
    this.maxConcurrency = positiveInteger(options.maxConcurrency ?? 4, 'maxConcurrency', 64);
    if (options.allowedTools) this.allowedTools = new Set(options.allowedTools);
  }

  async execute(toolName: string, parameters: Parameters, context: ExecutionContext = {}): Promise<ToolCall> {
    const started = performance.now();
    const call: ToolCall = { id: randomUUID(), toolName, parameters: {}, timestamp: new Date().toISOString(), executionTime: 0, status: 'executing' };
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`Tool timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    try {
      signal.throwIfAborted();
      if (this.allowedTools && !this.allowedTools.has(toolName)) throw new Error(`Tool is not allowed: ${toolName}`);
      const tool = this.registry.get(toolName);
      if (!tool) throw new Error(`Unknown tool: ${toolName}`);
      call.parameters = boundedJson(parameters, 64_000).data as Parameters;
      this.validate(tool, call.parameters);
      await this.acquire(signal);
      // Keep the slot occupied until the real execution settles, even after a timeout.
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return tool.execute(structuredClone(call.parameters), { signal, sessionId: context.sessionId ?? 'standalone' });
      }).finally(() => this.release());
      const value = await abortable(operation, signal);
      const result = boundedJson(value, this.maxResultChars);
      call.executionTime = performance.now() - started;
      call.status = 'completed';
      call.result = { success: true, ...result, metadata: { toolName, executionTime: call.executionTime, timestamp: new Date().toISOString() } };
    } catch (error) {
      call.executionTime = performance.now() - started;
      call.status = 'failed';
      call.error = (error instanceof Error ? error.message : 'Tool execution failed').slice(0, 1024);
      call.result = { success: false, data: null, raw: '', metadata: { toolName, executionTime: call.executionTime, timestamp: new Date().toISOString() } };
    } finally { clearTimeout(timer); }
    return call;
  }

  async executeParallel(calls: Array<{ toolName: string; parameters: Parameters }>, context: ExecutionContext = {}): Promise<ToolCall[]> {
    // A worker pool bounds queued executions as well as active tool promises.
    const results = new Array<ToolCall>(calls.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(calls.length, this.maxConcurrency) }, async () => {
      for (;;) {
        const index = next++;
        const call = calls[index];
        if (!call) return;
        results[index] = await this.execute(call.toolName, call.parameters, context);
      }
    }));
    return results;
  }

  private validate(tool: Tool, parameters: Parameters): void {
    if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object') throw new Error('Tool parameters must be an object');
    const known = new Set(tool.parameters.map((parameter) => parameter.name));
    for (const key of Object.keys(parameters)) if (!known.has(key)) throw new Error(`Unknown parameter: ${key}`);
    for (const definition of tool.parameters) {
      const value = parameters[definition.name];
      if (value === undefined) {
        if (definition.required) throw new Error(`Missing required parameter: ${definition.name}`);
        continue;
      }
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      if (actual !== definition.type) throw new Error(`Parameter ${definition.name} must be ${definition.type}`);
      if (definition.enum && !definition.enum.includes(value as string)) throw new Error(`Invalid value for parameter ${definition.name}`);
      if (typeof value === 'number' && ((definition.minimum !== undefined && value < definition.minimum) || (definition.maximum !== undefined && value > definition.maximum))) throw new Error(`Parameter ${definition.name} is outside its allowed range`);
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrency) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => {
        signal.removeEventListener('abort', cancelled);
        this.active++;
        resolve();
      };
      const cancelled = (): void => {
        const index = this.waiting.indexOf(ready);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(abortError(signal));
      };
      this.waiting.push(ready);
      signal.addEventListener('abort', cancelled, { once: true });
    });
  }

  private release(): void { this.active--; this.waiting.shift()?.(); }
}

export default ToolExecutor;
