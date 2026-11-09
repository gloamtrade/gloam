/* eslint-disable @typescript-eslint/no-explicit-any -- Relay's quote JSON is read field by field and checked below */
import { NextResponse } from "next/server";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { isNoLimit } from "@gloamtrade/sdk";
import { clientIp, hitRateLimit } from "@/lib/mcpRemote/rateLimit";
import { getNetwork, isNetworkKey } from "@/lib/networks";
import {
  BRIDGE_DESTINATIONS,
  BRIDGE_MIN_USD,
  RELAY_REFERRER,
  SWAP_SLIPPAGE_BPS,
  bridgeChain,
  bridgeFeeSetting,
  bridgeToken,
  privateBridgeable,
  quotedAppFee,
  relayAppFees,
  swapLeftover,
  swapSource,
  validRefundAddress,
  type PrivateBridgeQuote,
  type PrivateBridgeTx,
} from "@/lib/bridge";
import { originChain } from "@/lib/originChains";
import { noteRelayQuote } from "@/lib/relayLedger";
import { serverTransport } from "@/lib/serverRpc";
import { buildSolanaTx, type RelaySolanaInstruction } from "@/lib/solanaTx";
import { screenAddresses } from "@/lib/screeningServer";
import { SCREEN_BLOCKED_MESSAGE } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RELAY_API = "https://api.relay.link";
/** Orders per IP per minute. Each one is a fresh Relay order and a simulation. */
const RATE_LIMIT = 12;

const POOL_ABI = parseAbi([
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof)",
  "function depositLimitsOn() view returns (bool)",
  "function depositLimit(address asset) view returns (uint128 perDeposit, uint128 total)",
  "function deposited(address asset) view returns (uint256)",
  "function commitmentSeen(bytes32 commitment) view returns (bool)",
  "function shieldVerifier() view returns (address)",
]);
const VERIFIER_ABI = parseAbi(["function verify(bytes proof, uint256[] publicInputs) view returns (bool)"]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const ROUTE_BUSY = "The bridge couldn't make a route right now. Try again.";

function fail(status: number, message: string) {
  return NextResponse.json({ ok: false, error: { message } }, { status, headers: { "Cache-Control": "no-store" } });
}

const units = (v: bigint, decimals: number) =>
  Number(formatUnits(v, decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 });

const isHex = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);

/** The EVM transactions of a Relay order, or null when any step isn't one plain transaction on `chainId`. */
function evmSteps(steps: any[], chainId: number, sender: string): PrivateBridgeTx[] | null {
  const txs: PrivateBridgeTx[] = [];
  for (const s of steps) {
    const x = s?.kind === "transaction" && s?.items?.length === 1 ? s.items[0]?.data : null;
    if (!x || Number(x.chainId) !== chainId || !isAddress(String(x.to)) || !isHex(x.data)) return null;
    if (x.from !== undefined && String(x.from).toLowerCase() !== sender.toLowerCase()) return null;
    txs.push({ to: String(x.to), data: String(x.data), value: BigInt(x.value ?? 0).toString(), chainId });
  }
  return txs.length ? txs : null;
}

/**
 * A Relay order that pays from the person's own wallet straight into the
 * private balance: { chainId, symbol, network, amount, recipient, sender, commitment, proof }.
 *
 * `amount` is what lands privately, in the network's stablecoin. The browser
 * made the note and its shield proof for exactly that amount; the order is
 * EXACT_OUTPUT, so Relay delivers it to its router, which approves the vault
 * and calls shieldBound with the proof. Three kinds of payer:
 *   - a Solana wallet: one transaction, built and simulated here;
 *   - an EVM wallet on another chain: an approve (for a token) and a deposit,
 *     which the wallet signs on that chain;
 *   - this chain's own coin (ETH on Robinhood Chain): one swap that also makes
 *     the deposit, simulated here; what's left of the swap comes back to the
 *     wallet as the stablecoin.
 * If the call can't run, Relay sends the stablecoin to `recipient` instead.
 * Nothing here holds money or a secret: the commitment and proof are public.
 */
export async function POST(req: Request) {
  const rate = await hitRateLimit(clientIp(req), "bridge-private", RATE_LIMIT);
  if (!rate.allowed) return fail(429, "Too many tries. Wait a minute.");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "Send the details as JSON.");
  }

  if (typeof body.network !== "string" || !isNetworkKey(body.network)) return fail(400, "Pick a Gloam network.");
  const network = getNetwork(body.network);
  if (network.chain.testnet || !network.pool) return fail(400, "Bringing money in privately works on mainnet.");
  const dest = BRIDGE_DESTINATIONS[network.family];
  if (!dest) return fail(400, `Bringing money over isn't on ${network.label} yet.`);
  // Elysium takes the plain bridge only until a private landing there is proven (BridgeIn).
  if (network.family === "elysium") return fail(400, `On ${network.label}, bring the money to your wallet first, then add it privately.`);
  const asset = dest.token.address as Address;

  const swap = swapSource(network);
  const chain = swap && Number(body.chainId) === swap.id ? swap : bridgeChain(Number(body.chainId));
  const token = chain && typeof body.symbol === "string" ? bridgeToken(chain, body.symbol) : null;
  if (!chain || !token || !privateBridgeable(chain)) return fail(400, "Pick where the money is coming from.");
  if (!chain.swap && chain.id === dest.chainId) return fail(400, `The money is already on ${dest.chain}. Add it privately from your wallet.`);
  const sameChain = Boolean(chain.swap);
  const evm = chain.kind === "evm";
  const evmChain: Chain | null = sameChain ? network.chain : evm ? originChain(chain.id) : null;
  if (evm && !evmChain) return fail(400, "Pick where the money is coming from.");

  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  if (!isAddress(recipient)) return fail(400, "Connect a wallet to receive the money.");
  const sender = typeof body.sender === "string" ? body.sender.trim() : "";
  // An EVM wallet pays for itself: the payer is the connected wallet.
  if (evm ? sender.toLowerCase() !== recipient.toLowerCase() : !validRefundAddress(chain.kind, sender)) {
    return fail(400, evm ? "Pay from the wallet that's connected." : "Connect your Solana wallet.");
  }

  const amountText = typeof body.amount === "string" ? body.amount.trim() : "";
  if (!/^\d+(\.\d{1,2})?$/.test(amountText) || Number(amountText) < BRIDGE_MIN_USD) {
    return fail(400, `Enter an amount of at least ${BRIDGE_MIN_USD} ${dest.token.symbol}, in whole cents.`);
  }
  const amount = parseUnits(amountText, dest.token.decimals);

  const commitment = typeof body.commitment === "string" ? body.commitment : "";
  const proof = typeof body.proof === "string" ? body.proof : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(commitment) || /^0x0+$/.test(commitment) || !/^0x[0-9a-fA-F]{512}$/.test(proof)) {
    return fail(400, "The private deposit wasn't prepared right. Try again.");
  }

  const screen = await screenAddresses([recipient], { chainId: network.chainId, asset, flow: "deposit" });
  if (!screen.allowed) return fail(403, screen.message ?? SCREEN_BLOCKED_MESSAGE);

  // The vault's own checks, read before anyone pays: room under the deposit
  // limits, a commitment it hasn't seen, and a proof its verifier accepts.
  const client = createPublicClient({ chain: network.chain, ccipRead: false, transport: serverTransport(network, { retryCount: 2 }) });
  const pool = network.pool as Address;
  try {
    const [limitsOn, limit, deposited, seen, verifier] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "depositLimitsOn" }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "depositLimit", args: [asset] }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "deposited", args: [asset] }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "commitmentSeen", args: [commitment as Hex] }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "shieldVerifier" }),
    ]);
    if (limitsOn) {
      // A side set to type(uint128).max is no limit (isNoLimit): never checked or shown.
      const [perDeposit, total] = limit;
      if (!isNoLimit(perDeposit) && amount > perDeposit) {
        return fail(400, `One private deposit can be up to ${units(perDeposit, dest.token.decimals)} ${dest.token.symbol}.`);
      }
      if (!isNoLimit(total) && deposited + amount > total) {
        const room = total > deposited ? total - deposited : BigInt(0);
        return fail(400, room > BigInt(0)
          ? `The vault has room for ${units(room, dest.token.decimals)} ${dest.token.symbol} more right now.`
          : `The vault is at its deposit limit for ${dest.token.symbol}. Try again later.`);
      }
    }
    if (seen) return fail(400, "That private deposit was already used. Start over.");
    const valid = await client.readContract({
      address: verifier,
      abi: VERIFIER_ABI,
      functionName: "verify",
      args: [proof as Hex, [BigInt(commitment), amount, BigInt(asset)]],
    });
    if (!valid) return fail(400, "The private deposit wasn't prepared right. Try again.");
  } catch {
    return fail(502, `Couldn't reach ${dest.chain}. Try again.`);
  }

  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [pool, amount] });
  const shieldData = encodeFunctionData({
    abi: POOL_ABI,
    functionName: "shieldBound",
    args: [asset, amount, commitment as Hex, proof as Hex],
  });

  const apiKey = process.env.RELAY_API_KEY;
  let data: Record<string, any> | null = null;
  try {
    const res = await fetch(`${RELAY_API}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      body: JSON.stringify({
        user: sender,
        recipient,
        refundTo: sender,
        originChainId: chain.id,
        destinationChainId: dest.chainId,
        originCurrency: token.address,
        destinationCurrency: asset,
        amount: amount.toString(),
        tradeType: "EXACT_OUTPUT",
        useDepositAddress: false,
        ...(sameChain ? { slippageTolerance: SWAP_SLIPPAGE_BPS } : {}),
        txs: [
          { to: asset, value: "0", data: approveData },
          { to: pool, value: "0", data: shieldData },
        ],
        appFees: relayAppFees(bridgeFeeSetting(process.env)),
        ...(apiKey ? { referrer: RELAY_REFERRER } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok) {
      const msg = typeof data?.message === "string" ? data.message : "";
      return fail(502, /amount|too (low|small)|insufficient/i.test(msg) ? "That amount is too small to bridge. Try a little more." : ROUTE_BUSY);
    }
  } catch {
    return fail(502, "Couldn't reach the bridge. Try again.");
  }

  // The order must do exactly what was asked: deliver this amount of the
  // vault's stablecoin on this chain and run these two calls. Anything else is
  // refused rather than signed.
  const steps: any[] = Array.isArray(data?.steps) ? data.steps : [];
  const requestId = steps.find((s) => typeof s?.requestId === "string")?.requestId;
  const out = data?.details?.currencyOut;
  const inAmount = BigInt(data?.details?.currencyIn?.amount ?? -1);
  const outAmount = BigInt(out?.amount ?? -1);
  const outOk =
    typeof requestId === "string" &&
    inAmount > BigInt(0) &&
    Number(out?.currency?.chainId) === dest.chainId &&
    String(out?.currency?.address ?? "").toLowerCase() === asset.toLowerCase() &&
    (sameChain ? outAmount >= amount : outAmount === amount);
  if (!outOk) return fail(502, ROUTE_BUSY);
  const approveHex = approveData.slice(2).toLowerCase();
  const shieldHex = shieldData.slice(2).toLowerCase();
  if (!sameChain) {
    // A cross-chain order carries the calls Relay's router runs on arrival.
    const output = data?.protocol?.v2?.orderData?.output;
    const calls: string[] = Array.isArray(output?.calls) ? output.calls.map((c: unknown) => String(c).toLowerCase()) : [];
    const callsOk =
      calls.length === 2 &&
      calls[0]!.includes(approveHex) &&
      calls[1]!.includes(shieldHex) &&
      Array.isArray(output?.payments) &&
      output.payments.length > 0 &&
      output.payments.every((p: Record<string, unknown>) => String(p?.currency).toLowerCase() === asset.toLowerCase() && BigInt(String(p?.minimumAmount ?? -1)) === amount);
    if (!callsOk) return fail(502, ROUTE_BUSY);
  }

  const usdIn = Number(data?.details?.currencyIn?.amountUsd ?? NaN);
  const sendAmount = String(data?.details?.currencyIn?.amountFormatted ?? "");
  // A route that costs far more than it delivers is refused, whatever the reason.
  if (Number.isFinite(usdIn) && usdIn > Number(amountText) * 1.1 + 2) {
    return fail(502, "Bridge fees are unusually high right now. Try again in a minute.");
  }
  const notEnough = `That wallet doesn't hold enough for this. It needs ${sendAmount} ${token.symbol} on ${chain.name}, plus a little for the network fee.`;

  let solanaTx: string | null = null;
  let evmTxs: PrivateBridgeTx[] | null = null;

  if (chain.kind === "svm") {
    const step = steps[0];
    const item = step?.items?.[0]?.data;
    const shapeOk =
      steps.length === 1 &&
      step?.kind === "transaction" &&
      step?.items?.length === 1 &&
      Array.isArray(item?.instructions) &&
      item.instructions.length > 0 &&
      Array.isArray(item?.addressLookupTableAddresses);
    if (!shapeOk) return fail(502, ROUTE_BUSY);
    const built = await buildSolanaTx(
      sender,
      item.instructions as RelaySolanaInstruction[],
      (item.addressLookupTableAddresses as unknown[]).map(String)
    );
    if (!built.ok) {
      return fail(
        built.reason === "funds" ? 400 : 502,
        built.reason === "funds" ? notEnough : built.reason === "rpc" ? "Couldn't reach Solana. Try again." : ROUTE_BUSY
      );
    }
    solanaTx = built.tx;
  } else {
    const txs = evmSteps(steps, chain.id, sender);
    if (!txs) return fail(502, ROUTE_BUSY);
    const native = token.address.toLowerCase() === zeroAddress;
    const deposit = txs[txs.length - 1]!;
    if (native) {
      if (txs.length !== 1 || BigInt(deposit.value) !== inAmount) return fail(502, ROUTE_BUSY);
    } else {
      // A token pays with an exact approve to the deposit contract, then the deposit.
      if (BigInt(deposit.value) !== BigInt(0) || txs.length > 2) return fail(502, ROUTE_BUSY);
      if (txs.length === 2) {
        const approve = txs[0]!;
        let ok = false;
        try {
          const call = decodeFunctionData({ abi: ERC20_ABI, data: approve.data as Hex });
          ok =
            call.functionName === "approve" &&
            approve.to.toLowerCase() === token.address.toLowerCase() &&
            String(call.args[0]).toLowerCase() === deposit.to.toLowerCase() &&
            call.args[1] === inAmount &&
            BigInt(approve.value) === BigInt(0);
        } catch {
          ok = false;
        }
        if (!ok) return fail(502, ROUTE_BUSY);
      }
    }
    if (sameChain && !(deposit.data.toLowerCase().includes(approveHex) && deposit.data.toLowerCase().includes(shieldHex))) {
      return fail(502, ROUTE_BUSY);
    }

    // The wallet must hold enough on that chain. The same-chain swap is
    // simulated whole (swap, approve and deposit); a cross-chain payment is
    // checked by balance, since its deposit needs the approve to land first.
    const origin = createPublicClient({ chain: evmChain!, ccipRead: false, transport: http(evmChain!.rpcUrls.default.http[0], { timeout: 10_000 }) });
    if (sameChain) {
      try {
        await origin.call({ account: sender as Address, to: deposit.to as Address, data: deposit.data as Hex, value: BigInt(deposit.value) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        return fail(400, /insufficient funds|exceeds balance|not enough/i.test(msg) ? notEnough : ROUTE_BUSY);
      }
    } else {
      const held = await (native
        ? origin.getBalance({ address: sender as Address })
        : origin.readContract({ address: token.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [sender as Address] })
      ).catch(() => null);
      if (held !== null && held < inAmount) return fail(400, notEnough);
    }
    evmTxs = txs;
  }

  const feeUsd = ["relayer", "app"].reduce((sum, k) => sum + Number(data?.fees?.[k]?.amountUsd ?? 0), 0);
  const gasUsd = Number(data?.fees?.gas?.amountUsd ?? NaN);
  const paidUsd = Number.isFinite(usdIn) ? Math.round(usdIn * 100) / 100 : null;
  const quote: PrivateBridgeQuote = {
    requestId,
    solanaTx,
    evmTxs,
    sameChain,
    send: {
      amount: sendAmount,
      symbol: token.symbol,
      chain: chain.name,
      chainId: chain.id,
      logo: token.logo,
      usd: paidUsd,
    },
    receive: { amount: amountText, symbol: dest.token.symbol, chain: dest.chain, logo: dest.token.logo },
    extra: sameChain ? swapLeftover({ out: outAmount, amount, decimals: dest.token.decimals, paidUsd, feeUsd }) : null,
    feeUsd: Math.round(feeUsd * 100) / 100,
    appFee: quotedAppFee(bridgeFeeSetting(process.env), data?.fees?.app?.amountUsd, usdIn),
    gasUsd: Number.isFinite(gasUsd) ? Math.round(gasUsd * 100) / 100 : null,
    timeSec: Number(data?.details?.timeEstimate ?? 0),
  };
  if (apiKey) await noteRelayQuote(requestId);
  return NextResponse.json({ ok: true, data: quote }, { headers: { "Cache-Control": "no-store" } });
}
