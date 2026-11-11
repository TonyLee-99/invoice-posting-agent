// Money is stored as integer minor units (cents) so ledger comparisons are exact.
// Floats are only used for quantities and unit prices, which are compared with tolerances.

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX"]);

export function minorUnits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** Convert a major-unit number (e.g. 12.34) to integer minor units, rounding half away from zero. */
export function toMinor(amount: number, currency = "USD"): number {
  const factor = 10 ** minorUnits(currency);
  const scaled = amount * factor;
  // Guard against binary float noise such as 1.005 * 100 = 100.49999999999999.
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-7);
  return rounded === 0 ? 0 : rounded;
}

export function fromMinor(minor: number, currency = "USD"): number {
  const factor = 10 ** minorUnits(currency);
  return minor / factor;
}

export function formatMoney(minor: number, currency = "USD"): string {
  const digits = minorUnits(currency);
  const v = fromMinor(minor, currency);
  return `${currency} ${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Parse an amount string printed on an invoice. Handles "1,234.56", "1.234,56", "1 234,56", "$ 889,20",
 * "(12.00)", "-12.00", "12.00-", "12.00 CR". Returns a major-unit number or null.
 */
export function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bCR\b/i.test(s) || /-\s*$/.test(s) || /^\s*-/.test(s) || /^[A-Z$€£R]{0,3}\s*-/.test(s)) negative = true;
  s = s.replace(/\bCR\b/gi, "").replace(/[^\d.,\s']/g, "").trim();
  s = s.replace(/[\s']/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Whichever separator comes last is the decimal separator.
    normalized = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    const commas = (s.match(/,/g) ?? []).length;
    // "889,20" -> decimal comma; "1,234" -> thousands separator; "1,234,567" -> thousands.
    normalized = commas === 1 && decimals !== 3 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0) {
    // A single dot is read as a decimal point ("1.234" is ambiguous; invoices with EU thousands dots
    // almost always also print a decimal comma, handled above). Several dots are thousands separators.
    const dots = (s.match(/\./g) ?? []).length;
    normalized = dots > 1 ? s.replace(/\./g, "") : s;
  } else {
    normalized = s;
  }
  const v = Number(normalized);
  if (!Number.isFinite(v)) return null;
  return negative ? -v : v;
}
