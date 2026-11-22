/**
 * One private payment or cash out through Gloam's relay (the Pay and Cash out
 * tabs), sent so it can never go out twice. Pure rules, with the chain, the
 * relay and storage passed in (lib/solanaRings/client wires the browser's).
 * Checked by scripts/selftest-solana-rings.mts and, on devnet,
 * scripts/e2e-solana-send.mts.
 *
 * The danger is a relay answer that is lost after the relay sent the payment
 * (a timeout, a dropped connection, a failure after the send). Freeing the
 * payment's notes then lets a retry spend other notes for the same payment,
 * and both can land. So, as payroll does (lib/solanaRings/payroll):
 *
 *  - Before it goes to the relay, the payment is stored as pending: the
 *    nullifiers of the notes it spends and its blockhash. If that can't be
 *    stored, it isn't sent.
 *  - A refusal from before the send (4xx, the relay off, empty, or its check
 *    run failing) frees the notes at once: nothing was sent.
 *  - Anything else (a lost answer, a confirmation that timed out) is settled
 *    on chain first: by signature, else by whether its notes were spent. The
 *    notes are freed only once its blockhash has expired with them unspent.
 *  - A payment still pending from before (a tab closed mid-payment) is
 *    settled before the next one is built. If it went through, the next one
 *    is refused once, so the same payment isn't made again by hand.
 */
import { INFLIGHT_POLL_MS, isRelayRefusal, type Built, type InflightResult } from "./payroll";

export type Pending = {
  nullifiers: string[];
  blockhash: string;
  signature?: string;
  at: number;
};

export type PendingStore = {
  /** The pending payment, null when there is none, "unreadable" when one can't be read. */
  load(): Promise<Pending | null | "unreadable">;
  /** Resolves once it is stored; throws when it can't be. */
  save(p: Pending): Promise<void>;
  clear(): Promise<void>;
};

export type SendDeps = {
  /** Build and sign the payment. Nothing is sent; its notes are set aside. */
  build(): Promise<Built>;
  /** Hand it to the relay. Rejects with a RelayRefusal when the relay says no. */
  send(wire: Uint8Array): Promise<string>;
  /** Free the notes the build set aside, after a refusal that sent nothing. */
  release(): Promise<void>;
  /** Wait for a sent payment to land. Rejects if it fails or takes too long. */
  confirm(signature: string): Promise<void>;
  /** Where a payment that may have been sent stands (frees its notes itself when it was dropped or failed). */
  resolve(p: Pending): Promise<InflightResult>;
  pending: PendingStore;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Called while it waits to learn whether a payment went through. */
  onChecking?(): void;
};

export const LAST_PAYMENT_LANDED = "Your last payment on Solana went through after all. Check your balance before you pay again.";
export const NOT_SENT = "That payment didn't go through, and nothing moved. Try again.";
export const FAILED_ON_CHAIN = "That payment failed on Solana, and nothing moved. Try again.";
export const NOT_SURE = "Couldn't tell whether your last payment went through. Check your balance before you try again.";
export const NOT_SAVED = "This browser couldn't save the payment before sending it, so it wasn't sent. Free some space and try again.";

async function settle(deps: SendDeps, p: Pending): Promise<InflightResult> {
  for (;;) {
    const r = await deps.resolve(p);
    if (r.state !== "pending") return r;
    deps.onChecking?.();
    await deps.sleep(INFLIGHT_POLL_MS);
  }
}

/** Send one payment through the relay so it can't go out twice. Its signature. */
export async function sendGuarded(deps: SendDeps): Promise<string> {
  // 1. One left in flight earlier is settled before anything else is built.
  const earlier = await deps.pending.load();
  if (earlier === "unreadable") {
    await deps.pending.clear();
    throw new Error(NOT_SURE);
  }
  if (earlier) {
    deps.onChecking?.();
    const r = await settle(deps, earlier);
    await deps.pending.clear();
    if (r.state === "landed") throw new Error(LAST_PAYMENT_LANDED);
    if (r.state === "unknown") throw new Error(NOT_SURE);
    // failed or dropped: it never moved anything, so this one can go
  }

  // 2. Stored as pending before it is sent.
  const built = await deps.build();
  const p: Pending = { nullifiers: built.nullifiers, blockhash: built.blockhash, at: deps.now() };
  try {
    await deps.pending.save(p);
  } catch {
    await deps.release().catch(() => undefined);
    throw new Error(NOT_SAVED);
  }

  // 3. Sent. A refusal from before the send frees its notes; anything else waits for the chain.
  let signature: string | undefined;
  try {
    signature = await deps.send(built.wire);
  } catch (e) {
    if (isRelayRefusal(e) && !e.maybeSent) {
      await deps.pending.clear();
      await deps.release().catch(() => undefined);
      throw e;
    }
  }
  if (signature) {
    await deps.pending.save({ ...p, signature }).catch(() => undefined);
    try {
      await deps.confirm(signature);
      await deps.pending.clear();
      return signature;
    } catch {
      // timed out or failed: the chain says which, below
    }
  }

  deps.onChecking?.();
  const r = await settle(deps, signature ? { ...p, signature } : p);
  await deps.pending.clear();
  if (r.state === "landed") return r.signature ?? signature ?? "";
  if (r.state === "failed") throw new Error(FAILED_ON_CHAIN);
  if (r.state === "dropped") throw new Error(NOT_SENT);
  throw new Error(NOT_SURE);
}

function isPending(v: unknown): v is Pending {
  const p = v as Partial<Pending> | null;
  return (
    Boolean(p) &&
    Array.isArray(p!.nullifiers) &&
    p!.nullifiers.length > 0 &&
    p!.nullifiers.every((n) => typeof n === "string" && /^[0-9a-f]{64}$/.test(n)) &&
    typeof p!.blockhash === "string" &&
    p!.blockhash.length > 0 &&
    (p!.signature === undefined || typeof p!.signature === "string") &&
    typeof p!.at === "number"
  );
}

export function pendingKey(network: string, owner: string): string {
  return `gloam:solana-rings:pending:v1:${network}:${owner}`;
}

/** The pending payment of one private account, sealed (lib/solanaRings/payrollStore runCipher). */
export function pendingStore(opts: {
  key: string;
  cipher: { seal(plain: string): Promise<string>; open(sealed: string): Promise<string> };
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}): PendingStore {
  const storage = opts.storage ?? globalThis.localStorage;
  return {
    async load() {
      const raw = storage.getItem(opts.key);
      if (!raw) return null;
      try {
        const v = JSON.parse(await opts.cipher.open(raw)) as unknown;
        return isPending(v) ? v : "unreadable";
      } catch {
        return "unreadable";
      }
    },
    async save(p) {
      const sealed = await opts.cipher.seal(JSON.stringify(p));
      storage.setItem(opts.key, sealed);
      if (storage.getItem(opts.key) !== sealed) throw new Error("The payment didn't save in this browser.");
    },
    async clear() {
      storage.removeItem(opts.key);
    },
  };
}
