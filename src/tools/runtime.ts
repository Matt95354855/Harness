import type { JsonValue } from '../core/types.js';

export function positiveInteger(value: number, name: string, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled');
}

/** Also bounds callers when a third-party tool or injected fetch ignores AbortSignal. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Reject unsupported output before serialization; never silently drop undefined or Infinity. */
export function boundedJson(value: unknown, maximum: number): { data: JsonValue; raw: string } {
  let budget = maximum;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32) throw new Error('JSON nesting exceeds 32 levels');
    budget -= 1;
    if (typeof item === 'string') budget -= item.length;
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('JSON numbers must be finite');
    } else if (item !== null && typeof item !== 'boolean') {
      if (typeof item !== 'object') throw new Error('Tool values must be serializable JSON');
      if (seen.has(item)) throw new Error('Circular JSON value');
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error('Tool values must be plain JSON objects');
      }
      seen.add(item);
      for (const [key, nested] of Object.entries(item)) {
        budget -= key.length;
        if (budget < 0) throw new Error(`JSON value exceeds ${maximum} characters`);
        visit(nested, depth + 1);
      }
      seen.delete(item);
    }
    if (budget < 0) throw new Error(`JSON value exceeds ${maximum} characters`);
  };
  visit(value, 0);
  const raw = JSON.stringify(value);
  if (raw.length > maximum) throw new Error(`JSON value exceeds ${maximum} characters`);
  return { data: JSON.parse(raw) as JsonValue, raw };
}
