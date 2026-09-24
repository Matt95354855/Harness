import { join } from 'node:path';
import type { ExecutionTrace } from '../core/types.js';
import { writePrivateJson } from './storage.js';

/** Persist the execution record. Trace contents can contain user and tool data. */
export async function writeTrace(trace: ExecutionTrace, directory: string): Promise<string> {
  const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
  if (!safeId.test(trace.sessionId) || !safeId.test(trace.runId)) throw new Error('Trace sessionId and runId must be safe identifiers (1–120 letters, digits, underscores or hyphens, starting with a letter or digit)');
  const path = join(directory, `${trace.sessionId}-${trace.runId}.json`);
  await writePrivateJson(path, trace);
  return path;
}

export class DecisionLog {
  constructor(private readonly directory: string) {}
  write(trace: ExecutionTrace): Promise<string> { return writeTrace(trace, this.directory); }
}
