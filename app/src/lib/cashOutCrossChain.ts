/**
 * Cash out to another chain, in one step, through Relay (relay.link).
 *
 * A cash out normally lands as the same token on the vault's own chain. Here
 * the vault pays a one-time Relay deposit address instead, and Relay delivers
 * a stablecoin on the chain the person picked (USDG on Robinhood Chain out as
 * USDC on Base, say). Nothing new touches the vault: it is an ordinary
 * unshield whose recipient is that deposit address.
 *
 * The deposit address is a "strict" one: Relay binds it to one order with the
 * exact amount, the recipient on the other chain and a refund address on this
 * chain. Paid exactly, the order fills at the quoted price or better than its
 * minimum. Paid short, or if the fill would land under the minimum, Relay
 * refunds the money to the refund address on this chain (the person's own
 * wallet). Strict orders are never requoted, so the order's request id tracks
 * it to the end (app/api/bridge/status).
 *
 * The unshield proof binds the recipient and the amount, so both are fixed
 * before the proof is made: the address from the quote, and the amount the
 * vault pays it, which is the note's amount less the vault's cash-out fee
 * (ShieldPoolCore.unshield pays `amount - fee` to `to`). The quote is asked
 * for exactly that net amount, and readCrossChainQuote refuses one whose
 * deposit, amount, token, recipient or refund address differ from what was
 * asked. crossChainProblem checks the same again in the browser, right before
 * the proof and once more against the proof's own call.
 *
 * Only chains where Relay offers strict deposit addresses are sources. Live
 * strict quotes on 2026-11-09 worked from Robinhood Chain (USDG), Base (USDC,
 * USDT) and Ethereum (USDC, USDT, USDG, PYUSD) into USDC on Base, Ethereum,
 * Arbitrum and Solana. Tempo answered "strict is not supported for this
 * origin chain", so a cash out on Tempo stays on Tempo for now.
 *
 * Cross-chain is for "now" only. A cash out for later, or in pieces, stays on
 * its own chain: a scheduled proof can wait hours, and an order's price
 * should not.
 */
import { decodeFunctionData, formatUnits, isAddress, parseAbi, zeroAddress } from "viem";
import { BRIDGE_MAX_USD, BRIDGE_MIN_USD, RELAY_REFERRER, relayChainName } from "./bridge";

/** Relay's id for Solana. */
export const SOLANA_RELAY_ID = 792703809;

/** Slippage asked of Relay on a stablecoin to stablecoin route, in basis points: the order's minimum is 99.5% of the quote. */
export const XCHAIN_SLIPPAGE_BPS = "50";

/** An order whose own deadline is closer than this is refused: the cash out has to be proven and land first. */
export const XCHAIN_DEADLINE_MARGIN_SEC = 6 * 60 * 60;

/**
 * Right before the proof, a fresh quote is asked for. Its minimum may sit this
 * far under the one the person saw (in basis points) and still go ahead; past
 * that, the new price is shown and they confirm again.
 */
export const XCHAIN_REQUOTE_TOLERANCE_BPS = 50n;

export type CrossChainKind = "evm" | "svm";

export type CrossChainToken = { symbol: string; address: string; decimals: number; logo: string };

export type CrossChainDestination = {
  /** Stable id for the picker and the API: "base-usdc". */
  id: string;
  /** Relay's chain id. */
  chainId: number;
  chain: string;
  kind: CrossChainKind;
  token: CrossChainToken;
  /** The destination chain's explorer page for a transaction. */
  explorerTx: (hash: string) => string;
};

const usdc = (address: string): CrossChainToken => ({ symbol: "USDC", address, decimals: 6, logo: "/brand/tokens/usdc.png" });

/** Where a cash out can land instead of its own chain. Checked with live strict quotes on 2026-11-09. */
export const CROSS_CHAIN_DESTINATIONS: readonly CrossChainDestination[] = [
  { id: "base-usdc", chainId: 8453, chain: "Base", kind: "evm", token: usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), explorerTx: (h) => `https://basescan.org/tx/${h}` },
  { id: "ethereum-usdc", chainId: 1, chain: "Ethereum", kind: "evm", token: usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), explorerTx: (h) => `https://etherscan.io/tx/${h}` },
  { id: "arbitrum-usdc", chainId: 42161, chain: "Arbitrum", kind: "evm", token: usdc("0xaf88d065e77c8cc2239327c5edb3a432268e5831"), explorerTx: (h) => `https://arbiscan.io/tx/${h}` },
  { id: "solana-usdc", chainId: SOLANA_RELAY_ID, chain: "Solana", kind: "svm", token: usdc("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), explorerTx: (h) => `https://solscan.io/tx/${h}` },
];

/**
 * The vault assets that can leave to another chain, by the vault's chain id:
 * stablecoins on chains where Relay takes strict deposit addresses. Addresses
 * as the vaults list them (lib/tokens), compared lowercased.
 */
export const CROSS_CHAIN_SOURCES: Readonly<Record<number, readonly { symbol: string; address: string; decimals: number }[]>> = {
  4663: [{ symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6 }],
  8453: [
    { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    { symbol: "USDT", address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", decimals: 6 },
  ],
  1: [
    { symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
    { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    { symbol: "USDG", address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", decimals: 6 },
    { symbol: "PYUSD", address: "0x6c3ea9036406852006290770bedfcaba0e23a0e8", decimals: 6 },
  ],
};

/** The asset as a cross-chain source on this chain, or null when it can't leave this way. */
export function crossChainSource(chainId: number, asset: string): { symbol: string; address: string; decimals: number } | null {
  const want = asset.toLowerCase();
  return CROSS_CHAIN_SOURCES[chainId]?.find((t) => t.address === want) ?? null;
}

/** Where this asset can land from this chain: every destination on another chain, or none. */
export function crossChainDestinations(chainId: number, asset: string): CrossChainDestination[] {
  if (!crossChainSource(chainId, asset)) return [];
  return CROSS_CHAIN_DESTINATIONS.filter((d) => d.chainId !== chainId);
}

export function crossChainDestination(id: unknown): CrossChainDestination | null {
  return CROSS_CHAIN_DESTINATIONS.find((d) => d.id === id) ?? null;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** An address that can receive on the destination chain: a 0x wallet (not zero, not the token itself), or a Solana address. */
export function validCrossChainRecipient(dest: Pick<CrossChainDestination, "kind" | "token">, v: string): boolean {
  if (dest.kind === "svm") return SOLANA_ADDRESS.test(v);
  return isAddress(v) && v.toLowerCase() !== zeroAddress && v.toLowerCase() !== dest.token.address.toLowerCase();
}

/** What the vault pays out of `gross` at `bps`: the same floor(amount * bps / 10_000) fee as ShieldPoolCore. */
export function cashOutNet(gross: bigint, bps: number): bigint {
  const fee = Number.isInteger(bps) && bps > 0 ? (gross * BigInt(bps)) / 10_000n : 0n;
  return gross - fee;
}

const sameAddress = (kind: CrossChainKind, a: unknown, b: string) =>
  typeof a === "string" && (kind === "svm" ? a === b : a.toLowerCase() === b.toLowerCase());

/** A quote for a cash out to another chain, as the app shows and checks it. */
export type CrossChainQuote = {
  requestId: string;
  /** The one-time strict Relay address the vault pays. The proof is made for it. */
  depositAddress: string;
  /** The vault's chain and asset. */
  sourceChainId: number;
  sourceChain: string;
  asset: string;
  sourceSymbol: string;
  /** What reaches the deposit address, in the asset's raw units: the cash out less the vault's fee. */
  amountIn: string;
  /** Relay's dollar value of amountIn, when it gives one. */
  sendUsd: number | null;
  destination: { id: string; chainId: number; chain: string; symbol: string; logo: string; decimals: number };
  recipient: string;
  /** Where Relay sends a refund on the vault's chain. */
  refundTo: string;
  receive: { amount: string; minimum: string; amountRaw: string; minimumRaw: string };
  /** Relay's own fee, in dollars. */
  feeUsd: number;
  timeSec: number;
  /** When the order stops, in Unix seconds. */
  deadline: number;
  /** When the quote was made, in ms. */
  at: number;
};

export type CrossChainAsk = {
  sourceChainId: number;
  asset: string;
  /** Raw units that reach the deposit address. */
  amount: bigint;
  destination: CrossChainDestination;
  recipient: string;
  refundTo: string;
};

/** The body for Relay's /quote: a strict deposit address, exact input, refunds to `refundTo` on this chain. */
export function crossChainRelayBody(ask: CrossChainAsk, opts: { apiKey?: boolean } = {}): Record<string, unknown> {
  return {
    // Nobody signs on the source chain: the vault pays the deposit address.
    user: "0x000000000000000000000000000000000000dEaD",
    recipient: ask.recipient,
    originChainId: ask.sourceChainId,
    destinationChainId: ask.destination.chainId,
    originCurrency: ask.asset,
    destinationCurrency: ask.destination.token.address,
    amount: ask.amount.toString(),
    tradeType: "EXACT_INPUT",
    useDepositAddress: true,
    strict: true,
    refundTo: ask.refundTo,
    slippageTolerance: XCHAIN_SLIPPAGE_BPS,
    // Gloam already took its cash-out fee in the vault: no app fee on top.
    ...(opts.apiKey ? { referrer: RELAY_REFERRER } : {}),
  };
}

const ERC20_TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const REQUEST_ID = /^0x[0-9a-fA-F]{64}$/;

/* eslint-disable @typescript-eslint/no-explicit-any -- Relay's quote JSON is read field by field and checked */
/**
 * Relay's answer to crossChainRelayBody, checked against what was asked, or why
 * not. Refused unless all of these hold:
 *   - one deposit step with a 0x deposit address and a request id;
 *   - its transaction is a plain `transfer(depositAddress, amount)` of the asset on this chain;
 *   - the signed order pays in exactly `amount` of the asset, delivers the
 *     destination token to `recipient` on the destination chain, and refunds on
 *     this chain to `refundTo`;
 *   - the order runs past now plus XCHAIN_DEADLINE_MARGIN_SEC;
 *   - something arrives, at a minimum no higher than the expected amount.
 */
export function readCrossChainQuote(
  data: any,
  ask: CrossChainAsk,
  now = Date.now()
): { ok: true; quote: CrossChainQuote } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  const steps = Array.isArray(data?.steps) ? data.steps : null;
  if (!steps || steps.length !== 1) return no("steps");
  const step = steps[0];
  const depositAddress = step?.depositAddress;
  if (step?.id !== "deposit" || typeof depositAddress !== "string" || !isAddress(depositAddress)) return no("deposit address");
  if (depositAddress.toLowerCase() === zeroAddress) return no("deposit address");
  const requestId = String(step?.requestId ?? data?.requestId ?? "");
  if (!REQUEST_ID.test(requestId)) return no("request id");

  // The transaction Relay expects: the asset, sent to the deposit address, for exactly the amount.
  const item = step?.items?.length === 1 ? step.items[0]?.data : null;
  if (!item || Number(item.chainId) !== ask.sourceChainId) return no("transfer chain");
  if (String(item.to ?? "").toLowerCase() !== ask.asset.toLowerCase()) return no("transfer token");
  if (BigInt(item.value ?? 0) !== 0n) return no("transfer value");
  try {
    const call = decodeFunctionData({ abi: ERC20_TRANSFER, data: item.data });
    if (call.functionName !== "transfer") return no("transfer call");
    if (String(call.args[0]).toLowerCase() !== depositAddress.toLowerCase()) return no("transfer recipient");
    if (call.args[1] !== ask.amount) return no("transfer amount");
  } catch {
    return no("transfer call");
  }

  // The order itself, as Relay signed it.
  const order = data?.protocol?.v2?.orderData;
  const input = Array.isArray(order?.inputs) && order.inputs.length === 1 ? order.inputs[0] : null;
  if (!input) return no("order inputs");
  if (String(input.payment?.currency ?? "").toLowerCase() !== ask.asset.toLowerCase()) return no("order token");
  if (String(input.payment?.amount ?? "") !== ask.amount.toString()) return no("order amount");
  const refunds = Array.isArray(input.refunds) ? input.refunds : [];
  const refundHere = refunds.find((r: any) => String(r?.currency ?? "").toLowerCase() === ask.asset.toLowerCase());
  if (!refundHere || String(refundHere.recipient ?? "").toLowerCase() !== ask.refundTo.toLowerCase()) return no("refund address");
  const output = order?.output;
  const payments = Array.isArray(output?.payments) ? output.payments : [];
  if (payments.length !== 1) return no("order output");
  const pay = payments[0];
  const kind = ask.destination.kind;
  if (!sameAddress(kind, pay?.recipient, ask.recipient)) return no("order recipient");
  if (!sameAddress(kind, pay?.currency, ask.destination.token.address)) return no("order output token");
  if (Array.isArray(output?.calls) && output.calls.length > 0) return no("order calls");
  const deadline = Number(output?.deadline ?? NaN);
  if (!Number.isFinite(deadline) || deadline * 1000 < now + XCHAIN_DEADLINE_MARGIN_SEC * 1000) return no("order deadline");

  // What arrives: the expected amount and the order's minimum.
  const out = data?.details?.currencyOut;
  let expected: bigint;
  let minimum: bigint;
  try {
    expected = BigInt(out?.amount ?? pay?.expectedAmount ?? 0);
    minimum = BigInt(pay?.minimumAmount ?? out?.minimumAmount ?? 0);
  } catch {
    return no("amount out");
  }
  if (expected <= 0n || minimum <= 0n || minimum > expected) return no("amount out");
  // Never more out than in, give or take a cent: a stablecoin route that claims so is misread.
  const decimals = ask.destination.token.decimals;
  const source = crossChainSource(ask.sourceChainId, ask.asset);
  if (!source) return no("source");
  const inUnits = Number(formatUnits(ask.amount, source.decimals));
  if (Number(formatUnits(expected, decimals)) > inUnits * 1.01 + 0.01) return no("amount out");

  const usdIn = Number(data?.details?.currencyIn?.amountUsd ?? NaN);
  const feeUsd = Number(data?.fees?.relayer?.amountUsd ?? 0);
  const d = ask.destination;
  return {
    ok: true,
    quote: {
      requestId,
      depositAddress,
      sourceChainId: ask.sourceChainId,
      sourceChain: relayChainName(ask.sourceChainId),
      asset: ask.asset,
      sourceSymbol: source.symbol,
      amountIn: ask.amount.toString(),
      sendUsd: Number.isFinite(usdIn) ? Math.round(usdIn * 100) / 100 : null,
      destination: { id: d.id, chainId: d.chainId, chain: d.chain, symbol: d.token.symbol, logo: d.token.logo, decimals },
      recipient: ask.recipient,
      refundTo: ask.refundTo,
      receive: {
        amount: formatUnits(expected, decimals),
        minimum: formatUnits(minimum, decimals),
        amountRaw: expected.toString(),
        minimumRaw: minimum.toString(),
      },
      feeUsd: Number.isFinite(feeUsd) ? Math.round(feeUsd * 100) / 100 : 0,
      timeSec: Number(data?.details?.timeEstimate ?? 0) || 0,
      deadline,
      at: now,
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The dollar bounds on what reaches the deposit address, the same as a bridge in. */
export function crossChainAmountProblem(amount: bigint, decimals: number): string | null {
  const n = Number(formatUnits(amount, decimals));
  if (!(n >= BRIDGE_MIN_USD) || n > BRIDGE_MAX_USD) {
    return `Cash out ${BRIDGE_MIN_USD} to ${BRIDGE_MAX_USD.toLocaleString("en-US")} to another chain at a time.`;
  }
  return null;
}

/**
 * Why this quote must not be used for this cash out, or null when it fits.
 * Checked in the browser before the proof, and again against the proof's own
 * call: the vault pays `to` the cash out's `gross` less the fee at `feeBps`,
 * so `to` must be the quote's deposit address and that net must be exactly
 * the quote's amount, of the same asset on the same chain, for the recipient
 * and refund address the person gave.
 */
export function crossChainProblem(
  q: CrossChainQuote,
  c: { chainId: number; asset: string; gross: bigint; feeBps: number; to: string; destinationId: string; recipient: string; refundTo: string },
  now = Date.now()
): string | null {
  const stale = "The price for the other chain changed. Check it and try again.";
  const kind: CrossChainKind = q.destination.chainId === SOLANA_RELAY_ID ? "svm" : "evm";
  if (q.sourceChainId !== c.chainId || q.asset.toLowerCase() !== c.asset.toLowerCase()) return stale;
  if (q.destination.id !== c.destinationId) return stale;
  if (!isAddress(q.depositAddress) || q.depositAddress.toLowerCase() !== c.to.toLowerCase()) {
    return "This cash out isn't going to the address Relay gave. Nothing was sent. Try again.";
  }
  if (cashOutNet(c.gross, c.feeBps).toString() !== q.amountIn) {
    return "The amount no longer matches the price for the other chain. Nothing was sent. Try again.";
  }
  if (!sameAddress(kind, q.recipient, c.recipient)) return stale;
  if (q.refundTo.toLowerCase() !== c.refundTo.toLowerCase()) return stale;
  if (q.deadline * 1000 < now + XCHAIN_DEADLINE_MARGIN_SEC * 1000) return stale;
  return null;
}

/** A fresh quote is fine to use without asking again: its minimum is within XCHAIN_REQUOTE_TOLERANCE_BPS of the one shown. */
export function requoteStillFine(shown: Pick<CrossChainQuote, "receive">, fresh: Pick<CrossChainQuote, "receive">): boolean {
  const was = BigInt(shown.receive.minimumRaw);
  const now = BigInt(fresh.receive.minimumRaw);
  return now * 10_000n >= was * (10_000n - XCHAIN_REQUOTE_TOLERANCE_BPS);
}

/** Relay's own page for an order, where anyone can follow it, refunds included. */
export function relayOrderUrl(requestId: string): string {
  return `https://relay.link/transaction/${requestId}`;
}

/** Ask the app's server for a quote (browser only). */
export async function requestCrossChainQuote(p: {
  network: string;
  asset: string;
  amount: bigint;
  destination: string;
  recipient: string;
  refundTo: string;
  signal?: AbortSignal;
}): Promise<CrossChainQuote> {
  let res: Response;
  try {
    res = await fetch("/api/cashout/cross-chain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: p.network, asset: p.asset, amount: p.amount.toString(), destination: p.destination, recipient: p.recipient, refundTo: p.refundTo }),
      signal: p.signal,
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("Couldn't reach Relay. Try again.");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: CrossChainQuote; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok || !json.data) throw new Error(json?.error?.message ?? "Relay couldn't price this right now. Try again.");
  return json.data;
}
