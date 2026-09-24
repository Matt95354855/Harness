import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { validateEndpoint } from '../core/config.js';
import { abortable } from '../utils/parser.js';
import type { LanguageModel, LLMOptions, LLMRequest, LLMResponse } from '../core/types.js';

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }), finish_reason: z.string().nullable().optional() })).min(1),
  usage: z.object({ prompt_tokens: z.number().nonnegative().optional(), completion_tokens: z.number().nonnegative().optional(), total_tokens: z.number().nonnegative().optional() }).optional(),
});
class HTTPError extends Error {
  constructor(readonly status: number) { super(`LLM endpoint returned HTTP ${status}`); }
}
/** OpenAI-compatible Chat Completions transport; works with locally served models. */
export class LLMClient implements LanguageModel {
  private readonly options: Required<Omit<LLMOptions, 'apiKey'>> & { apiKey?: string };
  constructor(options: LLMOptions) {
    this.options = { ...options, endpoint: validateEndpoint(options.endpoint), fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? 60000, maxRetries: options.maxRetries ?? 2, maxResponseBytes: options.maxResponseBytes ?? 2_000_000 };
    if (!options.model.trim()) throw new Error('A model ID is required');
    if (!Number.isInteger(this.options.maxRetries) || this.options.maxRetries < 0 || this.options.maxRetries > 5) throw new Error('maxRetries must be between 0 and 5');
    if (!Number.isInteger(this.options.timeoutMs) || this.options.timeoutMs < 1) throw new Error('timeoutMs must be positive');
    if (!Number.isInteger(this.options.maxResponseBytes) || this.options.maxResponseBytes < 1) throw new Error('maxResponseBytes must be positive');
  }
  private async withDeadline<T>(external: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('LLM deadline exceeded', 'TimeoutError')), this.options.timeoutMs);
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    try { signal.throwIfAborted(); return await abortable(operation(signal), signal); }
    finally { clearTimeout(timer); }
  }
  private async request(path: string, signal: AbortSignal, body?: object): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await abortable(this.options.fetch(`${this.options.endpoint}${path}`, {
          method: body ? 'POST' : 'GET', signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        }), signal);
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new HTTPError(response.status);
        }
        return response;
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        const retryable = error instanceof HTTPError ? error.status === 429 || error.status >= 500 : error instanceof TypeError;
        if (!retryable || attempt >= this.options.maxRetries) throw error;
        await delay(Math.min(1000, 100 * 2 ** attempt), undefined, { signal });
      }
    }
  }
  private body(request: LLMRequest, stream: boolean): object {
    return { model: this.options.model, messages: request.messages.map(({ role, content }) => ({ role, content })), temperature: request.temperature ?? 0.2, top_p: request.topP ?? 0.9, max_tokens: request.maxTokens ?? 1500, stream };
  }
  private async read(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) throw new Error('Empty LLM response body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > this.options.maxResponseBytes) throw new Error('LLM response exceeds size limit');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.withDeadline(request.signal, async signal => {
    const response = await this.request('/chat/completions', signal, this.body(request, false));
    const parsed = completionSchema.parse(JSON.parse(await this.read(response, signal)));
    const choice = parsed.choices[0]!;
    if (choice.finish_reason === 'length') throw new Error('LLM output was truncated; increase MAX_TOKENS');
    const promptTokens = parsed.usage?.prompt_tokens ?? 0;
    const completionTokens = parsed.usage?.completion_tokens ?? 0;
    return { content: choice.message.content, model: parsed.model ?? this.options.model, finishReason: choice.finish_reason ?? 'stop', usage: { promptTokens, completionTokens, totalTokens: parsed.usage?.total_tokens ?? promptTokens + completionTokens } };
    });
  }
  /** Incremental SSE decoding. Never retries a partially delivered stream. */
  async stream(request: LLMRequest, onChunk: (chunk: string) => void): Promise<void> {
    return this.withDeadline(request.signal, async signal => {
    const response = await this.request('/chat/completions', signal, this.body(request, true));
    if (!response.body) throw new Error('Empty LLM stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let size = 0;
    let finished = false;
    const event = (raw: string): void => {
      const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') { finished = true; return; }
      const parsed = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional() }), finish_reason: z.string().nullable().optional() })) }).parse(JSON.parse(data));
      for (const choice of parsed.choices) {
        if (choice.finish_reason === 'length') throw new Error('LLM stream was truncated');
        if (choice.delta.content) onChunk(choice.delta.content);
      }
    };
    try {
      while (!finished) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) { buffer += decoder.decode(); break; }
        size += value.byteLength;
        if (size > this.options.maxResponseBytes) throw new Error('LLM stream exceeds size limit');
        buffer += decoder.decode(value, { stream: true });
        // Normalize only complete CRLF pairs, including pairs split across chunks.
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0 && !finished) {
          event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
        }
      }
      if (!finished && buffer.trim()) event(buffer);
      if (!finished) throw new Error('LLM stream ended before [DONE]');
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    });
  }
  async listModels(signal?: AbortSignal): Promise<string[]> {
    return this.withDeadline(signal, async activeSignal => {
    const response = await this.request('/models', activeSignal);
    const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(await this.read(response, activeSignal)));
    return parsed.data.map(model => model.id);
    });
  }
}
