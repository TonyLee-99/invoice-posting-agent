import type { TokenSet, TokenStore } from "@ipa/qbo";
import type { Db } from "./db.ts";

/** Token storage in Postgres. Refreshes are serialized across processes with a session advisory lock. */
export class PgTokenStore implements TokenStore {
  constructor(private readonly db: Db) {}

  async load() {
    const r = await this.db.query("select tokens, version from qbo_tokens where id = 1");
    return r.rows[0] ? { tokens: r.rows[0].tokens as TokenSet, version: r.rows[0].version as number } : null;
  }

  async swap(next: TokenSet, expectedVersion: number): Promise<boolean> {
    if (expectedVersion === 0) {
      const r = await this.db.query("insert into qbo_tokens (id, tokens, version) values (1, $1, 1) on conflict (id) do nothing", [JSON.stringify(next)]);
      return (r.rowCount ?? 0) === 1;
    }
    const r = await this.db.query("update qbo_tokens set tokens = $1, version = version + 1 where id = 1 and version = $2", [JSON.stringify(next), expectedVersion]);
    return (r.rowCount ?? 0) === 1;
  }

  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("select pg_advisory_lock(918273)");
      try {
        return await fn();
      } finally {
        await client.query("select pg_advisory_unlock(918273)");
      }
    } finally {
      client.release();
    }
  }
}
