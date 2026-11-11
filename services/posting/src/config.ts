import { FileTokenStore, QboClient, INTUIT } from "@ipa/qbo";
import type { TokenStore } from "@ipa/qbo";
import type { Db } from "./db.ts";
import { PgTokenStore } from "./tokens.ts";

/**
 * QBO client from environment. Defaults point at Intuit's sandbox; tests and the demo point it at the emulator.
 * QBO_TOKEN_STORE=file:<path> uses the local 0600 token file written by `make qbo-auth` (live runs); default Postgres.
 */
export function qboFromEnv(db: Db, env = process.env): QboClient {
  const storeSpec = env.QBO_TOKEN_STORE ?? "postgres";
  const store: TokenStore = storeSpec.startsWith("file:") ? new FileTokenStore(storeSpec.slice(5)) : new PgTokenStore(db);
  const api = env.QBO_API_BASE ?? INTUIT.sandboxApi;
  return new QboClient(
    {
      apiBaseUrl: api,
      authorizeUrl: env.QBO_AUTHORIZE_URL ?? INTUIT.authorizeUrl,
      tokenUrl: env.QBO_TOKEN_URL ?? INTUIT.tokenUrl,
      clientId: env.QBO_CLIENT_ID ?? "",
      clientSecret: env.QBO_CLIENT_SECRET ?? "",
      redirectUri: env.QBO_REDIRECT_URI ?? "http://localhost:4000/oauth/callback",
      realmId: env.QBO_REALM_ID ?? "",
      timeoutMs: Number(env.QBO_TIMEOUT_MS ?? 15_000),
    },
    store,
  );
}
