/** Accept an object or one fenced JSON object; never execute or heuristically repair text. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const result: unknown = JSON.parse(fenced?.[1] ?? trimmed);
  if (result === null || Array.isArray(result) || typeof result !== 'object') throw new Error('Expected a JSON object');
  return result;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** Race cooperative APIs against cancellation, including user-supplied model adapters. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(signal.reason ?? new Error('Operation cancelled')); }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('Operation cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
