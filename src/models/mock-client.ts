import type { LanguageModel, LLMRequest, LLMResponse } from '../core/types.js';
function response(content: string): LLMResponse {
  return { content, model: 'mock', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
}
/** Deterministic offline fixture, deliberately not an intelligence/performance benchmark. */
export class MockLLMClient implements LanguageModel {
  async complete(request: LLMRequest): Promise<LLMResponse> {
    request.signal?.throwIfAborted();
    const text = request.messages.at(-1)?.content ?? '';
    const split = text.indexOf('\n');
    const marker = text.slice(0, split);
    const payload = JSON.parse(text.slice(split + 1)) as { question: string; context: string; previousActions?: string[]; tools?: string; limited?: boolean };
    if (marker === 'HARNESS_DECIDE') {
      if (payload.previousActions?.length) return response(JSON.stringify({ summary: 'Les résultats permettent une synthèse.', nextAction: 'RESPOND', confidence: 1 }));
      const expression = payload.question.match(/[\d(][\d\s.+*/()%^-]*\d[\d\s.+*/()%^)]*/)?.[0]?.trim();
      if (expression && /[+*/%-]/.test(expression) && payload.tools?.includes('calculate')) return response(JSON.stringify({ summary: 'Vérifier le calcul avec un outil déterministe.', nextAction: 'TOOL', toolName: 'calculate', parameters: { expression }, confidence: 1 }));
      if (payload.tools?.includes('web_search')) return response(JSON.stringify({ summary: 'Consulter les données de démonstration.', nextAction: 'SEARCH', query: payload.question.slice(0, 2000), confidence: 1 }));
      return response(JSON.stringify({ summary: 'Aucun outil nécessaire pour cette démonstration.', nextAction: 'RESPOND', confidence: 1 }));
    }
    if (marker === 'HARNESS_REFLECT') return response(JSON.stringify({ analysis: 'Les résultats sont disponibles pour une synthèse de démonstration.', improvements: [], shouldContinue: false }));
    let observations: Array<{ tool: string; status: string; result?: { result?: number; results?: unknown[] }; error?: string }> = [];
    try { observations = JSON.parse(payload.context.split('\n')[1] ?? '[]') as typeof observations; }
    catch { /* A deliberately small context budget may truncate the observation JSON. */ }
    const details = observations.map(item => {
      if (item.status !== 'completed') return `- ${item.tool} : échec (${item.error ?? 'sans résultat'}).`;
      if (item.tool === 'calculate') return `- calculate : résultat ${item.result?.result}.`;
      if (item.tool === 'web_search') return `- web_search : ${item.result?.results?.length ?? 0} résultats synthétiques, sans recherche sur Internet.`;
      return `- ${item.tool} : exécution terminée.`;
    }).join('\n');
    return response(`Mode démonstration : réponse simulée, sans appel à un LLM.\n\nQuestion : ${payload.question}\n\n${details || 'Aucun résultat d’outil disponible.'}\n\nCette démonstration vérifie la boucle de l’agent. Connecte un modèle local pour obtenir une réponse rédigée à ta question.${payload.limited ? '\nLimite d’exécution atteinte.' : ''}`);
  }
}
/** Explicit scripted outputs for reproducible evaluations and integration tests. */
export class ScriptedLLMClient implements LanguageModel {
  readonly requests: LLMRequest[] = [];
  private cursor = 0;
  constructor(private readonly outputs: Array<string | LLMResponse | Error>) {}
  async complete(request: LLMRequest): Promise<LLMResponse> {
    request.signal?.throwIfAborted();
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const output = this.outputs[this.cursor++];
    if (output === undefined) throw new Error('Scripted model exhausted');
    if (output instanceof Error) throw output;
    return typeof output === 'string' ? response(output) : structuredClone(output);
  }
}
