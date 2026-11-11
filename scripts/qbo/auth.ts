// `make qbo-auth`: one-time OAuth 2.0 authorization-code flow against Intuit (sandbox company).
// Starts http://localhost:8765, opens Intuit's consent page, receives ?code=&realmId=&state= on /callback,
// exchanges the code and stores tokens in private/qbo_tokens.json (mode 0600, gitignored). Prints no secrets.
import http from "node:http";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { FileTokenStore, INTUIT, QboClient } from "@ipa/qbo";
import { PRIVATE, REALM_FILE, REDIRECT_URI, TOKEN_FILE, credentials, redactRealm, skip } from "./live.ts";

const creds = credentials();
if (!creds) skip("no Intuit app credentials in the keychain (items 'qbo-client-id' and 'qbo-client-secret').");

const free = await new Promise<boolean>((resolve) => {
  const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
  s.listen(8765, "127.0.0.1");
});
if (!free) {
  console.log("ERROR: port 8765 is in use (the job-tracker server in 07_投递记录 also uses it). Stop that server for a minute, then rerun `make qbo-auth`.");
  process.exit(1);
}

mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
const store = new FileTokenStore(TOKEN_FILE);
const state = randomBytes(16).toString("hex");
let realmId = "";
const client = () => new QboClient({ apiBaseUrl: INTUIT.sandboxApi, authorizeUrl: INTUIT.authorizeUrl, tokenUrl: INTUIT.tokenUrl, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: REDIRECT_URI, realmId }, store);

const done = new Promise<void>((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("state mismatch");
      return reject(new Error("OAuth state mismatch; aborted"));
    }
    const code = url.searchParams.get("code");
    realmId = url.searchParams.get("realmId") ?? "";
    if (!code || !realmId) {
      res.writeHead(400).end(`authorization failed: ${url.searchParams.get("error") ?? "no code"}`);
      return reject(new Error(`authorization failed: ${url.searchParams.get("error") ?? "no code"}`));
    }
    client()
      .exchangeCode(code, realmId)
      .then(() => {
        writeFileSync(REALM_FILE, JSON.stringify({ realmId, connectedAt: new Date().toISOString(), environment: "sandbox" }), { mode: 0o600 });
        res.writeHead(200, { "content-type": "text/plain" }).end("Connected. You can close this tab.");
        server.close();
        resolve();
      })
      .catch((e: Error) => {
        res.writeHead(500).end("token exchange failed");
        reject(e);
      });
  });
  server.listen(8765, "127.0.0.1");
});

const authUrl = client().authorizationUrl(state);
console.log("Opening Intuit's consent page in your browser. If it does not open, paste this URL (it contains no secret):");
console.log(authUrl);
try {
  execFileSync("open", [authUrl]);
} catch {
  /* printed above */
}
await done;
console.log(`Connected to sandbox company ${redactRealm(realmId)}. Tokens stored in private/qbo_tokens.json (0600, gitignored).`);
