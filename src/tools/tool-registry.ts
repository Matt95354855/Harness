import type { SearchProvider, Tool } from '../core/types.js';
import { calculate } from './calculate.js';
import { SearchTool } from './search-tool.js';

/** Explicit capabilities only: no shell, filesystem or network tool is enabled implicitly. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(searchProvider?: SearchProvider) {
    this.register({
      name: 'calculate',
      description: 'Evaluate arithmetic (+, -, *, /, %, ^, ** and parentheses). No code execution. Uses JavaScript floating-point numbers.',
      parameters: [{ name: 'expression', type: 'string', description: 'Arithmetic expression, at most 1024 characters.', required: true }],
      execute: async (params) => ({ result: calculate(params.expression as string) }),
    });
    if (searchProvider) this.register(new SearchTool(searchProvider));
  }

  register(tool: Tool): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error('Invalid tool name');
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (!tool.description.trim() || typeof tool.execute !== 'function') throw new Error('Tool requires a description and execute function');
    const names = new Set<string>();
    for (const parameter of tool.parameters) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(parameter.name) || names.has(parameter.name)) throw new Error('Invalid or duplicate tool parameter');
      names.add(parameter.name);
      if (!['string', 'number', 'boolean', 'array', 'object'].includes(parameter.type)) throw new Error('Unsupported parameter type');
      if (parameter.enum && (parameter.type !== 'string' || !parameter.enum.length || parameter.enum.some((value) => typeof value !== 'string'))) throw new Error('Parameter enum must contain strings');
      for (const bound of [parameter.minimum, parameter.maximum]) {
        if (bound !== undefined && (parameter.type !== 'number' || !Number.isFinite(bound))) throw new Error('Parameter bounds require finite numbers');
      }
      if (parameter.minimum !== undefined && parameter.maximum !== undefined && parameter.minimum > parameter.maximum) throw new Error('Parameter minimum exceeds maximum');
    }
    // Bind execution before cloning metadata so class-based tools keep their provider.
    this.tools.set(tool.name, { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), execute: tool.execute.bind(tool) });
  }

  get(name: string): Tool | undefined {
    const tool = this.tools.get(name);
    return tool ? { ...tool, parameters: structuredClone(tool.parameters) } : undefined;
  }

  listAll(): Tool[] { return [...this.tools.keys()].map((name) => this.get(name)!); }

  getFormattedDescription(): string {
    return this.listAll().map((tool) => `${tool.name}: ${tool.description}\nParameters: ${JSON.stringify(tool.parameters)}`).join('\n\n');
  }
}

export default ToolRegistry;
