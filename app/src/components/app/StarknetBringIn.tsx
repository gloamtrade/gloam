"use client";

/**
 * Add privately on Starknet, from another network: the person's own wallet
 * burns USDC there with Circle's CCTP, Circle signs it, Gloam's relay brings it
 * to their Starknet account and the private add follows, one progress view for
 * all of it (lib/starknetPrivacy/cctp says how, and who pays what).
 *
 * What it costs, said before anything is signed: Circle's fast transfer fee
 * where it has one, Gloam's fee to bring it in and its fee to add it, and the
 * network fee on the source chain, which the wallet shows. What lands
 * privately is the amount less those.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, erc20Abi, parseAbi, type Address } from "viem";
import { useConfig, useReadContract } from "wagmi";
import { useAppAccount } from "@/lib/demo";
import { chainLogoSrc } from "@/lib/chainLogo";
import type { GloamChainId } from "@/lib/networks";
import { payRelayTxs, wagmiPayActions, walletPaysAcrossChains } from "@/lib/relayWalletPay";
import { displayAmount, displayAmountText } from "@/lib/amountShort";
import { CCTP_SOURCES, EVM_CCTP_ABI, EVM_TOKEN_MESSENGER_V2, bringInCosts, circleFee, depositForBurnArgs, type CctpSource } from "@/lib/starknetPrivacy/cctp";
import { RELAY_HOP, RELAY_SOURCES, type RelayBringInQuote, type RelaySource } from "@/lib/starknetPrivacy/cctpRelay";
import type { StarknetToken } from "@/lib/starknetPrivacy/config";
import { Select, type SelectOption } from "@/components/ui/Select";
import { parseStarkAmount, useStarknet } from "./StarknetAccount";
import { STARKNET_NAME, StarknetActionButton, StarknetAmountCard, StarknetError, StarknetSteps, starkAmount, starkAmountProblem } from "./StarknetParts";

/** "account" adds what sits on the Starknet account; a chain id brings it in from there. */
export type StarknetAddFrom = "account" | number;

const CCTP_ABI = parseAbi(EVM_CCTP_ABI);

/** The least a bring-in may be: a dollar, and more than the fees it pays. */
const MIN_BRING_IN = 1_000_000n;

function ChainMark({ id, size = 22 }: { id: number; size?: number }) {
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(id)} alt="" width={size} height={size} className="h-full w-full object-cover dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(id, true)} alt="" width={size} height={size} className="hidden h-full w-full object-cover dark:block" />
    </span>
  );
}

/** The networks money can come from: EVM chains with Circle's CCTP that Circle prices (or needs no fee on). */
export function bringInSources(info: { on: boolean; sources: { domain: number; fastBps: number | null }[] } | null): CctpSource[] {
  if (!info?.on) return [];
  return CCTP_SOURCES.filter((s) => s.kind === "evm" && info.sources.some((x) => x.domain === s.domain));
}

/**
 * Gloam's networks CCTP doesn't serve, through Relay to Base first
 * (lib/starknetPrivacy/cctpRelay): on with bringing in, while Circle prices Base.
 */
export function bringInRelaySources(info: { on: boolean; sources: { domain: number; fastBps: number | null }[] } | null): RelaySource[] {
  if (!info?.on || info.sources.find((x) => x.domain === RELAY_HOP.domain)?.fastBps == null) return [];
  return [...RELAY_SOURCES];
}

/** A network's name, for a burn kept on this device. */
function sourceName(chainId: number): string {
  return CCTP_SOURCES.find((s) => s.chainId === chainId)?.name ?? RELAY_SOURCES.find((s) => s.chainId === chainId)?.name ?? "another network";
}

/** The "From" picker on Add privately: the Starknet account itself, or a network to bring USDC in from. */
export function StarknetAddFromPicker({
  value,
  onChange,
  sources,
  relaySources = [],
  disabled,
}: {
  value: StarknetAddFrom;
  onChange: (v: StarknetAddFrom) => void;
  sources: CctpSource[];
  relaySources?: RelaySource[];
  disabled?: boolean;
}) {
  const options = useMemo<SelectOption<string>[]>(
    () => [
      { value: "account", label: `Your ${STARKNET_NAME} account`, description: "USDC already on Starknet" },
      ...sources.map((s) => ({ value: String(s.chainId), label: s.name, icon: <ChainMark id={s.chainId} />, description: `USDC on ${s.name}, through Circle` })),
      ...relaySources.map((s) => ({
        value: String(s.chainId),
        label: s.name,
        icon: <ChainMark id={s.chainId} />,
        description: `${s.tokens.map((t) => t.symbol).join(" or ")} on ${s.name}, through Relay and Circle`,
      })),
    ],
    [sources, relaySources]
  );
  return (
    <div className="gl-inputcard p-5 sm:p-6">
      <p className="text-[13px] text-mute">From</p>
      <Select
        label="Add from"
        value={String(value)}
        onChange={(v) => onChange(v === "account" ? "account" : Number(v))}
        options={options}
        disabled={disabled}
        className="mt-2 w-full"
      />
    </div>
  );
}

/** Shown while a burn from another network hasn't arrived: one button carries on with it. */
export function StarknetBringInPending({ token }: { token: StarknetToken }) {
  const sn = useStarknet();
  if (!sn || !sn.pendingBringIns.length || sn.task) return null;
  return (
    <div className="space-y-2">
      {sn.pendingBringIns.map((p) => {
        return (
          <div key={p.relay ?? p.tx} role="status" className="flex flex-col gap-3 rounded-[16px] bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="tnum min-w-0 text-[14px] leading-relaxed text-foreground">
              {starkAmount(BigInt(p.amount), token)} {token.symbol} from {sourceName(p.chainId)} is on its way.
            </p>
            <button type="button" className="btn btn-ink h-10 shrink-0" onClick={() => void sn.bringIn({ resume: p })}>
              Finish adding it
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Bring USDC in from `source` with the connected wallet and add it privately. */
export function StarknetBringIn({ source, token, onDone }: { source: CctpSource; token: StarknetToken; onDone: (hash: string, lands: bigint) => void }) {
  const sn = useStarknet()!;
  const config = useConfig();
  const wallet = useAppAccount();
  const [amount, setAmount] = useState("");
  const owner = wallet.isConnected && wallet.address ? (wallet.address as Address) : null;
  const canPay = Boolean(owner) && walletPaysAcrossChains(wallet.connector?.type);
  const chainId = source.chainId as GloamChainId;
  const usdc = `0x${source.usdc.slice(-40)}` as Address;
  const bal = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner ?? "0x0000000000000000000000000000000000000000"],
    chainId,
    query: { enabled: canPay, retry: 1, refetchInterval: 30_000 },
  });
  const balance = typeof bal.data === "bigint" ? bal.data : null;
  const value = parseStarkAmount(amount, token.decimals);
  const bps = sn.cctp?.sources.find((s) => s.domain === source.domain)?.fastBps ?? null;
  const receiveFee = BigInt(sn.cctp?.fee ?? "0");
  const costs = value !== null && bps !== null ? bringInCosts(value, source, bps, receiveFee, sn.fee) : null;
  // Circle's fee in plain terms: what it takes from this amount, or its share before one is typed (1.3 bps is 0.013%).
  const circleText =
    bps === null
      ? "Not available right now"
      : value !== null
        ? `${starkAmount(circleFee(value, bps), token)} ${token.symbol} at most`
        : `${Number((bps / 100).toFixed(4))}% of the amount`;
  const landsText = costs ? `${starkAmount(costs.lands, token)} ${token.symbol} or a little more` : value !== null && bps !== null ? "Less than the fees" : `0.00 ${token.symbol}`;
  const working = sn.task?.kind === "bringin";
  const problem = starkAmountProblem(amount, token, balance);
  // One add moves at most the relay's cap: a bring-in over it would arrive and then wait for a second add.
  const cap = sn.maxAdd > 0n ? sn.maxAdd + receiveFee : 0n;
  const stop = !sn.relay?.funded || sn.relay.moves === "off"
    ? "Paused for a moment"
    : !canPay
      ? "Connect a browser wallet"
      : bps === null && source.fast
        ? "Circle's fee isn't available right now"
        : !amount.trim() || !value
          ? "Enter an amount"
          : (problem ??
            (value < MIN_BRING_IN
              ? `At least ${starkAmount(MIN_BRING_IN, token)} ${token.symbol}`
              : !costs
                ? "That is less than the fees"
                : cap > 0n && value > cap
                  ? `At most ${starkAmount(cap, token)} ${token.symbol} at once`
                  : null));

  const start = () => {
    if (!value || !owner || !sn.address) return;
    const args = depositForBurnArgs({ source, account: sn.address, amount: value, bps: bps ?? 0 });
    const lands = costs?.lands ?? 0n;
    const act = wagmiPayActions(config);
    void sn
      .bringIn({
        sourceSteps: [`Approving on ${source.name}`, `Sending from ${source.name}`],
        burn: async (step) => {
          step(0, "Confirm in your wallet");
          const allowed = await act.allowance(usdc, owner, EVM_TOKEN_MESSENGER_V2 as Address, source.chainId);
          const burn = { to: EVM_TOKEN_MESSENGER_V2, data: encodeFunctionData({ abi: CCTP_ABI, functionName: "depositForBurn", args: args as never }), value: "0", chainId: source.chainId };
          const txs =
            allowed !== null && allowed >= value
              ? [burn]
              : [{ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [EVM_TOKEN_MESSENGER_V2 as Address, value] }), value: "0", chainId: source.chainId }, burn];
          if (txs.length === 1) step(1, "Confirm in your wallet");
          const paid = await payRelayTxs(txs, { amount, symbol: token.symbol, chain: source.name, decimals: token.decimals }, act, (text) => {
            if (text && /bridge|Now confirm/i.test(text)) step(1, "Confirm in your wallet");
          });
          if (!paid.sent) throw new Error(paid.error);
          if (!paid.hash) {
            throw new Error(`Your wallet may have sent it without saying so. If it went out on ${source.name}, it is on its way to your ${STARKNET_NAME} account and the Add privately here takes it once it lands.`);
          }
          step(1, `Waiting for ${source.name}`);
          const rec = await act.receipt(paid.hash, source.chainId);
          if (rec.status !== "success") throw new Error(`It didn't go through on ${source.name}. Nothing moved.`);
          return { domain: source.domain, chainId: source.chainId, tx: paid.hash, amount: value.toString(), at: Date.now() };
        },
      })
      .then((hash) => {
        if (!hash) return;
        setAmount("");
        void bal.refetch();
        onDone(hash, lands);
      });
  };

  return (
    <>
      <StarknetAmountCard
        id={`sn-bring-${source.chainId}`}
        label="Bring in"
        balanceLabel={`In your wallet on ${source.name}`}
        balance={canPay ? balance : null}
        token={token}
        amount={amount}
        onAmount={setAmount}
        problem={problem}
        disabled={working}
      />
      <dl className="mt-3 divide-y divide-line text-[13.5px]">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">You add privately</dt>
          <dd className="tnum text-right text-foreground">{landsText}</dd>
        </div>
        {source.fast && (
          <div className="flex min-h-11 items-center justify-between gap-3">
            <dt className="text-mute">Circle&apos;s fee</dt>
            <dd className="tnum text-right text-foreground">{circleText}</dd>
          </div>
        )}
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Gloam&apos;s fee</dt>
          <dd className="tnum text-right text-foreground">
            {starkAmount(receiveFee + sn.fee, token)} {token.symbol}
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Network fee</dt>
          <dd className="text-right text-foreground">In your wallet, on {source.name}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Arrives</dt>
          <dd className="text-right text-foreground">In a few minutes</dd>
        </div>
      </dl>
      <StarknetActionButton kind="bringin" label="Bring in privately" stop={stop} className="mt-5" onClick={start} />
      <StarknetSteps task={working ? sn.task : null} className="mt-4" />
      <StarknetError kind="bringin" className="mt-4" />
      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
        Your wallet sends USDC on {source.name} to your {STARKNET_NAME} account through Circle. That transfer is public. It becomes private once it is added.
      </p>
    </>
  );
}

/** How long a Relay quote stays good to sign without asking again. */
const QUOTE_MS = 45_000;
const quoteStale = (at: number) => Date.now() - at >= QUOTE_MS;

type QuoteState = { status: "idle" } | { status: "loading" } | { status: "ready"; quote: RelayBringInQuote; key: string; at: number } | { status: "error"; message: string };

/** A decimal string of `decimals` places as base units (Relay's amountFormatted). */
function baseUnits(text: string, decimals: number): bigint {
  const [w, f = ""] = text.split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/**
 * Bring USDC in from a Gloam network CCTP doesn't serve: the wallet pays one
 * Relay order there, Relay delivers USDC on Base and burns it to the Starknet
 * account in the same fill (lib/starknetPrivacy/cctpRelay), then as any bring-in.
 * The amount is the USDC that reaches Base; the quote says what the wallet pays.
 */
export function StarknetBringInRelay({ source, token, onDone }: { source: RelaySource; token: StarknetToken; onDone: (hash: string, lands: bigint) => void }) {
  const sn = useStarknet()!;
  const config = useConfig();
  const wallet = useAppAccount();
  const [amount, setAmount] = useState("");
  const [symbol, setSymbol] = useState(source.tokens[0]!.symbol);
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const pay = source.tokens.find((t) => t.symbol === symbol) ?? source.tokens[0]!;
  const owner = wallet.isConnected && wallet.address ? (wallet.address as Address) : null;
  const canPay = Boolean(owner) && walletPaysAcrossChains(wallet.connector?.type);
  const bal = useReadContract({
    address: pay.address as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner ?? "0x0000000000000000000000000000000000000000"],
    chainId: source.chainId as GloamChainId,
    query: { enabled: canPay, retry: 1, refetchInterval: 30_000 },
  });
  const balance = typeof bal.data === "bigint" ? bal.data : null;
  const value = parseStarkAmount(amount, token.decimals);
  const bps = sn.cctp?.sources.find((s) => s.domain === RELAY_HOP.domain)?.fastBps ?? null;
  const receiveFee = BigInt(sn.cctp?.fee ?? "0");
  const costs = value !== null && bps !== null ? bringInCosts(value, RELAY_HOP, bps, receiveFee, sn.fee) : null;
  const working = sn.task?.kind === "bringin";
  const cap = sn.maxAdd > 0n ? sn.maxAdd + receiveFee : 0n;
  const key = `${source.chainId}|${pay.symbol}|${amount.trim()}|${owner}|${sn.address}`;
  const typedOk = value !== null && value >= MIN_BRING_IN && costs !== null && !(cap > 0n && value > cap);

  // A quote once the amount settles: what the wallet pays and Relay's fee, before anything is signed.
  const asked = useRef(0);
  const ask = async (): Promise<QuoteState> => {
    const n = ++asked.current;
    setQuote({ status: "loading" });
    const res = await fetch("/api/starknet/cctp/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: source.chainId, symbol: pay.symbol, amount: amount.trim(), account: sn.address, sender: owner }),
    }).catch(() => null);
    const body = res ? ((await res.json().catch(() => null)) as { ok?: boolean; quote?: RelayBringInQuote; error?: { message?: string } } | null) : null;
    const next: QuoteState =
      res?.ok && body?.ok && body.quote
        ? { status: "ready", quote: body.quote, key, at: Date.now() }
        : { status: "error", message: body?.error?.message ?? "The bridge couldn't make a route right now. Try again." };
    if (n === asked.current) setQuote(next);
    return next;
  };
  useEffect(() => {
    if (!typedOk || !canPay || !sn.address || working) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to price: the quote clears
      setQuote({ status: "idle" });
      return;
    }
    const t = window.setTimeout(() => void ask(), 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asks again only when what is priced changes
  }, [key, typedOk, canPay, working]);

  const ready = quote.status === "ready" && quote.key === key ? quote : null;
  // The wallet pays in its own token, which may have more places than USDC (BNB Chain's have 18).
  const tooMuch = balance !== null && ready !== null && baseUnits(ready.quote.pay, pay.decimals) > balance;
  const stop =
    !sn.relay?.funded || sn.relay.moves === "off"
      ? "Paused for a moment"
      : !canPay
        ? "Connect a browser wallet"
        : bps === null
          ? "Circle's fee isn't available right now"
          : !amount.trim() || !value
            ? "Enter an amount"
            : value < MIN_BRING_IN
              ? `At least ${starkAmount(MIN_BRING_IN, token)} ${token.symbol}`
              : !costs
                ? "That is less than the fees"
                : cap > 0n && value > cap
                  ? `At most ${starkAmount(cap, token)} ${token.symbol} at once`
                  : quote.status === "error"
                    ? "Try another amount"
                    : !ready
                      ? "Getting a route"
                      : tooMuch
                        ? `Not enough ${pay.symbol} on ${source.name}`
                        : null;

  const start = async () => {
    if (!value || !owner || !sn.address) return;
    // A route a while old is asked for again, so what is signed is what was shown.
    const fresh = ready && !quoteStale(ready.at) ? ready : await ask();
    if (fresh.status !== "ready") return;
    const q = fresh.quote;
    const lands = costs?.lands ?? 0n;
    const act = wagmiPayActions(config);
    const hash = await sn.bringIn({
      sourceSteps: [`Approving on ${source.name}`, `Sending from ${source.name}`],
      burn: async (step, keep) => {
        step(q.txs.length > 1 ? 0 : 1, "Confirm in your wallet");
        const paid = await payRelayTxs(q.txs, { amount: q.pay, symbol: pay.symbol, chain: source.name, decimals: pay.decimals }, act, (text) => {
          if (text && /bridge|Now confirm/i.test(text)) step(1, "Confirm in your wallet");
        });
        if (!paid.sent) throw new Error(paid.error);
        // Relay names its Base transaction once it fills: until then the order is what is kept.
        const p = { domain: RELAY_HOP.domain, chainId: source.chainId, tx: "", relay: q.requestId, amount: q.amount, at: Date.now() };
        keep(p);
        return p;
      },
    });
    if (!hash) return;
    setAmount("");
    void bal.refetch();
    onDone(hash, lands);
  };

  const symbols = useMemo<SelectOption<string>[]>(() => source.tokens.map((t) => ({ value: t.symbol, label: t.symbol })), [source]);
  const payText =
    ready !== null ? `${displayAmountText(ready.quote.pay)} ${pay.symbol} on ${source.name}` : quote.status === "loading" ? "Getting a route..." : quote.status === "error" ? quote.message : "...";
  return (
    <>
      {source.tokens.length > 1 && (
        <div className="gl-inputcard mb-3 p-5 sm:p-6">
          <p className="text-[13px] text-mute">Pay with</p>
          <Select label="Pay with" value={symbol} onChange={setSymbol} options={symbols} disabled={working} className="mt-2 w-full" />
        </div>
      )}
      <StarknetAmountCard
        id={`sn-bring-${source.chainId}`}
        label="Bring in"
        balanceLabel=""
        balanceText={canPay ? `${pay.symbol} in your wallet on ${source.name}: ${balance === null ? "..." : displayAmount(balance, pay.decimals)}` : ""}
        balance={null}
        token={token}
        amount={amount}
        onAmount={setAmount}
        problem={null}
        disabled={working}
      />
      <dl className="mt-3 divide-y divide-line text-[13.5px]">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">You pay</dt>
          <dd className="tnum text-right text-foreground">{payText}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">You add privately</dt>
          <dd className="tnum text-right text-foreground">
            {costs ? `${starkAmount(costs.lands, token)} ${token.symbol} or a little more` : value !== null && bps !== null ? "Less than the fees" : `0.00 ${token.symbol}`}
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Bridge fee</dt>
          <dd className="tnum text-right text-foreground">{ready !== null ? `About $${ready.quote.relayUsd.toFixed(2)}, Relay to Base` : "..."}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Circle&apos;s fee</dt>
          <dd className="tnum text-right text-foreground">
            {bps === null ? "Not available right now" : value !== null ? `${starkAmount(circleFee(value, bps), token)} ${token.symbol} at most` : `${Number((bps / 100).toFixed(4))}% of the amount`}
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Gloam&apos;s fee</dt>
          <dd className="tnum text-right text-foreground">
            {starkAmount(receiveFee + sn.fee, token)} {token.symbol}
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Network fee</dt>
          <dd className="text-right text-foreground">In your wallet, on {source.name}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Arrives</dt>
          <dd className="text-right text-foreground">In a few minutes</dd>
        </div>
      </dl>
      <StarknetActionButton kind="bringin" label="Bring in privately" stop={stop} className="mt-5" onClick={() => void start()} />
      <StarknetSteps task={working ? sn.task : null} className="mt-4" />
      <StarknetError kind="bringin" className="mt-4" />
      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
        Your wallet pays {pay.symbol} on {source.name}. Relay delivers USDC on Base and sends it to your {STARKNET_NAME} account through Circle. Those transfers are public. It becomes
        private once it is added.
      </p>
    </>
  );
}
