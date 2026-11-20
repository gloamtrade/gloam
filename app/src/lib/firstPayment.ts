/**
 * The "Send your first private payment" nudge and the share post that follows
 * a private payment.
 *
 * Whether this device has made a private payment comes from two places:
 *   - the note store: a "chg-" note is the change a private payment leaves
 *     behind (Pay and payroll both save one), so any device that paid before
 *     this flag existed is still counted;
 *   - the flag below, set when a private payment confirms, which also covers
 *     a payment that spent a whole balance and left no change.
 *
 * Nothing here is secret (no amounts, no recipients, only chain ids and a
 * dismissed bit), so it lives in plain localStorage. In a recording demo it
 * stays in this tab's memory and never touches the real flag.
 */

import { formatUnits, parseUnits, type Address } from "viem";
import { readDemo } from "./demoFlag";
import { shieldTokensFor } from "./tokens";
import type { LocalNote } from "./shield";

const KEY = "gloam.firstPay.v1";
/** Same-tab change signal (the storage event only fires in other tabs). */
const EVENT = "gloam:first-pay";

export type FirstPayState = {
  /** The nudge was dismissed on this device. */
  dismissed: boolean;
  /** Chain ids this device has made a private payment on. */
  paid: number[];
};

const EMPTY: FirstPayState = { dismissed: false, paid: [] };

let demoRaw = "";

export function parseFirstPay(raw: string | null | undefined): FirstPayState {
  if (!raw) return EMPTY;
  try {
    const p = JSON.parse(raw) as Partial<FirstPayState>;
    return {
      dismissed: Boolean(p.dismissed),
      paid: Array.isArray(p.paid)
        ? p.paid.filter((x): x is number => Number.isInteger(x))
        : [],
    };
  } catch {
    return EMPTY;
  }
}

/** The raw stored value, a stable string for useSyncExternalStore. */
export function firstPaySnapshot(): string {
  if (typeof window === "undefined") return "";
  if (readDemo()) return demoRaw;
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function subscribeFirstPay(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function write(next: FirstPayState) {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(next);
  if (readDemo()) {
    demoRaw = raw;
  } else {
    try {
      window.localStorage.setItem(KEY, raw);
    } catch {
      /* storage full or blocked: the nudge just shows again */
    }
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Call once a private payment has confirmed on `chainId`. */
export function markPrivatePaid(chainId: number) {
  const cur = parseFirstPay(firstPaySnapshot());
  if (cur.paid.includes(chainId)) return;
  write({ ...cur, paid: [...cur.paid, chainId] });
}

export function dismissFirstPayNudge() {
  const cur = parseFirstPay(firstPaySnapshot());
  if (cur.dismissed) return;
  write({ ...cur, dismissed: true });
}

/**
 * True when this device has made a private payment: the flag (any network) or
 * a change note among `notes` (pass the notes the app has loaded).
 */
export function hasPaidPrivately(state: FirstPayState, notes: LocalNote[]): boolean {
  return state.paid.length > 0 || notes.some((n) => n.id.startsWith("chg-"));
}

/** The small default the nudge opens Pay with. */
export const FIRST_PAY_AMOUNT = "5";

export type FirstPaySuggestion = {
  asset: Address;
  symbol: string;
  /** Plain decimal, e.g. "5". */
  amount: string;
};

/**
 * Which stablecoin to suggest and how much. Each payment comes from one
 * balance, so this looks at single balances: the network's main stablecoin
 * (OUSD on Tempo, USDG on Robinhood Chain) when one of its balances covers the
 * default, otherwise the stablecoin with the largest single balance. When that
 * balance is under the default, the suggestion is the whole balance. Null when
 * there is no private stablecoin on this network.
 */
export function firstPaySuggestion(
  notes: LocalNote[],
  chainId: number
): FirstPaySuggestion | null {
  const stables = shieldTokensFor(chainId).filter((t) => t.kind === "stablecoin");
  const best = stables
    .map((t) => {
      const largest = notes
        .filter((n) => n.asset.toLowerCase() === t.address.toLowerCase())
        .reduce((m, n) => {
          const v = BigInt(n.amountWei || "0");
          return v > m ? v : m;
        }, 0n);
      return { token: t, largest };
    })
    .filter((x) => x.largest > 0n);
  if (!best.length) return null;

  const pick = (x: (typeof best)[number]): FirstPaySuggestion => {
    const want = parseUnits(FIRST_PAY_AMOUNT, x.token.decimals);
    return {
      asset: x.token.address,
      symbol: x.token.symbol,
      amount:
        x.largest >= want
          ? FIRST_PAY_AMOUNT
          : formatUnits(x.largest, x.token.decimals),
    };
  };

  // Stablecoins are listed main-first, so the first one that covers wins.
  const covering = best.find(
    (x) => x.largest >= parseUnits(FIRST_PAY_AMOUNT, x.token.decimals)
  );
  if (covering) return pick(covering);
  const largest = best.reduce((a, b) =>
    Number(formatUnits(b.largest, b.token.decimals)) >
    Number(formatUnits(a.largest, a.token.decimals))
      ? b
      : a
  );
  return pick(largest);
}

/**
 * Pay, opened with a suggested amount and token. These names are separate from
 * a payment request's (to, amount, asset), so a suggestion is never read as a
 * request and never shows the request banner.
 */
export function firstPayHref(s: FirstPaySuggestion | null): string {
  // Send is Pay's default mode; mode=pay is left to request links, whose preview it names.
  const base = "/app/vault?tab=move";
  if (!s) return base;
  const p = new URLSearchParams({ suggest: s.amount, suggestAsset: s.asset });
  return `${base}&${p.toString()}`;
}

/** Reads a suggestion back from Pay's URL, checked against this network's tokens. */
export function readFirstPaySuggestion(
  params: { get(name: string): string | null },
  chainId: number
): FirstPaySuggestion | null {
  const amount = params.get("suggest")?.trim() ?? "";
  const asset = params.get("suggestAsset")?.trim().toLowerCase() ?? "";
  if (!amount || !asset) return null;
  const token = shieldTokensFor(chainId).find(
    (t) => t.address.toLowerCase() === asset
  );
  if (!token) return null;
  if (!/^\d{1,15}(\.\d+)?$/.test(amount)) return null;
  const [, frac = ""] = amount.split(".");
  if (frac.length > token.decimals) return null;
  if (parseUnits(amount, token.decimals) <= 0n) return null;
  return { asset: token.address, symbol: token.symbol, amount };
}
