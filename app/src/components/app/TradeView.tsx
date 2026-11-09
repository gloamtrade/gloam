"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits, isAddress } from "viem";
import { formatEth, shortAddress } from "@/lib/chain";
import { useNetwork } from "./NetworkProvider";
import { safeParseEther, safeParseUnits } from "@/lib/amount";
import { AmountProblem } from "./AmountProblem";
import {
  DEX_FACTORY,
  DEX_ROUTER,
  WETH,
  ZERO_ADDRESS,
  applySlippage,
  deadlineSeconds,
  erc20Abi,
  factoryAbi,
  routerAbi,
} from "@/lib/dex";
import { useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useTradingSettings } from "@/hooks/useTradingSettings";
import { formatMark, formatUsd } from "@/lib/markets";
import { isShieldDeployed } from "@/lib/shield";
import { WalletMenu } from "./WalletMenu";
import { NetworkPulse } from "./NetworkPulse";
import { PriceChart } from "./PriceChart";
import { Sparkline } from "./Sparkline";
import { StatusPill } from "./StatusPill";
import { SuccessModal } from "./SuccessModal";
import { VaultTradePanel } from "./VaultTradePanel";
import { SealedTradePanel } from "./SealedTradePanel";
import { TokenLogo } from "./TokenLogo";
import { walletErrorForPeople } from "@/lib/walletErrors";

type Side = "buy" | "sell";
type InputMode = "token" | "usd";
type TxKind = "transfer" | "approve" | "buy" | "sell" | null;
type PathMode = "public" | "vault" | "sealed";

function LockGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" fill="currentColor" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}
function EyeGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function TradeView() {
  const { address, isConnected } = useAccount();
  const { network } = useNetwork();
  const chainId = useChainId();
  const onProduct = chainId === network.chainId;
  const search = useSearchParams();
  const { settings } = useTradingSettings();
  const { data, isFetching, isError, refetch, isFetched } = useLiveMarkets();
  // one array per response, so the memos and effects below re-run only when it changes
  const markets = useMemo(() => data?.markets ?? [], [data?.markets]);
  const ethUsd = data?.ethUsd ?? null;
  const liveCount = data?.meta?.liveCount ?? 0;
  const shieldLive = isShieldDeployed();

  const searchMarket = search.get("market");
  const pathParam = search.get("path");
  const sideParam = search.get("side"); // sealed trade: buy | sell
  // Settings load after the first render, so the saved default side is read
  // on every render until the person picks one here; frozen into state, it was
  // always "buy".
  const [pickedSide, setSide] = useState<Side | null>(null);
  const side: Side = pickedSide ?? settings.defaultSide;
  const sealedSide: Side = sideParam === "buy" || sideParam === "sell" ? sideParam : settings.defaultSide;
  const [marketId, setMarketId] = useState(searchMarket ?? "tsla");
  const [amount, setAmount] = useState("");
  const [inputMode, setInputMode] = useState<InputMode>("token");
  const [filter, setFilter] = useState<"all" | "onchain" | "private" | "stocks">(
    "private"
  );
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<"swap" | "transfer">("transfer");
  const [pathMode, setPathMode] = useState<PathMode>(() => {
    // path=private is an alias for sealed private trade
    if (pathParam === "sealed" || pathParam === "private") return "sealed";
    if (pathParam === "vault" && shieldLive) return "vault";
    if (pathParam === "public") return "public";
    // Private-first: default to sealed when the vault is live.
    return shieldLive ? "sealed" : "public";
  });
  const [error, setError] = useState<string | null>(null);
  const [successOpen, setSuccessOpen] = useState(false);
  const [successTitle, setSuccessTitle] = useState("Done");
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();
  const [pendingKind, setPendingKind] = useState<TxKind>(null);
  const handledHash = useRef<string | null>(null);

  // Sync market from URL
  useEffect(() => {
    if (searchMarket && markets.some((m) => m.id === searchMarket)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- follows a ?market= link once that market is in the live list
      setMarketId(searchMarket);
    }
  }, [searchMarket, markets]);

  // Sync path tab from URL; default private-ready markets to sealed
  useEffect(() => {
    if (pathParam === "sealed" || pathParam === "private") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- follows a ?path= link, or opens sealed for a market that can trade privately
      setPathMode("sealed");
      return;
    }
    if (pathParam === "vault" && shieldLive) {
      setPathMode("vault");
      return;
    }
    if (pathParam === "public") {
      setPathMode("public");
      return;
    }
    // No path param: open sealed when this market can private-trade
    const m = markets.find((x) => x.id === (searchMarket ?? marketId));
    if (m?.privateReady && shieldLive) {
      setPathMode("sealed");
    }
  }, [pathParam, searchMarket, marketId, markets, shieldLive]);

  const resolvedId = markets.some((m) => m.id === marketId)
    ? marketId
    : markets.find((m) => m.address)?.id ?? markets[0]?.id ?? "tsla";

  const market = useMemo(
    () => markets.find((m) => m.id === resolvedId) ?? markets[0],
    [markets, resolvedId]
  );

  const list = useMemo(() => {
    if (filter === "all") return markets;
    if (filter === "onchain") return markets.filter((m) => Boolean(m.address));
    if (filter === "private")
      return markets.filter((m) => Boolean(m.privateReady));
    return markets.filter((m) => m.kind === "stock");
  }, [filter, markets]);

  const token = market?.address as `0x${string}` | undefined;
  const hasToken = Boolean(token);

  const { data: pair } = useReadContract({
    address: DEX_FACTORY,
    abi: factoryAbi,
    functionName: "getPair",
    args: token ? [token, WETH] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(token) },
  });

  const hasPool =
    Boolean(pair) && pair !== ZERO_ADDRESS && pair !== undefined;

  const { data: ethBal, refetch: refetchEth } = useBalance({
    address,
    chainId: network.chainId,
    query: { enabled: Boolean(address) },
  });

  const { data: tokenBal, refetch: refetchTok } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(address && token) },
  });

  const { data: allowance, refetch: refetchAllow } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, DEX_ROUTER] : undefined,
    chainId: network.chainId,
    query: { enabled: Boolean(address && token && hasPool) },
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a different market starts on the mode it supports
    if (hasPool) setMode("swap");
    else if (hasToken) setMode("transfer");
  }, [hasPool, hasToken, resolvedId]);

  const mark = market?.mark ?? 0;
  const tokenAmt = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (inputMode === "usd") return mark > 0 ? n / mark : 0;
    return n;
  }, [amount, inputMode, mark]);

  const usdAmt = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (inputMode === "usd") return n;
    return n * mark;
  }, [amount, inputMode, mark]);

  const buyEthIn = useMemo(() => {
    if (side !== "buy") return 0n;
    if (!ethUsd || ethUsd <= 0 || usdAmt <= 0) return 0n;
    const eth = usdAmt / ethUsd;
    if (!Number.isFinite(eth) || eth <= 0) return 0n;
    return safeParseEther(eth.toFixed(8)) ?? 0n;
  }, [side, ethUsd, usdAmt]);

  const { data: buyQuote } = useReadContract({
    address: DEX_ROUTER,
    abi: routerAbi,
    functionName: "getAmountsOut",
    args:
      hasPool && token && buyEthIn > 0n && side === "buy" && mode === "swap"
        ? [buyEthIn, [WETH, token]]
        : undefined,
    chainId: network.chainId,
    query: {
      enabled: hasPool && Boolean(token) && buyEthIn > 0n && side === "buy",
    },
  });

  const sellAmountIn = useMemo(
    () => (tokenAmt > 0 ? safeParseUnits(tokenAmt.toFixed(8), 18) : null),
    [tokenAmt]
  );

  const { data: sellQuote } = useReadContract({
    address: DEX_ROUTER,
    abi: routerAbi,
    functionName: "getAmountsOut",
    args:
      hasPool &&
      token &&
      sellAmountIn &&
      sellAmountIn > 0n &&
      side === "sell" &&
      mode === "swap"
        ? [sellAmountIn, [token, WETH]]
        : undefined,
    chainId: network.chainId,
    query: {
      enabled:
        hasPool &&
        Boolean(token) &&
        Boolean(sellAmountIn && sellAmountIn > 0n) &&
        side === "sell",
    },
  });

  const quoteOut = side === "buy" ? buyQuote?.[1] : sellQuote?.[1];

  const {
    writeContract,
    data: txHash,
    isPending,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: network.chainId,
  });

  // After approve, auto-submit sell once allowance is enough
  useEffect(() => {
    if (!isSuccess || !txHash || !pendingKind) return;
    if (handledHash.current === txHash) return;
    handledHash.current = txHash;

    void refetchEth();
    void refetchTok();
    void refetchAllow();

    if (pendingKind === "approve") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the approval's receipt arrived: clear the pending step once per transaction
      setPendingKind(null);
      setError(null);
      // will re-enable sell on next click with fresh allowance, auto sell:
      // wait for allowance refetch via short delay then sell
      return;
    }

    setLastHash(txHash);
    setSuccessTitle(
      pendingKind === "transfer"
        ? "Tokens sent"
        : pendingKind === "buy"
          ? "Bought"
          : "Sold"
    );
    setSuccessOpen(true);
    setPendingKind(null);
  }, [
    isSuccess,
    txHash,
    pendingKind,
    refetchEth,
    refetchTok,
    refetchAllow,
  ]);

  // Auto-continue sell after approve when allowance updates
  const autoSellAfterApprove = useRef(false);
  useEffect(() => {
    if (!autoSellAfterApprove.current) return;
    // a declined approval, or a switch to Buy, ends it: never send a sell nobody clicked
    if (writeError || side !== "sell") {
      autoSellAfterApprove.current = false;
      return;
    }
    if (!token || !address || !sellAmountIn) return;
    if (allowance === undefined || allowance < sellAmountIn) return;
    autoSellAfterApprove.current = false;
    if (!quoteOut || quoteOut <= 0n) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the allowance read after an approval came back: continue the sell or say why not
      setError("No quote, try again.");
      return;
    }
    setPendingKind("sell");
    handledHash.current = null;
    writeContract({
      address: DEX_ROUTER,
      abi: routerAbi,
      functionName: "swapExactTokensForETH",
      args: [
        sellAmountIn,
        applySlippage(quoteOut),
        [token, WETH],
        address,
        deadlineSeconds(),
      ],
      chainId: network.chainId,
    });
  }, [allowance, sellAmountIn, quoteOut, token, address, writeContract, network.chainId, writeError, side]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    resetWrite();
    handledHash.current = null;
    autoSellAfterApprove.current = false;

    if (!isConnected || !onProduct || !address) {
      setError(`Connect on ${network.label}.`);
      return;
    }
    if (!market) return;

    // Transfer (default path for faucet stocks without pools)
    if (mode === "transfer" || (!hasPool && hasToken)) {
      if (!token) {
        setError("No onchain token for this market.");
        return;
      }
      if (!isAddress(to)) {
        setError("Enter a recipient address.");
        return;
      }
      const value = safeParseUnits(
        inputMode === "usd" && mark > 0
          ? (Number(amount) / mark).toFixed(8)
          : amount,
        18
      );
      if (value === null || value <= 0n) {
        setError("Enter a valid amount.");
        return;
      }
      if (tokenBal !== undefined && value > tokenBal) {
        setError("Not enough tokens.");
        return;
      }
      setPendingKind("transfer");
      writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to as `0x${string}`, value],
        chainId: network.chainId,
      });
      return;
    }

    if (!hasPool || !token) {
      setError("No swap pool for this stock on testnet. Use Send for transfers.");
      return;
    }

    if (side === "buy") {
      if (buyEthIn <= 0n) {
        setError("Enter a size.");
        return;
      }
      if (ethBal && buyEthIn > ethBal.value) {
        setError("Not enough ETH.");
        return;
      }
      if (!quoteOut || quoteOut <= 0n) {
        setError("No pool quote. Liquidity may be empty.");
        return;
      }
      setPendingKind("buy");
      writeContract({
        address: DEX_ROUTER,
        abi: routerAbi,
        functionName: "swapExactETHForTokens",
        args: [
          applySlippage(quoteOut),
          [WETH, token],
          address,
          deadlineSeconds(),
        ],
        value: buyEthIn,
        chainId: network.chainId,
      });
      return;
    }

    // sell
    if (!sellAmountIn || sellAmountIn <= 0n) {
      setError("Enter an amount.");
      return;
    }
    if (tokenBal !== undefined && sellAmountIn > tokenBal) {
      setError("Not enough tokens.");
      return;
    }
    if (allowance === undefined || allowance < sellAmountIn) {
      setPendingKind("approve");
      autoSellAfterApprove.current = true;
      writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [DEX_ROUTER, sellAmountIn * 2n],
        chainId: network.chainId,
      });
      return;
    }
    if (!quoteOut || quoteOut <= 0n) {
      setError("No pool quote. Liquidity may be empty.");
      return;
    }
    setPendingKind("sell");
    writeContract({
      address: DEX_ROUTER,
      abi: routerAbi,
      functionName: "swapExactTokensForETH",
      args: [
        sellAmountIn,
        applySlippage(quoteOut),
        [token, WETH],
        address,
        deadlineSeconds(),
      ],
      chainId: network.chainId,
    });
  }

  const tokenBalFmt =
    tokenBal !== undefined ? formatUnits(tokenBal, 18) : "0";
  const ethBalFmt = ethBal ? formatEth(ethBal.value) : "0";

  if (!isFetched && markets.length === 0) {
    return (
      <div className="gl-card flex items-center gap-3 p-6 text-[14px] text-mute">
        <Spinner />
        Loading markets…
      </div>
    );
  }

  if (!market) {
    return (
      <div className="gl-card p-6 text-[14px] text-mute">
        No markets available.
      </div>
    );
  }

  const spark =
    market.spark && market.spark.length >= 2
      ? market.spark
      : market.mark > 0
        ? [
            market.mark * 0.97,
            market.mark * 0.99,
            market.mark * 0.98,
            market.mark * 1.01,
            market.mark,
          ]
        : [];

  const busy = isPending || confirming;
  const showTransferFields = mode === "transfer" || (!hasPool && hasToken);
  const priceFmt = (n: number) =>
    settings.showUsd ? formatUsd(n) : `$${formatMark(n)}`;

  const paths: {
    id: PathMode;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }[] = [
    { id: "sealed", label: "Private", hint: "Amount hidden. No public market.", icon: <LockGlyph /> },
    { id: "public", label: "Wallet", hint: "Public on the explorer", icon: <EyeGlyph /> },
    ...(shieldLive
      ? [{ id: "vault" as const, label: "Via market", hint: "Public. Needs a pool.", icon: <EyeGlyph /> }]
      : []),
  ];

  const marketHeader = (
    <div className="flex items-center gap-3">
      <TokenLogo id={market.id} symbol={market.symbol} size={40} />
      <div className="min-w-0 flex-1">
        <p className="text-[17px] font-medium leading-tight text-foreground">
          {market.symbol}
        </p>
        <p className="mt-0.5 truncate text-[13px] text-mute">{market.name}</p>
      </div>
      {hasPool ? (
        <StatusPill>Pool live</StatusPill>
      ) : hasToken ? (
        <StatusPill>Transfer only</StatusPill>
      ) : (
        <StatusPill>Watch only</StatusPill>
      )}
    </div>
  );

  const stats = (
    <div className="@container border-t border-line">
      <dl className="grid grid-cols-2 gap-px bg-line @xl:grid-cols-4">
        {(
          [
            [
              "Visibility",
              pathMode === "sealed" ? "Private, only you" : "Public",
              pathMode === "sealed",
            ],
            ["Network", `${network.label}`, false],
            ["Pool", hasPool ? "Yes" : "None", false],
            ["Action", hasPool ? "Swap" : hasToken ? "Transfer" : "Watch", false],
          ] as const
        ).map(([k, val, sealed]) => (
          <div key={k} className="min-w-0 bg-panel px-5 py-3.5">
            <dt className="t-label">{k}</dt>
            <dd
              className={`mt-1 truncate text-[14px] ${
                sealed ? "font-medium text-sealed" : "text-foreground"
              }`}
            >
              {val}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <div className="@container space-y-5">
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-3">
        <NetworkPulse />
        <span className="ml-auto inline-flex items-center gap-2 text-[12px] text-mute">
          {isError ? (
            <button
              type="button"
              onClick={() => void refetch()}
              className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
            >
              Retry prices
            </button>
          ) : (
            <>
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${
                  isFetching ? "bg-faint" : liveCount > 0 ? "bg-foreground" : "bg-line-strong"
                }`}
              />
              {isFetching
                ? "Updating…"
                : liveCount > 0
                  ? "Live prices"
                  : "Prices offline"}
            </>
          )}
        </span>
      </div>

      {/* How you trade: the public / private choice is the product's core.
          Private active carries the sealed tint; public options stay ink. */}
      <div>
        <p className="t-label">How you trade</p>
        <div
          role="group"
          aria-label="How you trade"
          className={`mt-2.5 grid grid-cols-1 gap-1 rounded-[18px] bg-surface p-1 ${
            paths.length === 3 ? "@xl:grid-cols-3" : "@xl:grid-cols-2"
          }`}
        >
          {paths.map((p) => {
            const active = pathMode === p.id;
            const sealed = p.id === "sealed";
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPathMode(p.id)}
                aria-pressed={active}
                className={`flex min-h-[60px] items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors ${
                  active
                    ? "bg-panel shadow-card dark:bg-surface-2"
                    : "hover:bg-surface-2"
                }`}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                    active
                      ? sealed
                        ? "bg-sealed-soft text-sealed"
                        : "bg-ink text-on-ink"
                      : "bg-surface-2 text-mute"
                  }`}
                >
                  {p.icon}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[14px] font-medium ${
                      active ? "text-foreground" : "text-soft"
                    }`}
                  >
                    {p.label}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-mute">
                    {p.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {pathMode === "public" && (
          <p className="mt-3 text-[13px] leading-relaxed text-mute">
            Trades from your open wallet. Everyone can see them on the explorer.
          </p>
        )}
        {pathMode === "vault" && (
          <p className="mt-3 max-w-[64ch] text-[13px] leading-relaxed text-mute">
            Takes money out of your vault, swaps on a public market, then puts the
            result back. It needs a live pool for this stock, and many testnet
            pairs are empty. For TSLA and the other faucet stocks, use{" "}
            <button
              type="button"
              onClick={() => setPathMode("sealed")}
              className="font-medium text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
            >
              Private
            </button>
            .
          </p>
        )}
      </div>

      <div className="grid gap-5 @2xl:grid-cols-2 @2xl:items-start">
        {/* Left column on wide containers: price, then the market list. On
            narrow ones the children join the parent grid so the order reads
            price, trade, list. */}
        <div className="contents @2xl:flex @2xl:min-w-0 @2xl:flex-col @2xl:gap-5">
          <div className="order-1 min-w-0">
            {!settings.compactCharts && (
              <PriceChart
                points={spark}
                mark={market.mark}
                change24h={market.change24h}
                header={marketHeader}
                footer={stats}
              />
            )}
            {settings.compactCharts && (
              <div className="gl-card overflow-hidden">
                <div className="px-5 pt-5">{marketHeader}</div>
                <div className="flex items-end justify-between gap-4 px-5 pb-5 pt-4">
                  <div>
                    <p className="t-label">Price</p>
                    <p className="tnum mt-1.5 text-[28px] font-light leading-none tracking-[-0.018em] text-foreground">
                      {formatUsd(market.mark)}
                    </p>
                  </div>
                  {spark.length >= 2 && (
                    <Sparkline
                      points={spark}
                      up={market.change24h >= 0}
                      width={120}
                      height={40}
                    />
                  )}
                </div>
                {stats}
              </div>
            )}
          </div>

          <div className="order-3 min-w-0">
            <div className="gl-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                <p className="t-label">Markets</p>
                <div
                  role="group"
                  aria-label="Filter markets"
                  className="inline-flex rounded-full bg-surface p-0.5"
                >
                  {(
                    [
                      ["private", "Private"],
                      ["onchain", "Onchain"],
                      ["all", "All"],
                      ["stocks", "Stocks"],
                    ] as const
                  ).map(([f, label]) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      aria-pressed={filter === f}
                      className={`h-8 rounded-full px-3 text-[12px] transition-colors ${
                        filter === f
                          ? "bg-panel font-medium text-foreground shadow-card dark:bg-surface-2"
                          : "text-mute hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <ul className="max-h-[26rem] overflow-y-auto">
                {list.length === 0 && (
                  <li className="px-4 py-10 text-center text-[13px] text-mute">
                    No markets in this filter. Try Onchain or All.
                  </li>
                )}
                {list.map((m) => {
                  const selectedRow = m.id === resolvedId;
                  return (
                    <li key={m.id} className="border-b border-line last:border-0">
                      <button
                        type="button"
                        onClick={() => setMarketId(m.id)}
                        aria-current={selectedRow ? "true" : undefined}
                        className={`flex min-h-[60px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          selectedRow ? "bg-surface" : "hover:bg-surface/60"
                        }`}
                      >
                        <TokenLogo id={m.id} symbol={m.symbol} size={32} />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-[14px] font-medium text-foreground">
                            {m.symbol}
                            {m.privateReady && (
                              <span className="text-sealed" title="Private-ready">
                                <LockGlyph size={11} />
                                <span className="sr-only">Private-ready</span>
                              </span>
                            )}
                          </p>
                          <p className="truncate text-[12px] text-mute">{m.name}</p>
                        </div>
                        <Sparkline
                          points={
                            m.spark && m.spark.length >= 2
                              ? m.spark
                              : m.mark > 0
                                ? [m.mark * 0.98, m.mark, m.mark * 1.01]
                                : []
                          }
                          up={m.change24h >= 0}
                          width={56}
                          height={24}
                        />
                        <div className="w-[76px] text-right">
                          <p className="tnum text-[14px] text-foreground">
                            {priceFmt(m.mark)}
                          </p>
                          <p className={`tnum text-[12px] ${changeTone(m.change24h)}`}>
                            {fmtChange(m.change24h)}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>

        <div className="order-2 min-w-0 @2xl:sticky @2xl:top-6">
          {pathMode === "vault" && shieldLive ? (
            <VaultTradePanel
              marketId={resolvedId}
              marketSymbol={market.symbol}
              tokenAddress={token}
              hasPool={hasPool}
              initialSide={settings.defaultSide}
              onUsePrivate={() => setPathMode("sealed")}
            />
          ) : pathMode === "sealed" ? (
            <SealedTradePanel
              marketId={resolvedId}
              marketSymbol={market.symbol}
              tokenAddress={token}
              initialDir={sealedSide}
            />
          ) : (
            <div className="gl-card overflow-hidden">
              <div className="flex items-start justify-between gap-3 px-5 pt-5">
                <div className="min-w-0">
                  <p className="t-title text-foreground">
                    {showTransferFields ? "Send" : "Trade"} {market.symbol}
                  </p>
                  <p className="mt-1 text-[13px] text-mute">
                    From your open wallet. Public on the explorer.
                  </p>
                </div>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-mute">
                  <EyeGlyph />
                </span>
              </div>

              <form onSubmit={onSubmit} className="space-y-4 p-5">
                {hasToken && (
                  <div className="grid grid-cols-2 gap-1 rounded-full bg-surface p-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (hasPool) {
                          setMode("swap");
                          setSide("buy");
                        }
                      }}
                      disabled={!hasPool}
                      aria-pressed={mode === "swap" && side === "buy"}
                      className={`h-10 rounded-full text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        mode === "swap" && side === "buy"
                          ? "bg-panel text-foreground shadow-card dark:bg-surface-2"
                          : "text-mute hover:text-foreground"
                      }`}
                    >
                      Buy
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (hasPool) {
                          setMode("swap");
                          setSide("sell");
                        } else {
                          setMode("transfer");
                          setSide("sell");
                        }
                      }}
                      aria-pressed={
                        (mode === "swap" && side === "sell") || mode === "transfer"
                      }
                      className={`h-10 rounded-full text-[14px] font-medium transition-colors ${
                        (mode === "swap" && side === "sell") ||
                        mode === "transfer"
                          ? "bg-panel text-foreground shadow-card dark:bg-surface-2"
                          : "text-mute hover:text-foreground"
                      }`}
                    >
                      {hasPool ? "Sell" : "Send"}
                    </button>
                  </div>
                )}

                {!hasPool && hasToken && (
                  <p className="rounded-[14px] bg-surface px-4 py-3 text-[13px] leading-relaxed text-mute">
                    No testnet pool for {market.symbol}. You can still send
                    faucet tokens to any address.
                  </p>
                )}
                {!hasToken && (
                  <p className="rounded-[14px] bg-surface px-4 py-3 text-[13px] leading-relaxed text-mute">
                    {market.symbol} is watch only on testnet. There is no
                    token to trade yet.
                  </p>
                )}

                <div className="gl-inputcard p-5">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="trade-amt" className="text-[13px] text-mute">
                      {showTransferFields
                        ? "You send"
                        : side === "buy"
                          ? "You buy"
                          : "You sell"}
                    </label>
                    <div
                      role="group"
                      aria-label="Enter amount in"
                      className="inline-flex rounded-full border border-line bg-panel p-0.5"
                    >
                      {(
                        [
                          ["token", market.symbol],
                          ["usd", "USD"],
                        ] as const
                      ).map(([m, label]) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setInputMode(m)}
                          aria-pressed={inputMode === m}
                          className={`h-7 rounded-full px-2.5 text-[12px] font-medium transition-colors ${
                            inputMode === m
                              ? "bg-ink text-on-ink"
                              : "text-mute hover:text-foreground"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3">
                    <input
                      id="trade-amt"
                      inputMode="decimal"
                      placeholder="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-describedby="trade-amt-unit"
                      className="tnum w-full bg-transparent text-[34px] font-light leading-none tracking-[-0.02em] text-foreground outline-none placeholder:text-faint"
                    />
                    <span id="trade-amt-unit" className="sr-only">
                      {inputMode === "usd" ? "in USD" : `in ${market.symbol}`}
                    </span>
                    <AmountProblem value={amount} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12px] text-mute">
                    <span className="tnum">
                      {inputMode === "usd"
                        ? `≈ ${
                            tokenAmt > 0
                              ? tokenAmt.toLocaleString(undefined, {
                                  maximumFractionDigits: 4,
                                })
                              : "0"
                          } ${market.symbol}`
                        : `≈ ${usdAmt > 0 ? formatUsd(usdAmt) : "$0"}`}
                      {side === "buy" && buyEthIn > 0n && (
                        <span> · {formatEth(buyEthIn, 5)} ETH</span>
                      )}
                    </span>
                    {isConnected && hasToken && (
                      <button
                        type="button"
                        className="rounded-full bg-panel px-2.5 py-1 font-medium text-foreground ring-1 ring-line transition-colors hover:ring-line-strong"
                        onClick={() => {
                          if (tokenBal && tokenBal > 0n) {
                            setInputMode("token");
                            setAmount(formatUnits(tokenBal, 18));
                          }
                        }}
                      >
                        Max
                      </button>
                    )}
                  </div>
                </div>

                {showTransferFields && (
                  <div>
                    <label
                      htmlFor="xfer-to"
                      className="mb-2 block text-[13px] text-mute"
                    >
                      Recipient
                    </label>
                    <input
                      id="xfer-to"
                      value={to}
                      onChange={(e) => setTo(e.target.value.trim())}
                      placeholder="0x…"
                      className="gl-input tnum"
                    />
                  </div>
                )}

                <dl className="space-y-2 rounded-[14px] bg-surface px-4 py-3 text-[13px]">
                  {quoteOut !== undefined && mode === "swap" && quoteOut > 0n && (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-mute">You get (quote)</dt>
                      <dd className="tnum font-medium text-foreground">
                        {side === "buy"
                          ? `${Number(formatUnits(quoteOut, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${market.symbol}`
                          : `${formatEth(quoteOut, 5)} ETH`}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-mute">Wallet</dt>
                    <dd className="tnum text-right text-foreground">
                      {ethBalFmt} ETH
                      {hasToken && (
                        <>
                          <span className="text-faint"> · </span>
                          {tokenBal !== undefined
                            ? Number(tokenBalFmt).toLocaleString(undefined, {
                                maximumFractionDigits: 4,
                              })
                            : "0"}{" "}
                          {market.symbol}
                        </>
                      )}
                    </dd>
                  </div>
                </dl>

                {!isConnected || !onProduct ? (
                  <WalletMenu variant="inline" />
                ) : (
                  <button
                    type="submit"
                    disabled={busy || !hasToken}
                    className="btn btn-ink btn-lg btn-block"
                  >
                    {busy && <Spinner onInk />}
                    {busy
                      ? pendingKind === "approve"
                        ? "Approve in wallet…"
                        : "Confirm in wallet…"
                      : showTransferFields
                        ? `Send ${market.symbol}`
                        : side === "buy"
                          ? `Buy ${market.symbol}`
                          : sellAmountIn &&
                              allowance !== undefined &&
                              allowance < sellAmountIn
                            ? `Approve ${market.symbol}`
                            : `Sell ${market.symbol}`}
                  </button>
                )}

                {(error || writeError) && (
                  <p
                    role="alert"
                    className="rounded-[14px] bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger"
                  >
                    {error || walletErrorForPeople(writeError)}
                  </p>
                )}
              </form>
            </div>
          )}
        </div>
      </div>

      <SuccessModal
        open={successOpen && Boolean(lastHash)}
        title={successTitle}
        body={
          <p>
            {market.symbol} on testnet.
            {lastHash && (
              <>
                {" "}
                <span className="tnum text-foreground">
                  {shortAddress(lastHash, 4)}
                </span>
              </>
            )}
          </p>
        }
        primaryHref={lastHash ? network.explorerTx(lastHash) : undefined}
        primaryLabel="View on explorer"
        secondaryLabel="Done"
        onClose={() => {
          setSuccessOpen(false);
          setAmount("");
        }}
      />
    </div>
  );
}

function fmtChange(n: number) {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function changeTone(n: number) {
  return n > 0
    ? "text-[var(--chart-up)]"
    : n < 0
      ? "text-[var(--chart-down)]"
      : "text-mute";
}

/** Small ring spinner; still (no spin) under reduced motion. */
function Spinner({ onInk = false }: { onInk?: boolean }) {
  return (
    <span
      aria-hidden
      className={`h-4 w-4 shrink-0 rounded-full border-2 motion-safe:animate-spin ${
        onInk
          ? "border-on-ink/30 border-t-on-ink"
          : "border-line-strong border-t-foreground"
      }`}
    />
  );
}
