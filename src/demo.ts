import { Agent } from './core/agent.js';
import type { AgentConfig } from './core/types.js';
import { MockLLMClient } from './models/mock-client.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { FixtureSearchProvider } from './tools/search-tool.js';
import { ConversationMemory } from './memory/conversation.js';
/** Always offline, even when the host environment configures a real model. */
export function createDemoAgent(config: Partial<AgentConfig> = {}): Agent {
  return new Agent({ name: 'DemoHarness', ...config, model: 'mock' }, {
    llm: new MockLLMClient(), registry: new ToolRegistry(new FixtureSearchProvider()), memory: new ConversationMemory(), memoryOptions: {},
  });
}
