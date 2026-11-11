const LEGAL_FORMS = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "plc", "pty", "co", "corp", "corporation", "company", "gmbh",
  "kg", "ag", "sa", "sarl", "srl", "bv", "nv", "cc", "lp", "llp", "the", "and",
]);

/** Lower-case, strip punctuation and legal-form words: "Nordhafen Supplies GmbH & Co. KG" -> "nordhafen supplies". */
export function normalizeVendorName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL_FORMS.has(t))
    .join(" ");
}

/** "Invoice # IN-0042 " -> "in0042". */
export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/^\s*(tax\s+)?(invoice|inv|bill|credit\s+note|no|number|nr|#|:|\.|\s)+/i, "")
    .replace(/[\s#:\-_/.]/g, "");
}

/** Token-set similarity in [0,1] used for vendor names and line descriptions. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  const tb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size) * (2 * inter / (ta.size + tb.size)) ** 0.5;
}

export function vendorNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeVendorName(a);
  const nb = normalizeVendorName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  return tokenSimilarity(na, nb) >= 0.85;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a printed date to YYYY-MM-DD. Numeric dates are read day-first unless `monthFirst` (US) is set or the
 * first part cannot be a day-of-month pairing. Returns null if unparseable.
 */
export function parseDate(raw: string | null | undefined, monthFirst = false): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
  if (m) {
    const a = +m[1]!, b = +m[2]!, y = year(+m[3]!);
    let day = monthFirst ? b : a;
    let month = monthFirst ? a : b;
    // If the assumed order is impossible but the other order is valid, swap.
    if (month > 12 && day <= 12) [day, month] = [month, day];
    return iso(y, month, day);
  }
  m = s.match(/(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2]!.slice(0, 3)];
    if (mo !== undefined) return iso(year(+m[3]!), mo, +m[1]!);
  }
  m = s.match(/([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3)];
    if (mo !== undefined) return iso(year(+m[3]!), mo, +m[2]!);
  }
  return null;
}

function year(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y.toString().padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
