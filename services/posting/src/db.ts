import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../migrations");

// bigint columns (ids, minor-unit amounts) come back as JS numbers; our values stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export const BASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/postgres";

export function connect(url = BASE_URL, max = 10): Db {
  const pool = new pg.Pool({ connectionString: url, max });
  // A crashed (destroyed) client emits errors on the pool; they are expected in fault tests.
  pool.on("error", () => {});
  return pool;
}

export async function migrate(db: Db): Promise<void> {
  await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(path.join(MIGRATIONS, f), "utf8");
    await withTx(db, async (tx) => {
      await tx.query(sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [f]);
    });
  }
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      broken = true;
    }
    throw e;
  } finally {
    client.release(broken);
  }
}

/** Fresh database for one test file / chaos shard. Returns the pool and a drop function. */
export async function createScratchDb(prefix = "ipa_test"): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = BASE_URL.replace(/\/[^/]*$/, `/${name}`);
  const db = connect(url, 20);
  await migrate(db);
  return {
    db,
    url,
    drop: async () => {
      await db.end();
      const a = new pg.Client({ connectionString: BASE_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
