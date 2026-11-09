"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { formatEther, formatUnits, isAddress } from "viem";
import { formatEth, shortAddress } from "@/lib/chain";
import {
  useAppAccount,
  useAppBalance,
  useAppSendTransaction,
  useAppTokenBalance,
  useAppTxReceipt,
  useAppWriteContract,
} from "@/lib/demo";
import { useNetwork } from "./NetworkProvider";
import { useModalFocus } from "@/hooks/useModalFocus";
import { safeParseEther, safeParseUnits } from "@/lib/amount";
import { erc20Abi } from "@/lib/dex";
import { estimateMaxNativeSend, type MaxNativeSend } from "@/lib/nativeSend";
import { NATIVE_CHOICE, hasNativeCoin, maxTokenSend, pickedToken, publicSendTargetProblem, publicSendTokens } from "@/lib/publicSend";
import { getRhPublicClient } from "@/lib/rhClient";
import { formatAssetAmount } from "@/lib/shield";
import { isDollarStable } from "@/lib/tokens";
import { amountTextError } from "@/lib/amountText";
import { hasCoingeckoMarks, useCoingeckoMarks } from "@/hooks/useCoingeckoMarks";
import { useEthPrice, useLiveMarkets } from "@/hooks/useLiveMarkets";
import { useTradingSettings } from "@/hooks/useTradingSettings";
import { formatUsd } from "@/lib/markets";
import { Select } from "@/components/ui/Select";
import { TokenLogo } from "./TokenLogo";
import { WalletMenu } from "./WalletMenu";
import { SuccessModal } from "./SuccessModal";
import { walletErrorForPeople } from "@/lib/walletErrors";

export function SendView() {
  const { address, isConnected, chainId, demo } = useAppAccount();
  const { network } = useNetwork();
  const onProduct = chainId === network.chainId;
  const { ethUsd } = useEthPrice();
  const { data: marketData } = useLiveMarkets();
  // Tokens the markets feed has no price for, $GLOAM and PONS among them.
  const { marks: geckoMarks } = useCoingeckoMarks(hasCoingeckoMarks(network.chainId));
  const { settings } = useTradingSettings();
  const { data: bal, refetch } = useAppBalance({
    address,
    chainId: network.chainId,
    enabled: Boolean(address),
  });

  // Tempo has no native coin, so it starts on its first stablecoin. What is
  // picked is worked out each render, so a network switch can't leave another
  // chain's token in the form.
  const tokens = useMemo(() => publicSendTokens(network.chainId), [network.chainId]);
  const nativeOk = hasNativeCoin(network);
  const [choice, setChoice] = useState(NATIVE_CHOICE);
  const token = pickedToken(choice, network, tokens);
  const symbol = token?.symbol ?? network.primaryAsset.symbol;
  const decimals = token?.decimals ?? 18;
  const { data: tokenBal, refetch: refetchToken } = useAppTokenBalance({
    token: token?.address,
    address,
    chainId: network.chainId,
    enabled: Boolean(token && onProduct),
  });
  const balance = token ? tokenBal : bal?.value;

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [sentAmount, setSentAmount] = useState("");
  const [sentSymbol, setSentSymbol] = useState("");
  const [sentTo, setSentTo] = useState("");
  // What Max set aside the fee for: sending that value to that address asks
  // the wallet for exactly that gas and fee, so value + fee fits the balance.
  const [maxSend, setMaxSend] = useState<(MaxNativeSend & { to: string; chainId: number }) | null>(null);
  const [estimatingMax, setEstimatingMax] = useState(false);
  // Bumped by every edit, so an estimate that comes back after one is dropped.
  const maxRun = useRef(0);
  // The review is a modal: focus moves into it and stays there, Escape closes it.
  const review = useRef<HTMLDivElement>(null);
  useModalFocus(review, () => setShowPreview(false), { open: showPreview });

  const native = useAppSendTransaction();
  const tokenSend = useAppWriteContract();
  // One of the two is in use: each send resets both first.
  const hash = native.data ?? tokenSend.data;
  const isPending = native.isPending || tokenSend.isPending;
  const sendError = native.error ?? tokenSend.error;

  const { isLoading: confirming, isSuccess, data: receipt } = useAppTxReceipt({
    hash,
    chainId: network.chainId,
  });

  const handledHash = useRef<string | null>(null);

  useEffect(() => {
    if (!isSuccess || !hash) return;
    if (handledHash.current === hash) return;
    handledHash.current = hash;
    void refetch();
    void refetchToken();
    // A token can refuse a transfer (a frozen address, say): mined, but nothing moved.
    if (receipt?.status === "reverted") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the transfer's receipt arrived: say it failed, once per transaction
      setFormError(`This ${sentSymbol} transfer failed on chain, so nothing moved. Network fee only.`);
      return;
    }
    if (settings.confirmSends) setShowSuccess(true);
    // no pop-up: clear the amount here, so pressing Send again can't repeat the payment by accident
    else setAmount("");
  }, [isSuccess, hash, receipt, sentSymbol, refetch, refetchToken, settings.confirmSends]);

  /** The amount in the asset's base units, or null when it doesn't read as a number. */
  function parseAmount(text: string): bigint | null {
    return token ? safeParseUnits(text || "0", token.decimals) : safeParseEther(text || "0");
  }

  function validate(): string | null {
    if (!isConnected || !onProduct) {
      return network.testnet ? "Connect and switch to testnet." : `Connect and switch to ${network.label}.`;
    }
    if (!isAddress(to)) return "Enter a valid address.";
    const lost = publicSendTargetProblem(to, network);
    if (lost) return lost;
    const value = parseAmount(amount);
    if (value === null) return "Invalid amount.";
    if (value <= BigInt(0)) return "Amount must be greater than zero.";
    if (balance !== undefined && value > balance) return network.testnet ? `Not enough testnet ${symbol}.` : `Not enough ${symbol}.`;
    return null;
  }

  async function fillMax() {
    if (token) {
      // The network fee isn't paid in this token (Tempo aside, lib/publicSend), so nothing to estimate.
      if (tokenBal === undefined) return;
      maxRun.current++;
      setFormError(null);
      setAmount(formatUnits(maxTokenSend(tokenBal, token.decimals, network), token.decimals));
      return;
    }
    if (!address || !bal) return;
    if (!isAddress(to)) {
      setFormError("Enter the address first, so Max can set the network fee aside.");
      return;
    }
    const run = ++maxRun.current;
    setFormError(null);
    setEstimatingMax(true);
    try {
      const max = demo
        ? { value: bal.value, gas: 0n, fees: { gasPrice: 0n } }
        : await estimateMaxNativeSend(getRhPublicClient(), address, to);
      if (run !== maxRun.current) return;
      setMaxSend({ ...max, to, chainId: network.chainId });
      setAmount(formatEther(max.value));
    } catch (e) {
      // our own words (lib/nativeSend) are shown; an RPC error's text (viem's, with a shortMessage) is not
      if (run === maxRun.current) {
        setFormError(e instanceof Error && !("shortMessage" in e) ? e.message : "Could not work out Max. Try again.");
      }
    } finally {
      // Max is off while it runs, so this is the only estimate in flight
      setEstimatingMax(false);
    }
  }

  function executeSend() {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    const value = parseAmount(amount);
    if (value === null) {
      setFormError("Invalid amount.");
      return;
    }
    setFormError(null);
    setShowPreview(false);
    native.reset();
    tokenSend.reset();
    setShowSuccess(false);
    handledHash.current = null;
    setSentAmount(amount);
    setSentSymbol(symbol);
    setSentTo(to);
    if (token) {
      // The wallet estimates the gas: a first transfer to an address costs more, and a token's own code varies.
      tokenSend.writeContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to as `0x${string}`, value],
        chainId: network.chainId,
      });
      return;
    }
    const fromMax =
      !demo && maxSend && maxSend.value === value && maxSend.to === to && maxSend.chainId === network.chainId
        ? { gas: maxSend.gas, ...maxSend.fees }
        : {};
    native.sendTransaction({
      to: to as `0x${string}`,
      value,
      chainId: network.chainId,
      ...fromMax,
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);

    // Fast send: go straight to wallet (still needs one signature, non-custodial)
    if (settings.fastSend) {
      executeSend();
      return;
    }
    setShowPreview(true);
  }

  // display only: Max reads the raw balance (lib/nativeSend, lib/publicSend), never this text
  const balanceText = token
    ? balance !== undefined
      ? formatAssetAmount(balance, token.address)
      : "0"
    : bal
      ? formatEth(bal.value, 6)
      : "0";
  const amtNum = Number(amount);
  // "1,25" or "-1" is refused out loud, never quietly turned into 125 or 1
  const amountProblem = amountTextError(amount, decimals);
  const usdEach = token
    ? isDollarStable(token)
      ? 1
      : (marketData?.markets?.find((m) => m.id === token.id)?.mark ?? geckoMarks.get(token.address.toLowerCase()) ?? null)
    : ethUsd;
  const usdHint =
    usdEach && Number.isFinite(amtNum) && amtNum > 0
      ? formatUsd(amtNum * usdEach)
      : null;
  const validPreview = !validate() && isAddress(to) && amtNum > 0;

  const connectedOk = isConnected && onProduct;
  const busy = isPending || confirming || estimatingMax;

  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <form onSubmit={onSubmit} className="gl-card min-w-0 p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="t-title text-foreground">Send from your wallet</h2>
              <p className="mt-1 text-[14px] leading-relaxed text-mute">
                A regular transfer to any 0x address on {network.label}.
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[12px] text-mute">
              <EyeIcon />
              Public
            </span>
          </div>

          <div className="gl-inputcard mt-6 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <label htmlFor="send-amount" className="text-mute">
                You send
              </label>
              <button
                type="button"
                disabled={!isConnected || !onProduct || balance === undefined || busy}
                onClick={() => void fillMax()}
                title={token ? "Your whole balance of this token" : "Your balance, less the network fee for this send"}
                aria-busy={estimatingMax || undefined}
                className="tnum -my-2 inline-flex min-h-10 items-center gap-1.5 text-mute transition-colors hover:text-foreground disabled:opacity-45"
              >
                Balance {isConnected && onProduct ? balanceText : "0"} {symbol}
                <span className="font-medium text-foreground">{estimatingMax ? "Max…" : "Max"}</span>
              </button>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <input
                id="send-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={amount}
                onChange={(e) => {
                  maxRun.current++;
                  setAmount(e.target.value);
                }}
                className="tnum min-w-0 flex-1 bg-transparent text-[40px] font-light leading-[1.15] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint sm:text-[46px]"
                aria-label="Amount to send"
              />
              <Select
                variant="pill"
                align="end"
                className="shrink-0"
                label="Asset to send"
                value={token?.id ?? NATIVE_CHOICE}
                // the send under way is for the asset it started with
                disabled={busy}
                onChange={(v) => {
                  maxRun.current++;
                  setChoice(v);
                  setAmount("");
                  setMaxSend(null);
                  setFormError(null);
                }}
                options={[
                  ...(nativeOk
                    ? [{ value: NATIVE_CHOICE, label: network.primaryAsset.symbol, description: "Ether", icon: <EthMark /> }]
                    : []),
                  ...tokens.map((t) => ({
                    value: t.id,
                    label: t.symbol,
                    description: t.name,
                    icon: <TokenLogo id={t.id} symbol={t.symbol} size={30} />,
                  })),
                ]}
              />
            </div>
            <p className={`tnum mt-1 min-h-5 text-[13px] ${amountProblem ? "text-danger" : "text-mute"}`} role={amountProblem ? "alert" : undefined}>
              {amountProblem ?? (usdHint ? `≈ ${usdHint}` : " ")}
            </p>
          </div>

          <div className="mt-5">
            <label htmlFor="send-to" className="text-[13px] text-mute">
              To
            </label>
            <input
              id="send-to"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={to}
              onChange={(e) => {
                maxRun.current++;
                setTo(e.target.value.trim());
              }}
              className="gl-input tnum mt-2"
            />
          </div>

          {validPreview && (
            <dl className="mt-5 divide-y divide-line rounded-[16px] border border-line px-4 text-[14px]">
              <div className="flex min-h-11 items-center justify-between gap-4 py-2">
                <dt className="text-mute">Sending</dt>
                <dd className="tnum text-right text-foreground">
                  {amount} {symbol}
                  {usdHint ? <span className="text-mute">, {usdHint}</span> : null}
                </dd>
              </div>
              <div className="flex min-h-11 items-center justify-between gap-4 py-2">
                <dt className="text-mute">To</dt>
                <dd className="tnum text-foreground">{shortAddress(to, 6)}</dd>
              </div>
            </dl>
          )}

          <div className="mt-6">
            {!connectedOk ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-surface px-4 py-3">
                <p className="text-[14px] text-mute">
                  {!isConnected
                    ? "Connect a wallet to send."
                    : `Switch to ${network.label} to send.`}
                </p>
                <WalletMenu />
              </div>
            ) : (
              <button
                type="submit"
                disabled={busy}
                className="btn btn-ink btn-lg btn-block"
              >
                {busy && <Spinner />}
                {isPending
                  ? "Confirm in wallet…"
                  : confirming
                    ? "Sending…"
                    : settings.fastSend
                      ? "Send now"
                      : "Review and send"}
              </button>
            )}
          </div>

          {(formError || sendError) && (
            <p
              role="alert"
              className="mt-4 break-words rounded-xl bg-danger-soft px-4 py-3 text-[13.5px] leading-relaxed text-danger"
            >
              {formError || walletErrorForPeople(sendError)}
            </p>
          )}
          {hash && isSuccess && !settings.confirmSends && receipt?.status !== "reverted" && (
            <p className="mt-4 flex items-center justify-center gap-2 text-[13.5px] text-mute" aria-live="polite">
              Sent.
              <a
                href={network.explorerTx(hash)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                View transaction
              </a>
            </p>
          )}
          {hash && !isSuccess && (
            <p className="mt-4 flex items-center justify-center gap-2 text-[13.5px] text-mute">
              Submitted.
              <a
                href={network.explorerTx(hash)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                View transaction
              </a>
            </p>
          )}
        </form>

        <aside className="space-y-4">
          <div className="gl-card p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-mute">What the explorer shows</p>
              <span className="inline-flex items-center gap-1.5 text-[12px] text-mute">
                <EyeIcon />
                Everything
              </span>
            </div>
            <dl className="mt-3 divide-y divide-line text-[14px]">
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">From</dt>
                <dd className="tnum truncate text-foreground">
                  {address ? shortAddress(address, 4) : "Your wallet"}
                </dd>
              </div>
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">To</dt>
                <dd className="tnum truncate text-foreground">
                  {isAddress(to) ? shortAddress(to, 4) : "Their wallet"}
                </dd>
              </div>
              <div className="flex h-11 items-center justify-between gap-3">
                <dt className="text-mute">Amount</dt>
                <dd className="tnum truncate text-foreground">
                  {amtNum > 0 ? `${amount} ${symbol}` : "The full amount"}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
              A public send is a normal transfer. Anyone can see who sent what to
              whom.
            </p>
          </div>

          <div className="gl-card p-5">
            <p className="text-[15px] text-foreground">Want it private?</p>
            <p className="mt-1 text-[13px] leading-relaxed text-mute">
              Pay from your private balance and the amount and the person you pay
              stay off the public record.
            </p>
            <Link href="/app/vault?tab=move" className="btn btn-ghost btn-sm mt-4">
              Pay privately
            </Link>
          </div>
        </aside>
      </div>

      {showPreview &&
        createPortal(
          <div
            ref={review}
            tabIndex={-1}
            className="fixed inset-0 z-[200] flex items-center justify-center p-[16px] outline-none sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="send-review-title"
          >
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              aria-label="Close"
              onClick={() => setShowPreview(false)}
            />
            <div className="relative z-[1] max-h-[min(90dvh,640px)] w-full max-w-[400px] overflow-y-auto rounded-[24px] bg-panel p-6 shadow-pop sm:p-8">
              <p className="t-eyebrow">Review</p>
              <h2
                id="send-review-title"
                className="mt-2 text-[28px] font-light leading-[1.12] tracking-[-0.018em] text-foreground"
              >
                Confirm send
              </h2>
              <dl className="mt-6 divide-y divide-line border-y border-line text-[14px]">
                <div className="flex min-h-12 items-center justify-between gap-4 py-2">
                  <dt className="text-mute">Amount</dt>
                  <dd className="tnum text-right text-foreground">
                    {amount} {symbol}
                    {usdHint ? <span className="ml-1 text-mute">({usdHint})</span> : null}
                  </dd>
                </div>
                <div className="flex min-h-12 items-center justify-between gap-4 py-2">
                  <dt className="text-mute">To</dt>
                  <dd className="tnum text-foreground">{shortAddress(to, 6)}</dd>
                </div>
                <div className="flex min-h-12 items-center justify-between gap-4 py-2">
                  <dt className="text-mute">Network</dt>
                  <dd className="text-foreground">{network.label}</dd>
                </div>
              </dl>
              <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
                This is a public transfer. The amount and both addresses show on
                the explorer.
              </p>
              <div className="mt-6 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={executeSend}
                  className="btn btn-ink btn-lg btn-block"
                >
                  Confirm in wallet
                </button>
                <button
                  type="button"
                  onClick={() => setShowPreview(false)}
                  className="btn btn-quiet btn-block"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      <SuccessModal
        open={showSuccess && Boolean(hash)}
        title="Sent"
        body={
          <>
            <p>
              <span className="tnum font-medium text-foreground">
                {sentAmount || "0"} {sentSymbol}
              </span>{" "}
              to{" "}
              <span className="tnum text-foreground">
                {sentTo ? shortAddress(sentTo, 5) : ""}
              </span>
            </p>
            <p className="mt-2">{network.testnet ? "Settled on testnet." : `Settled on ${network.label}.`}</p>
          </>
        }
        primaryHref={hash ? network.explorerTx(hash) : undefined}
        primaryLabel="View on explorer"
        secondaryLabel="Send more"
        onClose={() => {
          setShowSuccess(false);
          setAmount("");
        }}
      />
    </>
  );
}

function Spinner() {
  return (
    <span
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80 motion-reduce:animate-none"
      aria-hidden
    />
  );
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** ETH's real mark, the same one Portfolio and every token list show. */
function EthMark({ size = 30 }: { size?: number }) {
  return <TokenLogo id="eth" symbol="ETH" size={size} />;
}
