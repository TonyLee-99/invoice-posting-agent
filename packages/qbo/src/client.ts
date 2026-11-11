import type { Bill, BillCreate, CreateResult, QboFault, TokenSet } from "./types.ts";
import { QboAuthError, QboUnavailableError } from "./types.ts";

/** Endpoints from Intuit's OAuth 2.0 and Accounting API docs (see docs/QBO_SEMANTICS.md for sources). */
export const INTUIT = {
  authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
  tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  sandboxApi: "https://sandbox-quickbooks.api.intuit.com",
  productionApi: "https://quickbooks.api.intuit.com",
  scope: "com.intuit.quickbooks.accounting",
  /** Minor versions 1-74 were retired on 2025-08-01; 75 is the floor and what we pin. */
  minorVersion: 75,
} as const;

export interface QboConfig {
  apiBaseUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  realmId: string;
  minorVersion?: number;
  /** Per-request timeout. The posting lease must be several times longer (DESIGN §5). */
  timeoutMs?: number;
}

/**
 * Persists the token set. Intuit rotates refresh tokens, so after a refresh the new refresh token must be stored
 * before it is used; `swap` is compare-and-set on `version` so two workers refreshing at once cannot both win.
 */
export interface TokenStore {
  load(): Promise<{ tokens: TokenSet; version: number } | null>;
  swap(next: TokenSet, expectedVersion: number): Promise<boolean>;
  /** Serialize refreshes across processes (Postgres advisory lock in the service; a mutex in memory). */
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

export class InMemoryTokenStore implements TokenStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private current: { tokens: TokenSet; version: number } | null = null) {}
  async load() {
    return this.current ? structuredClone(this.current) : null;
  }
  async swap(next: TokenSet, expectedVersion: number) {
    if ((this.current?.version ?? 0) !== expectedVersion) return false;
    this.current = { tokens: next, version: expectedVersion + 1 };
    return true;
  }
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

class HttpTimeout extends Error {}

export class QboClient {
  readonly refreshCount = { n: 0 };

  constructor(private readonly cfg: QboConfig, private readonly tokens: TokenStore) {}

  // ---- OAuth 2.0 authorization-code flow --------------------------------------------------------

  authorizationUrl(state: string): string {
    const u = new URL(this.cfg.authorizeUrl);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", INTUIT.scope);
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  }

  /** Exchange the code from the redirect for tokens and store them. */
  async exchangeCode(code: string, realmId: string): Promise<TokenSet> {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri });
    const t = await this.tokenRequest(body, realmId);
    const cur = await this.tokens.load();
    if (!(await this.tokens.swap(t, cur?.version ?? 0))) throw new Error("token store changed during code exchange");
    return t;
  }

  /**
   * Refresh under the cross-process lock. If another worker already refreshed (version moved), use its tokens
   * instead of spending the (now retired) refresh token again.
   */
  async refresh(staleAccessToken: string): Promise<TokenSet> {
    return this.tokens.withRefreshLock(async () => {
      const cur = await this.tokens.load();
      if (!cur) throw new Error("no tokens stored; run the OAuth authorization flow first");
      if (cur.tokens.accessToken !== staleAccessToken && cur.tokens.accessExpiresAt > Date.now() + 30_000) return cur.tokens;
      const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: cur.tokens.refreshToken });
      const next = await this.tokenRequest(body, cur.tokens.realmId);
      this.refreshCount.n++;
      if (!(await this.tokens.swap(next, cur.version))) throw new Error("token store changed during refresh");
      return next;
    });
  }

  private async tokenRequest(body: URLSearchParams, realmId: string): Promise<TokenSet> {
    const res = await this.fetchWithTimeout(this.cfg.tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; x_refresh_token_expires_in?: number; error?: string };
    if (!res.ok || !json.access_token || !json.refresh_token) throw new Error(`token endpoint ${res.status}: ${json.error ?? "unknown"}`);
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      accessExpiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      refreshExpiresAt: Date.now() + (json.x_refresh_token_expires_in ?? 8_640_000) * 1000,
      realmId,
    };
  }

  // ---- Accounting API ---------------------------------------------------------------------------

  /**
   * Create a Bill. `requestId` must be the same on every retry of the same logical write (Intuit returns the
   * original response for a repeated requestid). Never throws for remote outcomes; classifies them instead.
   */
  async createBill(bill: BillCreate | string, requestId: string): Promise<CreateResult> {
    if (requestId.length > 50) throw new Error("requestid must be <= 50 characters");
    const path = `/v3/company/${this.cfg.realmId}/bill?requestid=${encodeURIComponent(requestId)}&minorversion=${this.minor()}`;
    const body = typeof bill === "string" ? bill : JSON.stringify(bill);
    let res: Response;
    let text: string;
    try {
      ({ res, text } = await this.authed(path, { method: "POST", body, headers: { "content-type": "application/json" } }));
    } catch (e) {
      if (e instanceof AuthFailed) return { kind: "auth_failed", httpStatus: 401, detail: e.message };
      // Timeout or connection error: the request may have been committed.
      return { kind: "unknown", reason: e instanceof HttpTimeout ? "timeout" : `network: ${(e as Error).message}`, httpStatus: null };
    }
    if (res.status === 200) {
      const parsed = JSON.parse(text) as { Bill: Bill };
      return { kind: "created", bill: parsed.Bill, httpStatus: 200 };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after") ?? "1");
      return { kind: "throttled", retryAfterMs: (Number.isFinite(ra) ? ra : 1) * 1000, httpStatus: 429 };
    }
    if (res.status >= 500) return { kind: "unknown", reason: `http ${res.status}`, httpStatus: res.status };
    return { kind: "rejected", httpStatus: res.status, fault: parseFault(text) };
  }

  /** Bills with this exact DocNumber. Throws QboUnavailableError if the answer is not trustworthy. */
  async queryBillsByDocNumber(docNumber: string): Promise<Bill[]> {
    const escaped = docNumber.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return this.query(`select * from Bill where DocNumber = '${escaped}'`);
  }

  async listBills(startPosition: number, maxResults: number): Promise<Bill[]> {
    return this.query(`select * from Bill STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`);
  }

  /** Read one Bill by Id; null if QBO reports it missing/deleted. */
  async getBill(id: string): Promise<Bill | null> {
    let res: Response, text: string;
    try {
      ({ res, text } = await this.authed(`/v3/company/${this.cfg.realmId}/bill/${encodeURIComponent(id)}?minorversion=${this.minor()}`, { method: "GET" }));
    } catch (e) {
      if (e instanceof AuthFailed) throw new QboAuthError(e.message);
      throw new QboUnavailableError(`read failed: ${(e as Error).message}`, null);
    }
    if (res.status === 200) return (JSON.parse(text) as { Bill: Bill }).Bill;
    if (res.status === 400 && text.includes('"610"')) return null;
    throw new QboUnavailableError(`read http ${res.status}`, res.status);
  }

  private async query(q: string): Promise<Bill[]> {
    let res: Response, text: string;
    try {
      ({ res, text } = await this.authed(`/v3/company/${this.cfg.realmId}/query?query=${encodeURIComponent(q)}&minorversion=${this.minor()}`, { method: "GET" }));
    } catch (e) {
      if (e instanceof AuthFailed) throw new QboAuthError(e.message);
      throw new QboUnavailableError(`query failed: ${(e as Error).message}`, null);
    }
    if (res.status !== 200) throw new QboUnavailableError(`query http ${res.status}`, res.status);
    const parsed = JSON.parse(text) as { QueryResponse?: { Bill?: Bill[] } };
    return parsed.QueryResponse?.Bill ?? [];
  }

  private minor(): number {
    return this.cfg.minorVersion ?? INTUIT.minorVersion;
  }

  /** Authenticated request; on 401 refresh once and retry the identical request. */
  private async authed(path: string, init: RequestInit): Promise<{ res: Response; text: string }> {
    const stored = await this.tokens.load();
    if (!stored) throw new AuthFailed("no tokens stored");
    let token = stored.tokens.accessToken;
    if (stored.tokens.accessExpiresAt < Date.now() + 30_000) token = (await this.refresh(token)).accessToken;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.fetchWithTimeout(this.cfg.apiBaseUrl + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`, accept: "application/json" },
      });
      const text = await res.text();
      if (res.status !== 401) return { res, text };
      if (attempt === 1) throw new AuthFailed("401 after refresh");
      try {
        token = (await this.refresh(token)).accessToken;
      } catch (e) {
        throw new AuthFailed(`refresh failed: ${(e as Error).message}`);
      }
    }
    throw new AuthFailed("unreachable");
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ms = this.cfg.timeoutMs ?? 15_000;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new HttpTimeout(`timed out after ${ms} ms`);
      throw e;
    }
  }
}

class AuthFailed extends Error {}

function parseFault(text: string): QboFault | null {
  try {
    return JSON.parse(text) as QboFault;
  } catch {
    return null;
  }
}
