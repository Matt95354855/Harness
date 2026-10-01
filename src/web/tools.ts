import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConfiguredToolRuntime, type ConfiguredToolRuntime } from '../tools/configured-runtime.js';
import { DuckDuckGoSearchProvider } from '../tools/duckduckgo-search.js';
import { SearchTool } from '../tools/search-tool.js';

export interface UnavailableToolFamily { family: string; reason: string }
export interface WebToolRuntime extends ConfiguredToolRuntime { unavailable: UnavailableToolFamily[] }

/** Build the Web chat registry from every Harness capability that is configured. */
export async function createWebToolRuntime(repositoryRoot: string, source: NodeJS.ProcessEnv = process.env): Promise<WebToolRuntime> {
  const env: NodeJS.ProcessEnv = { ...source };
  const unavailable: UnavailableToolFamily[] = [];

  // The Web server owns its model transport and always enables its safe, bounded Web reader.
  env.LLM_PROVIDER = 'openai-compatible';
  env.LLM_MODEL = 'harness-local';
  env.SEARCH_PROVIDER = 'none';
  env.WEB_ACCESS = 'true';
  env.LOCAL_FILE_ROOTS = env.LOCAL_FILE_ROOTS?.trim() || resolve(repositoryRoot, '..');
  delete env.ALLOWED_TOOLS;

  const massUrl = env.MASS_CLASSIFICATION_URL?.trim();
  const massKey = env.MASS_CLASSIFICATION_API_KEY?.trim();
  if (!massUrl || !massKey) {
    unavailable.push({ family: 'mass-classification', reason: 'MASS_CLASSIFICATION_URL et MASS_CLASSIFICATION_API_KEY sont requis.' });
    delete env.MASS_CLASSIFICATION_URL;
    delete env.MASS_CLASSIFICATION_API_KEY;
  }
  if (!env.GOOGLE_DRIVE_ACCESS_TOKEN?.trim()) {
    unavailable.push({ family: 'google-drive', reason: 'GOOGLE_DRIVE_ACCESS_TOKEN est requis.' });
  }

  const mcpPath = resolve(repositoryRoot, env.MCP_CONFIG_PATH?.trim() || '.harness/mcp.json');
  env.MCP_CONFIG_PATH = mcpPath;
  if (!existsSync(mcpPath)) unavailable.push({ family: 'mcp', reason: `Configuration absente : ${mcpPath}` });

  const runtime = await createConfiguredToolRuntime(env, { enableMassFeedback: true });
  runtime.registry.register(new SearchTool(new DuckDuckGoSearchProvider()));
  return { ...runtime, unavailable };
}
