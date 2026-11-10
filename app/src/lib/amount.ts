import { parseEther, parseUnits } from "viem";
import { readAmountText } from "./amountText";

/** Safe decimal → wei; refuses anything lib/amountText refuses (sci notation, "1,25", "-1"). */
export function safeParseEther(raw: string): bigint | null {
  const read = readAmountText(raw, 18);
  if (!read.ok || !read.text) return null;
  try {
    return parseEther(read.text);
  } catch {
    return null;
  }
}

/** Decimal → raw units. More decimals than the token has is refused, never clipped. */
export function safeParseUnits(raw: string, decimals = 18): bigint | null {
  const read = readAmountText(raw, decimals);
  if (!read.ok || !read.text) return null;
  try {
    return parseUnits(read.text, decimals);
  } catch {
    return null;
  }
}
