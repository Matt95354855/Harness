import { existsSync } from 'node:fs';
import { loadConfig } from '../core/config.js';
import { ToolRegistry } from './tool-registry.js';
import { FixtureSearchProvider, HttpSearchProvider } from './search-tool.js';
import { LocalFileTools } from './local-files.js';
import { GoogleDriveTools } from './google-drive.js';
import { WebFetchTool } from './web-fetch.js';
import { McpConnections } from './mcp-client.js';
import { MassClassificationTools } from './mass-classification.js';

export interface ConfiguredToolRuntime { registry: ToolRegistry; capabilities: string[]; close(): Promise<void> }

export async function createConfiguredToolRuntime(env: NodeJS.ProcessEnv = process.env): Promise<ConfiguredToolRuntime> {
  const config = loadConfig(env);
  const allowed = config.agent.allowedTools;
  const enabled = (...names: string[]): boolean => !allowed || names.some(name => allowed.includes(name));
  const enabledPrefix = (prefix: string): boolean => !allowed || allowed.some(name => name.startsWith(prefix));
  const search = config.search.provider === 'fixture' ? new FixtureSearchProvider() : config.search.options ? new HttpSearchProvider(config.search.options) : undefined;
  const registry = new ToolRegistry(search); const capabilities: string[] = []; const mcp = new McpConnections();
  if (env.WEB_ACCESS === 'true' && enabled('web_fetch')) { registry.register(new WebFetchTool()); capabilities.push('web'); }
  const roots = env.LOCAL_FILE_ROOTS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  if (roots.length && enabled('local_list', 'local_read', 'local_search')) { const local = await LocalFileTools.create(roots); for (const tool of local.tools()) registry.register(tool); capabilities.push('local-files'); }
  if (env.GOOGLE_DRIVE_ACCESS_TOKEN?.trim() && enabled('drive_search', 'drive_read')) { for (const tool of new GoogleDriveTools(env.GOOGLE_DRIVE_ACCESS_TOKEN).tools()) registry.register(tool); capabilities.push('google-drive'); }
  const massUrl = env.MASS_CLASSIFICATION_URL?.trim(); const massKey = env.MASS_CLASSIFICATION_API_KEY?.trim();
  if (enabledPrefix('mass_') && (massUrl || massKey) && (!massUrl || !massKey)) throw new Error('MASS_CLASSIFICATION_URL and MASS_CLASSIFICATION_API_KEY must be configured together');
  if (massUrl && massKey && enabledPrefix('mass_')) {
    const massRoots = env.MASS_INPUT_ROOTS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
    const maxUpload = env.MASS_MAX_UPLOAD_BYTES === undefined ? undefined : Number(env.MASS_MAX_UPLOAD_BYTES);
    const mass = await MassClassificationTools.create({ endpoint: massUrl, apiKey: massKey, inputRoots: enabled('mass_submit_document', 'mass_profile_document') ? massRoots : [], maxUploadBytes: maxUpload, enableFeedback: allowed?.includes('mass_submit_feedback') ?? false });
    const selected = mass.tools().filter(tool => enabled(tool.name)); for (const tool of selected) registry.register(tool);
    if (selected.length) capabilities.push('mass-classification');
  }
  const mcpPath = env.MCP_CONFIG_PATH ?? '.harness/mcp.json';
  if (existsSync(mcpPath) && enabledPrefix('mcp_')) { for (const tool of await mcp.connectFile(mcpPath, env)) registry.register(tool); capabilities.push('mcp'); }
  return { registry, capabilities, close: () => mcp.close() };
}
