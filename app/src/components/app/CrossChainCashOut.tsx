"use client";

/**
 * Pay > Cash out, "Lands on" (lib/cashOutCrossChain): the same token on this
 * chain (the default, today's cash out) or a stablecoin on another chain
 * through Relay. This draws the picker, the Solana address field, the price,
 * and where an order stands after it is sent. MoveView owns the cash out.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { chainLogo } from "@/lib/bridge";
import type { BridgeStage } from "@/lib/bridge";
import { shortAddress } from "@/lib/chain";
import {
  crossChainAmountProblem,
  crossChainSource,
  relayOrderUrl,
  requestCrossChainQuote,
  validCrossChainRecipient,
  type CrossChainDestination,
  type CrossChainQuote,
} from "@/lib/cashOutCrossChain";

function ChainLogo({ id, size = 18 }: { id: number; size?: number }) {
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogo(id)} alt="" width={size} height={size} className="h-full w-full object-cover dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogo(id, true)} alt="" width={size} height={size} className="hidden h-full w-full object-cover dark:block" />
    </span>
  );
}

const money = (v: string) =>
  Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "Lands on": this chain as today, or another chain. */
export function CrossChainPicker({
  chainId,
  chainLabel,
  symbol,
  destinations,
  value,
  onChange,
  disabled,
}: {
  chainId: number;
  chainLabel: string;
  symbol: string;
  destinations: CrossChainDestination[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const options: { id: string | null; chainId: number; label: string; hint: string }[] = [
    { id: null, chainId, label: chainLabel, hint: symbol },
    ...destinations.map((d) => ({ id: d.id, chainId: d.chainId, label: d.chain, hint: d.token.symbol })),
  ];
  return (
    <div>
      <p id="cashout-lands" className="text-[13px] text-mute">Lands on</p>
      <div role="radiogroup" aria-labelledby="cashout-lands" className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map((o) => {
          const active = value === o.id;
          return (
            <button
              key={o.id ?? "same"}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(o.id)}
              className={`flex min-h-[48px] min-w-0 items-center gap-2.5 rounded-[14px] border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                active ? "border-foreground bg-panel" : "border-line hover:border-line-strong hover:bg-surface"
              }`}
            >
              <ChainLogo id={o.chainId} />
              <span className="min-w-0">
                <span className="block truncate text-[14px] leading-snug text-foreground">{o.label}</span>
                <span className="block text-[12px] leading-snug text-mute">{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {value !== null && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
          Relay moves it to the other chain in the same step. It goes out now, all at once.
        </p>
      )}
    </div>
  );
}

/**
 * The address on the other chain and the live price. A Solana address is typed
 * here; an EVM one comes from MoveView's To. The price is asked for again as
 * the amount, the address or the fee changes.
 */
export function CrossChainQuoteCard({
  networkKey,
  chainId,
  asset,
  destination,
  netAmount,
  evmRecipient,
  refundTo,
  ready,
  quote,
  onQuote,
  disabled,
}: {
  networkKey: string;
  chainId: number;
  asset: string;
  destination: CrossChainDestination;
  /** What the vault pays out after its fee, raw units. */
  netAmount: bigint;
  evmRecipient: Address | null;
  refundTo: Address | null;
  /** The amount and fee are known. */
  ready: boolean;
  /** The price for exactly these inputs, or null (MoveView drops one that no longer fits). */
  quote: CrossChainQuote | null;
  onQuote: (q: CrossChainQuote | null) => void;
  disabled?: boolean;
}) {
  const [solanaTo, setSolanaTo] = useState("");
  /** The last answer, for the inputs it was asked with. */
  const [result, setResult] = useState<{ key: string; error?: string } | null>(null);
  const source = crossChainSource(chainId, asset);
  const recipient = destination.kind === "svm" ? solanaTo.trim() : (evmRecipient ?? "");
  const recipientOk = recipient !== "" && validCrossChainRecipient(destination, recipient);
  const amountProblem = source ? crossChainAmountProblem(netAmount, source.decimals) : "This can't go to another chain.";
  const key = ready && recipientOk && refundTo && !amountProblem ? `${destination.id}:${recipient}:${refundTo}:${netAmount}` : null;
  const loading = key !== null && result?.key !== key;
  const error = key !== null && result?.key === key ? (result.error ?? null) : null;

  useEffect(() => {
    if (!key || !refundTo) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      requestCrossChainQuote({ network: networkKey, asset, amount: netAmount, destination: destination.id, recipient, refundTo, signal: ctrl.signal })
        .then((q) => {
          if (ctrl.signal.aborted) return;
          setResult({ key });
          onQuote(q);
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setResult({ key, error: e instanceof Error ? e.message : "Relay couldn't price this right now. Try again." });
        });
    }, 600);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
    // the key holds everything the price depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, networkKey]);

  return (
    <div className="space-y-3">
      {destination.kind === "svm" && (
        <div>
          <label htmlFor="cashout-solana" className="text-[13px] text-mute">
            Solana address
          </label>
          <input
            id="cashout-solana"
            value={solanaTo}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => {
              setSolanaTo(e.target.value.trim());
              onQuote(null);
            }}
            placeholder="The Solana wallet that gets the USDC"
            className="gl-input tnum mt-2"
          />
          {solanaTo && !recipientOk && (
            <p className="mt-2 text-[12.5px] text-warn">That isn&apos;t a Solana address. Check it and paste it again.</p>
          )}
        </div>
      )}

      <div className="rounded-[16px] bg-surface p-[16px] sm:p-5">
        <p className="text-[13px] text-mute">{`You get on ${destination.chain}`}</p>
        {quote ? (
          <>
            <p className="tnum mt-1.5 flex items-center gap-2 truncate text-[22px] font-light leading-tight text-foreground">
              <ChainLogo id={destination.chainId} size={20} />
              {money(quote.receive.amount)} <span className="text-[14px] text-mute">{quote.destination.symbol}</span>
            </p>
            <p className="tnum mt-1 text-[12.5px] leading-relaxed text-mute">
              {`At least ${money(quote.receive.minimum)} ${quote.destination.symbol}. Relay fee about $${quote.feeUsd.toFixed(2)}. ${quote.timeSec > 0 && quote.timeSec < 120 ? "Usually under a minute." : "Usually a few minutes."}`}
            </p>
          </>
        ) : (
          <p className={`mt-1.5 text-[13px] leading-relaxed ${error || (amountProblem && ready) ? "text-warn" : "text-mute"}`}>
            {loading
              ? "Getting a price from Relay…"
              : error
                ? error
                : amountProblem && ready
                  ? amountProblem
                  : !recipientOk
                    ? destination.kind === "svm"
                      ? "Paste the Solana address to see the price."
                      : `Pick the address on ${destination.chain} to see the price.`
                    : !refundTo
                      ? "Connect a wallet to see the price."
                      : "Getting a price from Relay…"}
          </p>
        )}
      </div>

      {refundTo && source && (
        <p className="text-[12.5px] leading-relaxed text-mute">
          {`If Relay can't deliver it, it sends the ${source.symbol} back to your wallet ${shortAddress(refundTo, 4)} on this chain. That refund would be public.`}
        </p>
      )}
    </div>
  );
}

/** Where a cash out to another chain stands, read from Relay every few seconds until it ends. */
export function CrossChainCashOutStatus({ quote, explorerTx }: { quote: CrossChainQuote; explorerTx: (hash: string) => string }) {
  const [stage, setStage] = useState<BridgeStage>("waiting");
  const [outTx, setOutTx] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const started = Date.now();
    async function check() {
      try {
        const res = await fetch(
          `/api/bridge/status?requestId=${encodeURIComponent(quote.requestId)}&depositAddress=${encodeURIComponent(quote.depositAddress)}`,
          { cache: "no-store" }
        );
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { stage: BridgeStage; outTx: string | null } } | null;
        if (!stopped && json?.ok && json.data) {
          setStage(json.data.stage);
          setOutTx(json.data.outTx);
          if (json.data.stage === "done" || json.data.stage === "refunded" || json.data.stage === "failed") return;
        }
      } catch {
        /* tried again below */
      }
      // stop asking after an hour; the Relay link still follows it
      if (!stopped && Date.now() - started < 60 * 60 * 1000) timer = window.setTimeout(() => void check(), 5_000);
    }
    void check();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [quote.requestId, quote.depositAddress]);

  const d = quote.destination;
  const line =
    stage === "done"
      ? `Arrived on ${d.chain}.`
      : stage === "refunded"
        ? `Relay couldn't deliver it, so it sent the ${quote.sourceSymbol} back to your wallet ${shortAddress(quote.refundTo, 4)}.`
        : stage === "failed"
          ? `Relay couldn't deliver it. A refund goes back to your wallet ${shortAddress(quote.refundTo, 4)}. Follow it on Relay.`
          : stage === "moving"
            ? `Relay is moving it to ${d.chain}.`
            : "Waiting for the cash out to reach Relay.";

  return (
    <div className="rounded-[14px] bg-surface px-4 py-3.5 text-[13px] leading-relaxed text-foreground">
      <p className="flex items-center gap-2">
        <ChainLogo id={d.chainId} />
        <span>{line}</span>
      </p>
      <p className="mt-1 text-mute">
        {`${money(quote.receive.amount)} ${d.symbol} to ${shortAddress(quote.recipient, 4)} on ${d.chain}, at least ${money(quote.receive.minimum)}.`}
      </p>
      <p className="mt-2 flex flex-wrap gap-x-4">
        {stage === "done" && outTx && (
          <a href={explorerTx(outTx)} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
            {`See it on ${d.chain}`}
          </a>
        )}
        <a href={relayOrderUrl(quote.requestId)} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
          Follow it on Relay
        </a>
      </p>
    </div>
  );
}
