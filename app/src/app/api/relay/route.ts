import { NextResponse, after } from "next/server";
import { logSafe } from "@/lib/logSafe";
import { clientIp } from "@/lib/mcpRemote/rateLimit";
import { afterRelaySend, bindRelaySpend, relayFlowOf, unbindRelaySpend, type BoundSpend } from "@/lib/partnerAttribution";
import { isLinkCodeShape } from "@/lib/partnerCode";
import { BATCH_MAX_PARTS } from "@/lib/relay/batch";
import {
  RelayError,
  checkChainRateLimit,
  checkRateLimit,
  memoTicket,
  networkForChain,
  relayGasStation,
  relayMemo,
  relayNameClaim,
  relayStatus,
  relayTransfer,
  relayTransferBatch,
  relayUnshield,
  relayUnshieldBatch,
  relayVaultSwap,
  relayVaultSwapExit,
  type SendHooks,
} from "@/lib/relay/server";

export const runtime = "nodejs";
// a send can wait its turn in the relay's queue (lib/relay/inflight) before it goes out
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Which networks the relay can submit on right now (no secrets). */
export async function GET() {
  const networks = await relayStatus();
  // public and the same for everyone: the CDN answers the app's checks, the relay's balance reads stay rare
  return NextResponse.json({ ok: true, networks }, { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" } });
}

/**
 * Submit an already-proven private action through the Gloam relay.
 * Body: { chainId, action: "transfer" | "transferBatch" | "unshield" | "unshieldBatch" | "memo" | "swap" | "swapExit" | "nameClaim", ...args }
 * "transferBatch" takes { parts: [{ proof, root, nullifier, commitments, memo? }] }: one
 * payment in parts, sent as one transaction (lib/relay/batch). "unshieldBatch" takes
 * { pool, feeBps, parts: [{ proof, root, nullifier, asset, to, amount }] }: a cash out
 * across balances, every part's unshield to one wallet in one transaction. Each part of
 * either counts against the rate limits as the send it replaces.
 * Returns { ok: true, hash } as soon as the transaction is sent; the client
 * waits for the receipt itself. A transfer also returns `memoTicket` for its
 * payment (commitments[0]), null when the relay has no memo secret: sent back
 * as `ticket` with that payment's memo, it gets the payer's own few messages.
 * Also action "gas-station" with { wallet, step }: a fresh wallet's gas station
 * (lib/relay/gasStation), off unless switched on.
 *
 * A send opened from a partner's link may carry { partnerCode }, and a payment or
 * cash out in parts { partnerPayment } too: the app's random tag, the same on every
 * part, so the parts count as one payment (transfer, unshield, transferBatch,
 * unshieldBatch). Nothing about the send changes. Once the relay's checks, dry run
 * and holds have passed, just before the transaction goes out, the code is bound to
 * that exact payment (one store write, started then and never waited on); a
 * request the relay refuses binds nothing, and one that then surely didn't go out
 * is taken back. Once the send is out, the code is bound to the transaction's
 * hash, and the transaction is counted when it lands, after the response
 * (lib/partnerAttribution). None of this ever fails or delays a send.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new RelayError("Invalid request.");
    // a link's code is read now, bound just before the send goes out, counted after it (lib/partnerAttribution)
    const takenAt = Date.now();
    const partnerCode = body.partnerCode;
    const partnerPayment = body.partnerPayment;
    const net = networkForChain(body.chainId);
    const requester = clientIp(req);
    await checkRateLimit(requester);
    // payment messages have budgets of their own (lib/relay/server holdMemoSlot)
    if (body.action !== "memo") await checkChainRateLimit(net, requester);
    // a payment or a cash out in parts counts each part as the send it replaces
    if ((body.action === "transferBatch" || body.action === "unshieldBatch") && Array.isArray(body.parts)) {
      for (let i = 1; i < Math.min(body.parts.length, BATCH_MAX_PARTS); i++) {
        await checkRateLimit(requester);
        await checkChainRateLimit(net, requester);
      }
    }
    // bound only once the relay's checks, dry run and holds passed (beforeBroadcast), never waited on
    const flow = partnerCode !== undefined ? relayFlowOf(body) : null;
    let bound: Promise<BoundSpend | null> | undefined;
    const hooks: SendHooks = flow
      ? {
          beforeBroadcast: (tx) => {
            const b = bindRelaySpend({ net, tx, code: partnerCode, flow, at: Date.now(), payment: partnerPayment }).catch(() => null);
            bound = b;
            // the send surely didn't go out: take the binding back
            return () => void b.then(unbindRelaySpend);
          },
        }
      : {};
    // once sent: the link's code is bound to the transaction and counted when it lands, after the reply
    const countLater = (sent: `0x${string}`) => {
      if (!flow || !isLinkCodeShape(partnerCode)) return;
      try {
        after(() => afterRelaySend({ net, hash: sent, code: partnerCode, flow, at: takenAt, bound, payment: partnerPayment }));
      } catch (e) {
        // never the send's business
        console.error("gloam_partner_after_send", logSafe(e));
      }
    };

    let hash: `0x${string}`;
    switch (body.action) {
      case "transfer": {
        hash = await relayTransfer(net, body, requester, hooks);
        countLater(hash);
        // relayTransfer checked commitments[0] is a bytes32
        const payment = (body.commitments as string[])[0]!;
        return NextResponse.json({ ok: true, hash, memoTicket: memoTicket(net.chainId, payment) });
      }
      case "transferBatch":
        hash = await relayTransferBatch(net, body, requester, hooks);
        break;
      case "unshield":
        hash = await relayUnshield(net, body, requester, hooks);
        break;
      case "unshieldBatch":
        hash = await relayUnshieldBatch(net, body, requester, hooks);
        break;
      case "gas-station":
        hash = await relayGasStation(net, body, requester);
        break;
      case "memo":
        hash = await relayMemo(net, body);
        break;
      case "swap":
        hash = await relayVaultSwap(net, body, requester, hooks);
        break;
      case "swapExit":
        hash = await relayVaultSwapExit(net, body, requester);
        break;
      case "nameClaim":
        hash = await relayNameClaim(net, body, requester, hooks);
        break;
      default:
        throw new RelayError("Unknown action.");
    }
    // a payment, cash out or swap from a link (flow is null for everything else)
    countLater(hash);
    return NextResponse.json({ ok: true, hash });
  } catch (e) {
    if (e instanceof RelayError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: e.status });
    }
    console.error("gloam_relay", logSafe(e));
    return NextResponse.json(
      { ok: false, error: "The relay hit an error. Send from your wallet for now.", code: "internal" },
      { status: 500 }
    );
  }
}
