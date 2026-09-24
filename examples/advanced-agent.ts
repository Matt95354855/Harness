import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, ConversationMemory, ScriptedLLMClient, ToolRegistry } from '../src/index.js';

const directory = await mkdtemp(join(tmpdir(), 'harness-example-'));
try {
  const registry = new ToolRegistry();
  registry.register({ name: 'word_count', description: 'Compte les mots d’un texte.', parameters: [{ name: 'text', type: 'string', description: 'Texte à analyser.', required: true }], execute: async params => ({ words: String(params.text).trim().split(/\s+/u).filter(Boolean).length }) });
  const llm = new ScriptedLLMClient([
    JSON.stringify({ summary: 'Compter les mots avec l’outil personnalisé.', nextAction: 'TOOL', toolName: 'word_count', parameters: { text: 'Un harness extensible et testable' }, confidence: 1 }),
    JSON.stringify({ summary: 'Le résultat est disponible.', nextAction: 'RESPOND', confidence: 1 }),
    'Démonstration : le texte contient 5 mots.',
  ]);
  const persistencePath = join(directory, 'memory.json');
  const agent = new Agent({ traceDir: join(directory, 'traces'), allowedTools: ['word_count'] }, { llm, registry, memoryOptions: { persistencePath } });
  console.log(await agent.process('Compte les mots du texte fourni.'));
  assert.deepEqual(agent.getState().toolCalls[0]?.result?.data, { words: 5 });
  const restored = new ConversationMemory({ persistencePath });
  await restored.loadFromDisk();
  assert.equal(restored.snapshot().shortTerm.length, 1);
  console.log('Outil personnalisé, autorisations, traces et restauration de mémoire : validés.');
} finally { await rm(directory, { recursive: true, force: true }); }
