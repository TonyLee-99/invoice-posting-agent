import { readFileSync } from "node:fs";
import { Parser, fieldConfidence, llmExtract, toFields } from "@ipa/extract";
import type { LLMClient } from "@ipa/llm";
import { extractJson } from "@ipa/llm";
import type { InvoiceFields } from "@ipa/domain";
import { sha256 } from "@ipa/domain";
import type { PostingService } from "./service.ts";

export const DRAFT_SYSTEM = `You help an accounts-payable clerk. You get the invoice header and the deterministic match findings (JSON).
Write (1) "explanation": 2-3 plain-English sentences for the clerk on why the invoice was held and what to check, and
(2) a short, polite vendor email asking for a corrected invoice or confirmation. Use ONLY numbers that appear in the input. Do not decide anything; do not promise payment.
Return ONLY JSON: {"explanation": string, "email_subject": string, "email_body": string}.`;

export interface PipelineDeps {
  svc: PostingService;
  parser: Parser;
  llm: LLMClient;
  model: string;
}

/**
 * Upload -> parse (text layer / OCR) -> LLM extraction (zod-validated, one repair) -> confidence ->
 * deterministic match + route (inside svc.ingest) -> for held invoices, an LLM explanation + vendor email draft.
 * The LLM never decides: a failed extraction still creates an invoice, which routing sends to a person.
 */
export async function processDocument(d: PipelineDeps, file: string, mime: string, name: string): Promise<{ id: number; status: string }> {
  const parsed = await d.parser.parse(file, mime);
  const ex = await llmExtract(d.llm, parsed.text, d.model);
  const empty: InvoiceFields = { vendorName: null, vendorTaxId: null, invoiceNumber: null, poNumber: null, invoiceDate: null, dueDate: null, currency: null, documentType: "invoice", subtotalMinor: null, taxMinor: null, freightMinor: null, totalMinor: null, lines: [] };
  const fields = ex.extraction ? toFields(ex.extraction) : empty;
  const confidence = ex.extraction ? fieldConfidence(ex.extraction, parsed.text, { ocr: parsed.method !== "text_layer" }) : null;
  const res = await d.svc.ingest({
    sourceSha256: sha256(readFileSync(file)), sourceName: name, sourceMime: mime, parsedText: parsed.text, extracted: ex.extraction,
    extractionMeta: { parse: { method: parsed.method, ocrConfidence: parsed.ocrConfidence, pages: parsed.pages }, model: d.model, repaired: ex.repaired, error: ex.error, costUsd: ex.calls.reduce((s, c) => s + c.costUsd, 0), latencyMs: ex.calls.reduce((s, c) => s + c.latencyMs, 0) },
    fields, confidence,
  });
  if (res.status === "NEEDS_REVIEW" || res.status === "REJECTED") await draftExplanation(d, res.id);
  return res;
}

export async function draftExplanation(d: PipelineDeps, invoiceId: number): Promise<void> {
  const inv = await d.svc.get(invoiceId);
  const reasons = inv.match?.route?.reasons ?? inv.match?.discrepancies ?? [];
  if (!reasons.length) return;
  const f = inv.fields;
  const input = { invoice: { vendor: f.vendorName, invoiceNumber: f.invoiceNumber, invoiceDate: f.invoiceDate, currency: f.currency, total: f.totalMinor === null ? null : f.totalMinor / 100, poNumber: inv.match?.poNumber ?? null }, findings: reasons.map((x) => ({ code: x.code, message: x.message, facts: x.facts })) };
  try {
    const resp = await d.llm.complete({ model: d.model, system: DRAFT_SYSTEM, prompt: JSON.stringify(input), purpose: "draft", effort: "low" });
    const out = extractJson(resp.text);
    await d.svc.db.query("update invoices set explanation = $2 where id = $1", [invoiceId, JSON.stringify({ ...(out as object), model: d.model })]);
  } catch (e) {
    // Drafts are advisory; a failure leaves the deterministic reasons visible and is recorded.
    await d.svc.db.query("update invoices set explanation = $2 where id = $1", [invoiceId, JSON.stringify({ error: (e as Error).message })]);
  }
}
