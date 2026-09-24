import type { PrismTemplate, RenderedPrompt } from '../core/types.js';
/** Local template engine named after the design document; no PrismML SDK dependency. */
export class PrismAdapter {
  private readonly templates = new Map<string, PrismTemplate>();
  constructor() {
    this.registerTemplate({ name: 'hermes-thinking', version: '1', variables: ['payload'], template: 'HARNESS_DECIDE\n{{payload}}' });
    this.registerTemplate({ name: 'reflection', version: '1', variables: ['payload'], template: 'HARNESS_REFLECT\n{{payload}}' });
    this.registerTemplate({ name: 'synthesis', version: '1', variables: ['payload'], template: 'HARNESS_SYNTHESIZE\n{{payload}}' });
    this.registerTemplate({ name: 'search-intent', version: '1', variables: ['userQuery', 'context'], template: 'Search intent for {{userQuery}}\nContext: {{context}}' });
  }
  registerTemplate(template: PrismTemplate): void {
    if (!template.name.trim() || !template.version.trim()) throw new Error('Template name and version are required');
    const variables = [...template.template.matchAll(/{{\s*([\w]+)\s*}}/g)].map(match => match[1]!);
    if (variables.some(variable => !template.variables.includes(variable))) throw new Error('Undeclared template variable');
    this.templates.set(template.name, structuredClone(template));
  }
  render(name: string, variables: Record<string, unknown>): RenderedPrompt {
    const template = this.templates.get(name);
    if (!template) throw new Error(`Template not found: ${name}`);
    const missing = template.variables.filter(key => !Object.hasOwn(variables, key) || variables[key] === undefined);
    if (missing.length) throw new Error(`Missing template variables: ${missing.join(', ')}`);
    const formatted = template.template.replace(/{{\s*([\w]+)\s*}}/g, (_match, key: string) => typeof variables[key] === 'string' ? variables[key] as string : JSON.stringify(variables[key]));
    return { raw: template.template, formatted, variables: structuredClone(variables) };
  }
  listTemplates(): PrismTemplate[] { return structuredClone([...this.templates.values()]); }
  getTemplate(name: string): PrismTemplate | undefined { const value = this.templates.get(name); return value ? structuredClone(value) : undefined; }
}
