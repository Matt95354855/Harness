import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { ToolRegistry } from './tool-registry.js';
import { FixtureSearchProvider, HttpSearchProvider } from './search-tool.js';
import { LocalFileTools } from './local-files.js';
import { GoogleDriveTools } from './google-drive.js';
import { WebFetchTool } from './web-fetch.js';
import { McpConnections } from './mcp-client.js';

export interface ConfiguredToolRuntime { registry: ToolRegistry; capabilities: string[]; close(): Promise<void> }

export async function createConfiguredToolRuntime(env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredToolRuntime> {
  const config = loadConfig(env);
  const search = config.search.provider === 'fixture' ? new FixtureSearchProvider() : config.search.options ? new HttpSearchProvider(config.search.options) : undefined;
  const registry = new ToolRegistry(search); const capabilities: string[] = []; const mcp = new McpConnections();
  if (env.WEB_ACCESS === 'true') { registry.register(new WebFetchTool()); capabilities.push('web'); }
  const roots = env.LOCAL_FILE_ROOTS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  if (roots.length) { const local = await LocalFileTools.create(roots); for (const tool of local.tools()) registry.register(tool); capabilities.push('local-files'); }
  if (env.GOOGLE_DRIVE_ACCESS_TOKEN?.trim()) { for (const tool of new GoogleDriveTools(env.GOOGLE_DRIVE_ACCESS_TOKEN).tools()) registry.register(tool); capabilities.push('google-drive'); }
  const mcpPath = env.MCP_CONFIG_PATH ?? '.harness/mcp.json';
  if (existsSync(mcpPath)) { for (const tool of await mcp.connectFile(mcpPath, env)) registry.register(tool); capabilities.push('mcp'); }
  return { registry, capabilities, close: () => mcp.close() };
}
