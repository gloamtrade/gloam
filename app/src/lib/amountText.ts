/**
 * Reads an amount someone typed, without guessing. Every amount field and the
 * payroll CSV go through here, so a typed "1,25" can never quietly become 125
 * and "-1" can never become 1: anything that isn't a plain amount comes back as
 * a short message to show instead.
 *
 * Accepted: digits with at most one dot ("1250", "12.50", ".5"), and commas only
 * as thousands separators in groups of three ("1,250", "12,500.75"). Everything
 * else is refused: a decimal comma ("1,25"), a minus sign, letters or exponents
 * ("1e5"), more than one dot, more decimals than the asset has.
 */

/** A plain decimal string ("1250", "12.5", "" when empty), or why it isn't one. */
export type AmountText = { ok: true; text: string } | { ok: false; error: string };

const GROUPED = /^\d{1,3}(,\d{3})+(\.\d*)?$/;
const PLAIN = /^(\d+\.?\d*|\.\d+)$/;

export function readAmountText(input: string, decimals?: number): AmountText {
  const s = input.trim();
  if (!s || s === ".") return { ok: true, text: "" };
  if (s.includes("-")) return { ok: false, error: "Amounts can't be negative." };
  if (/[^\d.,]/.test(s)) return { ok: false, error: "Use numbers only, like 12.50." };
  let t = s;
  if (t.includes(",")) {
    if (!GROUPED.test(t)) return { ok: false, error: "Use a dot for decimals, like 1.25." };
    t = t.replace(/,/g, "");
  }
  if ((t.match(/\./g) ?? []).length > 1) return { ok: false, error: "Use one dot for decimals, like 12.50." };
  if (!PLAIN.test(t)) return { ok: false, error: "Use numbers only, like 12.50." };
  if (t.endsWith(".")) t = t.slice(0, -1);
  const frac = t.split(".")[1] ?? "";
  if (decimals !== undefined && frac.length > decimals) {
    return {
      ok: false,
      error: decimals === 0 ? "Use a whole number." : `Use at most ${decimals} decimal places.`,
    };
  }
  return { ok: true, text: t };
}

/** The message to show under an amount field, or null when it reads fine. */
export function amountTextError(input: string, decimals?: number): string | null {
  const r = readAmountText(input, decimals);
  return r.ok ? null : r.error;
}

/** "1250.5" → "1,250.5" without losing any decimals. */
export function formatRequestAmount(amount: string): string {
  const [int, frac] = amount.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}
