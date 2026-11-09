"use client";

/**
 * Swap inside the private balance (lib/vaultSwap, lib/vaultSwapRun), laid out
 * like a standard swap: a "You pay" card, a flip button, a "You receive" card,
 * a rate line and the details underneath. Shown only where a vault swap router
 * is deployed. Who swapped stays private; the amounts show on chain, like any
 * DEX trade, and the copy says so.
 *
 * A swap spends one private note. The note is picked from the amount: the one
 * that matches it exactly, else the smallest that covers it (the rest is set
 * aside privately first). More than the largest note takes a second swap.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { BaseError, formatUnits, type Address, type Hex } from "viem";
import { WALLET_DECLINED_TEXT, walletDeclined } from "@/lib/walletErrors";
import { useReadContract, useReadContracts } from "wagmi";
import { hasCoingeckoMarks, useCoingeckoMarks } from "@/hooks/useCoingeckoMarks";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useOpenGatedTokens } from "@/hooks/useOpenGatedTokens";
import { useAppAccount } from "@/lib/demo";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { getRhPublicClient, publicClientFor } from "@/lib/rhClient";
import { relayFor, type RelayNetworkStatus } from "@/lib/relay/client";
import { hasSwapFloor, swapFloorGas, swapFloorShown, swapGasUnits } from "@/lib/relay/swapFloor";
import { feeMoved } from "@/lib/cashOutLater";
import { isUnsecuredClaim } from "@/lib/claimSweep";
import { freshPath } from "@/lib/cashOutSplit";
import {
  assetDecimals,
  assetLabel,
  formatAssetAmount,
  formatAssetLabel,
  formatFeePercent,
  parseAssetAmount,
  shieldPoolAbi,
  withdrawFeeOf,
  type LocalNote,
} from "@/lib/shield";
import {
  NATIVE_ETH_TOKEN,
  isAddableToken,
  isDollarStable,
  isNativeAddable,
  knownTokens,
  shieldTokensFor,
  type OnchainToken,
} from "@/lib/tokens";
import {
  IMPACT_WARN_BPS,
  PEG_WARN_BPS,
  QUOTE_TTL_MS,
  SwapQuoteRefused,
  VALUE_STOP_BPS,
  VALUE_WARN_BPS,
  VAULT_SWAP_ASSETS,
  livePools,
  offeredSwapAssets,
  type PoolKey,
  depositRoom,
  maxSwapInForRefund,
  planVaultSwap,
  refundFits,
  quoteFresh,
  routeCurrencies,
  swapBufferBps,
  swapChecked,
  swapRouterFor,
  valueGapBps,
  vaultSwapRouter,
  type SwapPlan,
} from "@/lib/vaultSwap";
import { amountTextError } from "@/lib/amountText";
import { SWAP_REFUNDED, runVaultSwap } from "@/lib/vaultSwapRun";
import type { PoseidonMerklePath } from "@/lib/merklePoseidon";
import { countPerson } from "@/lib/people";
import type { GloamNetwork } from "@/lib/networks";
import { useNetwork } from "./NetworkProvider";
import { RelayGasNotice } from "./RelayGasNotice";
import { SuccessModal } from "./SuccessModal";
import { TokenLogo } from "./TokenLogo";
import { WalletMenu } from "./WalletMenu";
import { ADD_FIRST, vaultActionSearch } from "@/lib/vaultHub";
import { BRIDGE_DESTINATIONS, bridgeVisible } from "@/lib/bridge";
import type { NetworkKey } from "@/lib/networks";
import { swapLinkFromHash, swapLinkParams, swapLinkStep, type SwapLink } from "@/lib/swapLink";
import { dropSwapLink, keepSwapLink, keptSwapLink } from "@/lib/swapLinkStore";
import { SwapLinkBanner } from "./SwapLinkBanner";
import { settlePartnerTx, usePartnerName } from "@/lib/partnerLinkClient";

/**
 * The swap link this tab opens with (lib/swapLink): the one in the address bar,
 * else one this tab kept while the person went to Add first (lib/swapLinkStore).
 * One read from the address bar is kept for that trip.
 */
function openSwapLink(shown: NetworkKey): SwapLink | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  const link = swapLinkFromHash(hash, shown);
  if (link) {
    if (link.on) keepSwapLink(hash.replace(/^#/, ""), link.on);
    return link;
  }
  const kept = keptSwapLink();
  return kept ? swapLinkFromHash(kept.frag, kept.on) : null;
}

const limitAbi = [
  {
    type: "function",
    name: "depositLimit",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "perDeposit", type: "uint128" },
      { name: "total", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "deposited",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const noopSubscribe = () => () => {};
const ZERO = "0x0000000000000000000000000000000000000000";

/** The token record for an asset on this chain (logo id, name). */
function tokenFor(chainId: number, asset: string): OnchainToken | undefined {
  if (same(asset, NATIVE_ETH_TOKEN.address)) return NATIVE_ETH_TOKEN;
  return knownTokens(chainId).find((t) => same(t.address, asset));
}

/** A raw amount as a plain decimal string an input can hold (no grouping), cut to `maxFrac` places. */
function plainAmount(raw: bigint, asset: string, maxFrac = 6): string {
  const s = formatUnits(raw, assetDecimals(asset));
  const [a, b = ""] = s.split(".");
  const frac = b.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${a}.${frac}` : a!;
}

/** Big amount sizes (phone / from sm up), stepping down as digits grow so a long number never clips. */
function amountSize(text: string): string {
  const n = text.length;
  const phone = n <= 6 ? "text-[32px]" : n <= 8 ? "text-[27px]" : n <= 10 ? "text-[23px]" : n <= 13 ? "text-[19px]" : "text-[16px]";
  const wide = n <= 8 ? "sm:text-[40px]" : n <= 11 ? "sm:text-[33px]" : n <= 14 ? "sm:text-[27px]" : "sm:text-[22px]";
  return `${phone} ${wide}`;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return usd.format(n);
}

const uiMultiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/**
 * USD marks: stablecoins at $1, WETH at ETH's price. A Robinhood stock token at
 * the live share price times its uiMultiplier (balances never rebase; splits and
 * dividends move the multiplier, so one raw token is worth share price x
 * multiplier / 1e18), else the server's price for the token itself (lib/tokenMarksServer,
 * so the browser asks no price API). Other tokens at the server's price. Null while unknown.
 */
function useUsdMarks(
  chainId: GloamNetwork["chainId"],
  assets: readonly Address[],
  shown: readonly (Address | null)[]
): Record<string, number | null> {
  const tokens = useMemo(() => assets.map((a) => tokenFor(chainId, a)), [assets, chainId]);
  const { data: marketData } = useLiveMarkets();
  const { marks: serverMarks } = useCoingeckoMarks(hasCoingeckoMarks(chainId));
  const stocks = useMemo(
    () => shown.filter((a): a is Address => Boolean(a) && tokenFor(chainId, a!)?.kind === "stock"),
    [shown, chainId]
  );
  const { data: mults } = useReadContracts({
    contracts: stocks.map((a) => ({ address: a, abi: uiMultiplierAbi, functionName: "uiMultiplier", chainId }) as const),
    query: { enabled: stocks.length > 0, staleTime: 5 * 60_000 },
  });
  return useMemo(() => {
    const out: Record<string, number | null> = {};
    assets.forEach((a, i) => {
      const t = tokens[i];
      const key = a.toLowerCase();
      out[key] = !t
        ? null
        : isDollarStable(t)
          ? 1
          : t.id === "weth" || t.id === "eth"
            ? (marketData?.ethUsd ?? null)
            : (serverMarks.get(key) ?? null);
    });
    stocks.forEach((a, i) => {
      const t = tokenFor(chainId, a);
      const m = marketData?.markets.find((x) => x.id === t?.id && x.source === "live");
      const mult = mults?.[i]?.status === "success" ? (mults[i]!.result as bigint) : null;
      if (m && m.mark > 0 && mult) out[a.toLowerCase()] = (m.mark * Number(mult)) / 1e18;
    });
    return out;
  }, [assets, tokens, serverMarks, stocks, marketData, mults, chainId]);
}

/** The note a swap of `amount` spends: an exact match first, else the smallest that covers it. */
function pickSwapNote(notes: readonly LocalNote[] | undefined, amount: bigint | null): LocalNote | null {
  if (!notes || amount === null) return null;
  const exact = notes.find((n) => BigInt(n.amountWei) === amount);
  if (exact) return exact;
  const covering = notes.filter((n) => BigInt(n.amountWei) >= amount);
  return covering.length ? covering[covering.length - 1]! : null;
}

export function VaultSwapView() {
  const { network, networkKey, setNetworkKey } = useNetwork();
  const { address, isConnected } = useAppAccount();
  const router = vaultSwapRouter(network.chainId);
  const openGated = useOpenGatedTokens();
  // A queued asset (lib/vaultSwap offeredSwapAssets) shows once the router says one of its pools is live.
  const [livePool, setLivePool] = useState<{ chainId: number; is: (k: PoolKey) => boolean } | null>(null);
  useEffect(() => {
    const r = swapRouterFor(network.chainId);
    if (!r) return;
    let on = true;
    const read = async () => {
      const is = await livePools(publicClientFor(network), r);
      if (on) setLivePool({ chainId: network.chainId, is });
    };
    void read();
    const t = setInterval(() => void read(), 60_000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [network]);
  const assets = useMemo(
    () =>
      offeredSwapAssets(
        VAULT_SWAP_ASSETS[network.chainId] ?? [],
        swapRouterFor(network.chainId),
        openGated,
        livePool?.chainId === network.chainId ? livePool.is : null
      ),
    [network.chainId, openGated, livePool]
  );
  const { open, ready: notesRead, balanceSyncing, refresh: refreshNotes } = useLocalShieldNotes(address);

  // Notes a swap can spend: this vault's, in a swap asset, with their secret.
  // A claimed payment the payer could still take back is secured first, in Pay.
  const notes = useMemo(
    () =>
      open
        .filter(
          (n) =>
            n.chainId === network.chainId &&
            network.pool != null &&
            same(n.pool, network.pool) &&
            n.bound &&
            (!n.scheme || n.scheme === "poseidon") &&
            assets.some((a) => same(a, n.asset)) &&
            !isUnsecuredClaim(n)
        )
        .sort((a, b) => (BigInt(a.amountWei) > BigInt(b.amountWei) ? -1 : 1)),
    [open, network.chainId, network.pool, assets]
  );

  // Per asset: the private balance in all, and the most one swap can take (the largest note).
  const holdings = useMemo(() => {
    const m = new Map<string, { total: bigint; largest: bigint; notes: LocalNote[] }>();
    for (const n of notes) {
      const k = n.asset.toLowerCase();
      const v = BigInt(n.amountWei);
      const h = m.get(k) ?? { total: 0n, largest: 0n, notes: [] };
      h.total += v;
      if (v > h.largest) h.largest = v;
      h.notes.push(n);
      m.set(k, h);
    }
    return m;
  }, [notes]);

  // A swap link (lib/swapLink) fills in both tokens and the amount, read once
  // here and again when another link opens in this tab. It never swaps: the
  // person checks the quote and taps Swap privately like any other swap.
  const [link, setLink] = useState<SwapLink | null>(() => openSwapLink(networkKey));
  // A partner's link code (p=): their name from their Gloam account, once the server says it is live.
  const partnerName = usePartnerName(link?.partnerCode ?? null);
  const [payPick, setPayPick] = useState<Address | null>(() => link?.from?.address ?? null);
  const [toPick, setToPick] = useState<Address | null>(() => link?.to?.address ?? null);
  // The link's token to pay with stays picked with no private balance in it, so
  // the person sees what to add; a token picked by hand needs a balance.
  const [payPinned, setPayPinned] = useState(() => Boolean(link?.from));
  const offered = (a: Address) => assets.some((x) => same(x, a));
  const payAsset: Address | null =
    (payPick && offered(payPick) && (payPinned || holdings.has(payPick.toLowerCase())) ? payPick : null) ??
    // The first held token in the list's order (the dollar first), not the
    // largest raw amount: 18-decimal GLOAM would always outrank 6-decimal USDG.
    assets.find((a) => holdings.has(a.toLowerCase())) ??
    assets[0] ??
    null;
  const toAsset: Address | null =
    (toPick && payAsset && !same(toPick, payAsset) && offered(toPick) ? toPick : null) ??
    assets.find((a) => payAsset && !same(a, payAsset)) ??
    null;
  const [amountInput, setAmountInput] = useState(() => link?.amount ?? "");
  const marks = useUsdMarks(network.chainId, assets, [payAsset, toAsset]);

  // The vault's limits on the input token: a swap's refund note lands in it, so
  // one swap spends at most what that refund could bring back (lib/vaultSwap
  // refundFits); a larger note is split first, never swapped whole.
  const { data: limitIn } = useReadContract({
    address: network.pool ?? undefined,
    abi: limitAbi,
    functionName: "depositLimit",
    args: payAsset ? [payAsset] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(network.pool && payAsset) },
  });
  const { data: inVaultIn } = useReadContract({
    address: network.pool ?? undefined,
    abi: limitAbi,
    functionName: "deposited",
    args: payAsset ? [payAsset] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(network.pool && payAsset) },
  });
  const roomIn =
    limitIn && typeof inVaultIn === "bigint" ? { perDeposit: limitIn[0], total: limitIn[1], deposited: inVaultIn } : null;

  const held = payAsset ? holdings.get(payAsset.toLowerCase()) : undefined;
  // The vault's cash-out fee: a refund through a router with an exit is sized from it. Until it reads, the most it can be.
  const { data: feeRead, refetch: refetchFee } = useReadContract({
    address: network.pool ?? undefined,
    abi: shieldPoolAbi,
    functionName: "withdrawFeeBps",
    chainId: network.chainId,
    query: { enabled: Boolean(network.pool), refetchInterval: 60_000 },
  });
  const feeBps = typeof feeRead === "number" ? feeRead : null;
  const refundFee = swapRouterFor(network.chainId)?.version === 3 ? (feeBps ?? 100) : undefined;
  const refundCap = roomIn ? maxSwapInForRefund(roomIn, refundFee) : null;
  // The most one swap can spend: the largest note, and no more than its refund could bring back.
  const oneSwapMax = held ? (refundCap != null && refundCap < held.largest ? refundCap : held.largest) : 0n;
  const typed = amountInput.trim() && payAsset ? parseAssetAmount(amountInput.trim(), payAsset) : null;
  const amountBad = amountInput.trim() !== "" && (typed === null || typed <= 0n);
  // Nothing held counts as too little: a price still shows, the swap does not.
  const overTotal = typed !== null && !amountBad && (held == null || typed > held.total);
  const overNote = typed !== null && held != null && !overTotal && typed > oneSwapMax;
  const refundBlocked = typed !== null && roomIn != null && !overTotal && !overNote && !refundFits(roomIn, typed, refundFee);
  const amount = typed !== null && !amountBad && !overTotal && !overNote && !refundBlocked ? typed : null;

  // The note this swap spends: an exact match first, else the smallest that covers it.
  // A scan of a few notes, so no memo: the note found is the same object each render.
  const note: LocalNote | null = pickSwapNote(held?.notes, amount);

  const { data: limit } = useReadContract({
    address: network.pool ?? undefined,
    abi: limitAbi,
    functionName: "depositLimit",
    args: toAsset ? [toAsset] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(network.pool && toAsset) },
  });
  const { data: inVault } = useReadContract({
    address: network.pool ?? undefined,
    abi: limitAbi,
    functionName: "deposited",
    args: toAsset ? [toAsset] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(network.pool && toAsset) },
  });

  const [relay, setRelay] = useState<{ chainId: number; status: RelayNetworkStatus | null } | null>(null);
  const relayNow = relay?.chainId === network.chainId ? relay.status : null;
  const relayOk = relay?.chainId === network.chainId ? Boolean(relay.status?.enabled) : null;

  // A quote counts only for the exact swap it was asked for (quoteKey), so a
  // stale one can never be sent for a newer amount, and only while it is fresh
  // (quoteFresh): an old price can't sit on screen as if it were today's.
  const [quote, setQuote] = useState<{ key: string; plan: SwapPlan; at: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // About the most of the note a refused quote would take: the error line names it.
  const [quoteFits, setQuoteFits] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // The swap that just landed, so the receipt can show both marks and both amounts.
  const [receipt, setReceipt] = useState<{
    pay: Address;
    payAmount: bigint;
    receive: Address;
    receiveAmount: bigint;
    hash: Hex;
  } | null>(null);
  const [inverse, setInverse] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [picker, setPicker] = useState<"pay" | "receive" | null>(null);
  // The flip button turns half a circle on each flip.
  const [turns, setTurns] = useState(0);

  // The last swap's error or success belongs to the network it ran on: a switch clears them.
  const shownNet = useRef(networkKey);
  useEffect(() => {
    if (shownNet.current === networkKey || busy) return;
    shownNet.current = networkKey;
    setError(null);
    setDone(null);
    setReceipt(null);
  }, [networkKey, busy]);

  // Another swap link opened in this tab only changes the fragment: fill that one in.
  // Not while a swap is running: the form stays on the swap being sent.
  useEffect(() => {
    if (busy) return;
    const onHash = () => {
      const l = swapLinkFromHash(window.location.hash, networkKey);
      if (!l) return;
      if (l.on) keepSwapLink(window.location.hash.replace(/^#/, ""), l.on);
      setLink(l);
      setPayPick(l.from?.address ?? null);
      setPayPinned(Boolean(l.from));
      setToPick(l.to?.address ?? null);
      setAmountInput(l.amount ?? "");
      setQuote(null);
      setError(null);
      setDone(null);
      setReceipt(null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [busy, networkKey]);

  function closeLink() {
    dropSwapLink();
    setLink(null);
  }
  // Once its swap lands a link is done: a reload must not fill the same swap in again.
  function finishLink() {
    closeLink();
    if (swapLinkParams(window.location.hash).toString()) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }

  // A coarse clock for quote ages: every 5 seconds, paused while the page is hidden.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "hidden") setClock(Date.now());
    };
    const t = window.setInterval(tick, 5_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const refreshSlot = Math.floor(clock / QUOTE_TTL_MS);

  // The relay's state, and on a chain where gas is dear, its floor for a swap: it moves with gas, so it refreshes with the quote.
  const dearGas = hasSwapFloor(network.chainId);
  const relaySlot = dearGas ? refreshSlot : 0;
  useEffect(() => {
    let live = true;
    const chainId = network.chainId;
    void relayFor(chainId, dearGas).then((status) => live && setRelay({ chainId, status }));
    return () => {
      live = false;
    };
  }, [network.chainId, dearGas, relaySlot]);

  // A fresh quote whenever what is being swapped changes (after a short pause while
  // typing), and again every QUOTE_TTL_MS while it shows. Any valid amount gets a
  // price, even more than the balance holds, so people can see the rate before
  // they add money; the button still says why the swap can't go. A price depends
  // only on the tokens, the amount and the fee. The swap prices it once more
  // right before it goes (lib/vaultSwapRun).
  const quoteAmount = typed !== null && !amountBad ? typed : null;
  const quoteKey =
    router && payAsset && toAsset && feeBps != null && quoteAmount !== null
      ? `${router}|${payAsset}|${toAsset}|${quoteAmount}|${feeBps}`
      : null;
  useEffect(() => {
    if (!quoteKey || !router || !payAsset || !toAsset || feeBps == null || quoteAmount === null || busy) return;
    let live = true;
    const t = window.setTimeout(() => {
      setQuoting(true);
      setQuoteError(null);
      setQuoteFits(null);
      const key = quoteKey;
      planVaultSwap(getRhPublicClient(), network.chainId, {
        assetIn: payAsset,
        assetOut: toAsset,
        amountIn: quoteAmount,
        feeBps,
        router,
      })
        .then((p) => live && setQuote({ key, plan: p, at: Date.now() }))
        .catch((e) => {
          if (!live) return;
          // A refresh that fails leaves a fresh price up; it stops showing by itself.
          const now = Date.now();
          setQuote((q) => (q && q.key === key && quoteFresh(q.at, now) ? q : null));
          // an RPC's own words are no use here; what this code threw is
          setQuoteError(e instanceof Error && !(e instanceof BaseError) ? e.message : "Could not get a price. Try again.");
          setQuoteFits(e instanceof SwapQuoteRefused ? e.fitsIn : null);
        })
        .finally(() => live && setQuoting(false));
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- quoteKey names everything the quote reads
  }, [quoteKey, network.chainId, busy, refreshSlot]);
  // While a swap runs the quote stays up as it was: the swap prices it again before it goes.
  const shownPlan =
    quote && quoteKey && quote.key === quoteKey && (busy || quoteFresh(quote.at, clock)) ? quote.plan : null;
  // A refresh in flight or one that failed doesn't hide a price that still shows.
  const priceError = shownPlan ? null : quoteError;
  const waitingQuote = Boolean(quoteKey) && !shownPlan && !priceError;

  // The vault's deposit limits apply to what lands. A token it has no
  // limit for at all is one it doesn't take yet.
  const vaultClosed = Boolean(limit && limit[0] === 0n && limit[1] === 0n);
  const room = limit && typeof inVault === "bigint" ? depositRoom({ perDeposit: limit[0], total: limit[1], deposited: inVault }) : null;
  const overRoom = Boolean(shownPlan && room != null && shownPlan.amountOut > room && !vaultClosed);
  // About the most to pay so what lands fits the room, at this price (1% under, as prices move).
  const fitsIn =
    overRoom && shownPlan && room != null && quoteAmount !== null && shownPlan.amountOut > 0n
      ? (quoteAmount * room * 99n) / (shownPlan.amountOut * 100n)
      : null;
  const impact = shownPlan?.impactBps ?? null;
  const pegGap = shownPlan?.pegBps ?? null;

  if (!router) return null;

  async function onSwap() {
    if (!note || !toAsset || !shownPlan || feeBps == null || !address || amount === null || !payAsset) return;
    const paid = amount;
    const from = payAsset;
    const into = toAsset;
    // the link this swap came from, before finishing it clears the link
    const partnerCode = link?.partnerCode ?? null;
    const chainId = network.chainId;
    setBusy(true);
    setError(null);
    setDone(null);
    setReceipt(null);
    try {
      // A quote made at the old fee would leave too little to buy what it promised.
      const feeNote = await feeMoved(network, feeBps);
      if (feeNote) {
        setError(feeNote);
        void refetchFee();
        return;
      }
      const { outNote, refunded, hash } = await runVaultSwap({
        network,
        router: router!,
        note,
        amount: paid,
        assetOut: into,
        plan: shownPlan,
        feeBps,
        owner: address as Address,
        pathFor: async (n) => ((await freshPath(n.commitment))?.path as PoseidonMerklePath | undefined) ?? null,
        onStatus: setStatus,
        // from a partner's link: the code goes to the relay with the swap, which counts it once it lands
        ...(partnerCode ? { partnerCode } : {}),
      });
      if (!refunded) {
        countPerson("swap", address, network.testnet);
        // a second chance for the count if the relay's own step missed it; never waited on
        if (partnerCode) settlePartnerTx({ chainId, txHash: hash });
        setReceipt({ pay: from, payAmount: paid, receive: into, receiveAmount: BigInt(outNote.amountWei), hash });
        finishLink();
      }
      setDone(
        refunded ? SWAP_REFUNDED : `Swapped. ${formatAssetLabel(outNote.amountWei, outNote.asset)} is in your private balance.`
      );
      setAmountInput("");
      setQuote(null);
    } catch (e) {
      // What this code threw says what happened; viem's text (a read, a block, a replan)
      // lists contracts and calls. A swap can stop after its first step, so no "nothing moved".
      setError(
        walletDeclined(e)
          ? WALLET_DECLINED_TEXT
          : e instanceof Error && !(e instanceof BaseError)
            ? e.message
            : "The swap didn't finish. Refresh your private balance and check it before you try again."
      );
    } finally {
      setBusy(false);
      setStatus(null);
      refreshNotes();
    }
  }

  function pickPay(a: Address) {
    if (toAsset && same(a, toAsset)) setToPick(payAsset);
    setPayPick(a);
    setPayPinned(false);
    setAmountInput("");
    setQuote(null);
    setDone(null);
    setReceipt(null);
  }
  function pickReceive(a: Address) {
    if (payAsset && same(a, payAsset)) {
      if (toAsset && holdings.has(toAsset.toLowerCase())) {
        setPayPick(toAsset);
        setPayPinned(false);
        setAmountInput("");
      } else return;
    }
    setToPick(a);
    setQuote(null);
    setDone(null);
    setReceipt(null);
  }
  // Flip: what you receive becomes what you pay, when there is a private balance in it.
  const canFlip = Boolean(toAsset && holdings.has(toAsset.toLowerCase())) && !busy;
  function flip() {
    if (!canFlip || !toAsset || !payAsset) return;
    const next = shownPlan ? plainAmount(shownPlan.amountOut, toAsset) : "";
    setTurns((t) => t + 1);
    setPayPick(toAsset);
    setPayPinned(false);
    setToPick(payAsset);
    setAmountInput(next);
    setQuote(null);
    setDone(null);
    setReceipt(null);
  }
  function setShare(pct: number) {
    if (!held || !payAsset) return;
    const v = pct === 100 ? oneSwapMax : (oneSwapMax * BigInt(pct)) / 100n;
    setAmountInput(plainAmount(v, payAsset, assetDecimals(payAsset)));
    setDone(null);
    setReceipt(null);
  }

  const venue = network.chainId === 4217 ? "Tempo's stablecoin exchange" : `Uniswap on ${network.label}`;
  // What Add takes of the swap tokens (WETH, say, arrives only by swapping into it).
  const addable = assets.filter((a) => shieldTokensFor(network.chainId).some((t) => same(t.address, a)));

  // A swap link's next step (lib/swapLink): sign in, or add the token it pays
  // with when the private balance in it is none or too little. Bring money over
  // only where it lands that token (USDG on Robinhood Chain, USDC.e on Tempo).
  const linkFrom = link?.on === networkKey ? link.from : null;
  const linkHeld = linkFrom ? (holdings.get(linkFrom.address.toLowerCase())?.total ?? 0n) : 0n;
  const linkStep = link
    ? swapLinkStep(link, {
        signedIn: Boolean(isConnected && address),
        network: networkKey,
        known: notesRead && !balanceSyncing,
        held: linkHeld,
        need: linkFrom && link.amount ? parseAssetAmount(link.amount, linkFrom.address) : null,
        addable: Boolean(
          linkFrom &&
            (same(linkFrom.address, ZERO)
              ? isNativeAddable(network.chainId, openGated)
              : isAddableToken(network.chainId, linkFrom, openGated))
        ),
        bridge: Boolean(
          linkFrom && bridgeVisible(network) && same(BRIDGE_DESTINATIONS[network.family]?.token.address ?? "", linkFrom.address)
        ),
        heldLabel: linkFrom ? formatAssetLabel(linkHeld, linkFrom.address) : undefined,
      })
    : null;
  // A token the router lists but whose pools or vault limit haven't opened yet is left out, once the pools are read.
  const poolsRead = livePool?.chainId === network.chainId;
  const linkNotOpen =
    link?.on === networkKey && poolsRead
      ? [link.from, link.to].flatMap((t) =>
          t && !offered(t.address) ? [`${t.symbol} is not open for private swaps yet, so it was left out.`] : []
        )
      : [];

  const payUsd = payAsset && typed !== null && typed > 0n ? usdOf(typed, payAsset, marks) : null;
  const getUsd = shownPlan && toAsset ? usdOf(shownPlan.amountOut, toAsset, marks) : null;
  const receiveText = shownPlan && toAsset ? formatAssetAmount(shownPlan.amountOut, toAsset) : "0";

  // On a chain where gas is dear a swap's vault fee has to cover its gas (lib/relay/swapFloor), and the
  // relay counts a stablecoin at face value. The floor follows the route, each hop past the first costing
  // more, and setting part of a note aside first, which the relay can't see, so only this tab counts it.
  const hops = shownPlan?.route.length || 1;
  const splits = Boolean(note && amount !== null && amount < BigInt(note.amountWei));
  const floorUsd =
    relayNow?.swapFloorUsd != null
      ? (swapFloorShown(relayNow.swapFloorUsd) * Number(swapFloorGas(hops, splits))) / Number(swapGasUnits(1))
      : null;
  const paidFace =
    payAsset && typed !== null && typed > 0n
      ? tokenFor(network.chainId, payAsset)?.kind === "stablecoin"
        ? Number(formatUnits(typed, assetDecimals(payAsset)))
        : payUsd
      : null;
  const belowFloor = floorUsd != null && paidFace != null && paidFace < floorUsd;
  const gasHigh = dearGas && Boolean(relayNow?.gasHigh);

  // What the swap gives against what it costs, at market prices, fees included.
  const valueGap = payUsd != null && getUsd != null ? valueGapBps(payUsd, getUsd) : null;
  const farFromMarket = swapChecked(network.chainId) && valueGap != null && valueGap >= VALUE_STOP_BPS;

  // One label for the main button, the first thing that stops the swap.
  const button: { key: string; label: ReactNode; ready: boolean } = busy
    ? {
        key: `busy-${status ?? ""}`,
        label: (
          <>
            <Spinner />
            <span className="truncate">{status ?? "Swapping…"}</span>
          </>
        ),
        ready: false,
      }
    : !notes.length
      ? { key: "addfirst", label: ADD_FIRST, ready: false }
      : !amountInput.trim()
      ? { key: "empty", label: "Enter an amount", ready: false }
      : amountBad
        ? { key: "bad", label: amountTextError(amountInput, payAsset ? assetDecimals(payAsset) : undefined) ?? "Enter a valid amount", ready: false }
        : overTotal
          ? { key: "over", label: "Insufficient private balance", ready: false }
          : (overNote || refundBlocked) && held && payAsset
            ? oneSwapMax > 0n
              ? { key: "note", label: `Up to ${formatAssetLabel(oneSwapMax, payAsset)} in one swap`, ready: false }
              : { key: "inclosed", label: `The vault isn't taking ${assetLabel(payAsset)} back right now`, ready: false }
            : waitingQuote || (quoting && !shownPlan)
              ? {
                  key: "quoting",
                  label: (
                    <>
                      <Spinner />
                      Getting a price
                    </>
                  ),
                  ready: false,
                }
              : priceError
                ? { key: "noprice", label: "No price for this amount", ready: false }
                : vaultClosed && toAsset
                  ? { key: "closed", label: `The vault doesn't take ${assetLabel(toAsset)} yet`, ready: false }
                  : overRoom
                  ? { key: "room", label: "Too large for the vault right now", ready: false }
                  : relayOk === false
                    ? { key: "relay", label: "The Gloam relay is off", ready: false }
                    : gasHigh
                      ? { key: "gas", label: `${network.label} gas is high right now`, ready: false }
                      : belowFloor
                        ? { key: "floor", label: `Smallest swap right now: ${fmtUsd(Math.ceil(floorUsd!))}`, ready: false }
                        : farFromMarket
                          ? { key: "market", label: "Too far from the market price", ready: false }
                          : { key: "swap", label: "Swap privately", ready: Boolean(shownPlan && relayOk === true) };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="gl-card min-w-0 p-5 sm:p-7">
        <div className="flex items-start justify-between gap-3 px-1 pb-5">
          <div className="min-w-0">
            <h2 className="t-title text-foreground">Swap</h2>
            <p className="mt-1 text-[14px] leading-relaxed text-mute">
              Who swapped stays private. The tokens and amounts show, like any trade.
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 py-1 text-[12px] font-medium text-sealed">
            <LockIcon />
            Private
          </span>
        </div>

        {link && (
          <SwapLinkBanner
            link={link}
            currentNetwork={networkKey}
            onSwitchNetwork={setNetworkKey}
            onDismiss={closeLink}
            step={linkStep}
            notOpen={linkNotOpen}
            partnerName={partnerName}
          />
        )}

        {!isConnected || !address ? (
          <div className="space-y-4 rounded-[20px] bg-surface p-6">
            <p className="text-[14px] leading-relaxed text-soft">
              {linkStep?.kind === "signin"
                ? linkStep.text
                : "Connect the wallet you use with Gloam to swap from your private balance."}
            </p>
            <WalletMenu />
          </div>
        ) : (
          <>
            {/* You pay */}
            <div className="gl-inputcard p-5 sm:p-6">
              <div key={`pay-${payAsset ?? ""}`} className="gl-settle">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="swap-amount" className="text-[13px] text-mute">
                  You pay
                </label>
                {held && payAsset && (
                  <span className="tnum truncate text-[12.5px] text-mute">
                    Private balance {formatAssetAmount(held.total, payAsset)}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <input
                  id="swap-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amountInput}
                  disabled={busy}
                  onChange={(e) => {
                    setAmountInput(e.target.value);
                    setDone(null);
                    setReceipt(null);
                  }}
                  size={1}
                  className={`gl-amount tnum w-0 min-w-0 flex-1 bg-transparent font-light leading-tight tracking-[-0.02em] text-foreground outline-none placeholder:text-faint disabled:opacity-60 ${amountSize(
                    amountInput || "0"
                  )}`}
                />
                {payAsset && (
                  <TokenPill
                    chainId={network.chainId}
                    asset={payAsset}
                    disabled={busy}
                    onClick={() => setPicker("pay")}
                    label="Choose the token you pay with"
                  />
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="tnum text-[13px] text-mute">{payUsd != null ? fmtUsd(payUsd) : " "}</span>
                <div className="flex gap-2" role="group" aria-label="Amount presets">
                  {[25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={busy || !held}
                      onClick={() => setShare(p)}
                      className="gl-chip min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                    >
                      {p === 100 ? "Max" : `${p}%`}
                    </button>
                  ))}
                </div>
              </div>
              {held && payAsset && refundCap != null && refundCap < held.largest ? (
                <p className="mt-4 text-[12.5px] leading-[1.6] text-mute">
                  Up to {formatAssetLabel(oneSwapMax, payAsset)} in one swap, so that if it can&apos;t finish, the vault can
                  take it back in one go. The rest stays in your private balance.
                </p>
              ) : (
                held &&
                payAsset &&
                held.notes.length > 1 &&
                held.largest < held.total && (
                  <p className="mt-4 text-[12.5px] leading-[1.6] text-mute">
                    Up to {formatAssetLabel(held.largest, payAsset)} in one swap. Your balance is in {held.notes.length} parts,
                    and a swap spends one.
                  </p>
                )
              )}
              </div>
            </div>

            {/* Flip */}
            <div className="relative z-[1] flex h-2 items-center justify-center">
              <button
                type="button"
                onClick={flip}
                disabled={!canFlip}
                aria-label="Switch what you pay and what you receive"
                title={canFlip ? "Switch" : "You need a private balance in the other token to switch"}
                className="gl-press grid h-11 w-11 place-items-center rounded-full border border-line bg-panel text-foreground shadow-card ring-[5px] ring-panel hover:border-line-strong focus-visible:outline-none focus-visible:ring-foreground/20 disabled:text-faint"
              >
                <span
                  className="inline-grid transition-transform duration-300 ease-[cubic-bezier(0.34,1.22,0.64,1)] motion-reduce:transition-none"
                  style={{ transform: `rotate(${turns * 180}deg)` }}
                >
                  <FlipIcon />
                </span>
              </button>
            </div>

            {/* You receive */}
            <div className="rounded-[20px] bg-surface p-5 sm:p-6" aria-live="polite">
              <div key={`get-${toAsset ?? ""}`} className="gl-settle">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-mute">You receive</span>
                {toAsset && holdings.get(toAsset.toLowerCase()) && (
                  <span className="tnum truncate text-[12.5px] text-mute">
                    Private balance {formatAssetAmount(holdings.get(toAsset.toLowerCase())!.total, toAsset)}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  {(waitingQuote || quoting) && !shownPlan ? (
                    <span className="gl-skeleton block h-[40px] w-40 sm:h-[48px]" aria-label="Getting a price" />
                  ) : (
                    <p
                      key={shownPlan ? shownPlan.amountOut.toString() : "none"}
                      className={`gl-settle gl-amount tnum truncate font-light leading-tight tracking-[-0.02em] ${amountSize(
                        receiveText
                      )} ${shownPlan ? "text-foreground" : "text-faint"}`}
                    >
                      {receiveText}
                    </p>
                  )}
                </div>
                {toAsset && (
                  <TokenPill
                    chainId={network.chainId}
                    asset={toAsset}
                    disabled={busy}
                    onClick={() => setPicker("receive")}
                    label="Choose the token you receive"
                  />
                )}
              </div>
              <p key={getUsd != null ? fmtUsd(getUsd) : "none"} className="gl-settle-fast tnum mt-4 text-[13px] text-mute">
                {getUsd != null ? fmtUsd(getUsd) : " "}
              </p>
              </div>
            </div>

            {/* Rate and details */}
            {shownPlan && payAsset && toAsset && amount !== null && (
              <div className="gl-settle mt-4 rounded-[18px] border border-line px-5">
                <div className="flex min-h-[52px] items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setInverse((v) => !v)}
                    className="tnum min-w-0 truncate text-left text-[13px] text-soft transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline"
                    aria-label="Flip the rate"
                  >
                    <span key={`${inverse}-${shownPlan.amountOut}`} className="gl-settle-fast inline-block">
                      {rateLine(amount, payAsset, shownPlan.amountOut, toAsset, inverse)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDetails((v) => !v)}
                    aria-expanded={showDetails}
                    className="inline-flex min-h-10 shrink-0 items-center gap-1 text-[13px] text-mute transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline"
                  >
                    Details
                    <Chevron open={showDetails} />
                  </button>
                </div>
                <div className="gl-collapse" data-open={showDetails} aria-hidden={!showDetails}>
                  <div>
                  <dl className="divide-y divide-line border-t border-line pb-1 text-[13px]">
                    <Row term="You receive exactly">{formatAssetLabel(shownPlan.amountOut, toAsset)}</Row>
                    <Row term={`Vault fee (${formatFeePercent(feeBps ?? 0)})`}>
                      {formatAssetLabel(withdrawFeeOf(amount, feeBps ?? 0), payAsset)}
                    </Row>
                    <Row term={`Price buffer (${formatFeePercent(swapBufferBps(network.chainId, payAsset ?? undefined, toAsset ?? undefined))})`}>
                      about {formatAssetLabel(shownPlan.leftover, payAsset)} to the treasury
                    </Row>
                    {impact != null && (
                      <Row term="Price impact">{impact < 1 ? "<0.01%" : formatFeePercent(impact)}</Row>
                    )}
                    <Row term="Route">{routeLine(network.chainId, payAsset, toAsset, shownPlan, venue)}</Row>
                    <Row term="Network fee">Paid by the Gloam relay</Row>
                    <Row term="Sent by">The Gloam relay, not your wallet</Row>
                  </dl>
                  </div>
                </div>
              </div>
            )}

            {((!notes.length && linkStep?.kind !== "add") ||
              priceError ||
              overRoom ||
              relayOk === false ||
              belowFloor ||
              farFromMarket ||
              (pegGap != null && pegGap >= PEG_WARN_BPS) ||
              (valueGap != null && valueGap >= VALUE_WARN_BPS) ||
              (impact != null && impact >= IMPACT_WARN_BPS) ||
              (note && amount !== null && amount < BigInt(note.amountWei))) && (
              <div className="gl-settle mt-4 space-y-2.5 px-1 text-[12.5px] leading-[1.6]">
                {/* a swap link's banner already says what to add */}
                {!notes.length && addable.length > 0 && linkStep?.kind !== "add" && (
                  <p className="text-mute">
                    You can check prices now. To swap, add {listOr(addable.map(assetLabel))} to your private balance
                    first.{" "}
                    <Link
                      href={`/app/vault${vaultActionSearch("shield", "")}`}
                      className="inline-flex min-h-10 items-center font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                    >
                      Add privately
                    </Link>
                  </p>
                )}
                {priceError && (
                  <p className="text-warn">
                    {priceError}
                    {quoteFits != null && payAsset ? ` Try about ${formatAssetLabel(quoteFits, payAsset)} or less.` : ""}
                  </p>
                )}
                {overRoom && room != null && toAsset && (
                  <p className="text-warn">
                    The vault takes at most {formatAssetLabel(room, toAsset)} right now.
                    {fitsIn != null && payAsset && fitsIn > 0n
                      ? ` Swap about ${formatAssetLabel(fitsIn, payAsset)} or less.`
                      : " Swap a smaller amount."}
                  </p>
                )}
                {impact != null && impact >= IMPACT_WARN_BPS && !priceError && (
                  <p className="text-warn">
                    This swap moves the price by about {formatFeePercent(impact)}, as the pool is thin. A smaller amount gets a
                    better rate.
                  </p>
                )}
                {pegGap != null && pegGap >= PEG_WARN_BPS && !priceError && (
                  <p className="text-warn">
                    These two are about {formatFeePercent(pegGap)} apart right now, so this is less than a dollar for a dollar.
                  </p>
                )}
                {valueGap != null && valueGap >= VALUE_WARN_BPS && !priceError && !(pegGap != null && pegGap >= PEG_WARN_BPS) && (
                  <p className="text-warn">
                    {farFromMarket
                      ? `You would get about ${formatFeePercent(valueGap)} less than this is worth at market prices, so the swap won't go.`
                      : `You get about ${formatFeePercent(valueGap)} less than this is worth at market prices, fees included.`}
                  </p>
                )}
                {belowFloor && (
                  <p className="text-mute">
                    The relay pays the gas, so on {network.label} a swap&apos;s vault fee has to cover it
                    {splits ? ", and the step that sets this part aside" : ""}. This floor moves with gas.
                  </p>
                )}
                {relayOk === false && (
                  <p className="text-warn">Swaps go through the Gloam relay, so your wallet never shows. It is off right now; try again soon.</p>
                )}
                {note && amount !== null && amount < BigInt(note.amountWei) && !priceError && (
                  <p className="text-mute">The rest stays in your private balance: it is set aside privately first.</p>
                )}
              </div>
            )}

            {gasHigh && (
              <div className="mt-4">
                <RelayGasNotice status={relayNow} label={network.label} />
              </div>
            )}

            <button
              type="button"
              disabled={!button.ready || busy}
              onClick={() => void onSwap()}
              className="btn btn-ink btn-lg btn-block mt-5 h-[52px]"
            >
              <span key={button.key} className="gl-settle-fast inline-flex min-w-0 items-center gap-2">
                {button.label}
              </span>
            </button>

            {error && (
              <p role="alert" className="gl-settle mt-4 break-words rounded-[14px] bg-danger-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-danger">
                {error}
              </p>
            )}
            {done && (
              <p className="gl-settle mt-4 rounded-[14px] bg-sealed-soft px-4 py-3.5 text-[13.5px] leading-relaxed text-foreground">{done}</p>
            )}
          </>
        )}
      </div>

      <aside className="min-w-0 space-y-4">
        <ExplorerCard />
        <PrivacyNotes venue={venue} />
      </aside>

      {picker && (
        <TokenPicker
          chainId={network.chainId}
          assets={assets}
          mode={picker}
          current={picker === "pay" ? payAsset : toAsset}
          other={picker === "pay" ? toAsset : payAsset}
          holdings={holdings}
          onPick={(a) => {
            if (picker === "pay") pickPay(a);
            else pickReceive(a);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      <SuccessModal
        open={receipt !== null}
        title="Swapped"
        body={
          receipt
            ? `${formatAssetLabel(receipt.receiveAmount, receipt.receive)} is in your private balance.`
            : ""
        }
        detail={
          receipt ? (
            <SwapPair
              chainId={network.chainId}
              pay={receipt.pay}
              payAmount={receipt.payAmount}
              receive={receipt.receive}
              receiveAmount={receipt.receiveAmount}
            />
          ) : null
        }
        primaryHref={receipt ? network.explorerTx(receipt.hash) : undefined}
        primaryLabel="View on explorer"
        secondaryLabel="Done"
        onClose={() => setReceipt(null)}
      />
    </div>
  );
}

/** Both marks and both amounts for a finished swap. Works for any pair, not one market. */
function SwapPair({
  chainId,
  pay,
  payAmount,
  receive,
  receiveAmount,
}: {
  chainId: number;
  pay: Address;
  payAmount: bigint;
  receive: Address;
  receiveAmount: bigint;
}) {
  const from = tokenFor(chainId, pay);
  const to = tokenFor(chainId, receive);
  const fromSymbol = from?.symbol ?? assetLabel(pay);
  const toSymbol = to?.symbol ?? assetLabel(receive);
  const paid = formatAssetAmount(payAmount, pay);
  const got = formatAssetAmount(receiveAmount, receive);
  return (
    <div
      className="flex items-center justify-center gap-2 rounded-[18px] bg-surface px-3 py-4 sm:gap-3 sm:px-4"
      aria-label={`Swapped ${paid} ${fromSymbol} for ${got} ${toSymbol}`}
    >
      <SwapSide label="You pay" id={from?.id ?? fromSymbol.toLowerCase()} symbol={fromSymbol} amount={paid} />
      <span aria-hidden className="shrink-0 text-[20px] font-light leading-none text-mute">
        →
      </span>
      <SwapSide label="You receive" id={to?.id ?? toSymbol.toLowerCase()} symbol={toSymbol} amount={got} />
    </div>
  );
}

function SwapSide({ label, id, symbol, amount }: { label: string; id: string; symbol: string; amount: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
      <p className="text-[12px] text-mute">{label}</p>
      <TokenLogo id={id} symbol={symbol} size={52} />
      <p className="tnum max-w-full text-[14px] font-medium leading-snug text-foreground">
        {amount} <span className="font-normal text-mute">{symbol}</span>
      </p>
    </div>
  );
}

function usdOf(raw: bigint, asset: string, marks: Record<string, number | null>): number | null {
  const m = marks[asset.toLowerCase()];
  if (m == null) return null;
  return Number(formatUnits(raw, assetDecimals(asset))) * m;
}

/** "1 USDG ≈ 0.4446 GLOAM", what the swap gives for each unit paid (fees included). */
function rateLine(amountIn: bigint, assetIn: string, amountOut: bigint, assetOut: string, inverse: boolean): string {
  const a = Number(formatUnits(amountIn, assetDecimals(assetIn)));
  const b = Number(formatUnits(amountOut, assetDecimals(assetOut)));
  if (!(a > 0) || !(b > 0)) return "";
  const [from, to, r] = inverse ? [assetOut, assetIn, a / b] : [assetIn, assetOut, b / a];
  const digits = r >= 100 ? 2 : r >= 1 ? 4 : 6;
  return `1 ${assetLabel(from)} ≈ ${r.toLocaleString("en-US", { maximumFractionDigits: digits })} ${assetLabel(to)}`;
}

/**
 * "USDG → ETH → GLOAM on Uniswap on Robinhood Chain": the hops the swap takes,
 * worked out as the router does (lib/vaultSwap routeCurrencies). The ends show
 * as the two tokens, so a WETH note paid in ETH at the first pool reads WETH.
 */
function routeLine(chainId: number, assetIn: Address, assetOut: Address, plan: SwapPlan, venue: string): string {
  if (!plan.route.length) return `Direct on ${venue}`;
  const r = swapRouterFor(chainId, plan.router);
  const path = r ? routeCurrencies(r, assetIn, assetOut, plan.route) : null;
  if (!path) return `On ${venue}`;
  const name = (a: string) => (same(a, ZERO) ? "ETH" : (tokenFor(chainId, a)?.symbol ?? assetLabel(a)));
  const names = path.map((a, i) => name(i === 0 ? assetIn : i === path.length - 1 ? assetOut : a));
  return `${names.join(" → ")} on ${venue}`;
}

/** "USDG", "USDG or GLOAM", "USDG, GLOAM or WETH". */
function listOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-2.5">
      <dt className="text-mute">{term}</dt>
      <dd className="tnum min-w-0 text-right text-foreground">{children}</dd>
    </div>
  );
}

function TokenPill({
  chainId,
  asset,
  onClick,
  disabled,
  label,
}: {
  chainId: number;
  asset: Address;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  const t = tokenFor(chainId, asset);
  const symbol = t?.symbol ?? assetLabel(asset);
  const id = t?.id ?? symbol.toLowerCase();
  // The mark sits inside the pill with even room around it, a disc or a rounded tile.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${label}, now ${symbol}`}
      className="gl-press inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-line bg-panel py-0 pl-[7px] pr-3 text-[15px] font-medium text-foreground shadow-card hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 disabled:opacity-60"
    >
      <TokenLogo id={id} symbol={symbol} size={30} />
      {symbol}
      <Chevron open={false} />
    </button>
  );
}

function TokenPicker({
  chainId,
  assets,
  mode,
  current,
  other,
  holdings,
  onPick,
  onClose,
}: {
  chainId: number;
  assets: readonly Address[];
  mode: "pay" | "receive";
  current: Address | null;
  other: Address | null;
  holdings: Map<string, { total: bigint; largest: bigint; notes: LocalNote[] }>;
  onPick: (a: Address) => void;
  onClose: () => void;
}) {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const first = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // A long list gets a search box; paying, the tokens held come first.
  const searchable = assets.length > 6;
  const [query, setQuery] = useState("");
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (a: Address) => {
      if (!q) return true;
      const t = tokenFor(chainId, a);
      return [t?.symbol ?? assetLabel(a), t?.name ?? "", a].some((x) => x.toLowerCase().includes(q));
    };
    const all = assets.filter(hit);
    if (mode !== "pay") return all;
    return [...all.filter((a) => holdings.has(a.toLowerCase())), ...all.filter((a) => !holdings.has(a.toLowerCase()))];
  }, [assets, chainId, holdings, mode, query]);
  // Closing plays the sheet out first (instantly with reduced motion), then
  // hands over to the parent.
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const leave = useCallback((then: () => void) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return then();
    setLeaving(true);
    window.setTimeout(then, 170);
  }, []);
  useEffect(() => {
    (search.current ?? first.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && leave(onClose);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, leave]);
  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center p-[16px] sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="swap-picker-title"
    >
      <button
        type="button"
        data-leaving={leaving}
        tabIndex={-1}
        aria-hidden="true"
        className="gl-backdrop absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={() => leave(onClose)}
      />
      <div
        data-leaving={leaving}
        className="gl-sheet relative z-[1] max-h-[min(80dvh,560px)] w-full max-w-[400px] overflow-y-auto rounded-[24px] bg-panel p-6 shadow-pop sm:p-7"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="swap-picker-title" className="text-[20px] font-light tracking-[-0.01em] text-foreground">
            {mode === "pay" ? "Pay with" : "Receive"}
          </h2>
          <button
            type="button"
            onClick={() => leave(onClose)}
            aria-label="Close"
            className="gl-press -mr-2 grid h-10 w-10 place-items-center rounded-full text-mute hover:bg-surface hover:text-foreground"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className="mt-1 text-[13px] text-mute">
          {mode === "pay" ? "From your private balance." : "Lands in your private balance."}
        </p>
        {searchable && (
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or symbol"
            aria-label="Search tokens"
            autoComplete="off"
            className="gl-input mt-4 h-11 px-3.5 text-[16px] sm:text-[14px]"
          />
        )}
        {listed.length === 0 && <p className="mt-5 px-1 text-[13px] text-mute">No token matches that.</p>}
        <ul className="mt-5 space-y-1.5">
          {listed.map((a, i) => {
            const t = tokenFor(chainId, a);
            const symbol = t?.symbol ?? assetLabel(a);
            const h = holdings.get(a.toLowerCase());
            const isCurrent = current != null && same(a, current);
            const blocked = mode === "pay" ? !h : false;
            const isOther = other != null && same(a, other);
            return (
              <li key={a}>
                <button
                  ref={i === 0 ? first : undefined}
                  type="button"
                  disabled={blocked}
                  onClick={() => leave(() => onPick(a))}
                  aria-current={isCurrent ? "true" : undefined}
                  className={`gl-press flex min-h-[60px] w-full items-center gap-3 rounded-[16px] px-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 disabled:cursor-not-allowed disabled:opacity-50 ${
                    isCurrent ? "bg-surface" : "hover:bg-surface"
                  }`}
                >
                  <TokenLogo id={t?.id ?? symbol.toLowerCase()} symbol={symbol} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium leading-tight text-foreground">{symbol}</span>
                    <span className="mt-0.5 block truncate text-[12.5px] leading-tight text-mute">
                      {t?.name ?? symbol}
                      {isOther ? (mode === "pay" ? " · now receiving" : " · now paying") : ""}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-right text-[13px] text-soft">
                    {h ? formatAssetAmount(h.total, a) : mode === "pay" ? "None" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body
  );
}

/**
 * What stays private, what is public, and what happens if a swap can't finish.
 * Kept in full, folded under the swap: the one-line summary always shows.
 */
/** What anyone can see of a private swap, laid out like the Pay tab's card. */
function ExplorerCard() {
  return (
    <div className="gl-card p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-mute">What the explorer shows</p>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 py-0.5 text-[12px] font-medium text-sealed">
          <LockIcon />
          Private
        </span>
      </div>
      <dl className="mt-3 divide-y divide-line text-[14px]">
        <div className="flex h-11 items-center justify-between gap-3">
          <dt className="text-mute">Swapped by</dt>
          <dd className="truncate text-foreground">Gloam relay</dd>
        </div>
        <div className="flex h-11 items-center justify-between gap-3">
          <dt className="text-mute">Your wallet</dt>
          <dd className="truncate text-foreground">Never shows</dd>
        </div>
        <div className="flex h-11 items-center justify-between gap-3">
          <dt className="text-mute">Tokens and amounts</dt>
          <dd className="truncate text-foreground">Public</dd>
        </div>
        <div className="flex h-11 items-center justify-between gap-3">
          <dt className="text-mute">Lands in</dt>
          <dd className="truncate text-foreground">Your private balance</dd>
        </div>
      </dl>
    </div>
  );
}

function PrivacyNotes({ venue }: { venue: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gl-card min-w-0 text-[13.5px] leading-[1.65] text-soft">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-14 w-full items-center justify-between gap-4 rounded-[inherit] px-5 py-4 text-left transition-colors duration-200 hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 sm:px-6"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-medium text-foreground">
            <LockIcon />
            Good to know
          </span>
          <span className="mt-1 block text-[13px] text-mute">
            How to keep a swap from linking back to you.
          </span>
        </span>
        <Chevron open={open} />
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-line px-5 pb-6 pt-5 sm:px-6">
            <p className="font-medium text-foreground">Private</p>
            <ul className="mt-2 space-y-2">
              <li>Who swapped. The Gloam relay sends it, so your wallet never shows.</li>
              <li>Which balance it came from, and where the new one goes next.</li>
            </ul>
            <p className="mt-5 font-medium text-foreground">Public</p>
            <ul className="mt-2 space-y-2">
              <li>The two amounts and the two tokens, as with any trade on {venue}.</li>
              <li>
                The amount you swap, too: swapping exactly what you added links back to that deposit. Swap a different
                amount.
              </li>
              <li>And cashing out exactly what you got can be matched to this swap. Send it on or cash out a different amount.</li>
            </ul>
            <p className="mt-5 font-medium text-foreground">If it can&apos;t finish</p>
            <p className="mt-2">
              Once a swap is sent, anyone can make it fail on purpose by sending its first step on its own. Then the money
              comes back to your private balance by itself, less up to 1%: the vault&apos;s cash-out fee and a safety margin
              that goes to the Gloam treasury.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent opacity-70 motion-safe:animate-spin"
    />
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`shrink-0 text-mute transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
    >
      <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FlipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 4v15m0 0-4-4m4 4 4-4M16 20V5m0 0-4 4m4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
