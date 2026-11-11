import { createHash } from "node:crypto";
import type { InvoiceFields } from "./schemas.ts";

/** JSON with object keys sorted recursively, so equal content always serializes to equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of the posting-relevant content. Approvals bind to this value; any edit changes it. */
export function contentHash(fields: InvoiceFields): string {
  return sha256(canonicalJson(fields));
}
