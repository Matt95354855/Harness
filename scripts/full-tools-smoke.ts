import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../src/core/agent.js';
import { LLMClient } from '../src/models/llm-client.js';
import { decisionContent, finalContent } from '../src/web/model-output.js';
import { createWebToolRuntime } from '../src/web/tools.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = await createWebToolRuntime(root);
try {
  const transport = new LLMClient({ endpoint: 'http://127.0.0.1:8082/v1', model: 'harness-local', timeoutMs: 180_000, maxRetries: 0 });
  const agent = new Agent({ model: 'harness-local', maxIterations: 6, maxToolCalls: 4, maxTokens: 1000,
    maxContextChars: 9000, runTimeoutMs: 240_000, toolTimeoutMs: 30_000, enableReflection: false, traceDir: undefined }, {
    registry: runtime.registry,
    llm: { complete: async request => {
      const result = await transport.complete(request);
      const decision = request.messages.some(message => message.role === 'system' && message.content.includes('Choose exactly one next action'));
      return { ...result, content: decision ? decisionContent(result.content) : finalContent(result.content) };
    } },
    memoryOptions: {},
  });
  const answer = await agent.process(`Utilise obligatoirement l'outil local_list pour lister le dossier ${join(root, 'docs')}. Donne ensuite trois noms trouvés.`);
  const tools = agent.getTrace()?.toolCalls.map(call => call.toolName) ?? [];
  console.log(JSON.stringify({ available: runtime.registry.listAll().map(tool => tool.name), tools, answer }, null, 2));
  if (!tools.includes('local_list')) throw new Error('The model did not invoke local_list');
} finally {
  await runtime.close();
}
