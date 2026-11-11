import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CachedClient, FileCache, ReplayMissError, extractJson } from "../src/index.ts";
import type { LLMClient, LLMRequest, LLMResponse } from "../src/index.ts";

class FakeLive implements LLMClient {
  readonly name = "fake";
  calls = 0;
  concurrent = 0;
  maxConcurrent = 0;
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await new Promise((r) => setTimeout(r, 5));
    this.concurrent--;
    return { text: `echo:${req.prompt}`, model: req.model, backend: this.name, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, latencyMs: 5, cached: false, cacheKey: "" };
  }
}

const req = (prompt: string): LLMRequest => ({ model: "m", system: "s", prompt, purpose: "test" });

describe("CachedClient", () => {
  it("serves repeated calls from cache and replays offline", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "llm-"));
    const live = new FakeLive();
    const c = new CachedClient(live, new FileCache(dir));
    expect((await c.complete(req("a"))).cached).toBe(false);
    expect((await c.complete(req("a"))).cached).toBe(true);
    expect(live.calls).toBe(1);
    const replay = new CachedClient(null, new FileCache(dir));
    expect((await replay.complete(req("a"))).text).toBe("echo:a");
    await expect(replay.complete(req("b"))).rejects.toBeInstanceOf(ReplayMissError);
  });

  it("never runs more than 4 live calls at once", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "llm-"));
    const live = new FakeLive();
    const c = new CachedClient(live, new FileCache(dir), { concurrency: 4 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.complete(req(String(i)))));
    expect(live.maxConcurrent).toBeLessThanOrEqual(4);
    expect(c.stats.live).toBe(20);
  });
});

describe("extractJson", () => {
  it("handles fences and prose", () => {
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("nothing")).toThrow();
  });
});
