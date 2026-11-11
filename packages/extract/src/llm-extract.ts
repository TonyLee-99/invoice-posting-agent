import type { LLMClient, LLMResponse } from "@ipa/llm";
import { extractJson } from "@ipa/llm";
import { LlmExtraction } from "@ipa/domain";

export const EXTRACTION_PROMPT_VERSION = "extract-v1";

export const EXTRACTION_SYSTEM = `You read supplier invoices for an accounts-payable team. The input is text from a PDF text layer or from OCR, so spacing and column order may be imperfect and OCR may misread characters.
Return ONLY one JSON object, no prose, with exactly these keys:
{
 "vendor_name": F, "vendor_tax_id": F, "invoice_number": F, "po_number": F,
 "invoice_date": F, "due_date": F, "currency": F,
 "subtotal": F, "tax": F, "freight": F, "total": F, "document_type": F,
 "lines": [{"description": string, "quantity": number|null, "unit_price": number|null, "amount": number}],
 "lines_confidence": number,
 "notes": string|null
}
where every F is {"value": <value or null>, "confidence": <0..1>}.
Rules:
- vendor_name: the supplier that issued the document (not the customer / bill-to), name only, no address.
- vendor_tax_id: the supplier's VAT / tax id as printed, else null.
- invoice_number: as printed, without the label. If only an order/PO number is printed, invoice_number is null and the order number goes in po_number.
- Dates as YYYY-MM-DD. Decide day/month order from the country, currency and other dates on the page. due_date only if printed.
- currency: ISO 4217 code of the amount payable (EUR, GBP, USD, ZAR, NAD, ZMW, ...). Use symbols, codes and the supplier's country; null if there is no indication at all.
- Amounts are plain numbers in major units (1234.56), no symbols. subtotal = net amount before tax; tax = total tax; total = amount payable including tax. For credit notes give positive magnitudes and set document_type "credit_note".
- freight: a delivery / shipping / freight charge shown outside the item lines (e.g. a "Shipping" row in the totals block); null otherwise.
- document_type: "invoice", "credit_note", or "other" (statements, quotes, several invoices in one file).
- lines: one entry per billed item row with the net line amount (before tax). Do not include subtotal/tax/total rows. Multi-line descriptions are joined with a space.
- confidence: your probability that the value is exactly right. If a field is not on the document, value null and confidence near 1 if you are sure it is absent.`;

export function extractionPrompt(text: string): string {
  return `<document>\n${text}\n</document>\nReturn the JSON object now.`;
}

export interface LlmExtractResult {
  ok: boolean;
  extraction: LlmExtraction | null;
  error: string | null;
  calls: LLMResponse[];
  repaired: boolean;
}

/** One extraction call plus at most one repair call if the JSON fails schema validation. */
export async function llmExtract(llm: LLMClient, text: string, model: string): Promise<LlmExtractResult> {
  const calls: LLMResponse[] = [];
  const first = await llm.complete({ model, system: EXTRACTION_SYSTEM, prompt: extractionPrompt(text), purpose: "extract", effort: "low" });
  calls.push(first);
  const v1 = validate(first.text);
  if (v1.ok) return { ok: true, extraction: v1.value, error: null, calls, repaired: false };
  const repairPrompt = `${extractionPrompt(text)}\n\nYour previous reply was:\n${first.text.slice(0, 6000)}\n\nIt failed validation: ${v1.error}\nReturn the corrected JSON object only.`;
  const second = await llm.complete({ model, system: EXTRACTION_SYSTEM, prompt: repairPrompt, purpose: "extract_repair", effort: "low" });
  calls.push(second);
  const v2 = validate(second.text);
  if (v2.ok) return { ok: true, extraction: v2.value, error: null, calls, repaired: true };
  return { ok: false, extraction: null, error: v2.error, calls, repaired: true };
}

function validate(text: string): { ok: true; value: LlmExtraction } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
  const r = LlmExtraction.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
