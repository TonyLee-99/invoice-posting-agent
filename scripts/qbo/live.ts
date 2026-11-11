// Shared setup for the live QuickBooks Online sandbox scripts. Nothing here prints a secret or a token.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FileTokenStore, INTUIT, QboClient, keychainSecret } from "@ipa/qbo";

export const ROOT = path.resolve(import.meta.dirname, "../..");
/** QBO_PRIVATE_DIR overrides the location (used only by the offline rehearsal test against the emulator). */
export const PRIVATE = process.env.QBO_PRIVATE_DIR ?? path.join(ROOT, "private");
export const TOKEN_FILE = path.join(PRIVATE, "qbo_tokens.json");
export const REALM_FILE = path.join(PRIVATE, "qbo_realm.json");
/** Must match the redirect URI registered in the Intuit app exactly. */
export const CALLBACK_PORT = 8777;
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

export function credentials(): { clientId: string; clientSecret: string } | null {
  // Env vars exist only for the offline rehearsal against the emulator; live use reads the keychain.
  const clientId = process.env.QBO_REHEARSAL_CLIENT_ID ?? keychainSecret("qbo-client-id");
  const clientSecret = process.env.QBO_REHEARSAL_CLIENT_SECRET ?? keychainSecret("qbo-client-secret");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  console.log("See docs/RUNBOOK.md 'Run against the QuickBooks sandbox' for the one-time setup.");
  process.exit(0);
}

/** A sandbox client using the token file from `make qbo-auth`, or a SKIP with the missing piece named. */
export function liveClient(timeoutMs = 15_000): { qbo: QboClient; realmId: string; tokenFile: string; clientId: string; clientSecret: string } {
  const creds = credentials();
  if (!creds) skip("no Intuit app credentials in the keychain (items 'qbo-client-id' and 'qbo-client-secret').");
  if (!existsSync(TOKEN_FILE) || !existsSync(REALM_FILE)) skip("not connected to a sandbox company yet; run `make qbo-auth` first.");
  const realmId = (JSON.parse(readFileSync(REALM_FILE, "utf8")) as { realmId: string }).realmId;
  const qbo = new QboClient(
    { apiBaseUrl: process.env.QBO_API_BASE ?? INTUIT.sandboxApi, authorizeUrl: INTUIT.authorizeUrl, tokenUrl: process.env.QBO_TOKEN_URL ?? INTUIT.tokenUrl, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: REDIRECT_URI, realmId, timeoutMs },
    new FileTokenStore(TOKEN_FILE),
  );
  return { qbo, realmId, tokenFile: TOKEN_FILE, ...creds };
}

/** Realm ids are not secrets, but results files only keep a short suffix. */
/** Where result files go (the rehearsal writes to a temp dir so it never overwrites live results). */
export const RESULTS = process.env.QBO_RESULTS_DIR ?? path.join(ROOT, "results");

export const redactRealm = (r: string) => `…${r.slice(-4)}`;
