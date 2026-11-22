/**
 * What the Cash out amount field holds, and what it cashes out.
 *
 * Cash out opens with the whole balance written into the field as real text,
 * to the last unit, with Max on: the usual cash out still takes no extra
 * click, and what is on screen is exactly what goes. `null` is that state (no
 * amount typed or picked since the balance was chosen), so the text follows
 * the balance picked.
 *
 * An empty field means no amount. It never stands for the whole balance: the
 * field shows a muted "0", the help asks for an amount or Max, and the button
 * stays off. Max writes the whole balance back in.
 */
import { formatUnits, parseUnits } from "viem";
import { readAmountText } from "./amountText";

export const CASH_OUT_EMPTY_HELP = "Enter an amount, or pick Max.";

export type CashOutAmountRead = {
  /** The field's text: what was typed, or the whole balance in full while nothing was. */
  text: string;
  /** Raw units to cash out; null when there is none to cash out (empty, or not an amount up to the balance). */
  amount: bigint | null;
  /** The field is empty: nothing to cash out. */
  empty: boolean;
  /** Something is typed that isn't an amount above zero and up to the balance. */
  invalid: boolean;
  /** The whole balance is going out (Max is on). */
  max: boolean;
  /** Less than the whole balance is going out. */
  partial: boolean;
};

/** Typed text as raw units, refused the way lib/amountText refuses it ("1,25", "-1", too many decimals). */
function parseTyped(text: string, decimals: number): bigint | null {
  const read = readAmountText(text, decimals);
  if (!read.ok || !read.text) return null;
  const [a, b = ""] = read.text.split(".");
  try {
    return parseUnits(b ? `${a || "0"}.${b}` : a, decimals);
  } catch {
    return null;
  }
}

/** The whole balance as the field writes it: every unit, no grouping ("1202.29", "1223.109888000000000001"). */
export function wholeBalanceText(balance: bigint, decimals: number): string {
  return formatUnits(balance, decimals);
}

/**
 * Read the field. `input` null: nothing typed yet, so the whole balance is
 * written in. "" (or spaces): empty, no amount.
 */
export function readCashOutAmount(input: string | null, balance: bigint, decimals: number): CashOutAmountRead {
  const text = input ?? wholeBalanceText(balance, decimals);
  const trimmed = text.trim();
  if (trimmed === "") return { text, amount: null, empty: true, invalid: false, max: false, partial: false };
  const typed = parseTyped(trimmed, decimals);
  if (typed === null || typed <= 0n || typed > balance) {
    return { text, amount: null, empty: false, invalid: true, max: false, partial: false };
  }
  return { text, amount: typed, empty: false, invalid: false, max: typed === balance, partial: typed < balance };
}
