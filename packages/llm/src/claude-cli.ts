import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LLMClient, LLMRequest, LLMResponse } from "./types.ts";
import { cacheKey } from "./cache.ts";

interface CliResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * Calls `claude -p --output-format json` as a subprocess (subscription auth, no API key).
 * Tools, MCP servers, settings and session persistence are disabled so the call is a plain completion.
 * Runs from an empty temp directory so no project CLAUDE.md leaks into the prompt.
 */
export class ClaudeCliClient implements LLMClient {
  readonly name = "claude-cli";
  private readonly cwd: string;

  constructor(private readonly opts: { timeoutMs?: number; binary?: string } = {}) {
    this.cwd = path.join(os.tmpdir(), "ipa-claude-cli");
    mkdirSync(this.cwd, { recursive: true });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const args = [
      "-p", "--output-format", "json", "--model", req.model, "--tools", "", "--system-prompt", req.system,
      "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
    ];
    if (req.effort) args.push("--effort", req.effort);
    const started = Date.now();
    const stdout = await run(this.opts.binary ?? "claude", args, req.prompt, this.cwd, this.opts.timeoutMs ?? 240_000);
    const parsed = JSON.parse(stdout) as CliResult;
    if (parsed.is_error || typeof parsed.result !== "string") {
      throw new Error(`claude-cli error: ${stdout.slice(0, 400)}`);
    }
    const u = parsed.usage ?? {};
    return {
      text: parsed.result,
      model: req.model,
      backend: this.name,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
      costUsd: parsed.total_cost_usd ?? 0,
      latencyMs: Date.now() - started,
      cached: false,
      cacheKey: cacheKey(req),
    };
  }
}

function run(bin: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude-cli timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude-cli exited ${code}: ${(err || out).slice(0, 500)}`));
    });
    child.stdin.end(stdin);
  });
}
