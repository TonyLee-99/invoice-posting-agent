import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "@ipa/domain";
import type { Worker } from "tesseract.js";

export interface ParsedDoc {
  sha256: string;
  method: "text_layer" | "ocr" | "ocr_rendered_pdf";
  pages: number;
  text: string;
  /** Mean OCR word confidence in [0,1]; null for text-layer PDFs. */
  ocrConfidence: number | null;
  ms: number;
}

/** A PDF page with fewer characters than this in its text layer is treated as scanned and OCR'd. */
const MIN_TEXT_CHARS_PER_PAGE = 40;

export class Parser {
  private worker: Worker | null = null;

  constructor(private readonly opts: { cacheDir: string; tessdataDir: string; offline?: boolean }) {}

  /** Parse a document, cache-first by content hash. With `offline`, a cache miss is an error (CI). */
  async parse(file: string, mime: string): Promise<ParsedDoc> {
    const bytes = readFileSync(file);
    const hash = sha256(bytes);
    const cached = path.join(this.opts.cacheDir, `${hash}.json`);
    if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8")) as ParsedDoc;
    if (this.opts.offline) throw new Error(`parse cache miss for ${file} (${hash}); run the live path once`);
    const t0 = Date.now();
    let doc: Omit<ParsedDoc, "ms" | "sha256">;
    if (mime === "application/pdf") {
      const layer = await pdfTextLayer(bytes);
      if (layer.text.replace(/\s/g, "").length >= MIN_TEXT_CHARS_PER_PAGE * layer.pages) {
        doc = { method: "text_layer", pages: layer.pages, text: layer.text, ocrConfidence: null };
      } else {
        doc = await this.ocrPdf(file, layer.pages);
      }
    } else {
      const r = await this.ocr(bytes);
      doc = { method: "ocr", pages: 1, text: r.text, ocrConfidence: r.confidence };
    }
    const out: ParsedDoc = { ...doc, sha256: hash, ms: Date.now() - t0 };
    mkdirSync(this.opts.cacheDir, { recursive: true });
    writeFileSync(`${cached}.tmp`, JSON.stringify(out));
    renameSync(`${cached}.tmp`, cached);
    return out;
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }

  private async ocr(image: Buffer): Promise<{ text: string; confidence: number }> {
    if (!this.worker) {
      const { createWorker } = await import("tesseract.js");
      mkdirSync(this.opts.tessdataDir, { recursive: true });
      // langPath/cachePath keep eng.traineddata on disk after the first download.
      this.worker = await createWorker("eng", 1, { cachePath: this.opts.tessdataDir });
      // PSM 6 = assume a uniform block of text; keeps table rows on one line far better than the default.
      await this.worker.setParameters({ tessedit_pageseg_mode: "6" as never, preserve_interword_spaces: "1" });
    }
    const r = await this.worker.recognize(image);
    return { text: r.data.text, confidence: (r.data.confidence ?? 0) / 100 };
  }

  /** Scanned PDF: render pages with poppler's pdftoppm (if installed) and OCR each page. */
  private async ocrPdf(file: string, pages: number): Promise<Omit<ParsedDoc, "ms" | "sha256">> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ipa-pdf-"));
    try {
      execFileSync("pdftoppm", ["-r", "200", "-png", file, path.join(dir, "p")], { stdio: "ignore" });
    } catch {
      throw new Error("scanned PDF needs pdftoppm (poppler) for OCR");
    }
    const texts: string[] = [];
    const confs: number[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".png")).sort()) {
      const r = await this.ocr(readFileSync(path.join(dir, f)));
      texts.push(r.text);
      confs.push(r.confidence);
    }
    return { method: "ocr_rendered_pdf", pages, text: texts.join("\n\f\n"), ocrConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0 };
  }
}

/** Text layer with lines rebuilt from glyph positions (pdf.js gives positioned runs, not lines). */
export async function pdfTextLayer(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const fonts = path.join(path.dirname(new URL(import.meta.resolve("pdfjs-dist/package.json")).pathname), "standard_fonts") + "/";
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: fonts, verbosity: 0 });
  const doc = await task.promise;
  const pageTexts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const runs = (content.items as { str: string; transform: number[]; width: number }[]).filter((i) => typeof i.str === "string" && i.str.trim() !== "");
    const rows: { y: number; runs: { x: number; w: number; s: string }[] }[] = [];
    for (const r of runs) {
      const x = r.transform[4]!;
      const y = r.transform[5]!;
      const row = rows.find((q) => Math.abs(q.y - y) < 2.5);
      if (row) row.runs.push({ x, w: r.width, s: r.str });
      else rows.push({ y, runs: [{ x, w: r.width, s: r.str }] });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map((row) => {
      row.runs.sort((a, b) => a.x - b.x);
      let line = "";
      let end = 0;
      for (const r of row.runs) {
        // Wide horizontal gaps become runs of spaces so table columns stay visually separated.
        const gap = line ? Math.max(1, Math.round((r.x - end) / 4)) : 0;
        line += " ".repeat(Math.min(gap, 12)) + r.s;
        end = r.x + r.w;
      }
      return line;
    });
    pageTexts.push(lines.join("\n"));
  }
  const pages = doc.numPages;
  await task.destroy();
  return { text: pageTexts.join("\n\f\n"), pages };
}
