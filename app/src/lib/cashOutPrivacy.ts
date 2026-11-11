/**
 * The cash-out privacy kit, the part that only reads and counts.
 *
 * A cash out is a public transfer: the amount, the address it goes to and the
 * time are on chain. What stays private is which deposit the money came from,
 * and the rest of the private balance and payments. These checks help a
 * person keep that last part true, and never block anything:
 *
 *  - presetAmounts: common round amounts for the asset (25, 50, 100… for a
 *    stablecoin, 0.01, 0.05… for ETH), up to what can be cashed out. Round
 *    amounts are common, so they are harder to match to one deposit.
 *  - cashOutPrivacyWarnings: the address is the wallet signed in right now, or
 *    one this browser added money from; or the amount is exactly a deposit
 *    made in the last 7 days.
 *
 * Only this browser's own notes are read (lib/shield LocalNote), and only the
 * ones on the cash out's own chain and vault: the same vault address runs on
 * several chains, and the same asset address can too. Nothing leaves the
 * browser.
 */
import { parseUnits, zeroAddress } from "viem";
import { moneyInKind, whenLabel } from "./cashOutPlan";
import type { LocalNote } from "./shield";
import { knownTokens, nativeTokenFor } from "./tokens";

const DAY = 24 * 60 * 60 * 1000;

/** How far back a deposit's exact amount counts as easy to match. */
export const SAME_AMOUNT_LOOKBACK_MS = 7 * DAY;

/** Round amounts offered for a stablecoin (dollar or euro), in whole units. */
export const STABLE_PRESETS = ["25", "50", "100", "250", "500", "1000"] as const;
/** Round amounts offered for ETH and WETH. */
export const ETH_PRESETS = ["0.01", "0.05", "0.1", "0.5"] as const;
/** Round amounts offered for HYPE, Elysium's native coin (one deposit is up to 12). */
export const HYPE_PRESETS = ["1", "2", "5", "10"] as const;

/** What the checks read of a note. */
export type PrivacyNote = Pick<LocalNote, "id" | "chainId" | "pool" | "asset" | "amountWei" | "createdAt" | "from" | "source">;

/** A cash out's chain and vault. */
export type CashOutScope = { chainId: number; pool: string | null | undefined };

/** A 0x address in lower case, or null when it is not one. */
export function normAddress(a: string | null | undefined): string | null {
  const v = (a ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(v) ? v : null;
}

/** Whether a note is on this chain and vault (both must match; the vault address is compared in any case). */
export function sameScope(n: Pick<PrivacyNote, "chainId" | "pool">, scope: CashOutScope): boolean {
  const pool = normAddress(scope.pool);
  return n.chainId === scope.chainId && pool != null && normAddress(n.pool) === pool;
}

// ---------------------------------------------------------------- amounts

export type PresetAmount = {
  /** "1,000", "0.05". */
  label: string;
  /** What the input field gets: "1000", "0.05". */
  value: string;
  /** In the asset's base units. */
  wei: bigint;
};

/** Which round amounts suit an asset on a chain, from the app's token list. */
export function presetsFor(chainId: number, asset: string): { values: readonly string[]; decimals: number } {
  const a = asset.toLowerCase();
  if (a === zeroAddress) return { values: nativeTokenFor(chainId).id === "hype" ? HYPE_PRESETS : ETH_PRESETS, decimals: 18 };
  const t = knownTokens(chainId).find((x) => x.address.toLowerCase() === a);
  if (!t) return { values: [], decimals: 18 };
  if (t.kind === "stablecoin") return { values: STABLE_PRESETS, decimals: t.decimals };
  if (t.id === "weth") return { values: ETH_PRESETS, decimals: t.decimals };
  return { values: [], decimals: t.decimals };
}

/**
 * The round amounts to offer for cashing out `asset`, smallest first: only
 * those at or below `spendable` (base units). None for an asset with no
 * common round sizes ($GLOAM, a stock token); Max is always the caller's.
 */
export function presetAmounts(p: { chainId: number; asset: string; spendable: bigint }): PresetAmount[] {
  const { values, decimals } = presetsFor(p.chainId, p.asset);
  const out: PresetAmount[] = [];
  for (const value of values) {
    const wei = parseUnits(value, decimals);
    if (wei <= 0n || wei > p.spendable) continue;
    out.push({ value, wei, label: Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 }) });
  }
  return out;
}

// ---------------------------------------------------------------- what this browser added

/** A deposit this browser made: a deposit note (lib/cashOutPlan moneyInKind), or a deposit read from the chain. */
export function isDepositNote(n: Pick<PrivacyNote, "id" | "source">): boolean {
  return n.source === "chain" || moneyInKind(n) === "deposit";
}

/** Every wallet this browser added money from on this chain and vault, in lower case. Spent deposits count: a deposit is public. */
export function depositWallets(notes: readonly PrivacyNote[], scope: CashOutScope): Set<string> {
  const out = new Set<string>();
  for (const n of notes) {
    if (!n || !sameScope(n, scope) || !isDepositNote(n)) continue;
    const from = normAddress(n.from);
    if (from) out.add(from);
  }
  return out;
}

/**
 * The newest deposit of exactly `amountWei` of `asset` on this chain and vault
 * in the last 7 days, or null. Only deposits made here count: a row read from
 * the chain has no real date.
 */
export function sameAmountDeposit(
  notes: readonly PrivacyNote[],
  p: CashOutScope & { asset: string; amountWei: bigint; now?: number }
): PrivacyNote | null {
  if (p.amountWei <= 0n) return null;
  const now = p.now ?? Date.now();
  const asset = p.asset.toLowerCase();
  let best: PrivacyNote | null = null;
  for (const n of notes) {
    if (!n || n.source === "chain" || moneyInKind(n) !== "deposit" || !sameScope(n, p)) continue;
    if ((n.asset ?? "").toLowerCase() !== asset) continue;
    if (!Number.isFinite(n.createdAt) || n.createdAt > now || now - n.createdAt > SAME_AMOUNT_LOOKBACK_MS) continue;
    let v: bigint;
    try {
      v = BigInt(n.amountWei || "0");
    } catch {
      continue;
    }
    if (v !== p.amountWei) continue;
    if (!best || n.createdAt > best.createdAt) best = n;
  }
  return best;
}

// ---------------------------------------------------------------- warnings

export type CashOutWarningKind = "own-wallet" | "deposit-wallet" | "same-amount";

export type CashOutWarning = {
  kind: CashOutWarningKind;
  /** One plain line. */
  text: string;
  /** Names what it is about (the kind and the address or amount), so dismissing one leaves a new one showing. */
  key: string;
  /** About the address: offer "Cash out somewhere else". */
  aboutAddress: boolean;
};

export const OWN_WALLET_TEXT = "This is the wallet you're signed in with. Anyone can link this cash out to it.";
export const DEPOSIT_WALLET_TEXT = "You added money to Gloam from this address. Anyone can link this cash out to it.";

/**
 * Who sends what, for the line on what goes public:
 *  - "relay": the Gloam relay sends every step.
 *  - "wallet": the signed-in wallet sends the cash out (and any step before it).
 *  - "wallet-first-step": a part of the balance cashed out later with Hide my
 *    wallet off: the wallet sends the first step (setting the amount aside)
 *    right away, and the relay sends the cash out later.
 */
export type CashOutSender = "relay" | "wallet" | "wallet-first-step";

/** The sender, from the cash-out form's choices. Pieces always go through the relay. */
export function cashOutSender(p: { relayOn: boolean; pieces: boolean; later: boolean; partial: boolean }): CashOutSender {
  if (p.relayOn || p.pieces) return "relay";
  if (!p.later) return "wallet";
  return p.partial ? "wallet-first-step" : "relay";
}

/** What a cash out makes public, in one plain sentence. */
export function publicLine(p: { sender: CashOutSender; pieces?: boolean }): string {
  const what = p.pieces
    ? "Which asset, each piece's amount, where it goes and when"
    : "Which asset, the amount, where it goes and when";
  if (p.sender === "wallet") return `${what}, and your wallet, which sends it.`;
  if (p.sender === "wallet-first-step") return `${what}. The first step, setting the amount aside, leaves from your wallet now.`;
  return `${what}.`;
}

/** What stays private, in one plain sentence. */
export const PRIVATE_LINE = "Which deposit it came from, and your other balance and payments.";

export function sameAmountText(at: number, now = Date.now()): string {
  return `You added this exact amount ${whenLabel(at, now)}. A different or rounder amount is harder to match.`;
}

/**
 * The quiet warnings for one cash out, address first. At most one about the
 * address (the signed-in wallet before a depositing one, since that says the
 * most) and one about the amount. Never a block: the person can go ahead.
 */
export function cashOutPrivacyWarnings(p: {
  /** Where it goes, or null while there is no valid address. */
  to: string | null | undefined;
  /** The wallet signed in now. */
  connected: string | null | undefined;
  /** What goes out, or null while the amount is not valid. */
  amountWei: bigint | null | undefined;
  asset: string | null | undefined;
  chainId: number;
  pool: string | null | undefined;
  /** This browser's notes, every wallet's. */
  notes: readonly PrivacyNote[];
  now?: number;
}): CashOutWarning[] {
  const out: CashOutWarning[] = [];
  const scope = { chainId: p.chainId, pool: p.pool };
  const to = normAddress(p.to);
  if (to) {
    if (to === normAddress(p.connected)) {
      out.push({ kind: "own-wallet", text: OWN_WALLET_TEXT, key: `own-wallet:${to}`, aboutAddress: true });
    } else if (depositWallets(p.notes, scope).has(to)) {
      out.push({ kind: "deposit-wallet", text: DEPOSIT_WALLET_TEXT, key: `deposit-wallet:${to}`, aboutAddress: true });
    }
  }
  if (p.asset && p.amountWei != null && p.amountWei > 0n) {
    const now = p.now ?? Date.now();
    const match = sameAmountDeposit(p.notes, { ...scope, asset: p.asset, amountWei: p.amountWei, now });
    if (match) {
      out.push({
        kind: "same-amount",
        text: sameAmountText(match.createdAt, now),
        key: `same-amount:${p.asset.toLowerCase()}:${p.amountWei}`,
        aboutAddress: false,
      });
    }
  }
  return out;
}
