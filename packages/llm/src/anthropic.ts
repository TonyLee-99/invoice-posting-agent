import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMRequest, LLMResponse } from "./types.ts";
import { cacheKey } from "./cache.ts";
import { listPriceUsd } from "./pricing.ts";

/** Direct Messages API backend. Only constructed when ANTHROPIC_API_KEY is set (see createClient). */
export class AnthropicClient implements LLMClient {
  readonly name = "anthropic";
  private readonly client = new Anthropic();

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    });
    if (response.stop_reason === "refusal") throw new Error("model refused the request");
    let text = "";
    for (const block of response.content) if (block.type === "text") text += block.text;
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    return {
      text, model: req.model, backend: this.name, usage, costUsd: listPriceUsd(req.model, usage),
      latencyMs: Date.now() - started, cached: false, cacheKey: cacheKey(req),
    };
  }
}
