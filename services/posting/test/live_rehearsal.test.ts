// Offline rehearsal of the live sandbox scripts: the exact `make qbo-contract` / `make qbo-live-demo` code paths run
// against the emulator (env overrides point them at it), so they are known to work before the first live run.
// Results go to a temp dir; nothing here touches Intuit or the keychain.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { QboEmulator } from "@ipa/qbo";
import { BASE_URL } from "../src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(ROOT, "node_modules/.bin/tsx");
// Async exec: the emulator runs in this process, so a synchronous child call would block its event loop.
const run = promisify(execFile);
let emu: QboEmulator;
let env: NodeJS.ProcessEnv;
let dir: string;

beforeAll(async () => {
  emu = new QboEmulator({ vendors: [{ id: "56", name: "Acme Industrial Supply LLC", currency: "USD" }, { id: "57", name: "Pennine Tyre & Parts Ltd", currency: "USD" }] });
  const url = await emu.start();
  dir = mkdtempSync(path.join(os.tmpdir(), "qbo-rehearsal-"));
  const t = emu.issueTokens();
  writeFileSync(path.join(dir, "qbo_tokens.json"), JSON.stringify({ tokens: { accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 8e9, realmId: emu.realmId }, version: 1 }));
  writeFileSync(path.join(dir, "qbo_realm.json"), JSON.stringify({ realmId: emu.realmId }));
  env = { ...process.env, QBO_API_BASE: url, QBO_TOKEN_URL: `${url}/oauth2/v1/tokens/bearer`, QBO_PRIVATE_DIR: dir, QBO_RESULTS_DIR: dir, QBO_REHEARSAL_CLIENT_ID: emu.clientId, QBO_REHEARSAL_CLIENT_SECRET: emu.clientSecret, QBO_LIVE_TIMEOUT_MS: "500", QBO_LIVE_DB: `ipa_rehearsal_${process.pid}` };
});
afterAll(async () => {
  await emu.stop();
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${env.QBO_LIVE_DB} with (force)`);
  await admin.end();
});

describe("live sandbox scripts, rehearsed against the emulator", () => {
  it("qbo-contract runs every check and cleans up its Bills", async () => {
    await run(tsx, [path.join(ROOT, "scripts/qbo/contract.ts")], { env, timeout: 90_000 });
    const out = JSON.parse(readFileSync(path.join(dir, "qbo_live_contract.json"), "utf8"));
    expect(Object.keys(out.checks).sort()).toEqual(["concurrent_same_requestid", "docnumber_query_freshness", "duplicate_docnumber_new_requestid", "repeat_requestid", "requestid_different_body", "token_refresh_rotation"]);
    expect(out.checks.repeat_requestid.pass).toBe(true);
    expect(out.checks.token_refresh_rotation.pass).toBe(true);
    expect(out.billsDeleted).toBe(out.billsCreated);
  }, 120_000);

  it("qbo-live-demo posts through the pipeline, survives the worker kill, and reconciles", async () => {
    await run(tsx, [path.join(ROOT, "scripts/qbo/live_demo.ts"), "--n", "4"], { env, timeout: 120_000 });
    const out = JSON.parse(readFileSync(path.join(dir, "qbo_live_demo.json"), "utf8"));
    expect(out).toMatchObject({ invoices: 4, postedLocally: 4, duplicateDocNumbers: 0, missingInSandbox: 0, ledgerTotalsMatch: true });
    expect(out.adoptedAfterUncertainty).toBeGreaterThanOrEqual(1); // the killed worker's Bill was adopted, not re-posted
    expect(out.reconciliation.status).toBe("complete");
  }, 150_000);
});
