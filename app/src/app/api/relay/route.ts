import { NextResponse, after } from "next/server";
import { logSafe } from "@/lib/logSafe";
import { clientIp } from "@/lib/mcpRemote/rateLimit";
import { afterRelaySend, bindRelaySpend, relayFlowOf, unbindRelaySpend, type BoundSpend } from "@/lib/partnerAttribution";
import {
  RelayError,
  checkChainRateLimit,
  checkRateLimit,
  memoTicket,
  networkForChain,
  relayGasStation,
  relayMemo,
  relayStatus,
  relayTransfer,
  relayUnshield,
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
 * Body: { chainId, action: "transfer" | "unshield" | "memo" | "swap" | "swapExit", ...args }
 * Returns { ok: true, hash } as soon as the transaction is sent; the client
 * waits for the receipt itself. A transfer also returns `memoTicket` for its
 * payment (commitments[0]), null when the relay has no memo secret: sent back
 * as `ticket` with that payment's memo, it gets the payer's own few messages.
 * Also action "gas-station" with { wallet, step }: a fresh wallet's gas station
 * (lib/relay/gasStation), off unless switched on.
 *
 * A send opened from a partner's link may carry { partnerCode }. Nothing about
 * the send changes. Once the relay's checks, dry run and holds have passed, just
 * before the transaction goes out, the code is bound to that exact payment (one
 * store write, started then and never waited on); a request the relay refuses
 * binds nothing, and one that then surely didn't go out is taken back. Once the
 * send is out, the code is bound to the transaction's hash, and the transaction is
 * counted when it lands, after the response (lib/partnerAttribution). None of
 * this ever fails or delays a send.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new RelayError("Invalid request.");
    // a link's code is read now, bound just before the send goes out, counted after it (lib/partnerAttribution)
    const takenAt = Date.now();
    const partnerCode = body.partnerCode;
    const net = networkForChain(body.chainId);
    const requester = clientIp(req);
    await checkRateLimit(requester);
    // payment messages have budgets of their own (lib/relay/server holdMemoSlot)
    if (body.action !== "memo") await checkChainRateLimit(net, requester);
    // bound only once the relay's checks, dry run and holds passed (beforeBroadcast), never waited on
    const flow = partnerCode !== undefined ? relayFlowOf(body) : null;
    let bound: Promise<BoundSpend | null> | undefined;
    const hooks: SendHooks = flow
      ? {
          beforeBroadcast: (tx) => {
            const b = bindRelaySpend({ net, tx, code: partnerCode, flow, at: Date.now() }).catch(() => null);
            bound = b;
            // the send surely didn't go out: take the binding back
            return () => void b.then(unbindRelaySpend);
          },
        }
      : {};

    let hash: `0x${string}`;
    switch (body.action) {
      case "transfer": {
        hash = await relayTransfer(net, body, requester, hooks);
        if (partnerCode !== undefined) {
          const sent = hash;
          after(() => afterRelaySend({ net, hash: sent, code: partnerCode, flow: relayFlowOf(body), at: takenAt, bound }));
        }
        // relayTransfer checked commitments[0] is a bytes32
        const payment = (body.commitments as string[])[0]!;
        return NextResponse.json({ ok: true, hash, memoTicket: memoTicket(net.chainId, payment) });
      }
      case "unshield":
        hash = await relayUnshield(net, body, requester, hooks);
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
      default:
        throw new RelayError("Unknown action.");
    }
    if (partnerCode !== undefined && (body.action === "unshield" || body.action === "swap")) {
      const sent = hash;
      after(() => afterRelaySend({ net, hash: sent, code: partnerCode, flow: relayFlowOf(body), at: takenAt, bound }));
    }
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
