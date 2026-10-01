import { Agent } from '../src/core/agent.js';
import { LLMClient } from '../src/models/llm-client.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { DuckDuckGoSearchProvider } from '../src/tools/duckduckgo-search.js';
import { WebFetchTool } from '../src/tools/web-fetch.js';
import { decisionContent, finalContent } from '../src/web/model-output.js';

const registry = new ToolRegistry(new DuckDuckGoSearchProvider());
registry.register(new WebFetchTool());
const transport = new LLMClient({ endpoint: 'http://127.0.0.1:8082/v1', model: 'harness-local', timeoutMs: 180_000, maxRetries: 0 });
const agent = new Agent({ model: 'harness-local', maxIterations: 6, maxToolCalls: 4, maxTokens: 1500,
  maxContextChars: 7000, runTimeoutMs: 240_000, toolTimeoutMs: 20_000, enableReflection: false,
  allowedTools: ['calculate', 'web_search', 'web_fetch'], traceDir: undefined }, {
  registry,
  llm: { complete: async request => {
    const result = await transport.complete(request);
    const decision = request.messages.some(message => message.role === 'system' && message.content.includes('Choose exactly one next action'));
    try { return { ...result, content: decision ? decisionContent(result.content) : finalContent(result.content) }; }
    catch (error) { console.error('RAW MODEL OUTPUT:', JSON.stringify(result.content)); throw error; }
  } },
  memoryOptions: {},
});
const answer = await agent.process('Utilise obligatoirement l’outil web_search pour trouver le titre du site officiel OpenAI. Réponds brièvement avec son URL source.');
const tools = agent.getTrace()?.toolCalls.map(call => call.toolName) ?? [];
console.log(JSON.stringify({ tools, answer }, null, 2));
if (!tools.includes('web_search')) throw new Error('The model did not invoke web_search');
