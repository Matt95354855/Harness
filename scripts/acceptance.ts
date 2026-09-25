import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Agent } from '../src/core/agent.js';
import type { ToolCall } from '../src/core/types.js';
import { createConfiguredToolRuntime } from '../src/tools/configured-runtime.js';

if (existsSync('.env')) process.loadEnvFile('.env');

type Outcome = 'PASS' | 'FAIL' | 'SKIP';
interface Result { name: string; outcome: Outcome; expectedTool: string; toolStatus?: string; evidence?: string; error?: string }
interface Case {
  name: string;
  expectedTool: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  optionalWhen?: () => string | undefined;
  prove: (call: ToolCall) => string | undefined;
}

const project = resolve(process.cwd());
const contains = (call: ToolCall, text: string): string | undefined => JSON.stringify(call.result?.data).includes(text) ? text : undefined;
const cases: Case[] = [
  {
    name: 'Calcul déterministe', expectedTool: 'calculate',
    prompt: 'Utilise obligatoirement calculate pour calculer (12 + 8) * 3. Réponds uniquement avec le résultat.',
    prove: call => contains(call, '60'),
  },
  {
    name: 'Liste des fichiers locaux', expectedTool: 'local_list', env: { LOCAL_FILE_ROOTS: project },
    prompt: `Utilise obligatoirement local_list pour lister ${project}. Réponds en une ligne.`,
    prove: call => contains(call, 'package.json'),
  },
  {
    name: 'Lecture d’un fichier local', expectedTool: 'local_read', env: { LOCAL_FILE_ROOTS: project },
    prompt: `Utilise obligatoirement local_read pour lire ${project}/package.json. Donne uniquement le nom du paquet.`,
    prove: call => contains(call, '@matt95354855/agent-harness'),
  },
  {
    name: 'Recherche dans les fichiers locaux', expectedTool: 'local_search', env: { LOCAL_FILE_ROOTS: project },
    prompt: `Utilise obligatoirement local_search pour rechercher McpConnections dans ${project}/src. Donne uniquement le fichier trouvé.`,
    prove: call => contains(call, 'mcp-client.ts'),
  },
  {
    name: 'Lecture d’Internet', expectedTool: 'web_fetch', env: { WEB_ACCESS: 'true' },
    prompt: 'Utilise obligatoirement web_fetch pour lire https://example.com puis donne uniquement le titre de la page.',
    prove: call => contains(call, 'Example Domain'),
  },
  {
    name: 'GitHub par MCP', expectedTool: 'mcp_github_get_file_contents', env: { MCP_CONFIG_PATH: 'config/mcp.example.json' },
    optionalWhen: () => process.env.GITHUB_TOKEN ? undefined : 'GITHUB_TOKEN absent',
    prompt: 'Utilise obligatoirement mcp_github_get_file_contents pour lire package.json dans le dépôt Matt95354855/Harness. Donne uniquement le nom du paquet.',
    prove: call => contains(call, '@matt95354855/agent-harness'),
  },
  {
    name: 'Recherche Internet', expectedTool: 'web_search', env: { WEB_ACCESS: 'true' },
    optionalWhen: () => ['http', 'searxng'].includes(process.env.SEARCH_PROVIDER ?? '') && process.env.SEARCH_ENDPOINT ? undefined : 'moteur SEARCH_PROVIDER/SEARCH_ENDPOINT absent',
    prompt: 'Utilise obligatoirement web_search pour rechercher le site officiel de Node.js. Donne uniquement la première URL pertinente.',
    prove: call => call.result?.data ? 'résultats reçus' : undefined,
  },
  {
    name: 'Google Drive', expectedTool: 'drive_search',
    optionalWhen: () => process.env.GOOGLE_DRIVE_ACCESS_TOKEN ? undefined : 'GOOGLE_DRIVE_ACCESS_TOKEN absent',
    prompt: 'Utilise obligatoirement drive_search pour rechercher README. Donne uniquement le premier nom de fichier, ou aucun résultat.',
    prove: call => call.result?.data ? 'réponse Drive reçue' : undefined,
  },
];

async function run(testCase: Case): Promise<Result> {
  const reason = testCase.optionalWhen?.();
  if (reason) return { name: testCase.name, outcome: 'SKIP', expectedTool: testCase.expectedTool, error: reason };
  const environment = { ...process.env, ...testCase.env, ALLOWED_TOOLS: testCase.expectedTool, PERSIST_TRACES: 'false' };
  const runtime = await createConfiguredToolRuntime(environment);
  try {
    const agent = new Agent({ allowedTools: [testCase.expectedTool], temperature: 0, maxIterations: 2, maxToolCalls: 1, maxTokens: 400, traceDir: undefined }, { registry: runtime.registry });
    await agent.process(testCase.prompt);
    const call = agent.getTrace()?.toolCalls.find(item => item.toolName === testCase.expectedTool);
    if (!call) return { name: testCase.name, outcome: 'FAIL', expectedTool: testCase.expectedTool, error: 'outil non appelé' };
    if (call.status !== 'completed') return { name: testCase.name, outcome: 'FAIL', expectedTool: testCase.expectedTool, toolStatus: call.status, error: call.error ?? 'outil en échec' };
    const evidence = testCase.prove(call);
    return evidence ? { name: testCase.name, outcome: 'PASS', expectedTool: testCase.expectedTool, toolStatus: call.status, evidence } : { name: testCase.name, outcome: 'FAIL', expectedTool: testCase.expectedTool, toolStatus: call.status, error: 'preuve attendue absente du résultat' };
  } catch (error) {
    return { name: testCase.name, outcome: 'FAIL', expectedTool: testCase.expectedTool, error: error instanceof Error ? error.message : String(error) };
  } finally { await runtime.close(); }
}

const results: Result[] = [];
console.log('CLASSCALE HARNESS · PREUVES DE FONCTIONNEMENT');
console.log('────────────────────────────────────────────');
for (const testCase of cases) {
  const result = await run(testCase); results.push(result);
  const detail = result.evidence ?? result.error ?? result.toolStatus ?? '';
  const mark = result.outcome === 'PASS' ? '✓' : result.outcome === 'SKIP' ? '○' : '✗';
  console.log(`${mark} ${result.outcome.padEnd(4)}  ${testCase.name}${detail ? ` — ${detail}` : ''}`);
}
const report = { generatedAt: new Date().toISOString(), model: process.env.LLM_MODEL ?? 'mock', summary: { pass: results.filter(item => item.outcome === 'PASS').length, fail: results.filter(item => item.outcome === 'FAIL').length, skip: results.filter(item => item.outcome === 'SKIP').length }, results };
await mkdir('.harness', { recursive: true });
await writeFile('.harness/acceptance-latest.json', JSON.stringify(report, null, 2), { mode: 0o600 });
const rows = results.map(item => `| ${item.outcome} | ${item.name} | ${item.expectedTool} | ${item.evidence ?? item.error ?? ''} |`).join('\n');
const markdown = `# Preuves de fonctionnement du Harness\n\n- Date UTC : ${report.generatedAt}\n- Modèle : ${report.model}\n- Résultat : ${report.summary.pass} réussis, ${report.summary.fail} échoués, ${report.summary.skip} non configurés\n\n| Statut | Scénario | Outil attendu | Preuve publique |\n| --- | --- | --- | --- |\n${rows}\n\nCe rapport ne contient ni jeton, ni contenu privé, ni chemin local. Les statuts prouvent les appels d'outils observés dans les traces d'exécution.\n`;
await writeFile('.harness/acceptance-latest.md', markdown, { mode: 0o600 });
console.log('────────────────────────────────────────────');
console.log(`RÉSULTAT  ${report.summary.pass} réussis · ${report.summary.fail} échoués · ${report.summary.skip} non configurés`);
console.log('PREUVES   .harness/acceptance-latest.md et acceptance-latest.json');
if (results.some(item => item.outcome === 'FAIL')) process.exitCode = 1;
