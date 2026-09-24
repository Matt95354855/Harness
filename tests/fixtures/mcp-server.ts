import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'harness-test', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', description: 'Return text.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text.' } }, required: ['text'] } }] }));
server.setRequestHandler(CallToolRequestSchema, request => ({ content: [{ type: 'text', text: String(request.params.arguments?.text) }], structuredContent: { echoed: request.params.arguments?.text } }));
await server.connect(new StdioServerTransport());
