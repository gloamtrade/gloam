/**
 * Cash outs to another chain, remembered for their receipt.
 *
 * A cross-chain cash out pays a one-time Relay address on this chain, and Relay
 * delivers the stablecoin on the destination chain. On chain the vault's log
 * only shows that Relay address, so a receipt would call it "a public wallet".
 * When the cash out is made, the app keeps where it was bridging to and the
 * wallet it lands in, by the note's spend marker, so the receipt can say
 * "Relay, bridging to Base" and name the wallet there.
 *
 * Kept per signed-in account in this browser (lib/accountSlot), never sent
 * anywhere. Holds nothing secret: the marker, the destination and the wallet
 * are all public once the cash out lands.
 */
import { scopedKey } from "./accountSlot";

export const BRIDGE_MARKS_KEY = "gloam.cashout.bridge.v1";
/** The most remembered at once: older ones go first. */
const KEEP = 200;

export type BridgeMark = {
  /** The destination chain's name ("Base") and id. */
  chain: string;
  chainId: number;
  /** What lands there ("USDC"). */
  symbol: string;
  /** The wallet it lands in on that chain. */
  recipient: string;
  /** When the cash out was made, ms. */
  at: number;
};

function readAll(key: string): Record<string, BridgeMark> {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, BridgeMark>) : {};
  } catch {
    return {};
  }
}

/** Remembers that the note with `nullifier` was cashed out to another chain. Signed out, nothing is kept. */
export function rememberBridgeCashOut(nullifier: string, mark: Omit<BridgeMark, "at">, now = Date.now()): void {
  if (typeof window === "undefined") return;
  const key = scopedKey(BRIDGE_MARKS_KEY);
  if (!key) return;
  const all = readAll(key);
  all[nullifier.toLowerCase()] = { ...mark, at: now };
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP);
  try {
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage off: the receipt says "Relay address" without the destination, which is still true */
  }
}

/** Where the cash out that spent `nullifier` was bridging to, if this browser made it. */
export function bridgeMarkFor(nullifier: string): BridgeMark | null {
  if (typeof window === "undefined") return null;
  const key = scopedKey(BRIDGE_MARKS_KEY);
  if (!key) return null;
  const m = readAll(key)[nullifier.toLowerCase()];
  return m && typeof m.chain === "string" && typeof m.recipient === "string" ? m : null;
}
