/**
 * Payroll's engine (lib/starknetPrivacy/payroll) wired to one open private
 * account (lib/starknetPrivacy/session), the way its Pay privately is: proofs
 * through /api/starknet/prove, every transaction through Gloam's relay.
 *
 * Each proof:
 *  1. reads the relay again (on, funded, the fee the page showed);
 *  2. waits until the last transaction is 10 blocks back (the SDK's
 *     sequencing recipe) and proves at that block; a session that didn't send
 *     the last transaction also checks nothing it would spend was spent since;
 *  3. runs the payment on the pool with the SDK's mock prover first (no proof
 *     made, nothing sent) and takes fewer people until its server actions fit
 *     the relay's cap (relayPolicy MAX_ACTIONS), so a proof is never made for
 *     a transaction the relay would refuse;
 *  4. proves it for real, and names the notes it spends and the change it
 *     makes, for the run to save before it is sent.
 */
import { SetupRequirement } from "@starkware-libs/starknet-privacy-sdk";
import { num, type Call } from "starknet";
import { payMany, simulatePayMany } from "./actions";
import type { StarknetToken } from "./config";
import { PAYROLL_PROOF_MAX, settleInflight, type Inflight, type PayrollDeps, type Proven, type Reach, type RelayRefusal } from "./payroll";
import { MAX_ACTIONS, decodeApply } from "./relayPolicy";
import { StarknetRelayError, waitText, type StarknetSession } from "./session";

/** Relay answers that sent nothing and can pass the next time (the session's own list). */
const RESEND_SAME_PROOF = new Set(["relay_busy", "upstream_unavailable"]);

type Executed = Awaited<ReturnType<typeof payMany>>;
type NoteLike = { id: unknown };

const noteIds = (notes: readonly NoteLike[] | undefined): string[] => (notes ?? []).map((n) => num.toHex(BigInt(n.id as bigint | string)));

/** Server actions a payment call carries (its apply_actions calldata decoded), or null when it doesn't decode. */
export function serverActionCount(call: Call): number | null {
  const cd = ((call.calldata ?? []) as (string | number | bigint)[]).map((x) => BigInt(x));
  return decodeApply(cd)?.actions.length ?? null;
}

/** The largest count, from `k` down, whose server actions fit `cap`: one more try per guess. */
export async function fitCount(k: number, actionsFor: (n: number) => Promise<number>, cap = MAX_ACTIONS): Promise<number> {
  let n = k;
  for (;;) {
    if (n <= 0) return 0;
    const used = await actionsFor(n);
    if (used <= cap) return n;
    if (n === 1) return 0;
    // Each person costs about the same: aim under the cap, then step down one at a time.
    n = Math.max(1, Math.min(n - 1, Math.floor((n * cap) / used)));
  }
}

/** The pool's proof window (proof_validity_blocks), read once per session. */
const windows = new WeakMap<StarknetSession, Promise<number>>();
function proofWindow(s: StarknetSession): Promise<number> {
  let w = windows.get(s);
  if (!w) {
    w = s.provider.callContract({ contractAddress: s.cfg.pool!, entrypoint: "get_proof_validity_blocks", calldata: [] }).then((r) => Number(BigInt(r[0] ?? "0x0")));
    w.catch(() => windows.delete(s));
    windows.set(s, w);
  }
  return w;
}

/** A relay refusal in the engine's terms: whether the relay may have sent it anyway. */
function refusal(e: unknown): RelayRefusal {
  if (e instanceof StarknetRelayError) {
    // "already_sent": a copy went out. "relay_failed": no answer the page could read (a gateway timeout can follow a send).
    const maybeSent = e.code === "already_sent" || e.code === "relay_failed";
    return { status: e.code === "rate_limited" ? 429 : 400, code: e.code, message: e.message, maybeSent };
  }
  // The request itself failed (offline, closed): it may have reached the relay.
  return { status: 0, code: "network", message: e instanceof Error ? e.message : String(e), maybeSent: true };
}

/**
 * Where each account stands for a payment from `s` (the SDK's
 * SetupRequirement): never registered, a first payment (it opens a channel),
 * or a channel already open. A few at a time, so a long list doesn't flood the node.
 */
export async function payrollReach(s: StarknetSession, token: StarknetToken, addresses: readonly string[]): Promise<Map<string, Reach>> {
  const out = new Map<string, Reach>();
  const queue = [...new Set(addresses)];
  const worker = async () => {
    for (let a = queue.shift(); a !== undefined; a = queue.shift()) {
      const r = await s.transfers.discoverRequirement(a, token.address);
      out.set(a, r === SetupRequirement.Register ? "closed" : r === SetupRequirement.Ready ? "ready" : "first");
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return out;
}

export function starknetPayrollDeps(s: StarknetSession, token: StarknetToken): Pick<PayrollDeps, "prove" | "send" | "confirm" | "resolve"> {
  const tokens = [BigInt(token.address)];
  /** This run saw its last transaction land, so the session knows its block. */
  let confirmed = false;
  return {
    async prove(payments, onWait) {
      // 1. The relay as it is now: paused, or a fee other than the one shown, stops here.
      const changed = await s.refreshRelay(token);
      const info = s.relayInfo;
      if (!info.on || !info.funded || !info.relayer) throw new StarknetRelayError("relay_paused", "Private payments on Starknet are paused for a moment. Try again later.");
      // The relay would refuse it after its proof (fee_unset): say so before proving.
      if (info.moves === "off") throw new StarknetRelayError("moves_off", "Paying on Starknet isn't open yet. Nothing was sent. Try again later.");
      if (changed) throw new StarknetRelayError("relay_changed", "Gloam's fee on Starknet just changed. Check it and resume.");
      // 2. The block to prove at.
      const blind = !confirmed && s.cfg.discovery.kind === "indexer";
      const at = await s.settle((left) => onWait(waitText(left)), true, blind ? async (b) => !(await s.spentSince(b, token)) : undefined);
      const fee = s.feeFor(token);
      const list = payments.slice(0, PAYROLL_PROOF_MAX).map((p) => ({ to: p.address, amount: p.amount }));
      const input = (n: number) => ({ token: token.address, self: s.address, payments: list.slice(0, n), fee, provingBlockId: at });
      // 3. How many fit, run on the pool first.
      onWait("Checking the payment");
      const count = await fitCount(list.length, async (n) => {
        const sim = await simulatePayMany(s.transfers, input(n), s.provider);
        const used = serverActionCount(sim.callAndProof.call);
        if (used === null) throw new Error("Couldn't read the payment back. Try again.");
        return used;
      });
      if (count === 0) return { count: 0, spends: [], change: [], provedAt: at, fee: fee?.amount ?? 0n, payload: null };
      // 4. The proof, and what it spends.
      const before = noteIds((await s.transfers.discoverNotes({ tokens, blockIdentifier: at })).notes.get(token.address) as NoteLike[] | undefined);
      onWait("Proving");
      const r = await payMany(s.transfers, input(count));
      const after = noteIds(r.registry.notes.get(token.address) as NoteLike[] | undefined);
      const had = new Set(before);
      const left = new Set(after);
      return {
        count,
        spends: before.filter((id) => !left.has(id)),
        change: after.filter((id) => !had.has(id)),
        provedAt: at,
        fee: fee?.amount ?? 0n,
        payload: r,
      } satisfies Proven;
    },

    async send(proven) {
      const r = proven.payload as Executed;
      const proof = r.callAndProof.proof;
      for (let tries = 0; ; tries++) {
        try {
          return await s.relay([r.callAndProof.call], { proofFacts: proof.proofFacts, data: proof.data });
        } catch (e) {
          if (tries < 3 && e instanceof StarknetRelayError && RESEND_SAME_PROOF.has(e.code)) {
            await new Promise((res) => setTimeout(res, 2_000 * 2 ** tries));
            continue;
          }
          throw refusal(e);
        }
      }
    },

    async confirm(txHash) {
      await s.confirm(txHash);
      confirmed = true;
    },

    async resolve(f: Inflight) {
      let receipt: { status: "succeeded" | "reverted"; reason?: string } | null = null;
      if (f.txHash) {
        try {
          const r = (await s.provider.getTransactionReceipt(f.txHash)) as unknown as { finality_status?: string; execution_status?: string; revert_reason?: string };
          if (r.finality_status === "ACCEPTED_ON_L2" || r.finality_status === "ACCEPTED_ON_L1") {
            receipt = r.execution_status === "REVERTED" ? { status: "reverted", reason: r.revert_reason } : { status: "succeeded" };
          }
        } catch {
          // Not known to the node (yet): the notes and the window decide.
        }
      }
      const [notes, head, validity] = await Promise.all([s.transfers.discoverNotes({ tokens, blockIdentifier: "latest" }), s.provider.getBlockNumber(), proofWindow(s)]);
      const unspent = new Set(noteIds(notes.notes.get(token.address) as NoteLike[] | undefined));
      return settleInflight(f, { receipt, unspent, head, validity });
    },
  };
}
