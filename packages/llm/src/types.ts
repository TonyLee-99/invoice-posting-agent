export interface LLMRequest {
  model: string;
  system: string;
  prompt: string;
  /** Free-form tag recorded in the call log, e.g. "extract" or "explain". */
  purpose: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  backend: string;
  usage: LLMUsage;
  /** List-price-equivalent USD. claude-cli reports it directly; anthropic backend computes it from the price table. */
  costUsd: number;
  latencyMs: number;
  /** True when served from cache (no live call made). */
  cached: boolean;
  cacheKey: string;
}

export interface LLMClient {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export class ReplayMissError extends Error {
  constructor(public readonly cacheKey: string, purpose: string) {
    super(`replay cache miss for ${purpose} (${cacheKey}); run the live path (make reproduce) to record it`);
  }
}
