import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Parser, pdfTextLayer } from "../src/index.ts";

/** Smallest valid one-page PDF with two text lines (hand-built so tests need no fixtures from data/). */
function tinyPdf(lines: string[]): Buffer {
  const content = lines.map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${l}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("parse", () => {
  const lines = ["INVOICE Number: INV-1001   Date: 2026-11-01", "Acme Industrial Supply LLC   Total: 1,234.56 USD"];
  it("rebuilds lines from the PDF text layer", async () => {
    const r = await pdfTextLayer(tinyPdf(lines));
    expect(r.pages).toBe(1);
    expect(r.text).toContain("INV-1001");
    expect(r.text.split("\n")).toHaveLength(2);
  });
  it("caches by content hash and refuses to parse on a miss when offline", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "parse-"));
    const file = path.join(dir, "a.pdf");
    writeFileSync(file, tinyPdf(lines));
    const p = new Parser({ cacheDir: path.join(dir, "cache"), tessdataDir: path.join(dir, "tess") });
    const first = await p.parse(file, "application/pdf");
    expect(first.method).toBe("text_layer");
    const offline = new Parser({ cacheDir: path.join(dir, "cache"), tessdataDir: path.join(dir, "tess"), offline: true });
    expect((await offline.parse(file, "application/pdf")).text).toBe(first.text);
    expect((await offline.parse("/nonexistent.pdf", "application/pdf", first.sha256)).sha256).toBe(first.sha256);
    writeFileSync(path.join(dir, "b.pdf"), tinyPdf(["other"]));
    await expect(offline.parse(path.join(dir, "b.pdf"), "application/pdf")).rejects.toThrow(/cache miss/);
  });
});
