/**
 * The one way the app shows a token amount: two decimal places, cut down and
 * never rounded up, grouped by thousands. 7.869953 GLOAM reads "7.86", 1,200
 * USDG reads "1,200.00", zero reads "0.00", and anything above zero that cuts
 * to nothing reads "<0.01", never "0.00". Every token, whatever its decimals
 * (USDG has 6, ETH 18, USDT and USDC 18 on BNB Chain), so a shown amount is
 * never more than is held.
 *
 * Only what is shown shortens. What is sent, signed, proved or saved in a note,
 * what Max writes into an amount field, what a field keeps as typed, what is
 * copied, CSV exports and a receipt's checked fields keep every unit (lib/shield
 * formatAssetAmountExact, or the raw units). Dollar values are not token
 * amounts and keep their own format.
 */
import { formatUnits } from "viem";

/** Places every shown token amount keeps, always written out ("5.00"). */
export const SHOWN_PLACES = 2;

/** What an amount above zero that cuts to nothing shows. */
export const SHOWN_DUST = "<0.01";

/**
 * `raw` in a token with `decimals`, cut down to `places` decimals and grouped
 * by thousands. `fixed` pads to `places` ("1,223.10"); otherwise trailing zeros
 * go ("0.0042"). An amount above zero that cuts to nothing reads "<0.01" (or
 * "<0.0001"), never "0".
 */
export function amountDown(raw: bigint, decimals: number, places: number, fixed = false): string {
  return textDown(formatUnits(raw, decimals), places, fixed) ?? "0";
}

/** A plain decimal string ("-12.3456"), cut down as amountDown does; null when it isn't one. */
function textDown(text: string, places: number, fixed: boolean): string | null {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) return null;
  const negative = m[1] === "-";
  const whole = m[2]!.replace(/^0+(?=\d)/, "");
  const frac = m[3] ?? "";
  let f = frac.slice(0, places);
  f = fixed ? f.padEnd(places, "0") : f.replace(/0+$/, "");
  const above = whole !== "0" || /[1-9]/.test(frac);
  if (above && whole === "0" && /^0*$/.test(f)) {
    return places > 0 ? `<0.${"0".repeat(places - 1)}1` : "<1";
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = f ? `${grouped}.${f}` : grouped;
  return negative && above ? `-${out}` : out;
}

/**
 * A token amount on screen: `raw` units of a token with `decimals`, to two
 * places, cut down. "7.86", "1,200.00", "0.00", "<0.01".
 */
export function displayAmount(raw: bigint, decimals: number): string {
  return amountDown(raw, decimals, SHOWN_PLACES, true);
}

/**
 * displayAmount for an amount that arrives as decimal text (a Relay quote's
 * "9.9005400052586123", an API's "1200.5"), however many places it has.
 * Thousands commas in it are read through. Anything that isn't a plain decimal
 * is shown as it came.
 */
export function displayAmountText(text: string): string {
  const t = text.trim().replace(/,(?=\d{3}(?:\D|$))/g, "");
  return textDown(t, SHOWN_PLACES, true) ?? text;
}

/**
 * displayAmount for an amount that is already a number (a float an API gave,
 * a total summed in whole units). Read as the shortest text that is that
 * number, so 0.29 stays 0.29 and never becomes 0.28 through float error.
 * Not a finite number shows "0.00".
 */
export function displayAmountNumber(n: number): string {
  if (!Number.isFinite(n)) return displayAmountText("0");
  const a = Math.abs(n);
  let s = String(a);
  if (/e-/i.test(s)) s = a > 0 ? "0.000000001" : "0";
  else if (/e\+/i.test(s)) s = BigInt(Math.trunc(a)).toString();
  return displayAmountText(n < 0 && a > 0 ? `-${s}` : s);
}
