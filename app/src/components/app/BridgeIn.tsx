"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { erc20Abi, formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";
import { useAccount, useBalance, useConfig, useReadContract } from "wagmi";
import { getAccount, getTransactionReceipt, readContract, sendTransaction, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import {
  BRIDGE_CHAINS,
  bridgeSources,
  BRIDGE_DESTINATIONS,
  BRIDGE_MAX_USD,
  BRIDGE_MIN_USD,
  SWAP_GAS_RESERVE_WEI,
  bridgeFeeLines,
  chainLogo,
  expensiveRoute,
  formatBridgeBalance,
  leftoverLabel,
  privateBridgeable,
  swapSource,
  type BridgeAppFee,
  swapWalletNote,
  type BridgeChain,
  type BridgeQuote,
  type BridgeStatus,
  type CostedQuote,
  type PrivateBridgeQuote,
} from "@/lib/bridge";
import { prepareBridgeNote, settleBridgeNote } from "@/lib/bridgePrivate";
import { useAppBalance, useAppSendTransaction, useAppTxReceipt, useDemo } from "@/lib/demo";
import { MAINNET_ENABLED, type GloamChainId } from "@/lib/networks";
import { isElysiumChainId } from "@/lib/elysium";
import { originChain } from "@/lib/originChains";
import { useVaultStatus } from "@/lib/passkey";
import { dropUnsentNote, formatFeePercent, saveLocalNote, updateLocalNote, type LocalNote } from "@/lib/shield";
import { connectSolana, paySolana, useSolanaWallets, type SolanaAccount, type SolanaWallet } from "@/lib/solanaWallet";
import { track } from "@/lib/track";
import type { TrackEvent } from "@/lib/trackEvents";
import { failedBeforeSend, solanaDeclined, solanaSurelyNotSent, surelyNotSent, walletDeclined, walletErrorText } from "@/lib/walletErrors";
import { SealedField } from "@/components/ui/SealedField";
import { useModalFocus } from "@/hooks/useModalFocus";
import { useNetwork } from "./NetworkProvider";
import { AmountProblem } from "./AmountProblem";
import { SuccessReceipt } from "./SuccessModal";

const noopSubscribe = () => () => {};
const noop = () => {};

/** Solana needs a Relay API key on the server, so it stays off until that is set. */
const CHAINS = BRIDGE_CHAINS.filter((c) => !c.needsKey || process.env.NEXT_PUBLIC_BRIDGE_SOLANA === "1");
/** The few logos the card shows before "+N more". */
const FEATURED = [1, 8453, 4663, 792703809, 56, 8253038, 42161, 728126428];

const ADDRESS_NAME: Record<string, string> = { svm: "Solana", tvm: "Tron", bvm: "Bitcoin" };

type Stage =
  | { kind: "form"; error: string | null }
  | { kind: "loading" }
  | { kind: "address"; quote: BridgeQuote; qr: string | null };

/**
 * Paying from the person's own wallet straight into the private balance: a
 * Solana wallet (`wallet` and `account` set), or the connected EVM wallet on
 * another chain or on this one (both null).
 */
type PrivateStage =
  | { kind: "idle" }
  | { kind: "working"; text: string }
  | {
      kind: "review";
      quote: PrivateBridgeQuote;
      at: number;
      wallet: SolanaWallet | null;
      account: SolanaAccount | null;
      note: LocalNote;
      proof: Hex;
      signing: boolean;
      /** What the wallet is being asked for right now, when there is more than one step. */
      progress: string | null;
      error: string | null;
    }
  | {
      kind: "sent";
      quote: PrivateBridgeQuote;
      note: LocalNote;
      payer: string;
      hash: Hex | null;
      unsure: boolean;
      at: number;
      /**
       * A Solana send we couldn't confirm, past its transaction's life, that Relay
       * hasn't seen: most likely never sent. Not proof, so its note is kept.
       */
      expired?: boolean;
    }
  | { kind: "landed"; quote: PrivateBridgeQuote }
  | { kind: "late"; quote: PrivateBridgeQuote }
  | { kind: "failed"; quote: PrivateBridgeQuote };

/** A chain's logo, with its dark-theme version when Relay ships one. */
function ChainLogo({ id, size = 24, className = "" }: { id: number; size?: number; className?: string }) {
  return (
    <span className={`relative inline-block shrink-0 overflow-hidden rounded-full ${className}`} style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogo(id)} alt="" width={size} height={size} className="h-full w-full object-cover dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogo(id, true)} alt="" width={size} height={size} className="hidden h-full w-full object-cover dark:block" />
    </span>
  );
}

function TokenMark({ src, size = 20 }: { src: string; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- small local logos
    <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-full" style={{ width: size, height: size }} />
  );
}

/**
 * "Money on another chain?" on the add-money screen: opens the bridge panel.
 * `onArrived` gets the delivered amount so the screen can fill it in;
 * `onPrivate` runs after money went straight into the private balance.
 * `startOpen` opens the panel once a wallet is there (a link with ?bridge=open,
 * from a new Gloam wallet's Add funds).
 */
export function BridgeInCard({
  recipient,
  onArrived,
  onPrivate,
  startOpen = false,
}: {
  recipient?: string;
  onArrived?: (amount: string) => void;
  onPrivate?: () => void;
  startOpen?: boolean;
}) {
  const { network } = useNetwork();
  const dest = BRIDGE_DESTINATIONS[network.family];
  const swap = swapSource(network);
  const [opened, setOpen] = useState(false);
  // Closing it, or opening it by hand, uses up the link's one opening.
  const [startUsed, setStartUsed] = useState(false);
  const open = opened || (startOpen && !startUsed && Boolean(recipient));
  // never offer the chain the money lands on as where it comes from
  const sources = dest ? bridgeSources(CHAINS, dest.chainId) : CHAINS;
  const featured = FEATURED.filter((id) => sources.some((c) => c.id === id));
  const solanaPrivate = !network.chain.testnet && Boolean(network.pool) && sources.some(privateBridgeable);
  // No bridge into this chain yet: nothing to offer.
  if (!dest) return null;

  return (
    <div className="gl-card p-5">
      <p className="text-[13px] text-mute">Money on another chain?</p>
      <div className="mt-3 flex items-center">
        {featured.map((id, i) => (
          <ChainLogo key={id} id={id} size={28} className={`ring-2 ring-panel ${i > 0 ? "-ml-2" : ""}`} />
        ))}
        <span className="ml-2.5 text-[12.5px] text-mute">+{sources.length - featured.length} more</span>
      </div>
      <p className="mt-3 text-[14px] leading-relaxed text-foreground">
        Bring money over from {sources.length} chains, or straight from an exchange.
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">
        {solanaPrivate
          ? `From a Solana wallet it goes straight into your private balance. From anywhere else it lands in your wallet on ${dest.chain} as ${dest.token.symbol}, then you add it here privately.`
          : `It lands in your wallet on ${dest.chain} as ${dest.token.symbol}. Then you add it here privately.`}
        {swap && ` Holding ${swap.tokens[0]!.symbol} on ${swap.name}? Swap it to ${dest.token.symbol} here too.`}
      </p>
      <button type="button" disabled={!recipient} onClick={() => setOpen(true)} className="btn btn-ghost btn-sm mt-4">
        {recipient ? "Bring money over" : "Connect a wallet first"}
      </button>
      {recipient && (
        <BridgeSheet
          open={open}
          recipient={recipient}
          onClose={() => {
            setOpen(false);
            setStartUsed(true);
          }}
          onArrived={(amount) => {
            setOpen(false);
            setStartUsed(true);
            onArrived?.(amount);
          }}
          onPrivate={() => {
            setOpen(false);
            setStartUsed(true);
            onPrivate?.();
          }}
        />
      )}
    </div>
  );
}

/**
 * "Swap to USDG" beside the gas coin in Holdings, on a chain where Relay swaps
 * it in place. Renders nothing elsewhere.
 */
export function SwapToStableButton({ recipient, onArrived }: { recipient?: string; onArrived?: (amount: string) => void }) {
  const { network } = useNetwork();
  const swap = swapSource(network);
  const [open, setOpen] = useState(false);
  if (!swap || !recipient) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost btn-sm">
        Swap to {BRIDGE_DESTINATIONS[network.family]?.token.symbol}
      </button>
      <BridgeSheet
        open={open}
        recipient={recipient}
        startOnSwap
        onClose={() => setOpen(false)}
        onArrived={(amount) => {
          setOpen(false);
          onArrived?.(amount);
        }}
        onPrivate={() => setOpen(false)}
      />
    </>
  );
}

function BridgeSheet({
  open,
  recipient,
  startOnSwap = false,
  onClose,
  onArrived,
  onPrivate,
}: {
  open: boolean;
  recipient: string;
  /** Open on the same-chain swap instead of the first bridge chain. */
  startOnSwap?: boolean;
  onClose: () => void;
  onArrived: (amount: string) => void;
  onPrivate?: () => void;
}) {
  const { network } = useNetwork();
  // Only opened from BridgeInCard and SwapToStableButton, which render nothing
  // on a chain without a bridge, so the destination is always there.
  const dest = BRIDGE_DESTINATIONS[network.family]!;
  const swap = swapSource(network);
  // The swap on this chain comes first: it is the cheapest way in for ETH already here.
  const sources = useMemo(() => bridgeSources(CHAINS, dest.chainId), [dest.chainId]);
  const chains = useMemo(() => (swap ? [swap, ...sources] : sources), [swap, sources]);
  const reduce = useReducedMotion();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [chosen, setChain] = useState<BridgeChain>(() => (startOnSwap && swap) || chains[0]!);
  // A network switch can leave the old chain's swap picked; the first entry stands in for it.
  const chain = chosen.swap && chosen.id !== swap?.id ? chains[0]! : chosen;
  const [symbol, setSymbol] = useState(() => ((startOnSwap && swap) || chains[0]!).tokens[0]!.symbol);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "form", error: null });
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const token = chain.tokens.find((t) => t.symbol === symbol) ?? chain.tokens[0]!;

  // Straight into the private balance when the person's own wallet pays: a
  // Solana wallet in this browser, the connected EVM wallet on another chain
  // (a browser or WalletConnect wallet, which can switch chains), or the swap
  // here. Off, it is the deposit address (an exchange) or the plain swap.
  const config = useConfig();
  const { connector } = useAccount();
  const demo = useDemo();
  const solWallets = useSolanaWallets();
  const vault = useVaultStatus();
  const [solName, setSolName] = useState("");
  const solWallet = chain.kind === "svm" ? (solWallets.find((w) => w.name === solName) ?? solWallets[0] ?? null) : null;
  const switchable = connector?.type === "injected" || connector?.type === "walletConnect";
  // Elysium: the plain bridge only (into the wallet, then Add privately), until a
  // private landing there is proven end to end. The first one (9 Nov 2026) sat at
  // Relay with no fill on Elysium.
  const canPrivate =
    !demo &&
    !isElysiumChainId(network.chainId) &&
    !network.chain.testnet &&
    Boolean(network.pool) &&
    privateBridgeable(chain) &&
    (chain.kind === "svm" ? Boolean(solWallet) : chain.swap ? true : switchable && Boolean(originChain(chain.id)));
  // On by default, except the Holdings "Swap to USDG", which asks for a plain swap.
  const [privateOn, setPrivateOn] = useState(!startOnSwap);
  const privately = canPrivate && privateOn;
  const payerName = solWallet?.name ?? "your wallet";
  const [priv, setPriv] = useState<PrivateStage>({ kind: "idle" });
  // The note and proof for the amount typed, kept until it is sent so a fresh price reuses them.
  const prepared = useRef<{ key: string; note: LocalNote; proof: Hex } | null>(null);

  // Paying from another chain moves the wallet there. Put it back on this
  // network once that is over (Done, Start over, or the sheet closing any
  // way), so the rest of the app doesn't ask the person to switch.
  const switchedAway = useRef(false);
  const backToNetwork = useCallback(() => {
    if (!switchedAway.current) return;
    switchedAway.current = false;
    if (getAccount(config).chainId === network.chainId) return;
    void switchChain(config, { chainId: network.chainId as GloamChainId }).catch(() => {
      /* the wallet can switch later; the app asks when it needs to */
    });
  }, [config, network.chainId]);
  useEffect(() => {
    if (!open) backToNetwork();
  }, [open, backToNetwork]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return chains;
    return chains.filter((c) => c.name.toLowerCase().includes(q) || c.tokens.some((t) => t.symbol.toLowerCase().includes(q)));
  }, [search, chains]);

  // The swap: the wallet's ETH on this chain, the transaction it signs, and its receipt.
  const swapping = Boolean(chain.swap);
  const { data: gasCoin } = useAppBalance({
    address: recipient as Address,
    chainId: (swap?.id ?? network.chainId) as GloamChainId,
    enabled: open && swapping,
  });
  // This wallet's balance of the picked token on the picked EVM chain, so the amount
  // isn't a guess (and Max). Only chains the wagmi config knows; a failed read shows nothing.
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const nativeToken = token.address === ZERO_ADDR;
  const balanceReadable =
    open && !demo && !swapping && chain.kind === "evm" && isAddress(recipient) && config.chains.some((c) => c.id === chain.id);
  const srcToken = useReadContract({
    address: token.address as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [recipient as Address],
    chainId: chain.id as GloamChainId,
    query: { enabled: balanceReadable && !nativeToken, retry: 1 },
  });
  const srcCoin = useBalance({
    address: recipient as Address,
    chainId: chain.id as GloamChainId,
    query: { enabled: balanceReadable && nativeToken, retry: 1 },
  });
  const srcRead = nativeToken ? srcCoin : srcToken;
  const srcBalance: bigint | null = balanceReadable && !srcRead.isError ? (nativeToken ? srcCoin.data?.value : srcToken.data) ?? null : null;
  const srcLoading = balanceReadable && srcRead.isLoading;
  const send = useAppSendTransaction();
  const receipt = useAppTxReceipt({ hash: send.data, chainId: (swap?.id ?? network.chainId) as GloamChainId });
  const resetSend = send.reset;

  const reset = useCallback(() => {
    setStage({ kind: "form", error: null });
    setStatus(null);
    setPriv({ kind: "idle" });
    resetSend();
  }, [resetSend]);

  const finishPrivate = useCallback(() => {
    reset();
    setAmount("");
    backToNetwork();
    onPrivate?.();
  }, [reset, backToNetwork, onPrivate]);
  // The success screen is the end of the flow: however it is closed, the sheet opens fresh next time.
  const landed = priv.kind === "landed";
  const dismiss = landed ? finishPrivate : onClose;

  // A live price for the swap while the amount is typed, refreshed every 20 seconds,
  // so the rate and fees show before review. It is the same quote the review uses.
  const [preview, setPreview] = useState<{ amount: string; at: number; quote: BridgeQuote | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  const pricing = open && swapping && !privately && stage.kind === "form" && /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  useEffect(() => {
    if (!pricing) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/bridge/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId: chain.id, symbol: token.symbol, network: network.key, amount, recipient }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { ok: boolean; data?: BridgeQuote; error?: { message: string } };
        setPreview({
          amount,
          at: Date.now(),
          quote: json.ok && json.data ? json.data : null,
          error: json.ok ? null : (json.error?.message ?? "No price right now. Try again."),
        });
      } catch {
        if (!ctrl.signal.aborted) setPreview({ amount, at: Date.now(), quote: null, error: "Couldn't get a price. Check your connection." });
      }
    }, 400);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [pricing, amount, chain.id, token.symbol, network.key, recipient, tick]);
  useEffect(() => {
    if (!pricing) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 20_000);
    return () => window.clearInterval(t);
  }, [pricing]);
  const live = preview && preview.amount === amount ? preview : null;

  // In a private swap the amount is the USDC that lands, paid in the wallet's ETH. This
  // prices the most that ETH buys (fees kept back), for Max and an "about X ETH" line.
  const swapMaxWei = gasCoin != null && gasCoin.value > SWAP_GAS_RESERVE_WEI ? gasCoin.value - SWAP_GAS_RESERVE_WEI : BigInt(0);
  const [maxOut, setMaxOut] = useState<{ wei: bigint; out: number } | null>(null);
  const pricingMax = open && swapping && privately && stage.kind === "form" && swapMaxWei > BigInt(0);
  useEffect(() => {
    if (!pricingMax) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/bridge/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId: chain.id, symbol: token.symbol, network: network.key, amount: formatUnits(swapMaxWei, token.decimals), recipient }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { ok: boolean; data?: BridgeQuote };
        const out = json.ok && json.data ? Number(json.data.receive.minimum) : NaN;
        if (Number.isFinite(out) && out > 0) setMaxOut({ wei: swapMaxWei, out });
      } catch {
        // no price: no Max, the form still works
      }
    })();
    return () => ctrl.abort();
  }, [pricingMax, swapMaxWei, chain.id, token.symbol, token.decimals, network.key, recipient]);


  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (picking) setPicking(false);
      else dismiss();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, dismiss, picking]);

  // Follow the transfer while the address (or a private payment) is on screen and it isn't finished.
  const requestId =
    stage.kind === "address" && !stage.quote.tx
      ? stage.quote.requestId
      : priv.kind === "sent" && (!priv.quote.sameChain || !priv.hash)
        ? priv.quote.requestId
        : null;
  // An open deposit address can be filled under a newer request (another amount,
  // an exchange's fee taken off), so the status check also looks the address up.
  const depositAddress = stage.kind === "address" && !stage.quote.tx ? stage.quote.depositAddress : "";
  const finished = status?.stage === "done" || status?.stage === "failed" || status?.stage === "refunded";
  useEffect(() => {
    if (!open || !requestId || finished) return;
    let live = true;
    const check = async () => {
      try {
        const res = await fetch(
          `/api/bridge/status?requestId=${requestId}${depositAddress ? `&depositAddress=${encodeURIComponent(depositAddress)}` : ""}`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as { ok: boolean; data?: BridgeStatus };
        if (live && json.ok && json.data) setStatus(json.data);
      } catch {
        /* the next check tries again */
      }
    };
    void check();
    const t = window.setInterval(check, 5000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [open, requestId, depositAddress, finished]);

  // Funnel events for /admin: chain and token names only, never amounts, addresses or hashes.
  const counted = useRef(new Set<string>());
  const once = useCallback((key: string, event: TrackEvent, meta: Record<string, string>) => {
    if (counted.current.has(key)) return;
    counted.current.add(key);
    track(event, meta);
  }, []);
  const shown = stage.kind === "address" ? stage.quote : null;
  useEffect(() => {
    if (shown && !shown.tx && status?.stage === "done") {
      once(`arrived:${shown.requestId}`, "bridge_arrived", { source: shown.send.chain, token: shown.send.symbol });
    }
  }, [shown, status, once]);
  useEffect(() => {
    if (shown?.tx && send.data) once(`sent:${send.data}`, "swap_submit", { token: shown.send.symbol });
  }, [shown, send.data, once]);

  // A private payment Relay finished: count the note once the vault shows it.
  // Relay reports done as it sends the deposit, so the vault can lag a few
  // seconds; after that the note stays pending and reconcileClaims settles it.
  const sentPriv = priv.kind === "sent" ? priv : null;
  useEffect(() => {
    if (!sentPriv || (sentPriv.quote.sameChain && sentPriv.hash) || !status) return;
    // A refund or failure from Relay is shown, but the note is left pending:
    // it is already out of the balance, and if the deposit lands after all,
    // reconcileClaims still counts it.
    if (status.stage === "refunded" || status.stage === "failed") return;
    if (status.stage !== "done") return;
    let live = true;
    void (async () => {
      for (let i = 0; i < 8 && live; i++) {
        if (await settleBridgeNote(sentPriv.note, status.outTx)) {
          if (!live) return;
          once(`private:${sentPriv.quote.requestId}`, "bridge_private_landed", { source: sentPriv.quote.send.chain, token: sentPriv.quote.send.symbol });
          setPriv({ kind: "landed", quote: sentPriv.quote });
          return;
        }
        await new Promise((r) => window.setTimeout(r, 2500));
      }
      if (live) setPriv({ kind: "late", quote: sentPriv.quote });
    })();
    return () => {
      live = false;
    };
  }, [sentPriv, status, once]);

  // The swap here makes the deposit in the same transaction: its receipt says
  // whether the note landed, no bridge to follow.
  useEffect(() => {
    if (!sentPriv?.quote.sameChain || !sentPriv.hash) return;
    const { hash, note, quote } = sentPriv;
    let live = true;
    void (async () => {
      const chainId = network.chainId as GloamChainId;
      // wagmi throws on a reverted receipt, so the failed branch below needs the receipt read once more
      const rec = await waitForTransactionReceipt(config, { hash, chainId }).catch(() =>
        getTransactionReceipt(config, { hash, chainId }).catch(() => null)
      );
      if (!live) return;
      if (rec?.status === "reverted") {
        updateLocalNote(note.id, { status: "recovered", sweepPending: false });
        setPriv({ kind: "failed", quote });
        return;
      }
      for (let i = 0; i < 6 && live; i++) {
        if (await settleBridgeNote(note, hash)) {
          if (!live) return;
          once(`private:${hash}`, "bridge_private_landed", { source: quote.send.chain, token: quote.send.symbol });
          setPriv({ kind: "landed", quote });
          return;
        }
        await new Promise((r) => window.setTimeout(r, 2500));
      }
      if (live) setPriv({ kind: "late", quote });
    })();
    return () => {
      live = false;
    };
  }, [sentPriv, config, network.chainId, once]);

  // A Solana transaction is good for about a minute. One we couldn't confirm
  // that Relay still hasn't seen after two and a half most likely never went
  // out, so the person may start over. Its note stays saved, out of the
  // balance: Relay not seeing it (or a status read that failed) is no proof,
  // and if it lands after all the sync counts it (lib/claimSweep).
  useEffect(() => {
    if (!sentPriv?.unsure || !sentPriv.quote.solanaTx || sentPriv.expired) return;
    const left = Math.max(0, sentPriv.at + 150_000 - Date.now());
    const t = window.setTimeout(() => setPriv((p) => (p === sentPriv ? { ...sentPriv, expired: true } : p)), left);
    return () => window.clearTimeout(t);
  }, [sentPriv]);
  useEffect(() => {
    if (shown?.tx && send.data && receipt.isSuccess) once(`swapped:${send.data}`, "swap_success", { token: shown.send.symbol });
  }, [shown, send.data, receipt.isSuccess, once]);

  /** The review or the deposit address is on screen. */
  function countShown(quote: BridgeQuote) {
    if (quote.tx) once(`review:${quote.requestId}`, "swap_review", { token: quote.send.symbol });
    else once(`address:${quote.requestId}`, "bridge_address_created", { source: quote.send.chain, token: quote.send.symbol });
  }

  function pick(c: BridgeChain) {
    // An error from the last chain's quote (its balance, its route) never carries over.
    setStage((st) => (st.kind === "form" ? { kind: "form", error: null } : st));
    setChain(c);
    setSymbol(c.tokens[0]!.symbol);
    setRefundTo("");
    setAmount("");
    setSearch("");
    setPicking(false);
  }

  /** A fresh Relay order for the prepared note, paid from `sender`. */
  async function privateQuote(prep: { note: LocalNote; proof: Hex }, amountText: string, sender: string): Promise<PrivateBridgeQuote> {
    const res = await fetch("/api/bridge/private", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: chain.id,
        symbol: token.symbol,
        network: network.key,
        amount: amountText,
        recipient,
        sender,
        commitment: prep.note.commitment,
        proof: prep.proof,
      }),
    });
    const json = (await res.json().catch(() => null)) as { ok: boolean; data?: PrivateBridgeQuote; error?: { message: string } } | null;
    if (!json?.ok || !json.data) throw new Error(json?.error?.message ?? "Something went wrong. Try again.");
    return json.data;
  }

  /** Connect the Solana wallet if it pays, make the note and its proof, and price the order. */
  async function startPrivate(e: React.FormEvent) {
    e.preventDefault();
    const wallet = solWallet;
    if ((chain.kind === "svm" && !wallet) || !network.pool) return;
    if (vault.locked) {
      setStage({ kind: "form", error: "Unlock your private balance with your passkey first." });
      return;
    }
    const wei = parseUnits(amount, dest.token.decimals);
    setStage({ kind: "form", error: null });
    let step = "connect";
    try {
      let account: SolanaAccount | null = null;
      if (wallet) {
        setPriv({ kind: "working", text: `Connecting ${wallet.name}…` });
        account = await connectSolana(wallet);
      }
      step = "prepare";
      const key = `${network.key}:${dest.token.address}:${wei}`;
      let prep = prepared.current?.key === key ? prepared.current : null;
      if (!prep) {
        setPriv({ kind: "working", text: "Preparing your private deposit…" });
        const made = await prepareBridgeNote(wei, dest.token.address as Address, network, recipient as Address);
        prep = { key, ...made };
        prepared.current = prep;
      }
      step = "price";
      setPriv({ kind: "working", text: "Getting a price…" });
      const quote = await privateQuote(prep, amount, account?.address ?? recipient);
      setPriv({
        kind: "review",
        quote,
        at: Date.now(),
        wallet,
        account,
        note: prep.note,
        proof: prep.proof,
        signing: false,
        progress: null,
        error: null,
      });
      once(`private-review:${quote.requestId}`, "bridge_private_review", { source: chain.name, token: token.symbol });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0]! : "";
      setPriv({ kind: "idle" });
      setStage({
        kind: "form",
        error:
          step === "connect"
            ? solanaDeclined(msg)
              ? `${payerName} didn't connect. Nothing moved.`
              : `Couldn't connect ${payerName}. Try again.`
            : step === "prepare"
              ? "Couldn't prepare your private deposit. Try again."
              : msg || "Something went wrong. Try again.",
      });
    }
  }

  /** Save the note, then have the wallet sign and send the order. */
  async function confirmPrivate() {
    if (priv.kind !== "review" || priv.signing) return;
    const r = priv;
    setPriv({ ...r, signing: true, progress: null, error: null });
    let quote = r.quote;
    try {
      // A quote (and a Solana transaction) is only good for about a minute: an older one is fetched again.
      if (Date.now() - r.at > 40_000) quote = await privateQuote(r, r.quote.receive.amount, r.account?.address ?? recipient);
    } catch (err) {
      setPriv({ ...r, signing: false, error: err instanceof Error ? err.message : "Couldn't refresh the price. Try again." });
      return;
    }
    const at = quote === r.quote ? r.at : Date.now();
    // The note's secret is the money: kept before anything is sent, out of the
    // balance until the vault shows it.
    try {
      await saveLocalNote({ ...r.note, status: "open", sweepPending: true });
    } catch (err) {
      setPriv({ ...r, signing: false, error: err instanceof Error ? err.message : "Couldn't save your private balance. Try again." });
      return;
    }

    if (quote.solanaTx && r.wallet && r.account) {
      let unsure = false;
      try {
        await paySolana(r.wallet, r.account, quote.solanaTx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (solanaSurelyNotSent(msg)) {
          dropUnsentNote(r.note.id);
          setPriv({
            ...r,
            quote,
            at,
            signing: false,
            error: solanaDeclined(msg) ? "You cancelled it in your wallet. Nothing moved." : (msg.split("\n")[0] ?? "It didn't send. Try again."),
          });
          return;
        }
        // The wallet may have sent it before it failed: keep the note and follow the order.
        unsure = true;
      }
      prepared.current = null;
      setStatus(null);
      setPriv({ kind: "sent", quote, note: r.note, payer: r.wallet.name, hash: null, unsure, at: Date.now() });
      once(`private-sent:${quote.requestId}`, "bridge_private_sent", { source: quote.send.chain, token: quote.send.symbol });
      return;
    }

    // An EVM wallet: an approve (for a token) that must land first, then the
    // deposit or the swap, each on the paying chain. The note is dropped only
    // when that last transaction never went out.
    const txs = quote.evmTxs ?? [];
    let hash: Hex | null = null;
    let approved = false;
    // Set once the last transaction (the one that pays) is handed to the wallet.
    let paying = false;
    try {
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]!;
        const last = i === txs.length - 1;
        const chainId = tx.chainId as GloamChainId;
        setPriv({
          ...r,
          quote,
          at,
          signing: true,
          error: null,
          progress: txs.length > 1 ? (last ? "Now confirm the payment in your wallet…" : "Approve in your wallet first (1 of 2)…") : null,
        });
        if (getAccount(config).chainId !== tx.chainId) {
          if (tx.chainId !== network.chainId) switchedAway.current = true;
          await switchChain(config, { chainId });
        }
        paying = last;
        const sent = await sendTransaction(config, { to: tx.to as Address, data: tx.data as Hex, value: BigInt(tx.value), chainId });
        if (last) {
          hash = sent;
        } else {
          // wagmi throws on a reverted receipt, with a reason decoded from raw bytes: read it plainly then
          const rec = await waitForTransactionReceipt(config, { hash: sent, chainId }).catch(async (e) => {
            const plain = await getTransactionReceipt(config, { hash: sent, chainId }).catch(() => null);
            if (plain) return plain;
            throw e;
          });
          if (rec.status !== "success") throw new Error("The approval didn't go through.");
          // Some wallets (OKX among them) let the approval be edited down. A payment
          // above what was approved fails in the wallet's own check, so stop here and
          // say so instead of handing over a payment that cannot go through.
          if (tx.data.slice(0, 10).toLowerCase() === "0x095ea7b3") {
            const spender = `0x${tx.data.slice(34, 74)}` as Address;
            const needed = BigInt(`0x${tx.data.slice(74, 138)}`);
            const allowed = await readContract(config, { address: tx.to as Address, abi: erc20Abi, functionName: "allowance", args: [getAccount(config).address as Address, spender], chainId }).catch(() => null);
            if (allowed !== null && allowed < needed) {
              throw new Error(`Your wallet approved less than this payment needs (${formatUnits(allowed, quote.send.symbol === "USDC" || quote.send.symbol === "USDT" ? 6 : 18)} of ${quote.send.amount} ${quote.send.symbol}). Try again and approve the amount shown, without editing it.`);
            }
          }
          approved = true;
          // Some wallets check the payment against a node that hasn't seen the approval yet
          // and call it a failed contract call: give the chain a few seconds first.
          setPriv({ ...r, quote, at, signing: true, error: null, progress: "Approval done. Getting the payment ready…" });
          await new Promise((res) => window.setTimeout(res, 4000));
        }
      }
    } catch (err) {
      // Before the paying transaction, or a clear no from the wallet: nothing
      // went out, so the note goes. A timeout or lost reply on the paying
      // transaction may come after the wallet sent it: keep the note and
      // follow the order.
      if (!paying || surelyNotSent(err)) {
        dropUnsentNote(r.note.id);
        setPriv({
          ...r,
          quote,
          at,
          signing: false,
          progress: null,
          error: walletDeclined(err)
            ? approved
              ? "You cancelled the payment. Nothing moved; the approval can be used next time."
              : "You cancelled it in your wallet. Nothing moved."
            : failedBeforeSend(err) && /chain/i.test(walletErrorText(err))
              ? `Switch your wallet to ${quote.send.chain} to pay from there.`
              : walletErrorText(err) || "It didn't send. Try again.",
        });
        return;
      }
    }
    prepared.current = null;
    setStatus(null);
    setPriv({ kind: "sent", quote, note: r.note, payer: "your wallet", hash, unsure: !hash, at: Date.now() });
    once(`private-sent:${quote.requestId}`, "bridge_private_sent", { source: quote.send.chain, token: quote.send.symbol });
  }


  async function getAddress(e: React.FormEvent) {
    e.preventDefault();
    // A swap price from the last few seconds is the review: no second wait.
    if (swapping && live?.quote && Date.now() - live.at < 25_000) {
      setStage({ kind: "address", quote: live.quote, qr: null });
      countShown(live.quote);
      return;
    }
    setStage({ kind: "loading" });
    setStatus(null);
    try {
      const res = await fetch("/api/bridge/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId: chain.id, symbol: token.symbol, network: network.key, amount, recipient, refundTo }),
      });
      const json = (await res.json()) as { ok: boolean; data?: BridgeQuote; error?: { message: string } };
      if (!json.ok || !json.data) {
        setStage({ kind: "form", error: json.error?.message ?? "Something went wrong. Try again." });
        return;
      }
      const quote = json.data;
      setStage({ kind: "address", quote, qr: null });
      countShown(quote);
      if (quote.tx) return;
      void import("qrcode")
        .then((QR) => QR.toDataURL(quote.depositAddress, { margin: 1, width: 400, errorCorrectionLevel: "M" }))
        .then((qr) => setStage((s) => (s.kind === "address" && s.quote.requestId === quote.requestId ? { ...s, qr } : s)))
        .catch(() => {
          /* the address and copy button still work */
        });
    } catch {
      setStage({ kind: "form", error: "Couldn't reach the bridge. Check your connection and try again." });
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* the address is selectable text */
    }
  }

  function signSwap(quote: BridgeQuote) {
    if (!quote.tx) return;
    send.sendTransaction({
      to: quote.tx.to as Address,
      data: quote.tx.data as Hex,
      value: BigInt(quote.tx.value),
      chainId: quote.tx.chainId as GloamChainId,
    });
  }

  if (!open || !mounted) return null;

  const amountNum = Number(amount);
  const amountWei = (() => {
    try {
      return /^\d+(\.\d+)?$/.test(amount) ? parseUnits(amount, token.decimals) : null;
    } catch {
      return null;
    }
  })();
  const overBalance = swapping && !privately && gasCoin != null && amountWei != null && amountWei > gasCoin.value;
  const maxWei = gasCoin != null && gasCoin.value > SWAP_GAS_RESERVE_WEI ? gasCoin.value - SWAP_GAS_RESERVE_WEI : BigInt(0);
  // Only a note, never a block: a deposit address can be paid from an exchange. Privately
  // the amount is what lands, so it is compared only for a stablecoin.
  const overSource =
    srcBalance != null && amountNum > 0 && (!privately || token.stable) && amountNum > Number(formatUnits(srcBalance, token.decimals));
  const amountOk = privately
    ? /^\d+(\.\d{1,2})?$/.test(amount) && amountNum >= BRIDGE_MIN_USD
    : (token.stable ? amountNum >= BRIDGE_MIN_USD && amountNum <= BRIDGE_MAX_USD : amountNum > 0) && !overBalance;
  const refundOk = privately || chain.kind === "evm" || refundTo.trim().length > 20;
  const refundName = ADDRESS_NAME[chain.kind] ?? chain.name;
  const working = priv.kind === "working" ? priv.text : null;
  const privatePanel = priv.kind !== "idle" && priv.kind !== "working";

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-end justify-center sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bridge-title"
    >
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={dismiss}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative z-[1] max-h-[92dvh] w-full max-w-[440px] overflow-y-auto rounded-t-[24px] bg-panel px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 shadow-pop sm:rounded-[24px] sm:px-7 sm:pb-7"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
      >
        {landed && (
          <div className="absolute inset-0 overflow-hidden">
            <SealedField tone="soft" />
          </div>
        )}
        {!landed && (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="bridge-title" className="text-[20px] font-medium tracking-[-0.01em] text-foreground">
                {picking ? "Where is the money?" : swapping ? `Swap to ${dest.token.symbol}` : "Bring money over"}
              </h2>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-mute">
                {picking
                  ? `${sources.length} chains. Sending from an exchange works too: pick the chain you withdraw on.`
                  : swapping
                    ? privately
                      ? `Swap ${token.symbol} for ${dest.token.symbol}, straight into your private balance.`
                      : `Swap ${token.symbol} for ${dest.token.symbol} in your wallet on ${dest.chain}.`
                    : privately
                      ? `From ${chain.kind === "svm" ? "your Solana wallet" : chain.name} to your private balance on ${dest.chain}.`
                      : `From another chain or an exchange, into your wallet on ${dest.chain}.`}
              </p>
            </div>
            <button
              type="button"
              onClick={picking ? () => setPicking(false) : onClose}
              aria-label={picking ? "Back" : "Close"}
              className="-mr-2 -mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {network.chain.testnet && !picking && (
          <p className="mt-4 rounded-2xl bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-soft">
            {MAINNET_ENABLED ? (
              <>
                Preview. This bridges to {dest.chain} mainnet, not to this testnet. Switch to {dest.chain} mainnet
                to add it privately.
              </>
            ) : (
              <>
                Preview. This bridges to {dest.chain} mainnet. The private balance there opens when Gloam goes to
                mainnet.
              </>
            )}
          </p>
        )}

        {picking && (
          <div className="mt-5">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chains or tokens"
              aria-label="Search chains or tokens"
              className="gl-input h-12 px-3.5 text-[16px] sm:text-[15px]"
            />
            <ul className="mt-3 grid gap-1">
              {matches.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => pick(c)}
                    aria-current={c.id === chain.id ? "true" : undefined}
                    className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl px-3 text-left transition-colors hover:bg-surface ${
                      c.id === chain.id ? "bg-surface" : ""
                    }`}
                  >
                    <ChainLogo id={c.id} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] text-foreground">{c.name}</span>
                      <span className="block truncate text-[12.5px] text-mute">
                        {c.swap
                          ? `Swap ${c.tokens.map((t) => t.symbol).join(", ")} to ${dest.token.symbol}, in this wallet`
                          : c.tokens.map((t) => t.symbol).join(", ")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && (
                <li className="rounded-2xl bg-surface px-4 py-4 text-[13.5px] text-mute">No chain matches that. Try another name.</li>
              )}
            </ul>
          </div>
        )}

        {!picking && stage.kind !== "address" && !privatePanel && (
          <form onSubmit={privately ? startPrivate : getAddress} className="mt-5 grid gap-4">
            <div>
              <p className="text-[13px] text-mute">From</p>
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="mt-1.5 flex h-14 w-full items-center gap-3 rounded-xl border border-line px-3.5 text-left transition-colors hover:bg-surface"
              >
                <ChainLogo id={chain.id} size={28} />
                <span className="min-w-0 flex-1 text-[15px] text-foreground">{chain.name}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className="text-mute">
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <div>
              <p className="text-[13px] text-mute">To</p>
              <div className="mt-1.5 flex h-14 w-full items-center gap-3 rounded-xl bg-surface px-3.5">
                <ChainLogo id={dest.chainId} size={28} />
                <span className="min-w-0 flex-1 text-[15px] text-foreground">{dest.chain}</span>
                <span className={`shrink-0 text-[13px] ${privately ? "text-sealed" : "text-mute"}`}>
                  {privately ? `Private balance, ${dest.token.symbol}` : `Your wallet, ${dest.token.symbol}`}
                </span>
              </div>
            </div>

            {chain.tokens.length > 1 && (
              <div role="radiogroup" aria-label="Token" className="flex flex-wrap gap-2">
                {chain.tokens.map((t) => (
                  <button
                    key={t.symbol}
                    type="button"
                    role="radio"
                    aria-checked={t.symbol === token.symbol}
                    onClick={() => {
                      setSymbol(t.symbol);
                      setAmount("");
                    }}
                    className={`inline-flex h-10 items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[14px] transition-colors ${
                      t.symbol === token.symbol ? "border-foreground text-foreground" : "border-line text-soft hover:bg-surface"
                    }`}
                  >
                    <TokenMark src={t.logo} size={26} />
                    {t.symbol}
                  </button>
                ))}
              </div>
            )}

            {canPrivate && (
              <PrivateToggle
                destChain={dest.chain}
                on={privateOn}
                onChange={setPrivateOn}
                detail={
                  privateOn
                    ? swapping
                      ? "One transaction swaps it and adds it privately."
                      : `${solWallet ? `${solWallet.name} pays` : "Pay from this wallet"} and it arrives private. Sending from an exchange? Turn this off for a deposit address.`
                    : swapping
                      ? `It lands in your wallet as ${dest.token.symbol}, then you add it privately.`
                      : `A deposit address: it lands in your wallet on ${dest.chain}, then you add it privately.`
                }
              />
            )}

            {privately && chain.kind === "svm" && solWallets.length > 1 && (
              <div role="radiogroup" aria-label="Solana wallet" className="flex flex-wrap gap-2">
                {solWallets.map((w) => (
                  <button
                    key={w.name}
                    type="button"
                    role="radio"
                    aria-checked={solWallet?.name === w.name}
                    onClick={() => setSolName(w.name)}
                    className={`inline-flex h-10 items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[14px] transition-colors ${
                      solWallet?.name === w.name ? "border-foreground text-foreground" : "border-line text-soft hover:bg-surface"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own data-URL icon */}
                    <img src={w.icon} alt="" width={26} height={26} className="h-[26px] w-[26px] rounded-full" />
                    {w.name}
                  </button>
                ))}
              </div>
            )}

            {privately ? (
              <div>
                <label htmlFor="bridge-amount" className="text-[13px] text-mute">
                  {swapping ? `${dest.token.symbol} to add privately` : "Add privately"}
                </label>
                <div className="gl-inputwrap mt-1.5 flex h-12 items-center gap-2 px-3.5">
                  <input
                    id="bridge-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="tnum min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none! placeholder:text-faint"
                  />
                  <TokenMark src={dest.token.logo} size={20} />
                  <span className="text-[14px] text-mute">{dest.token.symbol}</span>
                </div>
                <AmountProblem value={amount} decimals={2} />
                {!swapping && (
                  <SourceBalance
                    value={srcBalance}
                    loading={srcLoading}
                    decimals={token.decimals}
                    symbol={token.symbol}
                    stable={token.stable}
                    over={overSource ? chain.name : null}
                    // The amount here is what lands, so Max leaves room for Relay's fee.
                    onMax={
                      token.stable && srcBalance != null
                        ? () => setAmount(String(Math.floor(Number(formatUnits(srcBalance, token.decimals)) * 0.995 * 100) / 100))
                        : null
                    }
                  />
                )}
                {swapping && maxOut && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="tnum text-[12px] text-mute">
                      {amountNum > 0 && /^\d+(\.\d+)?$/.test(amount)
                        ? `About ${trimAmount(formatUnits((maxOut.wei * BigInt(Math.round(amountNum * 100))) / BigInt(Math.max(1, Math.round(maxOut.out * 100))), token.decimals))} ${token.symbol}`
                        : `Your ${token.symbol} buys up to about ${Math.floor(maxOut.out * 100) / 100} ${dest.token.symbol}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAmount(String(Math.floor(maxOut.out * 0.98 * 100) / 100))}
                      className="h-9 rounded-full border border-line px-3 text-[12.5px] text-soft transition-colors hover:bg-surface hover:text-foreground"
                    >
                      Max
                    </button>
                  </div>
                )}
                <p className="mt-1.5 text-[12px] text-mute">
                  {swapping && `Type the ${dest.token.symbol} you want to add, not the ${token.symbol}. `}
                  Paid in {token.symbol}{" "}
                  {solWallet ? `from ${solWallet.name}` : swapping ? "from this wallet" : `from this wallet on ${chain.name}`}.
                  {swapping && gasCoin != null && ` You hold ${trimAmount(formatUnits(gasCoin.value, token.decimals))} ${token.symbol}.`} You
                  see the exact cost before you sign.
                </p>
              </div>
            ) : (
            <div>
              <label htmlFor="bridge-amount" className="text-[13px] text-mute">
                Amount
              </label>
              <div className="gl-inputwrap mt-1.5 flex h-12 items-center gap-2 px-3.5">
                <input
                  id="bridge-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="tnum min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none! placeholder:text-faint"
                />
                {swapping && live?.quote?.send.usd != null && (
                  <span className="tnum shrink-0 text-[13px] text-mute">${fmtMoney(live.quote.send.usd)}</span>
                )}
                <TokenMark src={token.logo} size={20} />
                <span className="text-[14px] text-mute">{token.symbol}</span>
              </div>
              <AmountProblem value={amount} decimals={token.decimals} />
              {!swapping && (
                <SourceBalance
                  value={srcBalance}
                  loading={srcLoading}
                  decimals={token.decimals}
                  symbol={token.symbol}
                  stable={token.stable}
                  over={overSource ? chain.name : null}
                  // Stablecoins only: a chain's own coin also pays the network fee to send it.
                  onMax={token.stable && srcBalance != null ? () => setAmount(stableMax(srcBalance, token.decimals)) : null}
                />
              )}
              {swapping && gasCoin != null && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="tnum text-[12px] text-mute">
                    In your wallet: {trimAmount(formatUnits(gasCoin.value, token.decimals))} {token.symbol}
                  </span>
                  <div role="group" aria-label="Amount shortcuts" className="flex gap-1.5">
                    {[25, 50, 75, 100].map((pct) => {
                      const wei = pct === 100 ? maxWei : (gasCoin.value * BigInt(pct)) / BigInt(100);
                      const pick = wei > maxWei ? maxWei : wei;
                      return (
                        <button
                          key={pct}
                          type="button"
                          disabled={pick === BigInt(0)}
                          onClick={() => setAmount(trimAmount(formatUnits(pick, token.decimals)))}
                          className="h-9 rounded-full border border-line px-3 text-[12.5px] text-soft transition-colors hover:bg-surface hover:text-foreground disabled:opacity-40"
                        >
                          {pct === 100 ? "Max" : `${pct}%`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className={`mt-1.5 text-[12px] ${overBalance ? "text-danger" : "text-mute"}`}>
                {overBalance
                  ? `That's more ${token.symbol} than this wallet holds.`
                  : token.stable
                    ? `From ${BRIDGE_MIN_USD} to ${BRIDGE_MAX_USD.toLocaleString("en-US")} ${token.symbol}.`
                    : swapping
                      ? `Keep a little ${token.symbol} for network fees. It arrives as ${dest.token.symbol} in this wallet.`
                      : `Up to about $${BRIDGE_MAX_USD.toLocaleString("en-US")} worth. It arrives as ${dest.token.symbol}.`}
              </p>
            </div>
            )}

            {swapping && !privately && amountNum > 0 && !overBalance && (
              live?.error ? (
                <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
                  {live.error}
                </p>
              ) : (
                <SwapPrice quote={live?.quote ?? null} from={token.symbol} to={dest.token.symbol} />
              )
            )}

            {chain.kind !== "evm" && !privately && (
              <div>
                <label htmlFor="bridge-refund" className="text-[13px] text-mute">
                  Your {refundName} address
                </label>
                <input
                  id="bridge-refund"
                  autoComplete="off"
                  spellCheck={false}
                  value={refundTo}
                  onChange={(e) => setRefundTo(e.target.value.trim())}
                  className="gl-input tnum mt-1.5 h-12 px-3.5 text-[16px] sm:text-[14px]"
                />
                <p className="mt-1.5 text-[12px] text-mute">If the transfer fails, the money goes back here.</p>
              </div>
            )}

            {stage.kind === "form" && stage.error && (
              <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
                {stage.error}
              </p>
            )}

            <button
              type="submit"
              disabled={!amountOk || !refundOk || stage.kind === "loading" || working !== null}
              className="btn btn-ink btn-lg btn-block"
            >
              {working ??
                (stage.kind === "loading"
                  ? swapping
                    ? "Getting a price…"
                    : "Getting an address…"
                  : privately
                    ? "Continue"
                    : swapping
                      ? "Review the swap"
                      : "Get a deposit address")}
            </button>
            <p className="text-center text-[12px] leading-relaxed text-mute">
              {privately
                ? "Paying in is public, like any deposit. What you do with it after stays private."
                : swapping
                  ? "Swapping is public, like any deposit."
                  : "Bridging is public, like any deposit."}{" "}
              <PoweredByRelay />
            </p>
            {chain.kind === "svm" && solWallets.length === 0 && !network.chain.testnet && (
              <p className="text-center text-[12px] leading-relaxed text-mute">
                Using a Solana wallet app? Open gloam.trade in its browser to send straight to your private balance.
              </p>
            )}
          </form>
        )}

        {!picking && priv.kind === "review" && (
          <PrivateReview
            review={priv}
            onConfirm={() => void confirmPrivate()}
            onReset={() => {
              reset();
              backToNetwork();
            }}
          />
        )}

        {!picking && (priv.kind === "sent" || priv.kind === "landed" || priv.kind === "late" || priv.kind === "failed") && (
          <div aria-live="polite">
            {priv.kind === "landed" ? (
              <PrivateLanded quote={priv.quote} onDone={finishPrivate} />
            ) : (
              <PrivateProgress
                stage={priv}
                status={status}
                onDone={finishPrivate}
                onReset={() => {
                  reset();
                  backToNetwork();
                }}
                onGiveUp={() => {
                  // The note is kept: a payment Relay fills late still lands in it.
                  reset();
                }}
              />
            )}
          </div>
        )}

        {!picking && stage.kind === "address" && stage.quote.tx && (
          <SwapReview
            quote={stage.quote}
            hash={send.data}
            pending={send.isPending}
            error={send.error}
            landed={receipt.isSuccess}
            waitFailed={receipt.isError}
            onSign={() => signSwap(stage.quote)}
            onArrived={onArrived}
            onReset={reset}
          />
        )}

        {!picking && stage.kind === "address" && !stage.quote.tx && (
          <div className="mt-5" aria-live="polite">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] leading-relaxed text-foreground">
              Send exactly
              <TokenMark src={stage.quote.send.logo} size={18} />
              <span className="tnum font-medium">
                {stage.quote.send.amount} {stage.quote.send.symbol}
              </span>
              on
              <ChainLogo id={stage.quote.send.chainId} size={18} />
              {stage.quote.send.chain}
              {stage.quote.send.usd !== null && !stage.quote.send.symbol.startsWith("USD") && (
                <span className="tnum text-mute">(about ${stage.quote.send.usd.toFixed(2)})</span>
              )}
            </p>

            {stage.qr && (
              // eslint-disable-next-line @next/next/no-img-element -- a local data URL
              <img
                src={stage.qr}
                alt={`Deposit address on ${stage.quote.send.chain}`}
                width={200}
                height={200}
                className="mx-auto mt-4 aspect-square w-full max-w-[200px] rounded-2xl bg-white p-2"
              />
            )}

            <button
              type="button"
              onClick={() => void copy(stage.quote.depositAddress)}
              className="mt-4 flex w-full items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:bg-surface"
            >
              <span className="tnum min-w-0 flex-1 break-all text-[13.5px] text-foreground">{stage.quote.depositAddress}</span>
              <span className="shrink-0 text-[13px] font-medium text-foreground">{copied ? "Copied" : "Copy"}</span>
            </button>

            <dl className="mt-4 divide-y divide-line text-[14px]">
              <div className="flex min-h-11 items-center justify-between gap-3">
                <dt className="text-mute">You get about</dt>
                <dd className="tnum flex items-center gap-1.5 text-right text-foreground">
                  <TokenMark src={stage.quote.receive.logo} size={18} />
                  {Number(stage.quote.receive.amount).toFixed(2)} {stage.quote.receive.symbol}
                </dd>
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3">
                <dt className="text-mute">At least</dt>
                <dd className="tnum text-right text-foreground">
                  {Number(stage.quote.receive.minimum).toFixed(2)} {stage.quote.receive.symbol}
                </dd>
              </div>
              {feeRows(stage.quote, "Bridge fee").map(([k, v]) => (
                <div key={k} className="flex min-h-11 items-center justify-between gap-3">
                  <dt className="text-mute">{k}</dt>
                  <dd className="tnum text-right text-foreground">{v}</dd>
                </div>
              ))}
              <div className="flex min-h-11 items-center justify-between gap-3">
                <dt className="text-mute">Arrives</dt>
                <dd className="text-right text-foreground">
                  {stage.quote.bitcoin
                    ? "After Bitcoin confirms, usually 10 to 30 min"
                    : stage.quote.timeSec > 0 && stage.quote.timeSec < 60
                      ? "In under a minute"
                      : `In about ${Math.max(1, Math.round(stage.quote.timeSec / 60))} min`}
                </dd>
              </div>
            </dl>

            <CostWarning quote={stage.quote} />

            <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
              Send only {stage.quote.send.symbol} on {stage.quote.send.chain}, and use this address for this transfer
              only. Sending from an exchange works too.
            </p>

            <StatusLine status={status} quote={stage.quote} />

            {status?.stage === "done" ? (
              <button
                type="button"
                onClick={() => onArrived(floor2(stage.quote.receive.minimum))}
                className="btn btn-ink btn-lg btn-block mt-4"
              >
                Add it privately
              </button>
            ) : (
              <button type="button" onClick={reset} className="btn btn-ghost btn-sm mt-4">
                Start over
              </button>
            )}
          </div>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}

function StatusLine({ status, quote }: { status: BridgeStatus | null; quote: BridgeQuote }) {
  const stage = status?.stage ?? "waiting";
  const text =
    stage === "waiting"
      ? `Waiting for your ${quote.send.symbol}…`
      : stage === "moving"
        ? `Received. Sending it to ${quote.receive.chain}…`
        : stage === "done"
          ? `Arrived in your wallet on ${quote.receive.chain}.`
          : stage === "refunded"
            ? `Sent back to your ${quote.send.chain} address.`
            : `The transfer didn't go through. Relay returns the money to your ${quote.send.chain} address.`;
  const tone = stage === "done" ? "text-sealed" : stage === "failed" || stage === "refunded" ? "text-danger" : "text-foreground";
  return (
    <p className={`mt-4 flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3 text-[13.5px] ${tone}`}>
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${
          stage === "done" ? "bg-sealed" : stage === "failed" || stage === "refunded" ? "bg-danger" : "animate-pulse bg-foreground/50"
        }`}
      />
      {text}
    </p>
  );
}

/** "Land in private balance": on, the payer's own wallet pays straight into the private balance. */
function PrivateToggle({ on, onChange, detail, destChain }: { on: boolean; onChange: (on: boolean) => void; detail: string; destChain: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-3.5 text-left transition-colors ${
        on ? "border-sealed/40 bg-sealed-soft" : "border-line hover:bg-surface"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-medium text-foreground">Land in your private balance on {destChain}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-mute">{detail}</span>
      </span>
      <span
        aria-hidden
        className={`relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${
          on ? "bg-sealed" : "bg-foreground/20"
        }`}
      >
        <span
          className={`absolute h-5 w-5 rounded-full bg-panel shadow-sm transition-transform motion-reduce:transition-none ${
            on ? "translate-x-[18px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function arrivesText(q: PrivateBridgeQuote): string {
  if (q.sameChain) return "In seconds";
  return q.timeSec > 0 && q.timeSec < 60 ? "In under a minute" : `In about ${Math.max(1, Math.round(q.timeSec / 60))} min`;
}

/** What the wallet pays, what lands privately, and the fees, before it signs. */
function PrivateReview({
  review,
  onConfirm,
  onReset,
}: {
  review: Extract<PrivateStage, { kind: "review" }>;
  onConfirm: () => void;
  onReset: () => void;
}) {
  const q = review.quote;
  const pay = Number(q.send.amount).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const payer = review.wallet ? review.wallet.name : q.sameChain ? "this wallet" : `this wallet on ${q.send.chain}`;
  const steps = q.evmTxs?.length ?? 1;
  const confirm = review.wallet
    ? `Confirm in ${review.wallet.name}`
    : steps > 1
      ? "Approve and pay"
      : q.sameChain
        ? "Swap and add privately"
        : "Confirm in your wallet";
  const back = leftoverLabel(q);
  const rows: [string, React.ReactNode][] = [
    [
      "Added privately",
      <span key="a" className="flex items-center gap-1.5 font-medium">
        <TokenMark src={q.receive.logo} size={18} />
        {fmtMoney(Number(q.receive.amount))} {q.receive.symbol}
      </span>,
    ],
    ["On", q.receive.chain],
    ...feeRows(q, q.sameChain ? "Swap fee" : "Bridge fee"),
    ...(q.gasUsd !== null && q.gasUsd >= 0.01
      ? ([["Network fee", `about $${fmtMoney(q.gasUsd)} on ${q.send.chain}`]] as [string, React.ReactNode][])
      : q.evmTxs
        ? ([["Network fee", `Shown in your wallet, on ${q.send.chain}`]] as [string, React.ReactNode][])
        : []),
    ...(back ? ([["Back to your wallet", back]] as [string, React.ReactNode][]) : []),
    ["Arrives", arrivesText(q)],
  ];
  return (
    <div className="mt-5" aria-live="polite">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] leading-relaxed text-foreground">
        Pay
        <TokenMark src={q.send.logo} size={18} />
        <span className="tnum font-medium">
          {pay} {q.send.symbol}
        </span>
        from {payer}
        {q.send.usd !== null && !q.send.symbol.startsWith("USD") && (
          <span className="tnum text-mute">(about ${fmtMoney(q.send.usd)})</span>
        )}
      </p>

      <dl className="mt-4 divide-y divide-line text-[14px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-h-11 items-center justify-between gap-3">
            <dt className="text-mute">{k}</dt>
            <dd className="tnum text-right text-foreground">{v}</dd>
          </div>
        ))}
      </dl>

      <CostWarning quote={q} />

      {q.sameChain && (
        <p className="mt-4 rounded-xl bg-surface px-4 py-3 text-[13px] leading-relaxed text-soft">{swapWalletNote(q)}</p>
      )}

      {review.signing && review.progress && (
        <p className="mt-4 flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3 text-[13.5px] text-foreground">
          <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-foreground/50" />
          {review.progress}
        </p>
      )}

      {review.error && (
        <p role="alert" className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
          {review.error}
        </p>
      )}

      <button type="button" onClick={onConfirm} disabled={review.signing} className="btn btn-ink btn-lg btn-block mt-4">
        {review.signing ? "Waiting for your wallet…" : confirm}
      </button>
      {!review.signing && (
        <button type="button" onClick={onReset} className="btn btn-ghost btn-sm mt-3">
          Start over
        </button>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-mute">
        {q.sameChain
          ? "One transaction swaps it and adds it to your private balance."
          : `It goes into your private balance as it arrives. If that can't happen, Relay sends it to your wallet on ${q.receive.chain} instead, and you add it privately from there.`}
        {steps > 1 && " Your wallet asks twice: once to approve, once to pay."}
      </p>
    </div>
  );
}

/** The money is in the private balance: the same receipt as every other success, on the token's own mark. */
function PrivateLanded({ quote: q, onDone }: { quote: PrivateBridgeQuote; onDone: () => void }) {
  // The button that sent it is gone, so the keyboard lands on the one thing left to do. Escape is the sheet's.
  const receipt = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  useModalFocus(receipt, noop, { initial: done });
  const back = leftoverLabel(q);
  return (
    <div ref={receipt} className="relative pt-3 text-center">
      <SuccessReceipt
        titleId="bridge-title"
        title="Added privately"
        logo={<TokenMark src={q.receive.logo} size={56} />}
        amount={
          <>
            {fmtMoney(Number(q.receive.amount))}{" "}
            <span className="text-[16px] tracking-normal text-mute">{q.receive.symbol}</span>
          </>
        }
        body="Only you can see it."
        detail={
          back && (
            <dl className="rounded-xl bg-surface px-4 text-[13.5px]">
              <div className="flex min-h-11 items-center justify-between gap-3">
                <dt className="text-mute">Back to your wallet</dt>
                <dd className="tnum text-right text-foreground">{back}</dd>
              </div>
            </dl>
          )
        }
      />
      <button ref={done} type="button" onClick={onDone} className="btn btn-ink btn-lg btn-block mt-8">
        Done
      </button>
    </div>
  );
}

/** A private payment on its way, slower than expected, or failed. */
function PrivateProgress({
  stage,
  status,
  onDone,
  onReset,
  onGiveUp,
}: {
  stage: Extract<PrivateStage, { kind: "sent" | "late" | "failed" }>;
  status: BridgeStatus | null;
  onDone: () => void;
  onReset: () => void;
  onGiveUp: () => void;
}) {
  const q = stage.quote;
  const amount = `${fmtMoney(Number(q.receive.amount))} ${q.receive.symbol}`;
  const relay = status?.stage ?? "waiting";
  const failed =
    stage.kind === "failed" || (stage.kind === "sent" && !q.sameChain && (relay === "refunded" || relay === "failed"));
  const text =
    stage.kind === "late"
      ? `It arrived on ${q.receive.chain}. It shows in your private balance within a few minutes. If it doesn't, it's in your wallet as ${q.receive.symbol}: add it privately from there.`
      : stage.kind === "failed"
        ? "The swap didn't go through, so nothing was added. Only the network fee was spent."
        : failed
          ? `It didn't go through. Relay returns the money to the wallet that paid, or sends it as ${q.receive.symbol} to your wallet on ${q.receive.chain}.`
          : q.sameChain
            ? `Swapping and adding ${amount} to your private balance…`
            : relay === "waiting"
              ? stage.unsure
                ? stage.expired
                  ? `Relay hasn't seen a payment from ${stage.payer}, so it most likely didn't go out. If it did, it shows in your private balance by itself. Start over to try again.`
                  : `Checking whether ${stage.payer} sent it…`
                : `Sent from ${stage.payer}. Waiting for ${q.send.chain} to confirm…`
              : `Received. Adding ${amount} to your private balance on ${q.receive.chain}…`;
  return (
    <div className="mt-5">
      <p
        className={`flex items-start gap-2.5 rounded-2xl bg-surface px-4 py-3 text-[13.5px] leading-relaxed ${
          failed ? "text-danger" : "text-foreground"
        }`}
      >
        <span
          aria-hidden
          className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${
            failed ? "bg-danger" : stage.kind === "late" ? "bg-foreground/50" : "animate-pulse bg-foreground/50"
          }`}
        />
        {text}
      </p>
      {stage.kind === "late" ? (
        <button type="button" onClick={onDone} className="btn btn-ink btn-lg btn-block mt-4">
          Done
        </button>
      ) : failed ? (
        <button type="button" onClick={onReset} className="btn btn-ghost btn-sm mt-4">
          Start over
        </button>
      ) : stage.kind === "sent" && stage.expired && relay === "waiting" ? (
        <button type="button" onClick={onGiveUp} className="btn btn-ink btn-lg btn-block mt-4">
          Start over
        </button>
      ) : (
        <p className="mt-3 text-[12px] leading-relaxed text-mute">
          You can close this. It finishes on its own and shows in your private balance.
        </p>
      )}
    </div>
  );
}

/** At most six decimals, trailing zeros dropped, rounded down so Max never asks for more than is there. */
function trimAmount(text: string): string {
  const [whole, frac = ""] = text.split(".");
  const f = frac.slice(0, 6).replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole!;
}

/** Max for a stablecoin sent to a deposit address: all of it, up to the bridge's limit. */
function stableMax(value: bigint, decimals: number): string {
  const cap = parseUnits(String(BRIDGE_MAX_USD), decimals);
  return trimAmount(formatUnits(value > cap ? cap : value, decimals));
}

/** "Balance 727.49 USDC" under the amount, with Max when it has one. Nothing without a reading. */
function SourceBalance({
  value,
  loading,
  decimals,
  symbol,
  stable,
  over,
  onMax,
}: {
  value: bigint | null;
  loading: boolean;
  decimals: number;
  symbol: string;
  stable?: boolean;
  /** The source chain's name when the amount is more than the balance there. */
  over: string | null;
  onMax: (() => void) | null;
}) {
  if (loading) {
    return (
      <p className="mt-2 text-[12px] text-faint" aria-live="polite">
        Balance …
      </p>
    );
  }
  if (value == null) return null;
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="tnum text-[12px] text-mute">
          Balance {formatBridgeBalance(value, decimals, stable)} {symbol}
        </span>
        {onMax && (
          <button
            type="button"
            disabled={value === BigInt(0)}
            onClick={onMax}
            className="h-9 rounded-full border border-line px-3 text-[12.5px] text-soft transition-colors hover:bg-surface hover:text-foreground disabled:opacity-40"
          >
            Max
          </button>
        )}
      </div>
      {over && <p className="mt-1 text-[12px] text-mute">More than your balance on {over}.</p>}
    </>
  );
}

/** "Powered by" Relay's own wordmark, dark or light with the theme, linking to Relay. */
function PoweredByRelay() {
  return (
    <span className="whitespace-nowrap">
      Powered by{" "}
      <a
        href="https://relay.link"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Relay"
        className="inline-block align-baseline opacity-80 transition-opacity hover:opacity-100"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- small local logo */}
        <img src="/brand/partners/relay.svg" alt="" width={66} height={15} className="inline-block h-[15px] w-auto dark:hidden" />
        {/* eslint-disable-next-line @next/next/no-img-element -- small local logo */}
        <img src="/brand/partners/relay-white.svg" alt="" width={66} height={15} className="hidden h-[15px] w-auto dark:inline-block" />
      </a>
    </span>
  );
}

/** Two decimals, rounded down, so "Add it privately" never asks for more than arrived. */
function floor2(text: string): string {
  return (Math.floor(Number(text) * 100) / 100).toFixed(2);
}

function SwapReview({
  quote,
  hash,
  pending,
  error,
  landed,
  waitFailed,
  onSign,
  onArrived,
  onReset,
}: {
  quote: BridgeQuote;
  hash: Hex | undefined;
  pending: boolean;
  error: Error | null;
  landed: boolean;
  waitFailed: boolean;
  onSign: () => void;
  onArrived: (amount: string) => void;
  onReset: () => void;
}) {
  const cancelled = error && /reject|denied|cancel/i.test(error.message);
  const line = landed
    ? `Swapped. Your ${quote.receive.symbol} is in your wallet on ${quote.receive.chain}.`
    : waitFailed
      ? "Sent. It's taking a while to confirm; check your wallet's activity."
      : hash
        ? "Swapping…"
        : pending
          ? "Confirm the swap in your wallet…"
          : null;
  return (
    <div className="mt-5" aria-live="polite">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] leading-relaxed text-foreground">
        Swap
        <TokenMark src={quote.send.logo} size={18} />
        <span className="tnum font-medium">
          {quote.send.amount} {quote.send.symbol}
        </span>
        on
        <ChainLogo id={quote.send.chainId} size={18} />
        {quote.send.chain}
        {quote.send.usd !== null && <span className="tnum text-mute">(about ${quote.send.usd.toFixed(2)})</span>}
      </p>

      <dl className="mt-4 divide-y divide-line text-[14px]">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">You get about</dt>
          <dd className="tnum flex items-center gap-1.5 text-right text-foreground">
            <TokenMark src={quote.receive.logo} size={18} />
            {Number(quote.receive.amount).toFixed(2)} {quote.receive.symbol}
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Rate</dt>
          <dd className="tnum text-right text-foreground">{rateLine(quote)}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">At least</dt>
          <dd className="tnum text-right text-foreground">
            {Number(quote.receive.minimum).toFixed(2)} {quote.receive.symbol}
          </dd>
        </div>
        {feeRows(quote, "Swap fee").map(([k, v]) => (
          <div key={k} className="flex min-h-11 items-center justify-between gap-3">
            <dt className="text-mute">{k}</dt>
            <dd className="tnum text-right text-foreground">{v}</dd>
          </div>
        ))}
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Network fee</dt>
          <dd className="text-right text-foreground">A few cents of {quote.send.symbol}</dd>
        </div>
      </dl>

      <CostWarning quote={quote} />

      {line && (
        <p
          className={`mt-4 flex items-center gap-2.5 rounded-2xl bg-surface px-4 py-3 text-[13.5px] ${
            landed ? "text-sealed" : "text-foreground"
          }`}
        >
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${landed ? "bg-sealed" : "animate-pulse bg-foreground/50"}`}
          />
          {line}
        </p>
      )}

      {error && !hash && (
        <p role="alert" className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[13px] leading-relaxed text-danger">
          {cancelled ? "You cancelled it in your wallet. Nothing moved." : walletErrorText(error) || "It didn't send. Try again."}
        </p>
      )}

      {landed ? (
        <button
          type="button"
          onClick={() => onArrived(floor2(quote.receive.minimum))}
          className="btn btn-ink btn-lg btn-block mt-4"
        >
          Add it privately
        </button>
      ) : (
        <>
          {!hash && (
            <button type="button" onClick={onSign} disabled={pending} className="btn btn-ink btn-lg btn-block mt-4">
              {pending ? "Waiting for your wallet…" : "Swap in your wallet"}
            </button>
          )}
          {!pending && !hash && (
            <button type="button" onClick={onReset} className="btn btn-ghost btn-sm mt-3">
              Start over
            </button>
          )}
        </>
      )}
      {!hash && (
        <p className="mt-3 text-[12px] leading-relaxed text-mute">
          Prices move. If a minute passes before you sign, start over for a fresh price.
        </p>
      )}
    </div>
  );
}

/** Dollars with cents and thousands separators. */
function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "1 ETH = 2,504.83 USDG", from what a quote sends and returns. */
function rateLine(q: BridgeQuote): string {
  const rate = Number(q.receive.amount) / Number(q.send.amount);
  return Number.isFinite(rate) && rate > 0 ? `1 ${q.send.symbol} = ${fmtMoney(rate)} ${q.receive.symbol}` : "";
}

/** The live price under the swap amount: what arrives, the rate and the fees. */
function SwapPrice({ quote, from, to }: { quote: BridgeQuote | null; from: string; to: string }) {
  const wait = <span aria-hidden className="inline-block h-3.5 w-20 animate-pulse rounded bg-foreground/10" />;
  const rows: [string, React.ReactNode][] = [
    [
      "You get about",
      quote ? (
        <span className="flex items-center gap-1.5 font-medium">
          <TokenMark src={quote.receive.logo} size={16} />
          {fmtMoney(Number(quote.receive.amount))} {to}
        </span>
      ) : (
        wait
      ),
    ],
    ["Rate", quote ? rateLine(quote) : wait],
    ["At least", quote ? `${fmtMoney(Number(quote.receive.minimum))} ${to}` : wait],
    ...(quote ? feeRows(quote, "Swap fee") : ([["Swap fee", wait]] as [string, React.ReactNode][])),
    ["Network fee", `A few cents of ${from}`],
  ];
  return (
    <>
      <dl className="divide-y divide-line rounded-2xl bg-surface px-4 text-[13.5px]" aria-live="polite" aria-busy={!quote}>
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-h-10 items-center justify-between gap-3">
            <dt className="text-mute">{k}</dt>
            <dd className="tnum text-right text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      {quote && <CostWarning quote={quote} />}
    </>
  );
}

/** Relay's fee under `label`, then Gloam's own on a line of its own when it takes one (BRIDGE_FEE_BPS). */
function feeRows(q: { feeUsd: number; appFee: BridgeAppFee | null }, label: string): [string, string][] {
  const { relayUsd, app } = bridgeFeeLines(q);
  const said = (usd: number) => (usd < 0.01 ? "Under a cent" : `about $${fmtMoney(usd)}`);
  return [[label, said(relayUsd)], ...(app ? ([[`Gloam fee (${formatFeePercent(app.bps)})`, said(app.usd)]] as [string, string][]) : [])];
}

/**
 * Said before anything is sent when a route costs over 3% of what you pay
 * (lib/bridge expensiveRoute). The fees are already in the rows above; this
 * puts the total in plain words and says what tends to cost less.
 */
function CostWarning({ quote }: { quote: CostedQuote & { receive: { symbol: string } } }) {
  const cost = expensiveRoute(quote);
  if (!cost) return null;
  const pct = cost.share >= 0.1 ? Math.round(cost.share * 100) : Math.round(cost.share * 1000) / 10;
  return (
    <p role="status" className="mt-4 rounded-xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
      This route costs about {pct}% of what you pay (${fmtMoney(cost.usd)}). A larger amount spreads the fixed fees,
      and another chain or token, or {quote.receive.symbol} sent straight to your wallet, may cost less.
    </p>
  );
}
