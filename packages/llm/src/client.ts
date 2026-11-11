import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import type { LLMClient, LLMRequest, LLMResponse } from "./types.ts";
import { ReplayMissError } from "./types.ts";
import { FileCache, cacheKey } from "./cache.ts";
import { ClaudeCliClient } from "./claude-cli.ts";
import { AnthropicClient } from "./anthropic.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
export const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, "cache", "replay", "llm");

/** Limits concurrent live calls (rule: at most 4 concurrent `claude -p`). */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export interface CallStats {
  live: number;
  cached: number;
  costUsd: number;
}

/** Cache-first wrapper. With no live backend it is the deterministic replay backend. */
export class CachedClient implements LLMClient {
  readonly name: string;
  readonly stats: CallStats = { live: 0, cached: 0, costUsd: 0 };
  private readonly sem: Semaphore;

  constructor(
    private readonly live: LLMClient | null,
    private readonly cache: FileCache,
    private readonly opts: { concurrency?: number; callLog?: string } = {},
  ) {
    this.name = live ? `cached(${live.name})` : "replay";
    this.sem = new Semaphore(opts.concurrency ?? 4);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const key = cacheKey(req);
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.cached++;
      return { ...hit, cached: true };
    }
    if (!this.live) throw new ReplayMissError(key, req.purpose);
    const live = this.live;
    const resp = await this.sem.run(() => live.complete(req));
    this.cache.put(key, resp, req);
    this.stats.live++;
    this.stats.costUsd += resp.costUsd;
    if (this.opts.callLog) {
      mkdirSync(path.dirname(this.opts.callLog), { recursive: true });
      appendFileSync(this.opts.callLog, JSON.stringify({ ts: new Date().toISOString(), purpose: req.purpose, model: req.model, backend: resp.backend, costUsd: resp.costUsd, latencyMs: resp.latencyMs, usage: resp.usage }) + "\n");
    }
    return resp;
  }
}

export type BackendName = "replay" | "claude-cli" | "anthropic" | "auto";

/**
 * replay: cache only, a miss is an error (CI). claude-cli: subscription subprocess. anthropic: only with a key.
 * auto: anthropic if ANTHROPIC_API_KEY is set, else claude-cli.
 */
export function createClient(backend: BackendName, opts: { cacheDir?: string; callLog?: string; concurrency?: number } = {}): CachedClient {
  const cache = new FileCache(opts.cacheDir ?? DEFAULT_CACHE_DIR);
  let live: LLMClient | null = null;
  if (backend === "anthropic" || (backend === "auto" && process.env.ANTHROPIC_API_KEY)) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("anthropic backend requires ANTHROPIC_API_KEY");
    live = new AnthropicClient();
  } else if (backend === "claude-cli" || backend === "auto") {
    live = new ClaudeCliClient();
  }
  return new CachedClient(live, cache, { concurrency: Math.min(opts.concurrency ?? 4, 4), ...(opts.callLog ? { callLog: opts.callLog } : {}) });
}
