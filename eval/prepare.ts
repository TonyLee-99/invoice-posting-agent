// Build the evaluation manifest from the two public datasets in data/raw (downloaded by `make data`).
//   IPP  = Invoice Extraction Benchmark v1 (InvoiceParser Pro), CC BY 4.0, 181 documents.
//   KAT  = Katana ML "Sparrow" invoices (HF katanaml-org/invoices-donut-data-v1, MIT on the card), derived from
//          Kozlowski & Weichbroth (2021) "Samples of electronic invoices", Mendeley Data. We use 120 of 501.
// Labels are the publishers'; nothing here is relabelled by hand. Splits are fixed by a hash of the group id
// (IPP variants of one base document share a group), so dev/test never share a template variant.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { parseAmount, parseDate } from "@ipa/domain";

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW = path.join(ROOT, "data/raw");
const DOCS = path.join(ROOT, "data/docs");

export interface GtLine {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  alt_amounts?: number[];
}

export interface Gt {
  vendor_name: string | null;
  vendor_tax_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  document_type: "invoice" | "credit_note" | "other";
  lines: GtLine[];
}

export interface ManifestDoc {
  docId: string;
  source: "ipp" | "katana";
  file: string; // relative to repo root
  mime: string;
  category: string;
  group: string;
  split: "dev" | "test";
  scored: string[];
  /** Vendor label semantics differ: IPP gives the name; Katana gives "name + address" (scored by prefix). */
  vendorRule: "name" | "prefix";
  gt: Gt;
}

const splitOf = (group: string): "dev" | "test" => (createHash("sha256").update(`split-v1:${group}`).digest()[0]! % 4 === 0 ? "dev" : "test");

async function ipp(): Promise<ManifestDoc[]> {
  const base = path.join(RAW, "ipp/corpus/v1");
  const rows = readFileSync(path.join(base, "metadata.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return rows.map((r) => {
    const e = r.expected;
    const ext = path.extname(r.file_name).slice(1).toLowerCase();
    const group = r.base_id ?? r.doc_id;
    const scored: string[] = e.scored.map((s: string) => (s === "line_items" ? "lines" : s)).filter((s: string) => s !== "flag");
    return {
      docId: `ipp/${r.doc_id}`,
      source: "ipp",
      file: path.relative(ROOT, path.join(base, r.file_name)),
      mime: ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg",
      category: r.category,
      group: `ipp/${group}`,
      split: splitOf(`ipp/${group}`),
      scored,
      vendorRule: "name",
      gt: {
        vendor_name: e.vendor_name ?? null,
        vendor_tax_id: null,
        invoice_number: e.invoice_number ?? null,
        invoice_date: e.invoice_date ? String(e.invoice_date).slice(0, 10) : null,
        due_date: e.due_date ? String(e.due_date).slice(0, 10) : null,
        currency: e.currency ?? null,
        subtotal: e.subtotal ?? null,
        tax: e.tax ?? null,
        total: e.total ?? null,
        document_type: e.document_type,
        lines: (e.lines ?? []).map((l: { description: string; amount: number; alt_amounts?: number[] }) => ({ description: l.description, quantity: null, unit_price: null, amount: l.amount, alt_amounts: l.alt_amounts ?? [] })),
      },
    } satisfies ManifestDoc;
  });
}

const excluded: string[] = [];

async function katana(): Promise<ManifestDoc[]> {
  mkdirSync(path.join(DOCS, "katana"), { recursive: true });
  const take: [string, number][] = [["test", 26], ["validation", 50], ["train", 44]];
  const out: ManifestDoc[] = [];
  for (const [split, n] of take) {
    const file = await asyncBufferFromFile(path.join(RAW, `katana/${split}.parquet`));
    const rows = (await parquetReadObjects({ file, rowStart: 0, rowEnd: n, utf8: false } as Parameters<typeof parquetReadObjects>[0])) as { image: { bytes: Uint8Array; path: string }; ground_truth: string }[];
    rows.forEach((row, i) => {
      const id = `${split}-${String(i).padStart(3, "0")}`;
      const g0 = JSON.parse(row.ground_truth).gt_parse;
      // A few labels have no header/summary at all; they cannot be scored, so they are excluded (counted below).
      if (!g0?.summary?.total_gross_worth && !(Array.isArray(g0?.items) && g0.items.length)) {
        excluded.push(`katana/${id}`);
        return;
      }
      const rel = `data/docs/katana/${id}.jpg`;
      if (!existsSync(path.join(ROOT, rel))) writeFileSync(path.join(ROOT, rel), Buffer.from(row.image.bytes));
      const g = JSON.parse(row.ground_truth).gt_parse;
      const h = g.header ?? {};
      const s = g.summary ?? {};
      const items: Record<string, string>[] = Array.isArray(g.items) ? g.items : g.items ? [g.items] : [];
      out.push({
        docId: `katana/${id}`,
        source: "katana",
        file: rel,
        mime: "image/jpeg",
        category: "katana",
        group: `katana/${id}`,
        split: splitOf(`katana/${id}`),
        scored: ["vendor_name", "vendor_tax_id", "invoice_number", "invoice_date", "subtotal", "tax", "total", "lines"],
        vendorRule: "prefix",
        gt: {
          vendor_name: h.seller ?? null,
          vendor_tax_id: h.seller_tax_id ?? null,
          invoice_number: h.invoice_no ?? null,
          invoice_date: parseDate(h.invoice_date, true),
          due_date: null,
          currency: null,
          subtotal: parseAmount(s.total_net_worth),
          tax: parseAmount(s.total_vat),
          total: parseAmount(s.total_gross_worth),
          document_type: "invoice",
          lines: items.map((it) => ({ description: it.item_desc ?? "", quantity: parseAmount(it.item_qty), unit_price: parseAmount(it.item_net_price), amount: parseAmount(it.item_net_worth) ?? 0 })),
        },
      });
    });
  }
  return out;
}

const docs = [...(await ipp()), ...(await katana())];
mkdirSync(path.join(ROOT, "eval/data"), { recursive: true });
writeFileSync(path.join(ROOT, "eval/data/manifest.json"), JSON.stringify({ version: 1, generatedBy: "tsx eval/prepare.ts", docs }, null, 1) + "\n");
const count = (f: (d: ManifestDoc) => boolean) => docs.filter(f).length;
const summary = {
  total: docs.length,
  excludedUnlabelled: excluded,
  bySource: { ipp: count((d) => d.source === "ipp"), katana: count((d) => d.source === "katana") },
  bySplit: { dev: count((d) => d.split === "dev"), test: count((d) => d.split === "test") },
  byMime: { pdf: count((d) => d.mime === "application/pdf"), image: count((d) => d.mime !== "application/pdf") },
  licenses: {
    ipp: "CC BY 4.0 (data), MIT (code) - https://github.com/DrewKraken/invoice-extraction-benchmark; dataset card states synthetic documents made by InvoiceParser Pro",
    katana: "MIT per HF card katanaml-org/invoices-donut-data-v1; source: Kozlowski & Weichbroth (2021), Samples of electronic invoices, Mendeley Data V2, doi:10.17632/tnj49gpmtz.2",
  },
};
mkdirSync(path.join(ROOT, "results"), { recursive: true });
writeFileSync(path.join(ROOT, "results/dataset.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
