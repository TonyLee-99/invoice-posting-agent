import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Bill, BillCreate, QboFault } from "./types.ts";

/**
 * Local emulator of the QBO endpoints this service uses: OAuth token endpoint + authorize redirect, Bill create,
 * Bill read, and the query endpoint (Bill by DocNumber / paginated). It implements requestid de-duplication and
 * deliberate fault injection. Known differences from the real service are listed in docs/QBO_SEMANTICS.md.
 *
 * Pessimistic defaults where Intuit does not document behavior: duplicate DocNumbers on Bills are accepted;
 * requestid memory has a finite TTL and (unless persisted) is lost on restart.
 */

export type FaultEffect =
  | "error500_before" // 500 without committing
  | "error503_before"
  | "error500_after" // commit, then 500
  | "reset_after_commit" // commit, then destroy the socket
  | "hang_after_commit" // commit, then never answer (client times out)
  | "hang_before_commit" // never answer and never commit
  | "throttle429"
  | "expire_token" // answer 401 as if the access token expired
  | "latency";

export type FaultOp = "create" | "query" | "read" | "token" | "any";

export interface FaultRule {
  op: FaultOp;
  effect: FaultEffect;
  /** Apply to the nth matching request (1-based) only. */
  nth?: number;
  /** Or apply with this probability (seeded). */
  prob?: number;
  /** Remaining number of times this rule may fire (default unlimited). */
  times?: number;
  latencyMs?: number;
}

export interface EmulatorOptions {
  port?: number;
  realmId?: string;
  clientId?: string;
  clientSecret?: string;
  snapshotPath?: string;
  /** Persist the requestid memory in the snapshot (default false: lost on restart). */
  persistRequestIds?: boolean;
  /** How long a requestid is remembered. Intuit does not publish this; default 10 minutes. */
  requestIdTtlMs?: number;
  /** Bills become visible to queries only this long after creation (read-after-write lag). */
  queryLagMs?: number;
  /** Concurrent requests with the same requestid: "serialize" waits for the first; "race" executes both. */
  concurrentSameRequestId?: "serialize" | "race";
  accessTokenTtlMs?: number;
  seed?: number;
  vendors?: { id: string; name: string; currency: string }[];
}

export interface CreationRecord {
  billId: string;
  requestId: string | null;
  docNumber: string | null;
  vendorId: string;
  totalAmt: number;
  privateNote: string | null;
  at: number;
}

interface State {
  nextId: number;
  bills: Record<string, Bill & { _visibleAt: number; _deleted?: boolean }>;
  creationLog: CreationRecord[];
  requestIds: Record<string, { status: number; body: string; at: number }>;
  refreshTokens: Record<string, { realmId: string; expiresAt: number }>;
  accessTokens: Record<string, { realmId: string; expiresAt: number }>;
  authCodes: Record<string, { realmId: string; redirectUri: string }>;
}

function emptyState(): State {
  return { nextId: 100, bills: {}, creationLog: [], requestIds: {}, refreshTokens: {}, accessTokens: {}, authCodes: {} };
}

/** Small seeded PRNG (mulberry32) so fault schedules are reproducible per chaos seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class QboEmulator {
  readonly realmId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  private state: State;
  private server: http.Server | null = null;
  private rules: FaultRule[] = [];
  private counters: Record<string, number> = {};
  private rand: () => number;
  private inflight = new Map<string, Promise<void>>();
  private readonly hung = new Set<http.ServerResponse>();
  readonly faultLog: { op: FaultOp; effect: FaultEffect; at: number }[] = [];
  readonly vendors: Map<string, { id: string; name: string; currency: string }>;
  url = "";

  constructor(private readonly opts: EmulatorOptions = {}) {
    this.realmId = opts.realmId ?? "9341455000000001";
    this.clientId = opts.clientId ?? "emulator-client";
    this.clientSecret = opts.clientSecret ?? "emulator-secret";
    this.rand = prng(opts.seed ?? 1);
    this.vendors = new Map((opts.vendors ?? []).map((v) => [v.id, v]));
    this.state = emptyState();
    if (opts.snapshotPath && existsSync(opts.snapshotPath)) {
      const loaded = JSON.parse(readFileSync(opts.snapshotPath, "utf8")) as State;
      this.state = loaded;
      if (!opts.persistRequestIds) this.state.requestIds = {};
    }
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        if (!res.headersSent) this.send(res, 500, fault("InternalError", String(e), "-1"));
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.opts.port ?? 0, "127.0.0.1", r));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const res of this.hung) res.destroy();
    this.hung.clear();
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  // ---- test/admin API (in-process) --------------------------------------------------------------

  setFaults(rules: FaultRule[]): void {
    this.rules = rules.map((r) => ({ ...r }));
    this.counters = {};
  }

  addFault(rule: FaultRule): void {
    this.rules.push({ ...rule });
  }

  clearFaults(): void {
    this.rules = [];
  }

  /** Every Bill creation ever committed, including later-deleted ones. Append-only. */
  creations(): CreationRecord[] {
    return [...this.state.creationLog];
  }

  liveBills(): Bill[] {
    return Object.values(this.state.bills).filter((b) => !b._deleted).map(strip);
  }

  forgetRequestIds(): void {
    this.state.requestIds = {};
  }

  /** Drift injection for reconciliation tests: what a person might do in the QBO UI. */
  drift(kind: "delete" | "change_amount", billId: string): void {
    const b = this.state.bills[billId];
    if (!b) throw new Error(`no bill ${billId}`);
    if (kind === "delete") b._deleted = true;
    else {
      const first = b.Line[0]!;
      first.Amount = round2(first.Amount + 10);
      b.TotalAmt = round2(b.Line.reduce((s, l) => s + l.Amount, 0));
      b.SyncToken = String(Number(b.SyncToken) + 1);
    }
    this.persist();
  }

  /** A Bill entered by hand in QBO (no requestid, no integration marker). */
  manualBill(create: BillCreate): Bill {
    return strip(this.commitBill(create, null));
  }

  issueTokens(realmId = this.realmId): { accessToken: string; refreshToken: string } {
    const accessToken = `at_${randomBytes(12).toString("hex")}`;
    const refreshToken = `rt_${randomBytes(12).toString("hex")}`;
    this.state.accessTokens[accessToken] = { realmId, expiresAt: Date.now() + (this.opts.accessTokenTtlMs ?? 3_600_000) };
    this.state.refreshTokens[refreshToken] = { realmId, expiresAt: Date.now() + 100 * 86_400_000 };
    this.persist();
    return { accessToken, refreshToken };
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);
    if (url.pathname === "/connect/oauth2" && req.method === "GET") return this.authorize(url, res);
    if (url.pathname === "/oauth2/v1/tokens/bearer" && req.method === "POST") return this.token(req, body, res);

    const m = url.pathname.match(/^\/v3\/company\/([^/]+)\/(bill|query)(?:\/([^/]+))?$/);
    if (!m) return this.send(res, 404, fault("NotFound", url.pathname, "610"));
    const [, realm, entity, id] = m;
    const auth = this.authenticate(req, realm!);
    const op: FaultOp = entity === "query" ? "query" : req.method === "POST" ? "create" : "read";
    const rule = this.pickFault(op);
    if (rule?.effect === "latency") await sleep(rule.latencyMs ?? 200);
    if (rule?.effect === "expire_token" || !auth) {
      return this.send(res, 401, {
        fault: { error: [{ message: "message=AuthenticationFailed; errorCode=003200; statusCode=401", detail: "Token expired", code: "3200" }], type: "AUTHENTICATION" },
        time: new Date().toISOString(),
      });
    }
    if (rule?.effect === "throttle429") {
      res.setHeader("Retry-After", "1");
      return this.send(res, 429, fault("ThrottleExceeded", "Too many requests", "003001"));
    }
    if (rule?.effect === "error500_before") return this.send(res, 500, fault("InternalServerError", "injected", "-1"));
    if (rule?.effect === "error503_before") return this.send(res, 503, fault("ServiceUnavailable", "injected", "-1"));
    if (rule?.effect === "hang_before_commit") return this.hang(res);

    if (op === "query") return this.query(url, res, rule);
    if (op === "read") return this.read(id!, res);
    return this.create(url, body, res, rule);
  }

  private async create(url: URL, body: string, res: http.ServerResponse, rule: FaultRule | null): Promise<void> {
    const requestId = url.searchParams.get("requestid");
    const minor = Number(url.searchParams.get("minorversion") ?? "75");
    void minor; // versions below 75 are served as 75 (Intuit, Aug 2025); nothing differs for Bill create here.
    if (requestId !== null && requestId.length > 50) {
      return this.send(res, 400, fault("ValidationFault", "requestid exceeds 50 characters", "2050"));
    }
    const key = requestId ? `${this.realmId}:${requestId}` : null;
    if (key && this.opts.concurrentSameRequestId !== "race") {
      // Serialize same-requestid requests so the second sees the first's stored response.
      while (this.inflight.has(key)) await this.inflight.get(key);
    }
    let release: () => void = () => {};
    if (key) this.inflight.set(key, new Promise<void>((r) => (release = r)));
    try {
      if (key) {
        const seen = this.state.requestIds[key];
        const ttl = this.opts.requestIdTtlMs ?? 600_000;
        if (seen && Date.now() - seen.at <= ttl) {
          // Intuit: a repeated requestid gets the original response instead of re-executing.
          res.writeHead(seen.status, { "content-type": "application/json" });
          res.end(seen.body);
          return;
        }
      }
      let parsed: BillCreate;
      try {
        parsed = JSON.parse(body) as BillCreate;
      } catch {
        return this.send(res, 400, fault("ValidationFault", "Request has invalid or unsupported property", "2010"));
      }
      const invalid = this.validate(parsed);
      if (invalid) {
        // Validation faults are also remembered for the requestid, like any other response.
        const payload = JSON.stringify(invalid);
        if (key) this.state.requestIds[key] = { status: 400, body: payload, at: Date.now() };
        res.writeHead(400, { "content-type": "application/json" });
        res.end(payload);
        return;
      }
      const bill = this.commitBill(parsed, requestId);
      const responseBody = JSON.stringify({ Bill: strip(bill), time: new Date().toISOString() });
      // Bill and requestid record are committed together (one synchronous step, one snapshot write).
      if (key) this.state.requestIds[key] = { status: 200, body: responseBody, at: Date.now() };
      this.persist();
      if (rule?.effect === "error500_after") return this.send(res, 500, fault("InternalServerError", "injected after commit", "-1"));
      if (rule?.effect === "reset_after_commit") {
        res.socket?.destroy();
        return;
      }
      if (rule?.effect === "hang_after_commit") return this.hang(res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responseBody);
    } finally {
      if (key) {
        this.inflight.delete(key);
        release();
      }
    }
  }

  private validate(b: BillCreate): QboFault | null {
    if (!b.VendorRef?.value) return fault("ValidationFault", "Required param missing, need to supply the required value for the API: VendorRef", "2020");
    const vendor = this.vendors.size ? this.vendors.get(b.VendorRef.value) : { id: b.VendorRef.value, name: "", currency: b.CurrencyRef?.value ?? "USD" };
    if (!vendor) return fault("ValidationFault", `Invalid Reference Id: Vendor ${b.VendorRef.value}`, "2500");
    if (!Array.isArray(b.Line) || b.Line.length === 0) return fault("ValidationFault", "Required param missing: Line", "2020");
    for (const l of b.Line) {
      if (typeof l.Amount !== "number" || !Number.isFinite(l.Amount)) return fault("ValidationFault", "Invalid Number: Line.Amount", "2040");
      if (l.DetailType !== "AccountBasedExpenseLineDetail" || !l.AccountBasedExpenseLineDetail?.AccountRef?.value) {
        return fault("ValidationFault", "Required param missing: AccountRef", "2020");
      }
    }
    if (b.DocNumber && b.DocNumber.length > 21) return fault("ValidationFault", "String length is either shorter or longer than supported by specification: DocNumber", "2050");
    if (b.CurrencyRef && vendor.currency && b.CurrencyRef.value !== vendor.currency) {
      return fault("ValidationFault", "The currency of the transaction is invalid for this vendor", "6190");
    }
    return null;
  }

  private commitBill(b: BillCreate, requestId: string | null): Bill & { _visibleAt: number } {
    const id = String(this.state.nextId++);
    const now = new Date().toISOString();
    const total = round2(b.Line.reduce((s, l) => s + l.Amount, 0));
    const bill = {
      ...structuredClone(b),
      Line: b.Line.map((l, i) => ({ ...structuredClone(l), Id: String(i + 1), LineNum: i + 1 })),
      Id: id,
      SyncToken: "0",
      TotalAmt: total,
      Balance: total,
      domain: "QBO" as const,
      MetaData: { CreateTime: now, LastUpdatedTime: now },
      _visibleAt: Date.now() + (this.opts.queryLagMs ?? 0),
    };
    this.state.bills[id] = bill;
    this.state.creationLog.push({
      billId: id, requestId, docNumber: b.DocNumber ?? null, vendorId: b.VendorRef.value, totalAmt: total,
      privateNote: b.PrivateNote ?? null, at: Date.now(),
    });
    this.persist();
    return bill;
  }

  private query(url: URL, res: http.ServerResponse, _rule: FaultRule | null): void {
    const q = (url.searchParams.get("query") ?? "").trim();
    const now = Date.now();
    const visible = Object.values(this.state.bills).filter((b) => !b._deleted && b._visibleAt <= now);
    let m = q.match(/^select \* from Bill where DocNumber = '((?:[^'\\]|\\.)*)'$/i);
    if (m) {
      const doc = m[1]!.replace(/\\(.)/g, "$1");
      const hits = visible.filter((b) => b.DocNumber === doc).map(strip);
      return this.send(res, 200, { QueryResponse: hits.length ? { Bill: hits, startPosition: 1, maxResults: hits.length } : {}, time: new Date().toISOString() });
    }
    m = q.match(/^select \* from Bill(?: where Id = '(\d+)')?(?: STARTPOSITION (\d+))?(?: MAXRESULTS (\d+))?$/i);
    if (m) {
      let rows = visible.sort((a, b) => Number(a.Id) - Number(b.Id));
      if (m[1]) rows = rows.filter((b) => b.Id === m![1]);
      const start = Number(m[2] ?? "1");
      const max = Math.min(Number(m[3] ?? "100"), 1000);
      const page = rows.slice(start - 1, start - 1 + max).map(strip);
      return this.send(res, 200, { QueryResponse: page.length ? { Bill: page, startPosition: start, maxResults: page.length } : {}, time: new Date().toISOString() });
    }
    if (/^select count\(\*\) from Bill$/i.test(q)) {
      return this.send(res, 200, { QueryResponse: { totalCount: visible.length }, time: new Date().toISOString() });
    }
    return this.send(res, 400, fault("QueryValidationError", `unsupported query in emulator: ${q}`, "4000"));
  }

  private read(id: string, res: http.ServerResponse): void {
    const b = this.state.bills[id];
    if (!b || b._deleted) return this.send(res, 400, fault("ValidationFault", "Object Not Found: Something you're trying to use has been made inactive or deleted.", "610"));
    return this.send(res, 200, { Bill: strip(b), time: new Date().toISOString() });
  }

  private authorize(url: URL, res: http.ServerResponse): void {
    // Real Intuit shows a consent screen; the emulator consents immediately and redirects with a code.
    const redirect = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state") ?? "";
    if (url.searchParams.get("client_id") !== this.clientId || !redirect || url.searchParams.get("response_type") !== "code") {
      return this.send(res, 400, { error: "invalid_request" });
    }
    const code = `code_${randomBytes(8).toString("hex")}`;
    this.state.authCodes[code] = { realmId: this.realmId, redirectUri: redirect };
    res.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(state)}&realmId=${this.realmId}` });
    res.end();
  }

  private token(req: http.IncomingMessage, body: string, res: http.ServerResponse): void {
    const rule = this.pickFault("token");
    if (rule?.effect === "error500_before") return this.send(res, 500, { error: "server_error" });
    const basic = (req.headers.authorization ?? "").replace(/^Basic /, "");
    const [cid, secret] = Buffer.from(basic, "base64").toString().split(":");
    if (cid !== this.clientId || secret !== this.clientSecret) return this.send(res, 401, { error: "invalid_client" });
    const form = new URLSearchParams(body);
    let realmId: string;
    if (form.get("grant_type") === "authorization_code") {
      const code = this.state.authCodes[form.get("code") ?? ""];
      if (!code || code.redirectUri !== form.get("redirect_uri")) return this.send(res, 400, { error: "invalid_grant" });
      delete this.state.authCodes[form.get("code")!];
      realmId = code.realmId;
    } else if (form.get("grant_type") === "refresh_token") {
      const rt = this.state.refreshTokens[form.get("refresh_token") ?? ""];
      if (!rt || rt.expiresAt < Date.now()) return this.send(res, 400, { error: "invalid_grant" });
      // Rotation: the used refresh token is retired; clients must persist the new one.
      delete this.state.refreshTokens[form.get("refresh_token")!];
      realmId = rt.realmId;
    } else {
      return this.send(res, 400, { error: "unsupported_grant_type" });
    }
    const t = this.issueTokens(realmId);
    return this.send(res, 200, {
      token_type: "bearer",
      access_token: t.accessToken,
      refresh_token: t.refreshToken,
      expires_in: Math.round((this.opts.accessTokenTtlMs ?? 3_600_000) / 1000),
      x_refresh_token_expires_in: 8_640_000,
    });
  }

  private authenticate(req: http.IncomingMessage, realm: string): boolean {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const t = this.state.accessTokens[token];
    return Boolean(t && t.realmId === realm && t.expiresAt > Date.now());
  }

  private pickFault(op: FaultOp): FaultRule | null {
    const n = (this.counters[op] = (this.counters[op] ?? 0) + 1);
    for (const r of this.rules) {
      if (r.op !== op && r.op !== "any") continue;
      if (r.times !== undefined && r.times <= 0) continue;
      const hit = r.nth !== undefined ? r.nth === n : r.prob !== undefined ? this.rand() < r.prob : true;
      if (!hit) continue;
      if (r.times !== undefined) r.times--;
      this.faultLog.push({ op, effect: r.effect, at: Date.now() });
      return r;
    }
    return null;
  }

  private hang(res: http.ServerResponse): void {
    this.hung.add(res);
    res.on("close", () => this.hung.delete(res));
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private persist(): void {
    if (!this.opts.snapshotPath) return;
    const tmp = `${this.opts.snapshotPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.opts.snapshotPath);
  }
}

function strip(b: Bill & { _visibleAt?: number; _deleted?: boolean }): Bill {
  const { _visibleAt, _deleted, ...rest } = b;
  void _visibleAt;
  void _deleted;
  return structuredClone(rest);
}

function fault(type: string, message: string, code: string): QboFault {
  return { Fault: { Error: [{ Message: message, Detail: message, code }], type }, time: new Date().toISOString() };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d: Buffer) => (s += d.toString()));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
