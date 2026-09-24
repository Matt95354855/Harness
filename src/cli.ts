#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Agent } from './core/agent.js';
import { loadConfig } from './core/config.js';
import { createDemoAgent } from './demo.js';
import { LLMClient } from './models/llm-client.js';
import { errorMessage } from './utils/parser.js';

const help = `Harness — exécuter, observer et tester des agents IA

  npm run demo                         Démonstration hors ligne
  npm run doctor                       Vérifier la configuration et le serveur LLM
  npm run dev -- run "Votre question"  Une exécution avec la configuration .env
  npm run dev -- chat                   Conversation interactive (/reset, /exit)
  npm run dev -- run "Question" --json  Réponse et trace JSON

Options : --json, --help (-h), --version (-v)
Le mode mock est actif par défaut. Aucun modèle n'est téléchargé automatiquement.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.version) { console.log('0.1.0'); return; }
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command, ...words] = positionals;
  if (!['demo', 'doctor', 'run', 'chat'].includes(command!)) throw new Error(`Commande inconnue : ${command}. Utilise --help.`);
  if (command !== 'run' && words.length) throw new Error(`${command} n'accepte pas d'argument supplémentaire`);
  if (command === 'chat' && values.json) throw new Error('--json est disponible pour run, demo et doctor');
  // Explicit demo is independent of .env, even if that file is invalid.
  if (command !== 'demo' && existsSync('.env')) process.loadEnvFile('.env');
  if (command === 'doctor') {
    const config = loadConfig();
    const report: Record<string, unknown> = { ok: true, provider: config.provider, model: config.agent.model, search: config.search.provider, node: process.version };
    if (config.provider === 'openai-compatible') {
      const models = await new LLMClient(config.llm).listModels();
      report.models = models; report.modelAvailable = models.includes(config.agent.model);
      if (!report.modelAvailable) { report.ok = false; process.exitCode = 1; }
    } else report.note = 'Mode mock : aucun LLM réel contacté. Les tests de génération locale restent à faire après installation du modèle.';
    console.log(JSON.stringify(report, null, 2)); return;
  }
  const agent = command === 'demo' ? createDemoAgent() : new Agent();
  let controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error('Interrompu par l’utilisateur'));
  process.on('SIGINT', interrupt);
  try {
    if (command === 'chat') {
      if (!process.stdin.isTTY) throw new Error('chat exige un terminal interactif ; utilise run pour les scripts');
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      readline.on('SIGINT', interrupt);
      console.log('Harness — /exit pour quitter, /reset pour une nouvelle session.');
      try {
        while (true) {
          controller = new AbortController();
          let input: string;
          try { input = await readline.question('\nVous > ', { signal: controller.signal }); }
          catch { break; }
          if (input.trim() === '/exit') break;
          if (input.trim() === '/reset') { agent.reset(); console.log('Nouvelle session.'); continue; }
          if (!input.trim()) continue;
          try { console.log(`\nHarness > ${await agent.process(input, { signal: controller.signal })}`); }
          catch (error) { console.error(`Erreur : ${errorMessage(error)}`); }
        }
      } finally { readline.close(); }
      return;
    }
    const question = command === 'demo' ? 'Explique les composants d’un harness d’agents IA.' : words.join(' ');
    if (!question.trim()) throw new Error('Une question est requise : run "Votre question"');
    const response = await agent.process(question, { signal: controller.signal });
    const trace = agent.getTrace()!;
    if (values.json) console.log(JSON.stringify({ response, trace }, null, 2));
    else {
      console.log(response);
      console.log(`\n[${trace.status}] ${trace.totalIterations} itérations · ${trace.toolCalls.length} outils · ${trace.usage.totalTokens} jetons déclarés`);
    }
  } finally { process.removeListener('SIGINT', interrupt); }
}

main().catch(error => { console.error(`Harness : ${errorMessage(error)}`); process.exitCode = 1; });
