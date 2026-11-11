import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "@ipa/domain";
import type { LLMRequest, LLMResponse } from "./types.ts";

export function cacheKey(req: LLMRequest): string {
  // purpose is metadata, not content: the same prompt for two purposes is the same call.
  return sha256(canonicalJson({ model: req.model, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens ?? null, effort: req.effort ?? null }));
}

export class FileCache {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(key: string): LLMResponse | null {
    const f = this.file(key);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8")) as LLMResponse;
  }

  put(key: string, resp: LLMResponse, req: LLMRequest): void {
    const f = this.file(key);
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    // Store the request hash inputs too, so a cache entry is auditable without the original prompt file.
    writeFileSync(tmp, JSON.stringify({ ...resp, request: { model: req.model, purpose: req.purpose, promptSha256: sha256(req.prompt) } }, null, 1));
    renameSync(tmp, f);
  }
}
