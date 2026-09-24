import assert from 'node:assert/strict';
import { Agent, FixtureSearchProvider, ScriptedLLMClient, ToolRegistry } from '../src/index.js';

// Each output is a fixture. This checks orchestration, not a real model's reasoning ability.
const llm = new ScriptedLLMClient([
  JSON.stringify({ summary: 'Rechercher les composants.', nextAction: 'SEARCH', confidence: 1, query: 'agent harness components' }),
  JSON.stringify({ summary: 'Approfondir la validation des outils.', nextAction: 'SEARCH', confidence: 1, query: 'agent tool parameter validation' }),
  JSON.stringify({ summary: 'Évaluer les éléments collectés.', nextAction: 'REFLECT', confidence: 1 }),
  JSON.stringify({ analysis: 'Deux recherches distinctes ont fourni les fixtures attendues.', improvements: [], shouldContinue: false }),
  'Démonstration multi-hop réussie : deux recherches puis une réflexion. Les données utilisées sont synthétiques.',
]);
const agent = new Agent({ enableReflection: true }, { llm, registry: new ToolRegistry(new FixtureSearchProvider()) });
console.log(await agent.process('Compare les composants et la validation des outils.'));
const trace = agent.getTrace()!;
assert.equal(trace.toolCalls.length, 2);
assert.ok(trace.events.some(event => event.type === 'reflection'));
console.log(`Actions validées : ${trace.toolCalls.map(call => call.parameters.query).join(' → ')}`);
