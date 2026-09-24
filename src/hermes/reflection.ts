import type { AgentConfig } from '../core/types.js';
/** Automatic reflections occur after an action; each one consumes an iteration. */
export function shouldReflect(config: AgentConfig, iteration: number, lastReflection: number): boolean {
  return config.enableReflection && iteration > 0 && iteration % config.reflectionInterval === 0 && iteration !== lastReflection;
}
