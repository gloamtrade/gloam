/**
 * Claim links on Starknet, wired to the page's sessions
 * (lib/starknetPrivacy/session): the link's one-time account is a session of
 * its own, opened from the link's secret, its proofs made through Gloam's
 * prover and every transaction sent by Gloam's relay, as any private account's.
 *
 *  - Making one (payroll's link step, lib/starknetPrivacy/payroll): keep it
 *    under Sent links first, then open its account: the relay deploys it, and
 *    its open (viewing key and its own channel) is its first proof. The
 *    payment into it rides the sender's proof (lib/starknetPrivacy/payrollSession).
 *  - Claiming it, or taking it back: the link's account pays the claimer's
 *    own account what it holds, less Gloam's fee (claimAll).
 */
import { keysFromSeed } from "./account";
import { claimSeed, newClaimSecret, bytesOf, hexOf } from "./claimLink";
import { claimAll, type ClaimResult, type LinkHolding } from "./claim";
import type { StarknetNetworkConfig, StarknetToken } from "./config";
import type { PayrollDeps } from "./payroll";
import { StarknetSession, relayFee, type StarknetRelayInfo, type StepReporter } from "./session";
import type { SentLinksStore } from "./sentLinks";

/** The one-time account of a link, as a session. Its keys stay in this object. */
export async function linkSession(cfg: StarknetNetworkConfig, relay: StarknetRelayInfo, origin: string, secret: Uint8Array, pollMs?: number): Promise<StarknetSession> {
  const seed = await claimSeed(secret);
  try {
    return new StarknetSession(cfg, await keysFromSeed(seed, 0, cfg.accountClassHash), relay, origin, pollMs);
  } finally {
    seed.fill(0);
  }
}

/** What a link's account holds: open (deployed and registered) and its private balance. */
export async function readLink(a: StarknetSession, token: StarknetToken): Promise<LinkHolding> {
  if (!(await a.deployed())) return { open: false, balance: 0n };
  if (!(await a.ready(token))) return { open: false, balance: 0n };
  return { open: true, balance: await a.privateBalance(token) };
}

/** Steps a claim reports: 0 waiting for Starknet, 1 claiming privately (the session's pay). */
export const CLAIM_STEPS = ["Waiting for Starknet", "Claiming privately"];

/**
 * Move what the link holds into `to` (the claimer's own private account, or
 * the sender's to take it back), less Gloam's fee for the move.
 */
export async function claimInto(a: StarknetSession, to: string, token: StarknetToken, step: StepReporter): Promise<ClaimResult> {
  return claimAll({
    read: () => readLink(a, token),
    fee: async () => {
      await a.refreshRelay(token);
      return relayFee(a.relayInfo, token)?.amount ?? 0n;
    },
    move: (amount) => a.pay(to, token, amount, step),
  });
}

/** Steps a link's open reports (the session's ensureOpen). */
export const LINK_OPEN_STEPS = ["Setting up the link", "Waiting for Starknet", "Opening the link"];

/**
 * Payroll's link step over the sender's session `s` (lib/starknetPrivacy/payroll):
 * keep a new link, open its account, and mark it paid once its payment lands.
 */
export function starknetLinkDeps(s: StarknetSession, token: StarknetToken, links: SentLinksStore, origin: string, pollMs?: number): Required<Pick<PayrollDeps, "newLink" | "openLink" | "onPaid">> {
  return {
    async newLink(row) {
      const secret = newClaimSecret();
      const seed = await claimSeed(secret);
      const keys = await keysFromSeed(seed, 0, s.cfg.accountClassHash);
      seed.fill(0);
      const id = `snl-${hexOf(globalThis.crypto.getRandomValues(new Uint8Array(8)))}`;
      await links.save({
        v: 1,
        id,
        network: s.cfg.network,
        owner: s.address,
        secret: hexOf(secret),
        address: `0x${BigInt(keys.address).toString(16)}`,
        amount: row.amount.toString(),
        claimFee: (relayFee(s.relayInfo, token)?.amount ?? 0n).toString(),
        name: row.name,
        createdAt: Date.now(),
        state: "new",
        runId: row.runId,
      });
      secret.fill(0);
      return { id, address: `0x${BigInt(keys.address).toString(16)}` };
    },
    async openLink(id, onWait) {
      const l = (await links.load()).find((x) => x.id === id);
      if (!l) throw new Error("This browser lost the link before it was paid, so it wasn't paid. Close the run and pay them again.");
      const a = await linkSession(s.cfg, s.relayInfo, origin, bytesOf(l.secret), pollMs);
      await a.ensureOpen((at, detail) => onWait(detail ?? LINK_OPEN_STEPS[at] ?? LINK_OPEN_STEPS[0]!));
      if (l.state === "new") await links.update(id, (x) => ({ ...x, state: "open" }));
    },
    async onPaid(rows, txHash) {
      for (const r of rows) {
        const id = r.link?.id;
        if (!id) continue;
        await links.update(id, (x) => ({ ...x, state: x.state === "used" ? "used" : "paid", ...(txHash ? { txHash } : {}), claimFee: (relayFee(s.relayInfo, token)?.amount ?? BigInt(x.claimFee)).toString() }));
      }
    },
  };
}
