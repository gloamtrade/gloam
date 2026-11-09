import type { Hex } from "viem";
import { ApiError, jsonBody, requireKeyEnv, withApiKey } from "@/lib/partnersApi";
import { keyEnvForNetwork } from "@/lib/apiKeys";
import { recordActivity } from "@/lib/partners";
import { depositIn } from "@/lib/partnerDeposits";
import { networkForChain, relayPublicClient } from "@/lib/relay/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Deposits can be attributed for this long after they land. */
const CLAIM_WINDOW_SEC = 24 * 60 * 60;

/**
 * Attribute a deposit your app made: { chainId, txHash }. Deposits come from
 * the depositor's own wallet, not the relay, so your app reports them. The
 * server reads the transaction from the chain: it must be a successful deposit
 * into Gloam's vault (not a swap's or a refund's note, which go in through a swap
 * router), at most 24 hours old, and not yet attributed to anyone.
 * Only what the chain already shows is kept (asset, amount, time).
 */
export async function POST(req: Request) {
  return withApiKey(req, async ({ key, partner }) => {
    const body = await jsonBody(req);
    const net = networkForChain(body.chainId);
    requireKeyEnv(key, keyEnvForNetwork(net), net.label);
    if (typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      throw new ApiError(400, "bad_tx", "txHash must be a 32-byte transaction hash.");
    }
    const txHash = body.txHash as Hex;
    const client = relayPublicClient(net);
    const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt) throw new ApiError(404, "tx_not_found", `No confirmed transaction with that hash on ${net.label} yet.`);
    if (receipt.status !== "success") throw new ApiError(422, "tx_failed", "That transaction failed on chain.");

    // a swap's new note or a refund note goes in through a swap router: not a deposit
    const deposit = depositIn(receipt.logs, net.pool!);
    if (!deposit) throw new ApiError(422, "not_a_deposit", "That transaction is not a deposit into Gloam's vault.");
    const { asset, amount } = deposit;

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const age = Math.floor(Date.now() / 1000) - Number(block.timestamp);
    if (age > CLAIM_WINDOW_SEC) {
      throw new ApiError(422, "too_old", "Deposits can be attributed for 24 hours after they land.");
    }

    const r = await recordActivity({ partner, keyId: key.id, network: net, kind: "deposit", txHash, edge: { asset, amount } });
    if (!r.recorded) throw new ApiError(409, "already_attributed", "That deposit is already attributed.");
    return { data: { activity: r.record, charged: false }, status: 201 };
  });
}
