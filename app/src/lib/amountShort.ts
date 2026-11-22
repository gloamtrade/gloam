/**
 * Short amounts for reading at a glance: a balance in a picker ("Pay from",
 * "Cash out from"), the amount in a success dialog. Always cut, never rounded
 * up, so a shown balance is never more than is held.
 *
 * Only display shortens. The amount field, Max, the fee and You get lines,
 * receipts and CSV exports keep every unit (lib/shield formatAssetAmountExact,
 * or the raw units).
 */
import { formatUnits, parseUnits } from "viem";

/** Places a stablecoin keeps: cents, always shown ("1,223.10"). */
export const SHORT_STABLE_PLACES = 2;
/** Places anything else keeps, trailing zeros dropped ("0.0042 ETH", "12 BDX"). */
export const SHORT_OTHER_PLACES = 4;

/**
 * `raw` in a token with `decimals`, cut down to `places` decimals and grouped
 * by thousands. `fixed` pads to `places` ("1,223.10"); otherwise trailing zeros
 * go ("0.0042"). An amount above zero that cuts to nothing reads "<0.01" (or
 * "<0.0001"), never "0".
 */
export function amountDown(raw: bigint, decimals: number, places: number, fixed = false): string {
  const negative = raw < 0n;
  const v = negative ? -raw : raw;
  const [whole = "0", frac = ""] = formatUnits(v, decimals).split(".");
  let f = frac.slice(0, places);
  f = fixed ? f.padEnd(places, "0") : f.replace(/0+$/, "");
  if (v > 0n && whole === "0" && /^0*$/.test(f)) {
    return places > 0 ? `<0.${"0".repeat(places - 1)}1` : "<1";
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = f ? `${grouped}.${f}` : grouped;
  return negative ? `-${out}` : out;
}

/** A stablecoin to cents, anything else to 4 places, both cut down. */
export function shortAmount(raw: bigint, decimals: number, stable: boolean): string {
  return stable ? amountDown(raw, decimals, SHORT_STABLE_PLACES, true) : amountDown(raw, decimals, SHORT_OTHER_PLACES);
}

/**
 * A decimal string (an amount Relay quoted, "9.9005400052586123") cut to cents
 * with amountDown. Anything that isn't a plain decimal is shown as it came.
 */
export function stableTextDown(text: string): string {
  const t = text.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return text;
  return amountDown(parseUnits(t, 18), 18, SHORT_STABLE_PLACES, true);
}
