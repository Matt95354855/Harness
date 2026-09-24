import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JsonValue, Tool, ToolParameter } from '../core/types.js';

type ServerConfig = { url: string; headers?: Record<string, string> } | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
type McpFile = { servers?: Record<string, ServerConfig>; mcpServers?: Record<string, ServerConfig> };

function substitute(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/gu, (_all, braced: string | undefined, plain: string | undefined) => {
    const key = braced ?? plain!;
    const found = env[key]; if (!found) throw new Error(`Missing environment variable ${key}`); return found;
  });
}
function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9_]+/gu, '_').replace(/^[^a-z]+/u, 'mcp_').slice(0, 63); }
function parameter(name: string, schema: Record<string, unknown>, required: boolean): ToolParameter {
  const type = ['string', 'number', 'boolean', 'array', 'object'].includes(String(schema.type)) ? String(schema.type) as ToolParameter['type'] : 'string';
  const result: ToolParameter = { name, type, description: typeof schema.description === 'string' ? schema.description : `MCP parameter ${name}.`, required };
  if (type === 'string' && Array.isArray(schema.enum) && schema.enum.every(item => typeof item === 'string')) result.enum = schema.enum;
  if (type === 'number' && typeof schema.minimum === 'number') result.minimum = schema.minimum;
  if (type === 'number' && typeof schema.maximum === 'number') result.maximum = schema.maximum;
  return result;
}
function json(value: unknown): JsonValue {
  const serialized = JSON.stringify(value); if (serialized === undefined) return null;
  return JSON.parse(serialized) as JsonValue;
}

export class McpConnections {
  private readonly clients: Client[] = [];
  private readonly names = new Set<string>();
  async connectFile(path: string, env: NodeJS.ProcessEnv = process.env): Promise<Tool[]> {
    const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as McpFile;
    const servers = parsed.servers ?? parsed.mcpServers;
    if (!servers || !Object.keys(servers).length) throw new Error('MCP configuration contains no servers');
    const tools: Tool[] = [];
    for (const [serverName, config] of Object.entries(servers)) tools.push(...await this.connect(serverName, config, env));
    return tools;
  }
  private async connect(serverName: string, config: ServerConfig, env: NodeJS.ProcessEnv): Promise<Tool[]> {
    const client = new Client({ name: 'classcale-harness', version: '0.2.0' }, { capabilities: {} });
    if ('url' in config) {
      const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, substitute(value, env)]));
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } }));
    } else {
      const childEnv = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, substitute(value, env)]));
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...getDefaultEnvironment(), ...childEnv }, stderr: 'inherit' }));
    }
    this.clients.push(client);
    const listed = await client.listTools();
    return listed.tools.map(remote => {
      const name = safeName(`mcp_${serverName}_${remote.name}`);
      if (this.names.has(name)) throw new Error(`Duplicate MCP tool name after normalization: ${name}`); this.names.add(name);
      const schema = remote.inputSchema as Record<string, unknown>; const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>; const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
      return { name, description: `[MCP ${serverName}] ${remote.description ?? remote.name}`, parameters: Object.entries(properties).map(([key, value]) => parameter(key, value, required.has(key))), execute: async params => {
        const result = await client.callTool({ name: remote.name, arguments: params });
        if (result.isError) throw new Error(`MCP tool ${remote.name} failed: ${JSON.stringify(result.content).slice(0, 1000)}`);
        return json(result.structuredContent ?? result.content);
      } } satisfies Tool;
    });
  }
  async close(): Promise<void> { await Promise.allSettled(this.clients.map(client => client.close())); this.clients.length = 0; }
}
