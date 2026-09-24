/** Serializable public contracts. All timestamps use ISO 8601 strings. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Parameters = Record<string, JsonValue>;
export interface Message { role: 'system' | 'user' | 'assistant'; content: string; timestamp?: string }
export interface LLMRequest { messages: Message[]; temperature?: number; topP?: number; maxTokens?: number; signal?: AbortSignal }
export interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface LLMResponse { content: string; usage: TokenUsage; model: string; finishReason: string }
export interface LanguageModel { complete(request: LLMRequest): Promise<LLMResponse> }
export interface LLMOptions { endpoint: string; model: string; apiKey?: string; timeoutMs?: number; maxRetries?: number; fetch?: typeof globalThis.fetch; maxResponseBytes?: number }
export interface ToolParameter { name: string; type: 'string' | 'number' | 'boolean' | 'array' | 'object'; description: string; required: boolean; enum?: string[]; minimum?: number; maximum?: number }
export interface ToolContext { signal: AbortSignal; sessionId: string }
export interface Tool { name: string; description: string; parameters: ToolParameter[]; execute: (params: Parameters, context: ToolContext) => Promise<JsonValue> }
export interface ToolResult { success: boolean; data: JsonValue; raw: string; metadata: { toolName: string; executionTime: number; timestamp: string } }
export interface ToolCall { id: string; toolName: string; parameters: Parameters; timestamp: string; executionTime: number; status: 'pending' | 'executing' | 'completed' | 'failed'; result?: ToolResult; error?: string }
export type Action = 'SEARCH' | 'TOOL' | 'RESPOND' | 'REFLECT';
export interface HermesThought { iteration: number; question: string; summary: string; nextAction: Action; confidence: number; toolName?: string; parameters?: Parameters; query?: string }
export interface ReflectionResult { analysis: string; improvements: string[]; shouldContinue: boolean }
export interface Fact { statement: string; source: string; confidence: number; addedAt: string; expiresAt?: string }
export interface Decision { id: string; context: string; decision: string; summary: string; outcome?: string; timestamp: string }
export interface ToolUsageStats { toolName: string; usageCount: number; successCount: number; averageExecutionTime: number; lastUsed: string }
export interface ConversationTurn { userInput: string; actionSummaries: string[]; toolsUsed: ToolCall[]; agentResponse: string; timestamp: string; iterationNumber: number }
export interface Memory { shortTerm: ConversationTurn[]; facts: Fact[]; decisions: Decision[]; toolsUsed: ToolUsageStats[] }
export interface MemoryOptions { maxTurns?: number; maxFacts?: number; maxDecisions?: number; factTtlMs?: number; persistencePath?: string }
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export interface LogEntry { timestamp: string; level: LogLevel; component: string; message: string; data?: Record<string, unknown> }
export interface LoggerOptions { level?: LogLevel; console?: boolean; filePath?: string; maxFileBytes?: number; maxEntries?: number }
export interface TraceEvent { type: string; timestamp: string; iteration: number; data: Record<string, unknown> }
export interface ExecutionTrace { sessionId: string; runId: string; startTime: string; endTime?: string; totalIterations: number; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'limit_reached'; events: TraceEvent[]; toolCalls: ToolCall[]; usage: TokenUsage; error?: string }
export interface AgentConfig { name: string; model: string; maxIterations: number; temperature: number; topP: number; systemPrompt: string; maxContextChars: number; maxInputChars: number; maxToolCalls: number; maxTokens: number; runTimeoutMs: number; toolTimeoutMs: number; maxToolResultChars: number; enableReflection: boolean; reflectionInterval: number; enableMultiHop: boolean; allowedTools?: string[]; traceDir?: string }
export interface AgentState { currentIteration: number; isThinking: boolean; lastThought?: string; toolCalls: ToolCall[]; conversationHistory: Message[]; memoryBuffer: Memory; lastTrace?: ExecutionTrace }
export interface SearchQuery { query: string; maxResults?: number; language?: string; safeSearch?: boolean; timeRange?: 'day' | 'week' | 'month' | 'year' }
export interface SearchResult { url: string; title: string; snippet: string; rank: number; source: 'fixture' | 'custom' | 'searxng'; relevanceScore?: number }
export interface SearchResponse { query: string; results: SearchResult[]; totalResults: number; executionTime: number; cached: boolean }
export interface SearchProvider { search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> }
export interface SearchOptions { endpoint: string; apiKey?: string; timeoutMs?: number; maxRetries?: number; cacheTtlMs?: number; maxCacheEntries?: number; fetch?: typeof globalThis.fetch; format?: 'generic' | 'searxng' }
export interface PrismTemplate { name: string; template: string; variables: string[]; version: string; description?: string }
export interface RenderedPrompt { raw: string; formatted: string; variables: Record<string, unknown> }
