/**
 * A Solana amount in base units as shown: two places, cut down, like every
 * amount in the app (lib/amountShort displayAmount). ZEC is worth hundreds of
 * dollars a coin, so two places would read a few dollars of it as "<0.01": it
 * keeps up to four ("0.0075").
 */
import { parseUnits } from "viem";
import { amountDown, displayAmount, displayAmountText } from "@/lib/amountShort";
import { ZEC_DECIMALS, ZEC_PLACES } from "./config";

export function ringsAmount(v: bigint, decimals: number): string {
  return decimals === ZEC_DECIMALS ? amountDown(v, decimals, ZEC_PLACES) : displayAmount(v, decimals);
}

/** ringsAmount for an amount that arrives as decimal text (a quote's "0.09974272"); anything else as displayAmountText shows it. */
export function ringsAmountText(text: string, decimals: number): string {
  try {
    return ringsAmount(parseUnits(text.trim(), decimals), decimals);
  } catch {
    return displayAmountText(text);
  }
}
