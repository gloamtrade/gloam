/**
 * Bring ZEC from a Zcash wallet into a private balance on Solana, through NEAR
 * Intents' 1Click API (1click.chaindefuser.com). Shared by the browser,
 * /api/bridge/solana-zcash and the self-tests; nothing here touches the network.
 *
 * The path, one step for the person:
 *  1. 1Click gives a one-time transparent Zcash deposit address (t1) for an
 *     exact amount of ZEC, quoted to deliver ZEC on Solana (the Omni Bridge
 *     mint, config ZEC_SOLANA_MINT) to the private account's own address.
 *  2. The person sends that ZEC from any Zcash wallet, from a shielded or a
 *     transparent balance.
 *  3. Once it lands at the private account it is made private exactly as money
 *     brought over by Relay is (lib/solanaRings/arrivals, relayPolicy
 *     readDeposit): the account deposits it, Gloam's relay pays the fee. The
 *     panel follows it with the same flow (lib/solanaRings/bridgeIn), the
 *     transfer marked `via: "near"`.
 *
 * Public: the deposit on Zcash (a transparent address), any refund (to the
 * transparent address given), NEAR Intents' delivery to the private account on
 * Solana, and the deposit into the private balance. Private after that: the
 * asset and the amount of everything the account does. The private account
 * itself stays visible.
 *
 * Checked with live 1Click quotes on 2026-11-25 (no API key, no funds sent):
 * GET /v0/tokens lists nep141:zec.omft.near (blockchain zec, ZEC on Zcash) and
 * 1cs_v1:sol:spl:A7bd… (blockchain sol, the same mint Gloam lists). A quote of
 * 0.1 ZEC from Zcash to a Solana address gave a t1 deposit address, 0.09974272
 * ZEC on Solana (withdrawFee 0.00025728 ZEC, refundFee 0.00032 ZEC) and about
 * 452 seconds once Zcash confirms; under 0.00132 ZEC was refused ("Amount is
 * too low for bridge"); zs and u1 refund addresses were refused, t1 and t3
 * taken. Without a key 1Click adds its unauthenticated fee where it applies;
 * NEAR_INTENTS_API_KEY (a partner JWT, server only) is sent when set.
 *
 * Off unless NEXT_PUBLIC_SOLANA_ZCASH_IN is "1", on top of the bring-in flags.
 */
import { formatUnits } from "viem";
import { BRIDGE_MAX_USD, BRIDGE_MIN_USD, type BridgeStage } from "../bridge";
import { typedAmount } from "../amountShort";
import { amountTextError } from "../amountText";
import { validZcashTransparent, zcashRefundProblem } from "../zcashAddress";
import { RELAYED_DEPOSIT_MIN } from "./relayPolicy";
import { solanaBridgeVisible, type SolanaBridgeQuote, type TrackedBridge } from "./bridgeIn";
import { SOLANA_RINGS_NETWORK, ZEC_DECIMALS, ZEC_SOLANA_MINT, type RingsNetwork } from "./config";

export const SOLANA_ZCASH_IN_ENABLED = process.env.NEXT_PUBLIC_SOLANA_ZCASH_IN === "1";

/** Shown with its flag and the bring-in on (Solana mainnet, or a preview build). */
export function zcashInVisible(network: RingsNetwork = SOLANA_RINGS_NETWORK): boolean {
  return SOLANA_ZCASH_IN_ENABLED && solanaBridgeVisible(network);
}

export const ONECLICK_API = "https://1click.chaindefuser.com";
/** ZEC on the Zcash chain, as 1Click names it (/v0/tokens: blockchain "zec"). */
export const ZCASH_ORIGIN_ASSET = "nep141:zec.omft.near";
/** ZEC on Solana, as 1Click names it: the Omni Bridge mint Gloam lists. */
export const ZEC_SOLANA_ASSET = `1cs_v1:sol:spl:${ZEC_SOLANA_MINT}`;
/** Same asset both ends, so only fees move the price; 1% is room, not a cost. */
export const ZCASH_SLIPPAGE_BPS = 100;
/** 1Click's deadline: refunds begin if it isn't done by then. Two hours from the quote. */
export const ZCASH_DEADLINE_MS = 2 * 60 * 60 * 1000;
/** The panel asks for the ZEC within the first hour, leaving the second for Zcash to confirm it. */
export const ZCASH_SEND_WITHIN_MS = 60 * 60 * 1000;
/**
 * The refund address a price-only quote (dry: no deposit address) is asked
 * with before one is typed: the all-zero key hash, well formed and nobody's.
 * Nothing can be sent to it, since a price never has an address to pay.
 */
export const ZCASH_PREVIEW_REFUND = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
export const ZCASH_CHAIN = "Zcash";
export const ZCASH_PROVIDER = "NEAR Intents";
export const ZEC_LOGO = "/brand/tokens/zec.png";
/** Zcash has no chain id; screens show its mark by `via` (SolanaBridgeIn SourceMark). */
export const ZCASH_CHAIN_ID = 0;

/** The one line on what is public, said wherever ZEC comes in from Zcash. Never says who is hidden on Solana. */
export const ZCASH_IN_PRIVACY_NOTE =
  "Sending from Zcash is public: the deposit and any refund use transparent Zcash addresses, and the delivery to your private account on Solana shows. Once private on Solana, the token and amount stay hidden. Your private account itself stays visible.";

/** What the quote route sends 1Click. `amount` in base units (8 decimals), exact input. */
export type ZcashQuoteRequest = {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  deadline: string;
  depositMode: "SIMPLE";
};

export function zcashQuoteRequest(input: { amount: bigint; recipient: string; refundTo: string; dry: boolean; now: number }): ZcashQuoteRequest {
  return {
    dry: input.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: ZCASH_SLIPPAGE_BPS,
    originAsset: ZCASH_ORIGIN_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ZEC_SOLANA_ASSET,
    amount: input.amount.toString(),
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(input.now + ZCASH_DEADLINE_MS).toISOString(),
    depositMode: "SIMPLE",
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
function units(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^\d{1,40}$/.test(v)) return null;
  return BigInt(v);
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

const BUSY = "NEAR Intents couldn't make a route right now. Try again.";

export type ZcashParsed = { ok: true; quote: SolanaBridgeQuote } | { ok: false; status: number; message: string };

/**
 * 1Click's answer to `asked`, checked and turned into the quote the panel
 * shows (the same shape as a Relay one, marked `via: "near"`). Refused unless
 * it is the route asked for: ZEC on Zcash in, exactly the amount asked, ZEC on
 * Solana out to the private account, refunds to the address given; a real one
 * must carry a transparent deposit address and no memo. Out can't be more than
 * in (same asset), and what lands must be enough for the relay to make private.
 */
export function parseZcashQuote(data: unknown, asked: ZcashQuoteRequest): ZcashParsed {
  const busy = { ok: false as const, status: 502, message: BUSY };
  if (!isObj(data) || !isObj(data.quote) || !isObj(data.quoteRequest)) return busy;
  const q = data.quote;
  const r = data.quoteRequest;
  const same = (["originAsset", "destinationAsset", "amount", "recipient", "refundTo", "swapType", "depositType", "recipientType", "refundType"] as const).every(
    (k) => r[k] === asked[k]
  );
  if (!same || Boolean(r.dry) !== asked.dry) return busy;

  const amountIn = units(q.amountIn);
  const amountOut = units(q.amountOut);
  const minOut = units(q.minAmountOut) ?? amountOut;
  if (amountIn === null || amountIn.toString() !== asked.amount || amountOut === null || minOut === null) return busy;
  if (amountOut <= 0n || minOut > amountOut || amountOut > amountIn) return busy;

  const correlationId = str(data.correlationId) ?? "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(correlationId)) return busy;

  let near: SolanaBridgeQuote["near"];
  let depositAddress = "";
  if (!asked.dry) {
    depositAddress = str(q.depositAddress) ?? "";
    if (!validZcashTransparent(depositAddress)) return busy;
    if (str(q.depositMemo)) return busy; // a Zcash deposit needs none; never show an address that would
    const signature = str(data.signature) ?? "";
    if (!/^[A-Za-z0-9:]{16,200}$/.test(signature)) return busy;
    const asks = Date.parse(asked.deadline);
    const refundFee = units(q.refundFee);
    near = {
      signature,
      sendBy: asks - (ZCASH_DEADLINE_MS - ZCASH_SEND_WITHIN_MS),
      addressUntil: str(q.deadline),
      refundFee: refundFee === null ? null : formatUnits(refundFee, ZEC_DECIMALS),
    };
  }

  if (amountOut < (RELAYED_DEPOSIT_MIN.zec ?? 0n)) {
    const least = formatUnits(RELAYED_DEPOSIT_MIN.zec ?? 0n, ZEC_DECIMALS);
    return { ok: false, status: 400, message: `That lands under ${least} ZEC on Solana, too little to make private. Send a little more.` };
  }
  const usdIn = num(q.amountInUsd);
  if (usdIn !== null && usdIn < BRIDGE_MIN_USD) {
    return { ok: false, status: 400, message: `That's about $${usdIn.toFixed(2)}, under the $${BRIDGE_MIN_USD} minimum. Send at least $${BRIDGE_MIN_USD} worth.` };
  }
  if (usdIn !== null && usdIn > BRIDGE_MAX_USD) {
    return { ok: false, status: 400, message: `That's about $${usdIn.toFixed(2)}. Send at most $${BRIDGE_MAX_USD.toLocaleString("en-US")} worth at a time.` };
  }
  const usdOut = num(q.amountOutUsd);
  const feeUsd = usdIn !== null && usdOut !== null ? Math.max(0, Math.round((usdIn - usdOut) * 100) / 100) : 0;

  return {
    ok: true,
    quote: {
      requestId: correlationId,
      depositAddress,
      evmTxs: null,
      send: {
        amount: formatUnits(amountIn, ZEC_DECIMALS),
        symbol: "ZEC",
        chain: ZCASH_CHAIN,
        chainId: ZCASH_CHAIN_ID,
        logo: ZEC_LOGO,
        usd: usdIn === null ? null : Math.round(usdIn * 100) / 100,
      },
      receive: {
        amount: formatUnits(amountOut, ZEC_DECIMALS),
        minimum: formatUnits(minOut, ZEC_DECIMALS),
        symbol: "ZEC",
        assetId: "zec",
        decimals: ZEC_DECIMALS,
        logo: ZEC_LOGO,
      },
      refundTo: asked.dry ? "" : asked.refundTo,
      feeUsd,
      appFee: null,
      gasUsd: null,
      timeSec: Math.max(0, num(q.timeEstimate) ?? 0),
      bitcoin: false,
      via: "near",
      ...(near ? { near } : {}),
    },
  };
}

/**
 * 1Click's refusal of a quote ({ message }) in words that say why, or null
 * when it gave no reason worth naming (the caller says "try again").
 */
export function zcashRefusal(message: string): string | null {
  const low = /amount is too low for bridge, try at least (\d{1,30})/i.exec(message);
  if (low) return `That's under NEAR Intents' minimum from Zcash. Send at least ${formatUnits(BigInt(low[1]!), ZEC_DECIMALS)} ZEC.`;
  if (/refundTo\b.{0,80}\bnot valid/i.test(message)) return "Check your Zcash address. A refund needs a transparent one, starting with t1 or t3.";
  if (/recipient\b.{0,80}\bnot valid/i.test(message)) return "Open your private account on Solana first.";
  if (/minimum swap amount is \$?([\d,]+)/i.test(message)) {
    const m = /minimum swap amount is \$?([\d,]+)/i.exec(message)!;
    return `That's under NEAR Intents' minimum of $${m[1]}. Send a little more.`;
  }
  if (/no (quotes?|route)|not supported|disabled|unavailable/i.test(message)) return "NEAR Intents has no route from Zcash to Solana right now. Try again in a few minutes.";
  return null;
}

/** What 1Click's status word means for the panel. An unknown word is no answer. */
export function zcashStage(status: string): BridgeStage | null {
  switch (status) {
    case "PENDING_DEPOSIT":
    case "INCOMPLETE_DEPOSIT":
      return "waiting";
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return "moving";
    case "SUCCESS":
      return "done";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    default:
      return null;
  }
}

/**
 * Where a transfer stands: the stage, the Solana delivery's signature once
 * there is one, and `short`, how much arrived when it was less than asked
 * (INCOMPLETE_DEPOSIT). Null when the answer isn't about this deposit address
 * or into ZEC on Solana.
 */
export type ZcashStatus = { stage: BridgeStage; outTx: string | null; short: string | null };

export function parseZcashStatus(data: unknown, depositAddress: string): ZcashStatus | null {
  if (!isObj(data)) return null;
  const stage = zcashStage(str(data.status) ?? "");
  if (!stage) return null;
  const qr = isObj(data.quoteResponse) ? data.quoteResponse : null;
  const addr = qr && isObj(qr.quote) ? str(qr.quote.depositAddress) : null;
  const dest = qr && isObj(qr.quoteRequest) ? str(qr.quoteRequest.destinationAsset) : null;
  if ((addr !== null && addr !== depositAddress) || (dest !== null && dest !== ZEC_SOLANA_ASSET)) return null;
  const d = isObj(data.swapDetails) ? data.swapDetails : {};
  const outs = Array.isArray(d.destinationChainTxHashes) ? d.destinationChainTxHashes : [];
  const first = isObj(outs[0]) ? str(outs[0].hash) : null;
  const outTx = first && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(first) ? first : null;
  let short: string | null = null;
  if (data.status === "INCOMPLETE_DEPOSIT") {
    const raw = units(d.depositedAmount);
    short = raw !== null ? formatUnits(raw, ZEC_DECIMALS) : null;
  }
  return { stage, outTx, short };
}

/** What the Zcash wallet is shown: a ZIP 321 payment request with the address and the exact amount, so it fills both. */
export function zcashPaymentUri(t: Pick<TrackedBridge, "depositAddress" | "send">): string {
  return `zcash:${t.depositAddress}?amount=${t.send.amount}`;
}

/** The main button of the Zcash form: what it does, or what is missing first. */
export function zcashButton(s: { busy: boolean; onMainnet: boolean; zecReady: boolean; amount: string; refund: string }): { label: string; ready: boolean } {
  const no = (label: string) => ({ label, ready: false });
  if (s.busy) return no("Getting an address…");
  if (!s.onMainnet) return no("NEAR Intents delivers to Solana mainnet only");
  if (!s.zecReady) return no("ZEC isn't set up on Gloam yet");
  const text = s.amount.trim();
  if (text === "" || (/^\d*\.?\d*$/.test(text) && Number(text) === 0)) return no("Enter an amount");
  if (amountTextError(text, ZEC_DECIMALS) || !/^\d+(\.\d+)?$/.test(text)) return no("Check the amount");
  if (!s.refund.trim()) return no("Enter your Zcash address");
  if (zcashRefundProblem(s.refund)) return no("Check your Zcash address");
  return { label: "Get a deposit address", ready: true };
}

/** The amount said back in the panel's words: "Send exactly 0.1 ZEC". */
export function zcashSendLine(amount: string): string {
  return `Send exactly ${typedAmount(amount)} ZEC`;
}

/** "about 8 min after Zcash confirms it", from 1Click's estimate (seconds once the deposit is confirmed). */
export function zcashArrives(timeSec: number): string {
  const min = Math.max(1, Math.round(timeSec / 60));
  return `About ${min} min after Zcash confirms it`;
}

/** The hour and minute to send by, in the person's own time. */
export function sendByText(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + " UTC";
  }
}

/** Remembered refund address for this private account, so the next transfer starts with it. */
export const zcashRefundKey = (network: RingsNetwork, account: string) => `gloam:solana-zcash:refund:v1:${network}:${account}`;

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function loadZcashRefund(store: KV | null, key: string): string {
  try {
    const v = store?.getItem(key) ?? "";
    return validZcashTransparent(v) ? v : "";
  } catch {
    return "";
  }
}

export function saveZcashRefund(store: KV | null, key: string, address: string): void {
  if (!validZcashTransparent(address)) return;
  try {
    store?.setItem(key, address);
  } catch {
    // private mode or full storage: the field is typed next time
  }
}

/** The line under the amount: "From $1 to $25,000 worth." */
export const ZCASH_LIMIT_LINE = `From $${BRIDGE_MIN_USD} to $${BRIDGE_MAX_USD.toLocaleString("en-US")} worth.`;
