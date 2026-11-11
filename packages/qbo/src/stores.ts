import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { TokenStore } from "./client.ts";
import type { TokenSet } from "./types.ts";

/**
 * Token store in a local file with mode 0600 (default `private/qbo_tokens.json`, gitignored). Refreshes are serialized
 * across processes with an exclusive lock file, because Intuit rotates refresh tokens. Tokens are never logged.
 */
export class FileTokenStore implements TokenStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  async load(): Promise<{ tokens: TokenSet; version: number } | null> {
    if (!existsSync(this.file)) return null;
    return JSON.parse(readFileSync(this.file, "utf8")) as { tokens: TokenSet; version: number };
  }

  async swap(next: TokenSet, expectedVersion: number): Promise<boolean> {
    const cur = await this.load();
    if ((cur?.version ?? 0) !== expectedVersion) return false;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tokens: next, version: expectedVersion + 1 }), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
    return true;
  }

  withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const lock = `${this.file}.lock`;
      const t0 = Date.now();
      let fd: number | null = null;
      while (fd === null) {
        try {
          fd = openSync(lock, "wx");
        } catch {
          if (Date.now() - t0 > 30_000) throw new Error("token refresh lock held for > 30 s");
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      try {
        return await fn();
      } finally {
        closeSync(fd);
        unlinkSync(lock);
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** Read a secret from the macOS login keychain (`security find-generic-password -s <service> -w`); null if absent. */
export function keychainSecret(service: string): string | null {
  if (process.platform !== "darwin") return process.env[service.toUpperCase().replace(/-/g, "_")] ?? null;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", service, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}
