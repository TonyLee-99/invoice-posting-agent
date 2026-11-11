// Subset of the QuickBooks Online Accounting API v3 Bill entity used by this service.
// Field names follow Intuit's JSON (PascalCase) so payloads can be sent to the real API unchanged.

export interface Ref {
  value: string;
  name?: string;
}

export interface BillLine {
  Id?: string;
  LineNum?: number;
  Description?: string;
  Amount: number;
  DetailType: "AccountBasedExpenseLineDetail";
  AccountBasedExpenseLineDetail: { AccountRef: Ref };
}

/** What we POST. TotalAmt is computed by QBO from the lines, so we do not send it. */
export interface BillCreate {
  VendorRef: Ref;
  Line: BillLine[];
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  CurrencyRef?: Ref;
  PrivateNote?: string;
}

export interface Bill extends BillCreate {
  Id: string;
  SyncToken: string;
  TotalAmt: number;
  Balance: number;
  domain: "QBO";
  MetaData: { CreateTime: string; LastUpdatedTime: string };
}

export interface QboFaultError {
  Message: string;
  Detail?: string;
  code: string;
  element?: string;
}

export interface QboFault {
  Fault: { Error: QboFaultError[]; type: string };
  time: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  accessExpiresAt: number;
  refreshExpiresAt: number;
  realmId: string;
}

/** Result of a create call, classified for the posting protocol. */
export type CreateResult =
  | { kind: "created"; bill: Bill; httpStatus: number }
  /** The write may or may not have happened: timeout, connection reset, 5xx. */
  | { kind: "unknown"; reason: string; httpStatus: number | null }
  | { kind: "throttled"; retryAfterMs: number; httpStatus: 429 }
  /** Permanent: validation or business-rule fault. Not retried. */
  | { kind: "rejected"; httpStatus: number; fault: QboFault | null }
  /** Auth could not be recovered by one refresh. Systemic, not per-invoice. */
  | { kind: "auth_failed"; httpStatus: number; detail: string };

export class QboUnavailableError extends Error {
  constructor(message: string, public readonly httpStatus: number | null) {
    super(message);
  }
}

/** Authentication could not be recovered by one refresh. Systemic: callers pause instead of failing invoices. */
export class QboAuthError extends QboUnavailableError {
  constructor(message: string) {
    super(message, 401);
  }
}
