import "server-only";

/**
 * The Relay order for a bring-in from a chain CCTP doesn't serve
 * (lib/starknetPrivacy/cctpRelay): asked for here, and checked to do exactly
 * what was asked before the page gets anything to sign.
 */
import { isAddress } from "viem";
import { RELAY_REFERRER, bridgeFeeSetting, relayAppFees } from "@/lib/bridge";
import { RELAY_HOP, relayHopCalls, type RelayBringInQuote, type RelaySource, type RelaySourceToken } from "./cctpRelay";

const RELAY_API = "https://api.relay.link";
const APPROVE = "0x095ea7b3";

type Json = Record<string, unknown>;
const obj = (x: unknown): Json | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : null);
const isHex = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const big = (v: unknown): bigint | null => {
  try {
    return typeof v === "string" || typeof v === "number" ? BigInt(v) : null;
  } catch {
    return null;
  }
};

export type RelayOrderInput = { source: RelaySource; token: RelaySourceToken; amount: bigint; account: string; sender: string; bps: number };

/** The body Gloam sends Relay's /quote: EXACT_OUTPUT of `amount` USDC on Base, the two calls on arrival, refunds to the sender. */
export function relayOrderBody(input: RelayOrderInput, env: Record<string, string | undefined> = process.env): Json {
  const calls = relayHopCalls({ account: input.account, amount: input.amount, bps: input.bps });
  const apiKey = env.RELAY_API_KEY;
  return {
    user: input.sender,
    recipient: input.sender,
    refundTo: input.sender,
    originChainId: input.source.chainId,
    destinationChainId: RELAY_HOP.chainId,
    originCurrency: input.token.address,
    destinationCurrency: `0x${RELAY_HOP.usdc.slice(-40)}`,
    amount: input.amount.toString(),
    tradeType: "EXACT_OUTPUT",
    useDepositAddress: false,
    txs: calls.map((c) => ({ to: c.to, value: "0", data: c.data })),
    appFees: relayAppFees(bridgeFeeSetting(env)),
    ...(apiKey ? { referrer: RELAY_REFERRER } : {}),
  };
}

/**
 * Relay's answer as the page gets it, or why it is refused: it must deliver
 * exactly `amount` USDC on Base, run exactly Gloam's two calls there, pay out
 * only that USDC, and ask the wallet for plain transactions on the source
 * chain from the sender (an approve of the token, then a deposit with no
 * value). A route that costs far more than it moves is refused too.
 */
export function readRelayOrder(json: unknown, input: RelayOrderInput): { ok: true; quote: RelayBringInQuote } | { ok: false; reason: string } {
  const data = obj(json);
  if (!data) return { ok: false, reason: "shape" };
  const steps = Array.isArray(data.steps) ? (data.steps as unknown[]) : [];
  const requestId = steps.map((s) => obj(s)?.requestId).find((r) => typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r)) as string | undefined;
  if (!requestId) return { ok: false, reason: "request" };
  const details = obj(data.details);
  const out = obj(details?.currencyOut);
  const outCurrency = obj(out?.currency);
  const usdc = RELAY_HOP.usdc.slice(-40).toLowerCase();
  if (Number(outCurrency?.chainId) !== RELAY_HOP.chainId || String(outCurrency?.address ?? "").toLowerCase() !== `0x${usdc}` || big(out?.amount) !== input.amount) {
    return { ok: false, reason: "output" };
  }
  // The calls Relay's router runs on Base, and what it pays out: only Gloam's two, only that USDC.
  const want = relayHopCalls({ account: input.account, amount: input.amount, bps: input.bps }).map((c) => c.data.slice(2).toLowerCase());
  const output = obj(obj(obj(data.protocol)?.v2)?.orderData)?.output as Json | undefined;
  const calls = Array.isArray(output?.calls) ? (output!.calls as unknown[]).map((c) => String(c).toLowerCase()) : [];
  if (calls.length !== 2 || !calls[0]!.includes(want[0]!) || !calls[1]!.includes(want[1]!)) return { ok: false, reason: "calls" };
  const payments = Array.isArray(output?.payments) ? (output!.payments as unknown[]).map(obj) : [];
  if (!payments.length || !payments.every((p) => String(p?.currency ?? "").toLowerCase() === `0x${usdc}` && big(p?.minimumAmount) === input.amount)) {
    return { ok: false, reason: "payments" };
  }
  // The wallet's part on the source chain.
  const txs: RelayBringInQuote["txs"] = [];
  for (const s of steps) {
    const items = obj(s)?.items;
    const x = Array.isArray(items) && items.length === 1 ? obj(obj(items[0])?.data) : null;
    if (obj(s)?.kind !== "transaction" || !x || Number(x.chainId) !== input.source.chainId || !isAddress(String(x.to)) || !isHex(x.data)) return { ok: false, reason: "steps" };
    if (x.from !== undefined && String(x.from).toLowerCase() !== input.sender.toLowerCase()) return { ok: false, reason: "steps" };
    txs.push({ to: String(x.to), data: String(x.data), value: (big(x.value ?? 0) ?? -1n).toString(), chainId: input.source.chainId });
  }
  if (txs.length < 1 || txs.length > 2 || txs.some((t) => t.value !== "0")) return { ok: false, reason: "steps" };
  if (txs.length === 2 && (txs[0]!.to.toLowerCase() !== input.token.address.toLowerCase() || !txs[0]!.data.toLowerCase().startsWith(APPROVE))) return { ok: false, reason: "steps" };
  const inCur = obj(details?.currencyIn);
  const inAmount = big(inCur?.amount);
  if (inAmount === null || inAmount <= 0n || String(obj(inCur?.currency)?.address ?? "").toLowerCase() !== input.token.address.toLowerCase()) return { ok: false, reason: "input" };
  // Stablecoins in, USDC out: refuse a route that costs more than a tenth plus two dollars.
  const scale = 10n ** BigInt(Math.max(0, input.token.decimals - 6));
  const down = 10n ** BigInt(Math.max(0, 6 - input.token.decimals));
  const inUsdc = (inAmount * down) / scale;
  if (inUsdc > (input.amount * 11n) / 10n + 2_000_000n) return { ok: false, reason: "expensive" };
  const usd = Number(obj(obj(data.fees)?.relayer)?.amountUsd ?? NaN);
  const seconds = Number(details?.timeEstimate ?? NaN);
  return {
    ok: true,
    quote: {
      requestId,
      txs,
      pay: String(inCur?.amountFormatted ?? ""),
      symbol: input.token.symbol,
      amount: input.amount.toString(),
      relayUsd: Number.isFinite(usd) && usd >= 0 ? Math.round(usd * 100) / 100 : 0,
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 30,
    },
  };
}

/** Ask Relay for the order. */
export async function relayOrder(input: RelayOrderInput, fetcher: typeof fetch = fetch, env: Record<string, string | undefined> = process.env): Promise<{ ok: true; quote: RelayBringInQuote } | { ok: false; status: number; message: string }> {
  let res: Response;
  let json: unknown;
  try {
    res = await fetcher(`${RELAY_API}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.RELAY_API_KEY ? { "x-api-key": env.RELAY_API_KEY } : {}) },
      body: JSON.stringify(relayOrderBody(input, env)),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    json = await res.json().catch(() => null);
  } catch {
    return { ok: false, status: 502, message: "Couldn't reach the bridge. Try again." };
  }
  if (!res.ok) {
    const msg = String(obj(json)?.message ?? "");
    return { ok: false, status: 502, message: /amount|too (low|small)|insufficient/i.test(msg) ? "That amount is too small to bridge. Try a little more." : "The bridge couldn't make a route right now. Try again." };
  }
  const read = readRelayOrder(json, input);
  if (!read.ok) return { ok: false, status: 502, message: read.reason === "expensive" ? "Bridge fees are unusually high right now. Try again in a minute." : "The bridge couldn't make a route right now. Try again." };
  return read;
}
