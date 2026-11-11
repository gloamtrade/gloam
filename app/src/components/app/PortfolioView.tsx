"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { formatEth } from "@/lib/chain";
import { useAppAccount, useAppBalance, useAppTokenBalances } from "@/lib/demo";
import { useNetwork } from "./NetworkProvider";
import { faucetFor } from "@/lib/faucet";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useLocalShieldNotes } from "@/hooks/useLocalShieldNotes";
import { useAutoRestoreStatus } from "@/hooks/useAutoRestoreStatus";
import { useTradingSettings } from "@/hooks/useTradingSettings";
import {
  formatTokenAmount,
  formatUsd,
  formatUsdCompact,
} from "@/lib/markets";
import {
  hasUiMultiplier,
  isAddableToken,
  isDollarStable,
  knownTokens,
  shieldTokensFor,
  isNativeAddable,
  swapDisplayTokensFor,
  walletDisplayTokensFor,
  type OnchainToken,
} from "@/lib/tokens";
import { isElysiumChainId } from "@/lib/elysium";
import { COINGECKO_MARKED, hasCoingeckoMarks, useCoingeckoMarks } from "@/hooks/useCoingeckoMarks";
import { useOpenGatedTokens } from "@/hooks/useOpenGatedTokens";
import {
  privateHeadline,
  tidyAmount,
  splitWalletRows,
  walletRowValue,
  walletTotal,
  type WalletHolding,
} from "@/lib/portfolioValue";
import {
  assetDecimals,
  assetLabel,
  formatAssetAmount,
  isNativeAsset,
  isShieldDeployed,
} from "@/lib/shield";
import { isClaimedNote, isSecuredClaim, isUnsecuredClaim } from "@/lib/claimSweep";
import { canExitVaultSwap } from "@/lib/vaultSwap";
import { SwapExit } from "./SwapExit";
import { SealedField } from "@/components/ui/SealedField";
import { ActivityFeed } from "./ActivityFeed";
import { AddressChip } from "./AddressChip";
import { FirstPaymentCard } from "./FirstPaymentCard";
import { RecoveryNudge } from "./RecoveryPanel";
import { OnboardingCard } from "./OnboardingCard";
import { PaymentNoteLine } from "./PaymentNote";
import { TokenLogo } from "./TokenLogo";
import { WalletMenu } from "./WalletMenu";
import { NetworkPulse } from "./NetworkPulse";
import { Sparkline } from "./Sparkline";
import { BRIDGE_DESTINATIONS, bridgeVisible } from "@/lib/bridge";
import { addAssetHref, pickAddAsset } from "@/lib/vaultHub";

// The swap sheet is most of the bridge code and brings the animation library;
// it loads after the page, for the one row that offers it.
const SwapToStableButton = dynamic(() => import("./BridgeIn").then((m) => m.SwapToStableButton), { ssr: false });

/* Small marks that carry the public / private duality. */
function LockIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7 17L17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ReceiveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M17 7L7 17M15 17H7V9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CashOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function QuickAction({
  href,
  label,
  short,
  icon,
  primary = false,
  disabled = false,
  className = "",
}: {
  href: string;
  label: string;
  /** A phone's name for it, where three share one row. */
  short?: string;
  icon: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const cls = `btn ${primary ? "btn-ink" : "btn-quiet"} ${className}`;
  const text = short ? (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="max-sm:hidden">{label}</span>
    </>
  ) : (
    label
  );
  if (disabled) {
    return (
      <span className={cls} aria-disabled="true" title="Not live yet">
        {icon}
        {text}
      </span>
    );
  }
  return (
    <Link href={href} className={cls} aria-label={short ? label : undefined}>
      {icon}
      {text}
    </Link>
  );
}

/** A row of the wallet card: the gas coin or a token the vault takes. */
type WalletRow = WalletHolding & {
  key: string;
  native: boolean;
  id: string;
  name: string;
  raw: bigint;
  decimals: number;
  change24h: number;
  spark: number[];
  /** Add takes it (the gas coin and the pool's tokens); a stock or swap token can't be added as it is. */
  addable: boolean;
};

const uiMultiplierAbi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
    >
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 py-10 max-sm:px-5 sm:px-6">
      <p className="text-[15px] text-foreground">{title}</p>
      {body && <p className="max-w-[48ch] text-[13.5px] leading-relaxed text-mute">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PortfolioView() {
  const { address, isConnected, chainId } = useAppAccount();
  const router = useRouter();
  const { network } = useNetwork();
  const onProduct = chainId === network.chainId;
  // Test funds exist on the testnets only; a mainnet has no faucet.
  const faucet = faucetFor(network.key);
  const faucetExternal = faucet?.url.startsWith("http") ?? false;
  // Tempo (testnet or mainnet) has no native coin worth counting.
  const isTempo = network.family === "tempo";
  const { settings } = useTradingSettings();
  const { data: marketData, isPlaceholderData: marketsPending } = useLiveMarkets();
  const ethUsd = marketData?.ethUsd ?? null;
  const markets = useMemo(() => marketData?.markets ?? [], [marketData]);
  // The native gas asset is priced differently per chain: Robinhood is ETH
  // (marked against ETH/USD), Tempo's native currency IS the US dollar, so a
  // unit is worth $1, never the ETH price. The wallet card labels it with the
  // chain's own symbol rather than a hardcoded "ETH".
  const nativeSymbol = network.primaryAsset.symbol;
  const isElysium = isElysiumChainId(network.chainId);
  // The gas coin's own price: HYPE on Elysium, never ETH's.
  const nativeUsdRate: number | null = isTempo ? 1 : isElysium ? (marketData?.hypeUsd ?? null) : ethUsd;
  const nativeId = isElysium ? "hype" : "eth";
  const nativeName = isElysium ? "Hyperliquid" : "Ether";
  // $GLOAM and the swap tokens on Robinhood Chain mainnet, and BDX on Base and Ethereum, priced like Transparency does.
  const { marks: geckoMarks, pending: geckoPending } = useCoingeckoMarks(hasCoingeckoMarks(network.chainId));
  // BDX, or ETH on Robinhood Chain, is offered to Add only once the vault's live limit for it is open.
  const openGated = useOpenGatedTokens();
  // A mainnet stock token is worth the share price times its uiMultiplier / 1e18 per raw
  // token (splits and dividends move it; balances never rebase), as the private swap marks it.
  const multTokens = useMemo(
    () => swapDisplayTokensFor(network.chainId).filter((t) => hasUiMultiplier(network.chainId, t)),
    [network.chainId]
  );
  const { data: multData, isPending: multsPending } = useReadContracts({
    contracts: multTokens.map(
      (t) => ({ address: t.address, abi: uiMultiplierAbi, functionName: "uiMultiplier", chainId: network.chainId }) as const
    ),
    query: { enabled: onProduct && multTokens.length > 0, staleTime: 5 * 60_000 },
  });
  const multiplierOf = useCallback(
    (t: OnchainToken): number | null => {
      const i = multTokens.findIndex((x) => x.address.toLowerCase() === t.address.toLowerCase());
      const r = i >= 0 ? multData?.[i] : undefined;
      return r?.status === "success" ? Number(r.result as bigint) / 1e18 : null;
    },
    [multTokens, multData]
  );
  /**
   * What one unit of a token is worth in dollars, or null when nothing here
   * prices it (EURC is a euro and never $1; a token with no feed): a dollar
   * stablecoin is $1, WETH is ETH's price, a stock its live mark, $GLOAM and
   * the swap tokens CoinGecko's.
   */
  const unitUsd = useCallback(
    (t: OnchainToken): number | null => {
      if (isDollarStable(t)) return 1;
      if (t.id === "weth") return ethUsd;
      const m = markets.find((x) => x.id === t.id);
      if (m?.mark) {
        if (!hasUiMultiplier(network.chainId, t)) return m.mark;
        // Unpriced until the multiplier is read, never the share price alone.
        const mult = multiplierOf(t);
        return mult == null ? null : m.mark * mult;
      }
      return geckoMarks.get(t.address.toLowerCase()) ?? null;
    },
    [ethUsd, markets, geckoMarks, network.chainId, multiplierOf]
  );
  /**
   * The price unitUsd gives a token is still on its way: the markets feed's
   * first read (WETH, the stocks; until then it holds placeholder marks) or
   * CoinGecko's. A dollar stablecoin and a token nothing prices never wait.
   */
  const pricePending = useCallback(
    (t: OnchainToken): boolean => {
      if (isDollarStable(t)) return false;
      if (hasUiMultiplier(network.chainId, t)) return marketsPending || (multsPending && multiplierOf(t) == null);
      if (t.id === "weth" || markets.some((x) => x.id === t.id)) return marketsPending;
      const a = t.address.toLowerCase();
      return geckoPending && COINGECKO_MARKED.some((c) => c.address.toLowerCase() === a);
    },
    [markets, marketsPending, geckoPending, network.chainId, multsPending, multiplierOf]
  );
  // Every token this network can hold, its own first (a swap leaves tokens the pool list doesn't name).
  const knownHere = useMemo(() => knownTokens(network.chainId), [network.chainId]);
  const {
    open: shieldNotes,
    waiting: waitingClaims,
    heldRefunds,
    merged: allNotes,
    shieldedWei,
    byAsset,
    syncing,
    balanceSyncing,
    refresh: refreshVault,
  } = useLocalShieldNotes(address);
  // Claimed payments the vault hasn't shown yet are listed after the balance, never counted in it.
  // Swap refunds held outside the vault too, and those first, as only six rows show.
  const vaultRows = useMemo(() => [...heldRefunds, ...shieldNotes, ...waitingClaims], [heldRefunds, shieldNotes, waitingClaims]);
  // A restore from the backup on its way (lib/autoRestore): the balance is not known yet, so never a 0.
  const autoRestore = useAutoRestoreStatus(address);
  const restoring = autoRestore.kind === "checking" || autoRestore.kind === "running";
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // The wallet card's zero balances, folded under "Show N more" until asked for.
  const [showEmptyRows, setShowEmptyRows] = useState(false);
  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    refreshVault();
    await queryClient.invalidateQueries().catch(() => {});
    window.setTimeout(() => setRefreshing(false), 600);
  };
  const shieldLive = isShieldDeployed();
  // The stablecoin a swap in the wallet should end in, which Add then takes.
  const swapTo = BRIDGE_DESTINATIONS[network.family]?.token.symbol ?? "a stablecoin";

  const { data: bal } = useAppBalance({
    address,
    chainId: network.chainId,
    enabled: Boolean(address),
  });

  // Public tokens differ by chain: equities on Robinhood, faucet stablecoins on
  // Tempo. Reading Robinhood's stock tokens on Tempo (or vice-versa) is exactly
  // why the holdings looked empty on the wrong chain.
  const tokenSet = useMemo(
    () => shieldTokensFor(network.chainId),
    [network.chainId]
  );
  // The wallet card also reads what a private swap or a cash-out can leave there
  // (stocks, WETH) that Add does not take: tokenSet stays what Add offers.
  const walletTokenSet = useMemo(() => walletDisplayTokensFor(network.chainId), [network.chainId]);

  const tokenAddresses = useMemo(() => walletTokenSet.map((t) => t.address), [walletTokenSet]);
  const tokenBals = useAppTokenBalances({
    tokens: tokenAddresses,
    address,
    chainId: network.chainId,
    enabled: onProduct,
  });

  const positions = useMemo(() => {
    return walletTokenSet
      .map((t, i) => {
        const raw = tokenBals[i] ?? BigInt(0);
        const m = markets.find((x) => x.id === t.id);
        // unitUsd: $1 a dollar stablecoin, a live mark, CoinGecko for $GLOAM; null (EURC): no USD shown
        const unit = unitUsd(t);
        const mark = unit ?? 0;
        const amount = Number(raw) / 10 ** t.decimals;
        const usd = amount * mark;
        return {
          ...t,
          raw,
          amount,
          mark,
          priced: unit != null,
          usd,
          pending: pricePending(t),
          change24h: m?.change24h ?? 0,
          spark: m?.spark ?? [],
          live: m?.source === "live",
        };
      })
      // A token Add doesn't take is listed only while held: 20-odd zero rows of stocks help no one.
      .filter((p) => p.raw > BigInt(0) || (!settings.hideZeroBalances && isAddableToken(network.chainId, p, openGated)));
  }, [network.chainId, walletTokenSet, tokenBals, markets, unitUsd, pricePending, settings.hideZeroBalances, openGated]);

  // The public balance to point at the vault: a dollar stablecoin first.
  const addSuggestion = useMemo(
    () =>
      pickAddAsset(
        positions
          .filter((p) => p.raw > BigInt(0) && isAddableToken(network.chainId, p, openGated))
          .map((p) => ({ id: p.id, symbol: p.symbol, address: p.address, raw: p.raw, amount: p.amount, dollar: isDollarStable(p) }))
      ),
    [positions, network.chainId, openGated]
  );

  const shieldRows = useMemo(() => {
    const rows: {
      asset: string;
      label: string;
      amount: bigint;
      usd: number | null;
    }[] = [];
    byAsset.forEach((amount, asset) => {
      if (amount <= BigInt(0)) return;
      const label = assetLabel(asset);
      let usd: number | null = null;
      if (isNativeAsset(asset) && nativeUsdRate != null) {
        usd = (Number(amount) / 1e18) * nativeUsdRate;
      } else {
        const tok = knownHere.find((t) => t.address.toLowerCase() === asset.toLowerCase());
        const unit = tok ? unitUsd(tok) : null;
        if (tok && unit != null) usd = (Number(amount) / 10 ** tok.decimals) * unit;
      }
      rows.push({ asset, label, amount, usd });
    });
    return rows.sort((a, b) => {
      if (isNativeAsset(a.asset)) return -1;
      if (isNativeAsset(b.asset)) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [byAsset, nativeUsdRate, knownHere, unitUsd]);

  // Tempo has no native coin: its nodes answer a wallet's native balance with a
  // huge placeholder, so on Tempo the wallet's public money is its stablecoins.
  const nativeWei = isTempo ? BigInt(0) : (bal?.value ?? BigInt(0));
  const ethAmt = Number(nativeWei) / 1e18;
  const shieldEthUsd =
    nativeUsdRate != null && shieldedWei > BigInt(0)
      ? (Number(shieldedWei) / 1e18) * nativeUsdRate
      : 0;
  const shieldStocksUsd = shieldRows
    .filter((r) => !isNativeAsset(r.asset))
    .reduce((s, r) => s + (r.usd ?? 0), 0);
  const ethUsdVal = nativeUsdRate != null ? ethAmt * nativeUsdRate : null;
  const stocksUsd = positions.reduce((s, p) => s + p.usd, 0);
  // On Robinhood the native ETH is a real holding and counts toward value. On
  // Tempo the native USD is a faucet balance (the faucet hands out an absurd
  // amount), so it is NOT portfolio value. Total value there reflects only what
  // you actually hold and have shielded (stablecoins + vault).
  const nativeHeldUsd = isTempo ? 0 : (ethUsdVal ?? 0);
  const totalUsd = nativeHeldUsd + stocksUsd + shieldEthUsd + shieldStocksUsd;

  const hasShield = shieldRows.length > 0;
  const stockCount = positions.filter((p) => p.raw > BigInt(0)).length;

  // Held but with no dollar price here (EURC is a euro, never $1; ETH while its price loads or
  // the feed is down): left out of the dollar figures on both sides, and said so, never $0.
  const unpricedRows = shieldRows.filter((r) => r.usd == null);
  const shieldUnpriced = unpricedRows.map((r) => r.label);
  const tokensUnpriced = positions.filter((p) => p.raw > BigInt(0) && !p.priced).map((p) => p.symbol);
  const publicUnpriced = [...(!isTempo && nativeWei > BigInt(0) && nativeUsdRate == null ? [nativeSymbol] : []), ...tokensUnpriced];
  const unpriced = [...new Set([...shieldUnpriced, ...publicUnpriced])];

  // Public (wallet + tokens) vs sealed (vault) split, the whole point.
  const publicUsd = nativeHeldUsd + stocksUsd;
  const sealedUsd = shieldEthUsd + shieldStocksUsd;
  const totalKnown = publicUsd + sealedUsd;
  // A share of the priced part only would mislead, so no split while something has no price.
  const sealedPct =
    isConnected && onProduct && totalKnown > 0 && unpriced.length === 0
      ? Math.round((sealedUsd / totalKnown) * 100)
      : null;

  // Balances only mean anything when the wallet is on this network. When it is
  // connected to a different chain, its on-chain reads belong to that foreign
  // chain (and can be absurdly large), so hold everything at zero until the
  // wallet is switched, which is exactly what the wrong-network banner says.
  const balancesVisible = isConnected && onProduct;

  // The wallet card: the gas coin (never on Tempo) and every token the vault
  // takes, in one list and one order, the zero balances folded after the rest.
  const walletRows = useMemo<WalletRow[]>(() => {
    const rows: WalletRow[] = positions.map((p) => ({
      key: p.id,
      native: false,
      id: p.id,
      symbol: p.symbol,
      name: p.name,
      raw: p.raw,
      decimals: p.decimals,
      amount: p.amount,
      usd: p.priced ? p.usd : null,
      dollar: isDollarStable(p),
      text: `${formatTokenAmount(p.raw, p.decimals)} ${p.symbol}`,
      pending: p.pending,
      change24h: p.change24h,
      spark: p.spark,
      addable: isAddableToken(network.chainId, p, openGated),
    }));
    if (nativeWei > BigInt(0)) {
      const amount = Number(nativeWei) / 1e18;
      rows.push({
        key: "native",
        native: true,
        id: nativeId,
        symbol: nativeSymbol,
        name: nativeName,
        raw: nativeWei,
        decimals: 18,
        amount,
        usd: nativeUsdRate == null ? null : amount * nativeUsdRate,
        dollar: false,
        text: `${formatEth(nativeWei)} ${nativeSymbol}`,
        pending: marketsPending,
        change24h: 0,
        spark: [],
        addable: true,
      });
    }
    return rows;
  }, [network.chainId, positions, nativeWei, nativeSymbol, nativeId, nativeName, nativeUsdRate, marketsPending, openGated]);
  const walletSplit = useMemo(() => splitWalletRows(walletRows), [walletRows]);
  const foldEmpty = walletSplit.held.length > 0 && walletSplit.empty.length > 0;
  const walletShown = foldEmpty && !showEmptyRows ? walletSplit.held : [...walletSplit.held, ...walletSplit.empty];
  // A balance still being read leaves the total out until it is (a demo answers at once).
  const walletReading = tokenBals.some((b) => b === undefined) || (!isTempo && !bal);
  const walletSum = walletTotal({
    showUsd: settings.showUsd,
    loading: walletReading,
    rows: walletRows,
    formatUsd: formatUsdCompact,
  });

  const totalDisplay = !balancesVisible
    ? settings.showUsd
      ? formatUsd(0)
      : `0 ${nativeSymbol}`
    : totalUsd != null && settings.showUsd
      ? formatUsdCompact(totalUsd)
      : `${formatEth(nativeWei + shieldedWei)} ${nativeSymbol}`;

  // The public side in one figure, for the hero card's foot: the gas coin and
  // the tokens together (Holdings below lists them one by one).
  const publicDisplay =
    settings.showUsd
      ? formatUsdCompact(balancesVisible ? publicUsd : 0)
      : `${formatEth(balancesVisible ? nativeWei : BigInt(0))} ${nativeSymbol}, ${stockCount} ${stockCount === 1 ? "token" : "tokens"}`;

  // The hero number: what sits in the vault, only readable in this browser. What the
  // dollars leave out is shown by amount: "$100 + 1,000 GLOAM" rather than "2 assets".
  // A short amount: this is the big number, and the rows below keep every decimal.
  const amountOfRow = (r: (typeof shieldRows)[number]) =>
    `${tidyAmount(Number(formatUnits(r.amount, isNativeAsset(r.asset) ? 18 : assetDecimals(r.asset))))} ${r.label}`;
  const vaultValue = !balancesVisible
    ? "0"
    : !hasShield
      ? "0"
      : shieldRows.length === 1
        ? amountOfRow(shieldRows[0])
        : `${shieldRows.length} assets`;

  const privateDisplay = !balancesVisible
    ? settings.showUsd
      ? formatUsd(0)
      : "0"
    : privateHeadline({
        showUsd: settings.showUsd,
        sealedUsd,
        unpriced: unpricedRows.map(amountOfRow),
        vaultValue,
        formatUsd: formatUsdCompact,
      });
  const privateSub = !isConnected
    ? "Connect a wallet to see your private balance."
    : !onProduct
      ? `Switch your wallet to ${network.label} to see balances.`
      : restoring
        ? autoRestore.kind === "running" && autoRestore.prompt
          ? "Confirm in your wallet to bring your private balance to this device. It's free and sends nothing."
          : "Syncing your private balance…"
        : balanceSyncing
        ? "Syncing your vault…"
        : !hasShield
          ? shieldLive
            ? addSuggestion
              ? `You have ${formatAssetAmount(addSuggestion.raw, addSuggestion.address)} ${addSuggestion.symbol} in your wallet. Add it privately and only you will see this number.`
              : "Nothing here yet. Add money privately and only you will see this number."
            : "The private vault is not live on this network yet."
          : settings.showUsd && sealedUsd > 0 && shieldUnpriced.length === 0
            ? `${vaultValue} in your vault. Nobody else can see it.`
            : "Hidden from the public. Only you can see it.";


  return (
    <div className="space-y-5">
      <OnboardingCard />

      {/* Private balance: the hero. The field behind it is the sealed signal.
          One idea per row: what is private, the number, what to do with it,
          then the public side in one quiet line at the foot. */}
      <section className="gl-card relative overflow-hidden">
        <SealedField tone="soft" />
        <div className="relative z-[1] max-sm:p-6 sm:p-8 lg:p-10">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="text-[14px] text-soft">Private balance</span>
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 text-[12px] font-medium text-sealed">
                <LockIcon />
                Only you
              </span>
            </div>
            <div className="-mr-2 flex items-center gap-0.5">
              <NetworkPulse />
              <button
                type="button"
                onClick={() => void refreshAll()}
                disabled={refreshing || !isConnected}
                aria-label="Refresh balances"
                title="Refresh balances"
                className="grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground disabled:opacity-60"
              >
                <svg
                  aria-hidden
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  className={refreshing || syncing ? "animate-spin motion-reduce:animate-none" : undefined}
                >
                  <path
                    d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          <p
            className={`tnum mt-8 truncate max-sm:text-[52px] font-light leading-none tracking-[-0.03em] sm:text-[72px] lg:mt-10 ${
              balancesVisible && hasShield ? "text-foreground" : "text-foreground/85"
            }`}
          >
            {restoring && !hasShield ? (
              <span className="gl-skeleton inline-block h-[0.85em] w-[min(14rem,60%)] align-baseline" aria-label="Loading your private balance" />
            ) : (
              privateDisplay
            )}
          </p>
          <p className="mt-4 max-w-[64ch] text-[15px] leading-relaxed text-mute">{privateSub}</p>

          {/* One primary action; the other three money moves sit beside it,
              quiet. The same names as the nav under Vault, so Pay is never a
              public send. */}
          <div className="mt-8 flex flex-wrap items-center gap-x-1 gap-y-2 max-sm:grid max-sm:grid-cols-3 lg:mt-10">
            <QuickAction
              href={addSuggestion ? addAssetHref(addSuggestion.id) : "/app/vault?tab=shield"}
              label="Add privately"
              icon={<AddIcon />}
              primary
              disabled={!shieldLive}
              className="btn-lg mr-3 max-sm:col-span-3 max-sm:mr-0"
            />
            <QuickAction href="/app/vault?tab=move" label="Pay privately" short="Pay" icon={<SendIcon />} disabled={!shieldLive} className="max-sm:px-2" />
            <QuickAction href="/app/vault?tab=move&mode=receive" label="Receive" icon={<ReceiveIcon />} className="max-sm:px-2" />
            <QuickAction href="/app/vault?tab=move&mode=cashout" label="Cash out" icon={<CashOutIcon />} disabled={!shieldLive} className="max-sm:px-2" />
          </div>
        </div>

        {/* network banner lives in the card footer; the sidebar already
            carries the connect control, so no connect prompt here */}
        {isConnected && !onProduct && (
          <div className="relative z-[1] flex max-sm:flex-col gap-3 border-t border-line max-sm:px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
            <p className="text-[14px] text-danger">Switch your wallet to {network.label} to see balances.</p>
            <WalletMenu />
          </div>
        )}
        {/* The public side, once: what the wallet holds and the total, with
            the share that is private. With nothing private yet the line above
            already names the wallet's money, so the foot keeps to the address. */}
        {isConnected && onProduct && address && (
          <div className="relative z-[1] flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line py-3 max-sm:px-6 sm:px-8 lg:px-10">
            {hasShield ? (
              <dl className="tnum flex min-w-0 flex-wrap items-baseline gap-x-6 gap-y-1 text-[13px]">
                <div className="flex items-baseline gap-2">
                  <dt className="text-mute">In your wallet</dt>
                  <dd className="text-foreground">{publicDisplay}</dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-mute">Total</dt>
                  <dd className="text-foreground">
                    {totalDisplay}
                    {sealedPct != null && <span className="text-mute">, {sealedPct}% private</span>}
                  </dd>
                </div>
                {settings.showUsd && unpriced.length > 0 && (
                  <div className="text-mute">Not in the total: {unpriced.join(", ")}, no dollar price</div>
                )}
              </dl>
            ) : (
              <span className="text-[12.5px] text-mute">Wallet</span>
            )}
            <AddressChip address={address} className="min-h-10 text-[12.5px]" />
          </div>
        )}
      </section>

      {/* Recovery: back the private balance up, or bring it back on a new device. */}
      {onProduct && shieldLive && (
        <RecoveryNudge
          hasBalance={shieldNotes.some((n) => Boolean(n.secret) && n.secret !== "0x")}
          hasDeposits={allNotes.some((n) => n.source === "chain")}
        />
      )}

      {/* Holds a private balance here but has never paid privately from this
          device: point at Pay with a small amount filled in. */}
      {balancesVisible && hasShield && shieldLive && (
        <FirstPaymentCard open={shieldNotes} all={allNotes} chainId={network.chainId} />
      )}

      {/* Main split: vault + holdings, with the public feed alongside */}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 space-y-5 lg:col-span-8">
          {vaultRows.length > 0 && (
            <section className="gl-card overflow-hidden">
              <header className="flex items-center justify-between gap-3 max-sm:px-5 pb-3 pt-5 sm:px-6">
                <div>
                  <h2 className="text-[17px] text-foreground">Private balance</h2>
                  <p className="mt-0.5 text-[13px] text-mute">Only you can see these amounts</p>
                </div>
              </header>
              <ul className="divide-y divide-line border-t border-line">
                {vaultRows.slice(0, 6).map((n) => (
                  <li
                    key={n.id}
                    className="flex min-h-[64px] items-center justify-between gap-3 max-sm:px-5 py-3 transition-colors hover:bg-surface/60 sm:px-6"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <TokenLogo
                        id={
                          isNativeAsset(n.asset)
                            ? nativeId
                            : (tokenSet.find((t) => t.address.toLowerCase() === n.asset.toLowerCase())?.id ??
                              assetLabel(n.asset).toLowerCase())
                        }
                        symbol={assetLabel(n.asset)}
                        size={34}
                      />
                      <div className="min-w-0">
                        <p className="tnum truncate text-[15px] text-foreground">
                          {isNativeAsset(n.asset)
                            ? formatEth(BigInt(n.amountWei))
                            : formatAssetAmount(BigInt(n.amountWei), n.asset)}{" "}
                          <span className="text-mute">{assetLabel(n.asset)}</span>
                        </p>
                        <p className="mt-0.5 truncate text-[12.5px] text-mute">
                          {n.refundHeld
                            ? "Not in your balance yet"
                            : n.unfunded
                              ? "Waiting for this payment to reach the vault. Not in your balance yet."
                              : n.swapProofAt
                                ? "Moving to a fresh private balance"
                                : n.leafIndex != null
                                  ? "Ready to use"
                                  : "Confirming…"}
                          {!n.unfunded && !n.refundHeld && (isClaimedNote(n) || isSecuredClaim(n)) ? ", received" : ""}
                        </p>
                        {n.refundHeld && (
                          <p className="mt-0.5 text-[12.5px] text-warn">
                            {n.refundHeld === "blocked"
                              ? "A swap of this couldn't finish, and the vault isn't taking this token back right now. It stays held and comes back once the vault takes it again. Gloam tries each time you open the app."
                              : "A swap of this couldn't finish, so it's on its way back to your private balance."}
                          </p>
                        )}
                        {canExitVaultSwap(n) && <SwapExit note={n} onDone={refreshVault} />}
                        {isUnsecuredClaim(n) && !n.unfunded && (
                          <p className="mt-0.5 text-[12.5px] text-warn">
                            Not secured yet, so the sender can still take it back.{" "}
                            <Link
                              href="/app/vault?tab=move"
                              className="font-medium underline underline-offset-4"
                            >
                              Secure it
                            </Link>
                          </p>
                        )}
                        {n.note && (
                          <PaymentNoteLine
                            note={n.note}
                            label="Their note"
                            className="mt-0.5 text-[12.5px] text-soft"
                          />
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {n.txHash && (
                        <a
                          href={network.explorerTx(n.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="h-10 items-center rounded-full px-3 text-[13px] text-mute transition-colors hover:bg-surface hover:text-foreground max-sm:hidden sm:inline-flex"
                        >
                          Receipt
                        </a>
                      )}
                      {network.stocks && (
                        <Link
                          href={
                            isNativeAsset(n.asset)
                              ? "/app/trade"
                              : `/app/trade?side=sell&market=${
                                  tokenSet.find(
                                    (t) =>
                                      t.address.toLowerCase() ===
                                      n.asset.toLowerCase()
                                  )?.id ?? "tsla"
                                }`
                          }
                          className="btn btn-quiet btn-sm h-10"
                        >
                          Trade
                        </Link>
                      )}
                      <Link href="/app/vault?tab=move" className="btn btn-ghost btn-sm h-10">
                        Pay
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
              {/* What a private balance is for, one tap from each. */}
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-3 max-sm:px-5 sm:px-6">
                <p className="text-[13px] text-mute">Pay from it privately, or cash out to any wallet.</p>
                <div className="flex gap-1">
                  <Link href="/app/vault?tab=move" className="btn btn-quiet btn-sm h-10">
                    Pay privately
                  </Link>
                  <Link href="/app/vault?tab=move&mode=cashout" className="btn btn-quiet btn-sm h-10">
                    Cash out
                  </Link>
                </div>
              </div>
            </section>
          )}

          {/* In your wallet: the public side, its total on the right. The rows
              follow the card's own width (a container), not the window's: at
              1024 the card is narrow beside the activity feed, and fixed 24h
              and action columns left the asset's name no room at all. */}
          <section className="gl-card @container overflow-hidden">
            <header className="flex items-start justify-between gap-4 max-sm:px-5 pb-3 pt-5 sm:px-6">
              <div className="min-w-0">
                <h2 className="text-[17px] text-foreground">In your wallet</h2>
                <p className="mt-0.5 text-[13px] text-mute">Public: anyone can see these on the explorer</p>
              </div>
              {balancesVisible && walletRows.length > 0 && walletSum.state === "ready" && (
                <div className="shrink-0 text-right">
                  <p className="tnum text-[17px] text-foreground">
                    <span className="sr-only">Total in your wallet: </span>
                    {walletSum.figure}
                  </p>
                  {walletSum.extra && (
                    <p className="tnum mt-0.5 text-[13px] text-mute">
                      {walletSum.extra}
                      <span className="sr-only">, no dollar price</span>
                    </p>
                  )}
                </div>
              )}
              {balancesVisible && walletRows.length > 0 && walletSum.state === "loading" && (
                <span
                  role="status"
                  aria-label="Loading the total"
                  className="mt-1 inline-block h-5 w-16 shrink-0 rounded-md bg-surface-2 motion-safe:animate-pulse"
                />
              )}
            </header>
            {!balancesVisible ? (
              <div className="border-t border-line">
                <EmptyState
                  title={!isConnected ? "Connect a wallet" : `Switch to ${network.label}`}
                  body={
                    !isConnected
                      ? faucet
                        ? "Your tokens from the faucet show up here once you connect."
                        : "Your tokens show up here once you connect."
                      : `Your wallet is on another network. Switch it to ${network.label} to see your tokens.`
                  }
                />
              </div>
            ) : walletRows.length === 0 ? (
              <div className="border-t border-line">
                {faucet ? (
                  <EmptyState
                    title="No tokens yet"
                    body="Claim free test tokens to try paying and holding privately."
                    action={
                      <a
                        href={faucet.url}
                        target={faucetExternal ? "_blank" : undefined}
                        rel={faucetExternal ? "noreferrer" : undefined}
                        className="btn btn-ghost h-10"
                      >
                        Claim from the faucet
                      </a>
                    }
                  />
                ) : (
                  <EmptyState
                    title="No tokens yet"
                    body={`Gloam takes ${tokenSet.map((t) => t.symbol).join(", ")} on ${network.label}. Once one is in your wallet, you can add it privately.`}
                    action={
                      shieldLive && bridgeVisible(network) ? (
                        <Link href="/app/vault?tab=shield" className="btn btn-ghost h-10">
                          Bring money over
                        </Link>
                      ) : undefined
                    }
                  />
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-x-3 border-t border-line py-2.5 max-sm:px-5 sm:px-6">
                  <span className="t-label flex-1">Asset</span>
                  <span className="t-label hidden w-[88px] text-center @2xl:block">24h</span>
                  <span className="t-label w-28 text-right">Balance</span>
                  <span className="hidden w-[200px] @xl:block" aria-hidden />
                </div>
                <ul className="divide-y divide-line border-t border-line">
                  {walletShown.map((r) => {
                    const value = walletRowValue(r, settings.showUsd, formatUsd);
                    return (
                      <li
                        key={r.key}
                        className="flex min-h-[64px] flex-wrap items-center gap-x-3 gap-y-2.5 py-3 transition-colors hover:bg-surface/60 max-sm:px-5 sm:px-6 @xl:flex-nowrap"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <TokenLogo id={r.id} symbol={r.symbol} size={34} />
                          <div className="min-w-0">
                            <p className="truncate text-[14px] font-medium text-foreground">{r.symbol}</p>
                            <p className="truncate text-[12.5px] text-mute">{r.name}</p>
                          </div>
                        </div>
                        {r.native ? (
                          <div className="hidden w-[88px] @2xl:block" aria-hidden />
                        ) : (
                          <div className="hidden w-[88px] justify-center @2xl:flex">
                            <Sparkline
                              // Real history only: without it the line stays a flat hairline.
                              points={r.spark.length >= 2 ? r.spark : []}
                              up={r.change24h >= 0}
                              width={72}
                              height={26}
                            />
                          </div>
                        )}
                        <div className="w-28 text-right">
                          <p className="tnum text-[14px] text-foreground">
                            {r.native ? formatEth(r.raw) : formatTokenAmount(r.raw, r.decimals)}
                          </p>
                          {value && <p className="tnum text-[12.5px] text-mute">{value}</p>}
                        </div>
                        <div className="flex gap-1 @max-xl:w-full @max-xl:justify-start @max-xl:pl-[46px] @max-xl:empty:hidden @xl:w-[200px] @xl:justify-end">
                          {r.native ? (
                            // The gas coin. Until the pool takes it (Robinhood Chain mainnet,
                            // before ETH's limit lands), swap it into the stablecoin it does.
                            shieldLive && isNativeAddable(network.chainId, openGated) ? (
                              <Link href={addAssetHref("eth")} className="btn btn-ghost btn-sm h-10">
                                Add privately
                              </Link>
                            ) : (
                              <SwapToStableButton recipient={address ?? undefined} onArrived={() => router.push("/app/shield")} />
                            )
                          ) : (
                            <>
                              {shieldLive &&
                                (r.addable ? (
                                  <Link href={addAssetHref(r.id)} className="btn btn-ghost btn-sm h-10">
                                    Add privately
                                  </Link>
                                ) : (
                                  // Add only takes the pool's tokens, so a stock or swap token can't go in as it is.
                                  // The in-app swap sells the gas coin only, so point at the wallet's own swap.
                                  <div className="flex flex-col items-end gap-1 @max-xl:items-start">
                                    <button
                                      type="button"
                                      aria-disabled="true"
                                      aria-describedby={`swap-hint-${r.key}`}
                                      className="btn btn-ghost btn-sm h-10 cursor-not-allowed opacity-50"
                                    >
                                      Swap to {swapTo}
                                    </button>
                                    <p id={`swap-hint-${r.key}`} className="text-[12px] leading-tight text-mute @xl:text-right">
                                      Swap to {swapTo} in your wallet, then add
                                    </p>
                                  </div>
                                ))}
                              {network.stocks && (
                                <Link href={`/app/trade?market=${r.id}`} className="btn btn-quiet btn-sm h-10">
                                  Trade
                                </Link>
                              )}
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {/* The zero balances fold away; each one's Add privately is a tap behind this. */}
                {foldEmpty && (
                  <div className="border-t border-line py-2 max-sm:px-5 sm:px-6">
                    <button
                      type="button"
                      aria-expanded={showEmptyRows}
                      onClick={() => setShowEmptyRows((v) => !v)}
                      className="btn btn-quiet btn-sm -ml-4 h-10 text-mute hover:text-foreground"
                    >
                      {showEmptyRows ? "Show less" : `Show ${walletSplit.empty.length} more`}
                      <ChevronIcon open={showEmptyRows} />
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-4">
          <ActivityFeed />
        </div>
      </div>
    </div>
  );
}
