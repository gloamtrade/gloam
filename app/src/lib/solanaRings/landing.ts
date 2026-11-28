/**
 * Landing a Solana transaction, and knowing for sure when it never will.
 * Pure rules with the chain passed in: the browser's wiring is in
 * lib/solanaRings/client, the relay's in app/api/solana/relay. Checked by
 * scripts/selftest-solana-rings.mts.
 *
 * An RPC can accept a send and the transaction can still never reach a
 * leader; Solana says nothing about it. So, as Helius recommends:
 *
 *  - The same signed transaction goes out again every REBROADCAST_MS until it
 *    is confirmed or its blockhash expires. It is the same transaction with the
 *    same signature, so it lands once at most and pays its fee once.
 *  - Every call is bounded, and so is the whole wait (LANDING_MAX_MS): a stalled
 *    request or a paused tab can't hold it forever.
 *  - "dropped" is said only once the blockhash has expired and the signature is
 *    still unseen on DROP_CHECKS reads made after that. From then it can never
 *    land, so building and sending it again is safe.
 *  - The priority fee follows Helius's recommended price (what its staked
 *    connections ask for), never below RELAY_PRIORITY_FEE_FLOOR and never over
 *    the relay's cap (lib/solanaRings/relayPolicy RELAY_LIMITS).
 */
import {
  decompileTransactionConfig,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionConfigMask,
  getTransactionConfigValues,
  getTransactionDecoder,
  type Transaction,
} from "@solana/kit";
import { RELAY_LIMITS } from "./relayPolicy";

/** How often the same signed transaction goes out again while it is unconfirmed (Helius: about every 2 seconds). */
export const REBROADCAST_MS = 2_000;
/** How often its status is read while waiting. */
export const LANDING_POLL_MS = 1_500;
/** How often its blockhash is checked while waiting. */
export const BLOCKHASH_CHECK_MS = 4_000;
/** Longest any one read may take before it counts as no answer. */
export const CALL_TIMEOUT_MS = 10_000;
/**
 * The longest a wait can last. A blockhash lasts 150 blocks (about a minute,
 * more when leaders skip slots), so this only ends a wait the chain could not
 * answer: the caller then says it can't tell yet, never that it was dropped.
 */
export const LANDING_MAX_MS = 150_000;
/** Unseen reads after the blockhash expired before it counts as dropped. */
export const DROP_CHECKS = 3;
/** The relay's own rebroadcast window, before it answers the page (which carries on). */
export const RELAY_WINDOW_MS = 6_000;
export const RELAY_POLL_MS = 1_000;
export const RELAY_CALL_TIMEOUT_MS = 4_000;

/** The least priority fee the relay pays on a transaction, in lamports (what it paid before fees followed Helius). */
export const RELAY_PRIORITY_FEE_FLOOR = 10_000n;
/** Headroom over Helius's recommended price, as its own sendSmartTransaction adds. */
const FEE_HEADROOM_PERCENT = 120n;
/** Compute units a registration asks for (client buildRegistration). */
export const REGISTER_COMPUTE_UNITS = 200_000;

/**
 * Tree 0 of the shielded pool: written by every private payment, so the
 * account Helius's fee estimate looks at (with the two programs). The SDK's
 * getTreeAddress(0); scripts/selftest-solana-rings.mts checks it.
 */
export const RINGS_TREE = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";

export type SigStatus = { seen: false } | { seen: true; failed: boolean; confirmed: boolean; slot: bigint };

export type Landing =
  | { state: "landed"; slot: bigint }
  /** It reached Solana and failed there: nothing it did happened. */
  | { state: "failed" }
  /** Its blockhash expired and it was never seen: it never landed and never will. */
  | { state: "dropped" }
  /** The chain didn't answer in time: it may still land. */
  | { state: "unknown" };

/** One getSignatureStatuses value as a SigStatus. */
export function sigStatusFrom(
  v: { err?: unknown; confirmationStatus?: string | null; confirmations?: number | null; slot?: number | bigint } | null | undefined
): SigStatus {
  if (!v) return { seen: false };
  const confirmed =
    v.confirmationStatus === "confirmed" ||
    v.confirmationStatus === "finalized" ||
    // an old node answers a rooted transaction with neither
    (v.confirmationStatus == null && v.confirmations === null);
  return { seen: true, failed: v.err !== null && v.err !== undefined, confirmed, slot: BigInt(v.slot ?? 0) };
}

type Clock = { sleep(ms: number): Promise<void>; now(): number };

/** `p`, or null when it rejects or takes longer than `ms`. */
async function bounded<T>(clock: Clock, p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.then((v) => v, () => null), clock.sleep(ms).then(() => null)]);
}

export type LandingDeps = Clock & {
  /** Where the transaction stands (getSignatureStatuses, searching history). */
  status(): Promise<SigStatus>;
  /** Whether its blockhash can still land it. Null when it isn't known: then it is never called dropped. */
  blockhashValid: (() => Promise<boolean>) | null;
  /** Send the same signed transaction again. Omitted when the page doesn't hold it (a wallet sent it). */
  rebroadcast?(): Promise<unknown>;
  /** Extra wait after the blockhash expired before "dropped" (a wallet that sent it itself). */
  graceMs?: number;
  maxMs?: number;
  callTimeoutMs?: number;
};

/** Wait for a sent transaction to land, fail, or be dropped for good. Never waits past maxMs. */
export async function awaitLanding(deps: LandingDeps): Promise<Landing> {
  const start = deps.now();
  const maxMs = deps.maxMs ?? LANDING_MAX_MS;
  const callMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  let lastSend = start;
  let lastCheck = -Infinity;
  let expiredAt: number | null = null;
  let unseenAfterExpiry = 0;
  for (;;) {
    // the blockhash first, so a status read after it counts as read after expiry
    const t = deps.now();
    if (expiredAt === null && deps.blockhashValid && t - lastCheck >= BLOCKHASH_CHECK_MS) {
      lastCheck = t;
      if ((await bounded(deps, deps.blockhashValid(), callMs)) === false) expiredAt = deps.now();
    }
    const counts = expiredAt !== null;
    const st = await bounded(deps, deps.status(), callMs);
    if (st?.seen) {
      if (st.failed) return { state: "failed" };
      if (st.confirmed) return { state: "landed", slot: st.slot };
      unseenAfterExpiry = 0; // processed: it may still confirm
    } else if (st && counts) {
      unseenAfterExpiry++;
    }
    const now = deps.now();
    if (expiredAt !== null && unseenAfterExpiry >= DROP_CHECKS && now - expiredAt >= (deps.graceMs ?? 0)) return { state: "dropped" };
    if (now - start >= maxMs) return { state: "unknown" };
    if (deps.rebroadcast && expiredAt === null && now - lastSend >= REBROADCAST_MS) {
      lastSend = now;
      await bounded(deps, deps.rebroadcast(), callMs);
    }
    await deps.sleep(LANDING_POLL_MS);
  }
}

export type BroadcastDeps = Clock & {
  /** Send the signed transaction once. Resolves when the RPC took it, rejects when it didn't. */
  send(): Promise<unknown>;
  status(): Promise<SigStatus>;
};

export type Broadcast = { accepted: boolean; seen: boolean; sends: number };

/**
 * The relay's first sends: once, then again every REBROADCAST_MS until Solana
 * has seen it or `windowMs` passes. The page keeps rebroadcasting after that
 * (awaitLanding). `accepted`: some send was taken, or it was seen; when none
 * was, the relay says so instead of handing back a signature.
 */
export async function relayBroadcast(deps: BroadcastDeps, windowMs = RELAY_WINDOW_MS): Promise<Broadcast> {
  const start = deps.now();
  let accepted = false;
  let sends = 0;
  let lastSend = start;
  const sendOnce = async () => {
    sends++;
    if ((await bounded(deps, deps.send().then(() => true), RELAY_CALL_TIMEOUT_MS)) === true) accepted = true;
  };
  await sendOnce();
  for (;;) {
    await deps.sleep(RELAY_POLL_MS);
    const st = await bounded(deps, deps.status(), RELAY_CALL_TIMEOUT_MS);
    if (st?.seen) return { accepted: true, seen: true, sends };
    const now = deps.now();
    if (now - start >= windowMs) return { accepted, seen: false, sends };
    if (now - lastSend >= REBROADCAST_MS) {
      lastSend = now;
      await sendOnce();
    }
  }
}

/**
 * Build with `build`, send and wait with `sendAndWait`, and once (only once)
 * build and send again if it was dropped. `build` returning null means there
 * is nothing to do (a registration that is already there). With `recheck`, a
 * second drop builds once more only to ask that, never to send a third time.
 */
export async function landWithOneResend<B>(deps: {
  build(): Promise<B | null>;
  sendAndWait(built: B): Promise<Landing>;
  onResend?(): void;
  recheck?: boolean;
}): Promise<Landing | { state: "done" }> {
  for (let attempt = 0; ; attempt++) {
    const built = await deps.build();
    if (built === null) return { state: "done" };
    if (attempt === 2) return { state: "dropped" };
    if (attempt === 1) deps.onResend?.();
    const r = await deps.sendAndWait(built);
    if (r.state !== "dropped") return r;
    if (attempt === 1 && !deps.recheck) return r;
  }
}

/**
 * The priority fee for a transaction of `computeUnits`, in lamports: Helius's
 * recommended price per compute unit (micro-lamports) with headroom, never
 * below the floor, never over the relay's cap.
 */
export function priorityFeeFor(microLamportsPerCu: number | null | undefined, computeUnits: number, cap: bigint = RELAY_LIMITS.maxPriorityFeeLamports): bigint {
  let fee = RELAY_PRIORITY_FEE_FLOOR;
  if (typeof microLamportsPerCu === "number" && Number.isFinite(microLamportsPerCu) && microLamportsPerCu > 0 && computeUnits > 0) {
    const micro = (BigInt(Math.ceil(microLamportsPerCu)) * BigInt(Math.floor(computeUnits)) * FEE_HEADROOM_PERCENT) / 100n;
    const lamports = (micro + 999_999n) / 1_000_000n;
    if (lamports > fee) fee = lamports;
  }
  return fee > cap ? cap : fee;
}

/**
 * The compute unit price (micro-lamports) for a version 0 transaction of
 * `units` the relay pays for (a wallet's add, client buildAddTransaction): the
 * fee priorityFeeFor sets, as a per-unit price rounded down, so the fee Solana
 * charges (price times units, rounded up) never passes it or the relay's cap.
 */
export function relayUnitPrice(microLamportsPerCu: number | null | undefined, units: number, cap: bigint = RELAY_LIMITS.maxPriorityFeeLamports): bigint {
  const u = BigInt(Math.max(1, Math.floor(units)));
  return (priorityFeeFor(microLamportsPerCu, units, cap) * 1_000_000n) / u;
}

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * A version 0 or legacy transaction's whole fee in lamports: 5,000 a
 * signature and its priority fee (its ComputeBudget unit price times its unit
 * limit, rounded up; priced at 1,400,000 units when it sets no limit). Null
 * when it can't be read or is version 1 (whose fee is in its header).
 */
export function feeLamportsOfWire(wire: Uint8Array): bigint | null {
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(wire).messageBytes) as {
      version: unknown;
      header: { numSignerAccounts: number };
      staticAccounts: readonly string[];
      instructions: readonly { programAddressIndex: number; data?: Uint8Array }[];
    };
    if (compiled.version === 1) return null;
    let units: bigint | null = null;
    let price = 0n;
    for (const ix of compiled.instructions) {
      const d = ix.data;
      if (compiled.staticAccounts[ix.programAddressIndex] !== COMPUTE_BUDGET || !d) continue;
      const value = (bytes: Uint8Array) => bytes.reduceRight((v, b) => (v << 8n) | BigInt(b), 0n);
      if (d[0] === 2 && d.length === 5) units = value(d.subarray(1));
      if (d[0] === 3 && d.length === 9) price = value(d.subarray(1));
    }
    const priority = (price * (units ?? BigInt(RELAY_LIMITS.maxComputeUnits)) + 999_999n) / 1_000_000n;
    return BigInt(compiled.header.numSignerAccounts) * LAMPORTS_PER_SIGNATURE + priority;
  } catch {
    return null;
  }
}

/** A version 1 transaction's compute unit limit (its header config), or null. */
export function computeUnitsOf(messageBytes: Transaction["messageBytes"] | Uint8Array): number | null {
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes) as { version: unknown; configMask?: number; configValues?: never };
  if (compiled.version !== 1 || compiled.configMask === undefined) return null;
  return decompileTransactionConfig(compiled.configMask, compiled.configValues!).computeUnitLimit ?? null;
}

/**
 * `tx` (version 1, not signed yet) with its priority fee set to `fee`. Only
 * the header's config changes: the accounts, the instructions and the
 * blockhash stay as built.
 */
export function withPriorityFee<T extends Transaction>(tx: T, fee: bigint): T {
  if (Object.values(tx.signatures).some((s) => s && (s as Uint8Array).some((b) => b !== 0))) {
    throw new Error("The priority fee is set before anyone signs.");
  }
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (compiled.version !== 1) throw new Error("Only a version 1 transaction carries its priority fee in its header.");
  const config = { ...decompileTransactionConfig(compiled.configMask, compiled.configValues), priorityFeeLamports: fee };
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...compiled,
    configMask: getTransactionConfigMask(config),
    configValues: getTransactionConfigValues(config),
  } as never);
  return { ...tx, messageBytes } as T;
}

/** The blockhash a serialized message or transaction lives by. */
export function blockhashOfMessage(messageBytes: Transaction["messageBytes"] | Uint8Array): string | null {
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes) as { lifetimeToken?: string };
  return compiled.lifetimeToken ?? null;
}

export function blockhashOfWire(wire: Uint8Array): string | null {
  try {
    return blockhashOfMessage(getTransactionDecoder().decode(wire).messageBytes);
  } catch {
    return null;
  }
}

/** A transaction's signature: its fee payer's, the first. Null when that slot is empty. */
export function signatureOfWire(wire: Uint8Array): string | null {
  try {
    const tx = getTransactionDecoder().decode(wire);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const payer = (compiled.staticAccounts as readonly string[])[0];
    const sig = payer ? (tx.signatures as Record<string, Uint8Array | null>)[payer] : null;
    return sig && sig.some((b) => b !== 0) ? getBase58Decoder().decode(sig) : null;
  } catch {
    return null;
  }
}
