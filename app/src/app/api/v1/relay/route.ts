import { jsonBody, requireKeyEnv, withApiKey } from "@/lib/partnersApi";
import { keyEnvForNetwork } from "@/lib/apiKeys";
import { clientIp } from "@/lib/mcpRemote/rateLimit";
import { relayForPartner } from "@/lib/partnerRelay";
import { checkChainRateLimit, checkRateLimit, networkForChain, relayStatus } from "@/lib/relay/server";

export const runtime = "nodejs";
// a send can wait its turn in the relay's queue (lib/relay/inflight) before it goes out
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Relay readiness per network (same as /api/relay, behind a key). */
export async function GET(req: Request) {
  return withApiKey(req, async () => ({ data: { networks: await relayStatus() } }));
}

/**
 * Submit an already-proven private action through the Gloam relay, attributed
 * to your partner account. Body is the same as /api/relay:
 *   { chainId, action: "transfer", proof, root, nullifier, commitments: [c0, c1] }
 *   { chainId, action: "unshield", proof, root, nullifier, asset, to, amount }
 *   { chainId, action: "memo", paymentCommitment, memo }
 *   { chainId, action: "swap", router?, spend, deposit, refund, route, exitKey?, deadline?, unshieldTx? }
 *   { chainId, action: "swapExit", router, asset, key, to, signature, unshieldTx }
 * The relay checks, screens and dry-runs exactly as it does for the app
 * (lib/relay/server); this route adds the key, the limits and the accounting
 * (lib/partnerRelay). A swap is counted when the vault read its note as unspent
 * before the send; a refund and an exit are sent and not counted.
 */
export async function POST(req: Request) {
  return withApiKey(req, async ({ key, partner }) => {
    const body = await jsonBody(req);
    const net = networkForChain(body.chainId);
    requireKeyEnv(key, keyEnvForNetwork(net), net.label);
    // The relay's own per-sender caps, with the partner account as the sender: all its
    // keys count together (the network caps apply when it sends). An account no admin
    // approved counts as the calling IP too, as accounts are free to make and an IP is not.
    const account = `partner:${partner.id}`;
    const sender = partner.relayApproved === true ? [account] : [account, clientIp(req)];
    for (const one of sender) {
      await checkRateLimit(one);
      if (body.action !== "memo") await checkChainRateLimit(net, one);
    }
    // the same sender holds its share of the network's cap when the relay sends (lib/relay/server)
    const { hash, action, attribution } = await relayForPartner({ net, body, partner, keyId: key.id, sender });
    return { data: { hash, chainId: net.chainId, network: net.key, action, attribution, charged: false } };
  });
}
