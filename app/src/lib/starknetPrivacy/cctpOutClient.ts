/**
 * A cash out from Starknet to another chain, in the browser
 * (lib/starknetPrivacy/cctpOut says the whole transaction and what is public):
 * pick the next unused one-time account, prove the cash out to it, sign that
 * account's burn once the proof is made, hand both to Gloam's relay
 * (/api/starknet/cctp/burn), then follow Circle's signature and its delivery
 * on the destination chain (/api/starknet/cctp/message?domain=25).
 *
 * Nothing needs keeping on this device: the withdrawal and the burn land
 * together or not at all, and Circle delivers on its own once it has signed.
 */
import { Account, OutsideExecutionVersion, num, outsideExecution, stark, type Call } from "starknet";
import { starknetCctp, type CctpSource } from "./cctp";
import type { CctpInfo } from "./cctpClient";
import { cashOutToChainCosts, oneTimeCalls, oneTimeKeys, type ForwardFee, type OneTimeKeys } from "./cctpOut";
import type { StarknetToken } from "./config";
import { StarknetRelayError, type StarknetSession, type StepReporter } from "./session";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Circle's fees for a destination as GET /api/starknet/cctp gives them, or null when it didn't price it. */
export function destinationFees(info: Pick<CctpInfo, "destinations">, domain: number): { fastBps: number; forward: ForwardFee } | null {
  const d = info.destinations?.find((x) => x.domain === domain);
  if (!d || d.fastBps === null || !d.forward) return null;
  return { fastBps: d.fastBps, forward: { low: BigInt(d.forward.low), med: BigInt(d.forward.med), high: BigInt(d.forward.high) } };
}

/** The node's "contract not found" (starknet.js RpcError code 20). */
const notFound = (e: unknown) => (e as { code?: unknown } | null)?.code === 20;

/**
 * The first one-time account of this private account that isn't deployed yet:
 * each cash out to another chain deploys the one it uses, in the same
 * transaction, so a used one is never picked again and a failed one is.
 */
export async function nextOneTime(session: Pick<StarknetSession, "keys" | "provider">, limit = 256): Promise<OneTimeKeys> {
  for (let i = 0; i < limit; i++) {
    const k = await oneTimeKeys(session.keys.accountKey, i);
    try {
      await session.provider.getClassHashAt(k.address);
    } catch (e) {
      if (notFound(e)) return k;
      throw e;
    }
  }
  throw new Error("No one-time account is left for this private account.");
}

/** Relay answers that sent nothing and may pass next time: the same proof goes again. */
const AGAIN = new Set(["relay_busy", "upstream_unavailable"]);

/**
 * Cash out `amount` (what is burned) to `recipient` on `dest`. Steps: 0 waiting
 * for Starknet, 1 cashing out, 2 waiting for Circle, 3 arriving on the
 * destination. The Starknet transaction's hash, and whether Circle's delivery
 * was seen before the page stopped waiting (it carries on either way).
 */
export async function cashOutToChain(input: {
  session: StarknetSession;
  token: StarknetToken;
  info: CctpInfo;
  dest: CctpSource;
  recipient: string;
  amount: bigint;
  step: StepReporter;
  origin?: string;
  pollMs?: number;
  waitMs?: number;
}): Promise<{ txHash: string; delivered: boolean; arrives: bigint }> {
  const { session, token, info, dest, step } = input;
  const origin = input.origin ?? "";
  const cctp = starknetCctp(session.cfg.network);
  if (!cctp || !session.cfg.pool) throw new StarknetRelayError("cctp_off", "Cashing out to other networks isn't on here.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipient) || BigInt(input.recipient) === 0n) throw new Error("That isn't an address on " + dest.name + ".");
  const fees = destinationFees(info, dest.domain);
  if (!fees) throw new StarknetRelayError("circle_fee", "Circle's fee for that network isn't available right now. Try again in a minute.");
  const burnFee = BigInt(info.fee);
  const costs = cashOutToChainCosts(input.amount, fees.fastBps, fees.forward, session.feeFor(token)?.amount ?? 0n, burnFee);
  if (!costs) throw new StarknetRelayError("too_small", "That is less than Circle's fee to deliver it.");
  const oneTime = await nextOneTime(session);
  const calls = oneTimeCalls(cctp, { amount: input.amount, domain: dest.domain, recipient: input.recipient, maxFee: costs.maxFee, relay: session.relayer!, fee: burnFee });

  // The burn is signed once the proof is made, so its window starts when it is sent.
  const send = async (proven: { call: Call; proof: { proofFacts: readonly string[]; data: string } }): Promise<string> => {
    const signer = new Account({ provider: session.provider, address: oneTime.address, signer: num.toHex(oneTime.key), cairoVersion: "1" });
    const now = Math.floor(Date.now() / 1000);
    // The one-time account isn't deployed yet, so the SNIP-9 nonce is a fresh random one rather than one asked of it.
    const signed = await signer.getOutsideTransaction({ caller: session.relayer!, execute_after: now - 60, execute_before: now + 600 }, calls, OutsideExecutionVersion.V2, stark.randomAddress());
    const [outside] = outsideExecution.buildExecuteFromOutsideCall(signed);
    const body = JSON.stringify({
      apply: { contractAddress: proven.call.contractAddress, entrypoint: proven.call.entrypoint, calldata: ((proven.call.calldata ?? []) as (string | number | bigint)[]).map((x) => num.toHex(x)) },
      proof: { proofFacts: proven.proof.proofFacts.map((f) => num.toHex(f)), proof: proven.proof.data },
      deploy: oneTime.publicKey,
      outside: { contractAddress: outside!.contractAddress, entrypoint: outside!.entrypoint, calldata: (outside!.calldata as (string | number | bigint)[]).map((x) => num.toHex(x)) },
    });
    for (let tries = 0; ; tries++) {
      const res = await fetch(`${origin}/api/starknet/cctp/burn`, { method: "POST", headers: { "content-type": "application/json" }, body });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; txHash?: string; error?: { code?: string; message?: string } };
      if (res.ok && out.ok && out.txHash) return out.txHash;
      const code = out.error?.code ?? "relay_failed";
      if (tries < 3 && AGAIN.has(code)) {
        await sleep((input.pollMs ?? 1_000) * 2 ** (tries + 1));
        continue;
      }
      throw new StarknetRelayError(code, out.error?.message ?? "Gloam's Starknet relay couldn't send it. Try again.");
    }
  };
  const txHash = await session.cashOut(oneTime.address, token, input.amount + burnFee, (at, d) => step(at, d), { send });

  // Circle signs the burn (about 20 seconds from Starknet), then delivers it on the destination.
  step(2);
  const started = Date.now();
  const waitMs = input.waitMs ?? 10 * 60_000;
  for (let tries = 0; Date.now() - started < waitMs; tries++) {
    if (tries) await sleep(input.pollMs ?? 3_000);
    const res = await fetch(`${origin}/api/starknet/cctp/message?domain=25&tx=${encodeURIComponent(txHash)}`, { cache: "no-store" }).catch(() => null);
    const b = res?.ok ? ((await res.json().catch(() => null)) as { status?: string; forwardState?: string | null } | null) : null;
    if (b?.status !== "complete") continue;
    step(3);
    if (b.forwardState === "COMPLETE") return { txHash, delivered: true, arrives: costs.arrives };
  }
  return { txHash, delivered: false, arrives: costs.arrives };
}
