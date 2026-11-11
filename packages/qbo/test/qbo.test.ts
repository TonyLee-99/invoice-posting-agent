import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTokenStore, QboClient, QboEmulator } from "../src/index.ts";
import type { BillCreate } from "../src/index.ts";

const VENDORS = [{ id: "56", name: "Acme Supplies", currency: "USD" }];
const bill = (doc: string, amount = 100): BillCreate => ({
  VendorRef: { value: "56" },
  DocNumber: doc,
  TxnDate: "2026-01-02",
  CurrencyRef: { value: "USD" },
  PrivateNote: "ipa-ref:test",
  Line: [{ Amount: amount, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }],
});

let emulators: QboEmulator[] = [];
afterEach(async () => {
  await Promise.all(emulators.map((e) => e.stop()));
  emulators = [];
});

async function setup(opts: ConstructorParameters<typeof QboEmulator>[0] = {}, timeoutMs = 500) {
  const emu = new QboEmulator({ vendors: VENDORS, ...opts });
  emulators.push(emu);
  const url = await emu.start();
  const t = emu.issueTokens();
  const store = new InMemoryTokenStore({
    tokens: { accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 8e9, realmId: emu.realmId },
    version: 1,
  });
  const client = new QboClient({ apiBaseUrl: url, authorizeUrl: `${url}/connect/oauth2`, tokenUrl: `${url}/oauth2/v1/tokens/bearer`, clientId: emu.clientId, clientSecret: emu.clientSecret, redirectUri: "http://localhost/cb", realmId: emu.realmId, timeoutMs }, store);
  return { emu, url, client, store };
}

describe("OAuth", () => {
  it("authorization-code flow: authorize redirect -> code exchange -> stored tokens", async () => {
    const emu = new QboEmulator({ vendors: VENDORS });
    emulators.push(emu);
    const url = await emu.start();
    const store = new InMemoryTokenStore();
    const client = new QboClient({ apiBaseUrl: url, authorizeUrl: `${url}/connect/oauth2`, tokenUrl: `${url}/oauth2/v1/tokens/bearer`, clientId: emu.clientId, clientSecret: emu.clientSecret, redirectUri: "http://localhost/cb", realmId: emu.realmId }, store);
    const authUrl = client.authorizationUrl("xyz");
    expect(authUrl).toContain("scope=com.intuit.quickbooks.accounting");
    const redirect = await fetch(authUrl, { redirect: "manual" });
    const loc = new URL(redirect.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");
    await client.exchangeCode(loc.searchParams.get("code")!, loc.searchParams.get("realmId")!);
    const r = await client.createBill(bill("A1"), "req-1");
    expect(r.kind).toBe("created");
  });

  it("refreshes on 401, persists the rotated refresh token, and serializes concurrent refreshes", async () => {
    const { emu, client, store } = await setup();
    const before = (await store.load())!.tokens.refreshToken;
    emu.setFaults([{ op: "create", effect: "expire_token", times: 2 }]);
    const results = await Promise.all([client.createBill(bill("R1"), "r1"), client.createBill(bill("R2"), "r2")]);
    expect(results.map((r) => r.kind)).toEqual(["created", "created"]);
    const after = (await store.load())!;
    expect(after.tokens.refreshToken).not.toBe(before);
    expect(client.refreshCount.n).toBe(1);
  });
});

describe("Bill create + requestid", () => {
  it("same requestid returns the original Bill instead of creating a second one", async () => {
    const { emu, client } = await setup();
    const a = await client.createBill(bill("D1"), "same");
    const b = await client.createBill(bill("D1"), "same");
    expect(a.kind === "created" && b.kind === "created" && a.bill.Id === b.bill.Id).toBe(true);
    expect(emu.creations()).toHaveLength(1);
  });

  it("without requestid dedup (different id) a retry duplicates — DocNumber is not an idempotency key", async () => {
    const { emu, client } = await setup();
    await client.createBill(bill("D2"), "x1");
    await client.createBill(bill("D2"), "x2");
    expect(emu.creations()).toHaveLength(2);
    expect(await client.queryBillsByDocNumber("D2")).toHaveLength(2);
  });

  it("timeout after commit is classified unknown, and the same requestid then returns the committed Bill", async () => {
    const { emu, client } = await setup({}, 200);
    emu.setFaults([{ op: "create", effect: "hang_after_commit", times: 1 }]);
    const first = await client.createBill(bill("T1"), "t1");
    expect(first).toMatchObject({ kind: "unknown", reason: "timeout" });
    const again = await client.createBill(bill("T1"), "t1");
    expect(again.kind).toBe("created");
    expect(emu.creations()).toHaveLength(1);
  });

  it("classifies 5xx, reset, 429 and validation faults", async () => {
    const { emu, client } = await setup();
    emu.setFaults([
      { op: "create", effect: "error500_after", nth: 1 },
      { op: "create", effect: "reset_after_commit", nth: 2 },
      { op: "create", effect: "throttle429", nth: 3 },
    ]);
    expect((await client.createBill(bill("E1"), "e1")).kind).toBe("unknown");
    expect((await client.createBill(bill("E2"), "e2")).kind).toBe("unknown");
    expect((await client.createBill(bill("E3"), "e3")).kind).toBe("throttled");
    expect((await client.createBill({ ...bill("E4"), VendorRef: { value: "999" } }, "e4")).kind).toBe("rejected");
    expect((await client.createBill(bill("X".repeat(22)), "e5")).kind).toBe("rejected");
    expect(emu.creations()).toHaveLength(2); // the two after-commit faults did commit
  });

  it("restart loses requestid memory unless persisted; the ledger survives", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "emu-"));
    const snapshotPath = path.join(dir, "state.json");
    const one = await setup({ snapshotPath, port: 0 });
    await one.client.createBill(bill("S1"), "s1");
    await one.emu.stop();
    const emu2 = new QboEmulator({ vendors: VENDORS, snapshotPath });
    emulators.push(emu2);
    expect(emu2.liveBills()).toHaveLength(1);
    expect(emu2.creations()).toHaveLength(1);
  });

  it("query lag hides fresh Bills from DocNumber queries", async () => {
    const { client } = await setup({ queryLagMs: 300 });
    await client.createBill(bill("L1"), "l1");
    expect(await client.queryBillsByDocNumber("L1")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 350));
    expect(await client.queryBillsByDocNumber("L1")).toHaveLength(1);
  });

  it("paginates and reads by id; deleted bills read as null", async () => {
    const { emu, client } = await setup();
    for (let i = 0; i < 5; i++) await client.createBill(bill(`P${i}`), `p${i}`);
    expect(await client.listBills(1, 2)).toHaveLength(2);
    expect(await client.listBills(5, 2)).toHaveLength(1);
    const id = emu.liveBills()[0]!.Id;
    emu.drift("delete", id);
    expect(await client.getBill(id)).toBeNull();
  });
});
