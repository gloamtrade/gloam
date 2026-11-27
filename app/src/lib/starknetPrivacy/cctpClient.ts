/**
 * Bringing USDC in to a Gloam private account on Starknet with CCTP, in the
 * browser, after the source chain's burn (lib/starknetPrivacy/cctp says the
 * whole flow): wait for Circle's signature through /api/starknet/cctp/message,
 * sign the account's outside execution (the relay's fee and the pool's approve)
 * and hand both to the relay (/api/starknet/cctp), then the existing add.
 *
 * A burn already sent is kept on this device (source domain and transaction
 * only, nothing secret) until it arrives, so a closed tab or a reload picks it
 * up again. If it is lost anyway the money is not: any CCTP relayer, or the
 * person, can deliver Circle's message to the account, and the plain Add
 * privately takes it from there.
 */
import type { StarknetToken } from "./config";
import { receiveOutsideCalls, starknetCctp, type CctpSource } from "./cctp";
import { StarknetRelayError, type StarknetSession, type StepReporter } from "./session";

/** Gloam's CCTP routes (next to STARKNET_PROXY_PATHS.relay). */
export const CCTP_PATHS = { info: "/api/starknet/cctp", message: "/api/starknet/cctp/message" } as const;

export type CctpInfo = {
  on: boolean;
  network: string;
  relayer: string | null;
  /** The relay's fee on a receive, base units. */
  fee: string;
  /** Circle's fast fee per source domain in basis points (0: none; null: Circle didn't answer). */
  sources: { domain: number; chainId: number; fastBps: number | null }[];
  /** For a cash out to another chain: Circle's fast fee from Starknet and its forwarding fee there (base units, strings). */
  destinations?: { domain: number; chainId: number; fastBps: number | null; forward: { low: string; med: string; high: string } | null }[];
};

export const CCTP_OFF: CctpInfo = { on: false, network: "", relayer: null, fee: "0", sources: [] };

export async function readCctpInfo(origin = ""): Promise<CctpInfo> {
  const res = await fetch(`${origin}${CCTP_PATHS.info}`, { cache: "no-store" });
  if (!res.ok) return CCTP_OFF;
  return (await res.json()) as CctpInfo;
}

/**
 * A burn sent on the source chain, on its way to the account. `chainId` is
 * where the person paid; `domain` and `tx` are the CCTP burn's. A bring-in
 * through Relay (lib/starknetPrivacy/cctpRelay) burns on Base in Relay's own
 * transaction: until Relay names it, `tx` is empty and `relay` is its request id.
 */
export type PendingBringIn = { domain: number; chainId: number; tx: string; amount: string; at: number; relay?: string };

/** What identifies a pending bring-in on this device: Relay's request id, else the burn's transaction. */
export function pendingKey(p: Pick<PendingBringIn, "tx" | "relay">): string {
  return p.relay ?? p.tx;
}

export type Attested = { message: string; attestation: string; nonce: string; minted: bigint; expirationBlock: bigint };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Stopped", "AbortError"));
    });
  });

/** How long the page waits for Circle before it says the transfer is still on its way: well past Circle's own times. */
export function attestWaitMs(source: Pick<CctpSource, "fast" | "attestSeconds">): number {
  return Math.max(10 * 60_000, source.attestSeconds * 30_000);
}

/** Wait until Circle signs the burn in `p`; `onWait` gets the seconds waited. */
export async function waitForCircle(p: Pick<PendingBringIn, "domain" | "tx">, opts: { origin?: string; timeoutMs: number; pollMs?: number; onWait?: (s: number) => void; signal?: AbortSignal }): Promise<Attested> {
  const started = Date.now();
  const poll = opts.pollMs ?? 3_000;
  for (let tries = 0; ; tries++) {
    if (tries) await sleep(poll, opts.signal);
    opts.onWait?.(Math.floor((Date.now() - started) / 1000));
    let res: Response | null = null;
    try {
      res = await fetch(`${opts.origin ?? ""}${CCTP_PATHS.message}?domain=${p.domain}&tx=${encodeURIComponent(p.tx)}`, { cache: "no-store", signal: opts.signal });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
    }
    const body = res ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
    if (res?.status === 404 && (body?.error as { code?: string } | undefined)?.code === "not_to_starknet") {
      throw new StarknetRelayError("not_to_starknet", "That transaction has no USDC transfer to Starknet.");
    }
    if (res?.ok && body?.status === "complete") {
      return {
        message: String(body.message),
        attestation: String(body.attestation),
        nonce: String(body.nonce),
        minted: BigInt(String(body.minted)),
        expirationBlock: BigInt(String(body.expirationBlock ?? "0")),
      };
    }
    if (Date.now() - started > opts.timeoutMs) {
      throw new StarknetRelayError("circle_slow", "Circle hasn't signed this transfer yet. It is still on its way: come back to this page and it carries on.");
    }
  }
}

/**
 * Wait until Relay has filled order `requestId` on Base; the Base transaction
 * that ran the burn. A refund or a failure stops here: the money went back to
 * the wallet (Relay's refund), or to the wallet on Base if the calls couldn't run.
 */
export async function waitForRelay(requestId: string, opts: { origin?: string; timeoutMs?: number; pollMs?: number; onWait?: (s: number) => void }): Promise<string> {
  const started = Date.now();
  for (let tries = 0; ; tries++) {
    if (tries) await sleep(opts.pollMs ?? 3_000);
    opts.onWait?.(Math.floor((Date.now() - started) / 1000));
    const res = await fetch(`${opts.origin ?? ""}/api/bridge/status?requestId=${encodeURIComponent(requestId)}`, { cache: "no-store" }).catch(() => null);
    const body = res ? ((await res.json().catch(() => null)) as { ok?: boolean; data?: { stage?: string; outTx?: string | null } } | null) : null;
    const stage = body?.data?.stage;
    if (stage === "done" && typeof body?.data?.outTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.data.outTx)) return body.data.outTx;
    if (stage === "refunded") throw new StarknetRelayError("relay_refunded", "The bridge couldn't take it, so it sent your money back to your wallet. Nothing reached Starknet.");
    if (stage === "failed") throw new StarknetRelayError("relay_failed", "The bridge couldn't finish it. If it reached Base, it is in your wallet there.");
    if (Date.now() - started > (opts.timeoutMs ?? 30 * 60_000)) throw new StarknetRelayError("relay_slow", "The bridge hasn't delivered it yet. It is still on its way: come back to this page and it carries on.");
  }
}

/** Ask Circle to sign an expired transfer again. */
export async function askCircleAgain(nonce: string, origin = ""): Promise<boolean> {
  const res = await fetch(`${origin}${CCTP_PATHS.message}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce }) });
  return res.ok;
}

/**
 * Hand Circle's message and the account's signed fee and approve to the relay:
 * one Starknet transaction that mints to the account and pays the relay from
 * it. The transaction hash and what the approve lets the add take.
 */
export async function receiveIntoAccount(session: StarknetSession, token: StarknetToken, info: Pick<CctpInfo, "fee">, a: Attested, origin = ""): Promise<{ txHash: string; approved: bigint }> {
  const cctp = starknetCctp(session.cfg.network);
  if (!cctp || !session.cfg.pool) throw new StarknetRelayError("cctp_off", "Bringing money in to Starknet isn't on here.");
  const fee = BigInt(info.fee);
  const approve = a.minted - fee;
  if (approve <= 0n) throw new StarknetRelayError("too_small", "That transfer is smaller than Gloam's fee to bring it in.");
  const outside = await session.outsideCall(receiveOutsideCalls({ usdc: token.address, relay: session.relayer!, pool: session.cfg.pool, fee, approve }));
  const res = await fetch(`${origin}${CCTP_PATHS.info}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: a.message,
      attestation: a.attestation,
      outside: { contractAddress: outside.contractAddress, entrypoint: outside.entrypoint, calldata: (outside.calldata as string[]).map((x) => `0x${BigInt(x).toString(16)}`) },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; txHash?: string; error?: { code?: string; message?: string } };
  if (!res.ok || !body.ok || !body.txHash) throw new StarknetRelayError(body.error?.code ?? "relay_failed", body.error?.message ?? "Gloam's Starknet relay couldn't bring it in. Try again.");
  return { txHash: body.txHash, approved: approve };
}

/**
 * After the burn: wait for Circle, bring it in, then add it privately. Steps:
 * 0 waiting for Circle (and, through Relay, for its fill on Base first), 1
 * arriving on Starknet, 2 waiting for Starknet, 3 adding privately.
 * `onSettled` runs once the mint landed (the page forgets the pending burn
 * then: from there the money is on the account), or once Relay sent it back.
 */
export async function finishBringIn(input: {
  session: StarknetSession;
  token: StarknetToken;
  info: CctpInfo;
  pending: PendingBringIn;
  source: Pick<CctpSource, "fast" | "attestSeconds">;
  step: StepReporter;
  /** Relay named the Base transaction of a bring-in through Relay (keep it). */
  onRelayed?: (p: PendingBringIn) => void;
  /** The pending burn is settled (forget it): it arrived on the account, or Relay sent the money back. */
  onSettled?: () => void;
  origin?: string;
  pollMs?: number;
}): Promise<string> {
  const { session, token, step } = input;
  step(0);
  let pending = input.pending;
  if (!pending.tx && pending.relay) {
    let tx: string;
    try {
      tx = await waitForRelay(pending.relay, { origin: input.origin, pollMs: input.pollMs, onWait: () => step(0, "The bridge is delivering it to Base") });
    } catch (e) {
      // Refunded or failed: nothing is on its way to Starknet any more.
      if (e instanceof StarknetRelayError && (e.code === "relay_refunded" || e.code === "relay_failed")) input.onSettled?.();
      throw e;
    }
    pending = { ...pending, tx };
    input.onRelayed?.(pending);
  }
  let a = await waitForCircle(pending, {
    origin: input.origin,
    timeoutMs: attestWaitMs(input.source),
    pollMs: input.pollMs,
    onWait: (s) => step(0, s >= 20 ? `${s} seconds so far` : undefined),
  });
  step(1);
  let landed: { txHash: string; approved: bigint } | null = null;
  for (let tries = 0; !landed; tries++) {
    try {
      landed = await receiveIntoAccount(session, token, input.info, a, input.origin);
    } catch (e) {
      const code = e instanceof StarknetRelayError ? e.code : "";
      if (code === "already_received") break;
      // A fast transfer's signature lasts a day: an older one is signed again once.
      if (code === "cctp_expired" && tries === 0 && (await askCircleAgain(a.nonce, input.origin))) {
        step(0);
        a = await waitForCircle(pending, { origin: input.origin, timeoutMs: attestWaitMs(input.source), pollMs: input.pollMs });
        step(1);
        continue;
      }
      if ((code === "relay_busy" || code === "upstream_unavailable") && tries < 3) {
        await sleep((input.pollMs ?? 1_000) * 2 ** (tries + 1));
        continue;
      }
      throw e;
    }
  }
  if (landed) await session.confirm(landed.txHash);
  input.onSettled?.();
  // Delivered by someone else: the money is on the account with no approve, so the plain add runs.
  const amount = landed ? landed.approved : await session.publicBalance(token);
  if (amount <= 0n) throw new StarknetRelayError("nothing_arrived", "The transfer arrived, but there is nothing on your Starknet account to add.");
  return session.add(token, amount, (at, detail) => step(at === 0 ? 1 : at + 1, detail), { approved: Boolean(landed) });
}

// ------------------------------------------------------------------ kept on this device

const KEY = (account: string) => `gloam:starknet:cctp:pending:v1:${BigInt(account).toString(16)}`;

export function pendingBringIns(account: string): PendingBringIn[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY(account)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is PendingBringIn =>
        Boolean(p) &&
        Number.isSafeInteger(p.domain) &&
        Number.isSafeInteger(p.chainId) &&
        typeof p.tx === "string" &&
        (p.relay === undefined || /^0x[0-9a-fA-F]{64}$/.test(String(p.relay))) &&
        Boolean(p.tx || p.relay) &&
        /^\d+$/.test(String(p.amount)) &&
        Number.isFinite(p.at)
    );
  } catch {
    return [];
  }
}

export function keepPendingBringIn(account: string, p: PendingBringIn): void {
  try {
    const list = pendingBringIns(account).filter((x) => pendingKey(x) !== pendingKey(p));
    globalThis.localStorage?.setItem(KEY(account), JSON.stringify([...list, p].slice(-10)));
  } catch {
    /* storage off: the transfer still arrives, it just isn't picked up again here */
  }
}

/** Forget the pending bring-in with this key (pendingKey). */
export function dropPendingBringIn(account: string, key: string): void {
  try {
    const list = pendingBringIns(account).filter((x) => pendingKey(x) !== key);
    if (list.length) globalThis.localStorage?.setItem(KEY(account), JSON.stringify(list));
    else globalThis.localStorage?.removeItem(KEY(account));
  } catch {
    /* nothing kept */
  }
}
