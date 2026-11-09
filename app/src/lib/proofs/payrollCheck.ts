/**
 * Checking a payroll total proof, kept free of app wiring (network clients,
 * artifacts, demo switch) so node tests can run it with real snarks and a
 * pretend chain. verify.ts and lib/proofsServer pass the real dependencies.
 *
 * What a pass means, check by check:
 *   0. the proof is within size (at most PAYROLL_MAX_PARTS parts and
 *      PAYROLL_MAX_PAYMENTS_TOTAL payments), before any math or network work
 *   1. every part's Groth16 proof holds against the payroll_total key
 *   2. every part was sealed for this label, expiry, chain and vault
 *   3. the vault is Gloam's own on that chain
 *   4. the plain total, count and payment list are exactly what was proven
 *      (each part's list rehashes to its paymentsHash signal)
 *   5. no payment appears twice, across all parts
 *   6. every payment is the first output of a private transfer in that vault
 *      whose spend marker is the one proven: a payment out of a note the prover
 *      spent, not a deposit, a trade, change, or someone else's payment to them
 *   7. when the first and last payment landed
 *   8. not expired
 * Checks 6 and 7 read the chain, so they only run when 1 to 5 all passed and
 * the proof has not expired. Payments are looked up a group at a time, and the
 * lookups stop at the first group with a payment that is not found as it should
 * be: the answer is already "not confirmed" then, and the rest would not change it.
 *
 * What it does not show: who was paid. A payment to yourself, or to a second
 * wallet, looks the same as one to someone else, so the claim is "a run of N
 * payments adding up to X, funded by the prover", never "N people".
 */
import {
  FIELD_PRIME,
  PAYROLL_PROOF_SLOTS,
  payrollPaymentsHash,
  proofContext,
  readPayrollSignals,
} from "@gloamtrade/sdk";
import type { Hex } from "viem";
import { displayLabel, isPlainLabel } from "./label";
import {
  PAYROLL_MAX_PARTS,
  PAYROLL_MAX_PAYMENTS_TOTAL,
  type CheckState,
  type PayrollPayment,
  type PayrollProof,
  type PayrollProofPart,
  type VerifyResult,
} from "./types";

/**
 * How one payment was found on chain. A found payment carries when it landed,
 * or the block it landed in (then only the first and last block are timed).
 */
export type PaymentLookup =
  | { state: "found"; txHash: Hex; paidAt: number; block?: undefined }
  | { state: "found"; txHash: Hex; block: bigint; paidAt?: undefined }
  /** The note exists, but a deposit or a private trade made it, not a payment. */
  | { state: "wrong-origin"; origin: "deposit" | "trade" }
  /** The transfer exists, but this note is its change, which went back to the sender. */
  | { state: "change" }
  /** The named transaction does not pair this note with this spend marker. */
  | { state: "mismatch" }
  /** The named transaction is not on this network. */
  | { state: "no-tx" }
  /** No transaction named, and the payment is older than the bounded scan. */
  | { state: "not-found" }
  /** Not looked up: the check already made the most chain reads one check makes. */
  | { state: "over-limit" };

/** A decoded pool event, as viem's parseEventLogs returns it. */
export type PoolEventLog = { eventName: string; address: string; args: Record<string, unknown> };

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

/**
 * What a successful transaction's pool events say about one payroll payment:
 * it must hold Transferred(nullifier, [commitment, change]) from this pool.
 */
export function classifyPaymentLogs(
  logs: readonly PoolEventLog[],
  pool: string,
  commitment: string,
  nullifier: string
): "found" | "change" | "deposit" | "trade" | "mismatch" {
  const c = commitment.toLowerCase();
  const n = nullifier.toLowerCase();
  const ours = logs.filter((l) => lower(l.address) === pool.toLowerCase());
  for (const l of ours) {
    if (l.eventName !== "Transferred" || lower(l.args.nullifier) !== n) continue;
    const out = Array.isArray(l.args.newCommitments) ? l.args.newCommitments.map(lower) : [];
    if (out[0] === c) return "found";
    if (out[1] === c) return "change";
  }
  for (const l of ours) {
    if (l.eventName === "Shielded" && lower(l.args.commitment) === c) return "deposit";
    if (l.eventName === "SealedSwapped" && (lower(l.args.newCommitmentOut) === c || lower(l.args.newCommitmentChange) === c)) {
      return "trade";
    }
  }
  return "mismatch";
}

export type PayrollCheckDeps = {
  /** Groth16 check of one part against the payroll_total key. */
  verifySnark: (part: PayrollProofPart) => Promise<boolean>;
  /** Gloam's network for the proof's chain, when the proof's vault is Gloam's own; else null. */
  vault: { label: string } | null;
  /** Looks one payment up on chain; throws when the network cannot be reached. */
  findPayment?: (pay: PayrollPayment) => Promise<PaymentLookup>;
  /**
   * Looks a group of payments up together (lib/proofs/chain: receipts, and one
   * log query per block range for the ones that name no transaction). An entry
   * left undefined was not looked up. Throws when the network cannot be reached.
   * Used instead of findPayment when given.
   */
  findPayments?: (pays: PayrollPayment[]) => Promise<(PaymentLookup | undefined)[]>;
  /** When a block landed (unix seconds), for lookups that name a block instead of a time. */
  blockTime?: (block: bigint) => Promise<number>;
  /** Unix seconds, for expiry. */
  now: number;
  /** How a time reads on the page. */
  when: (unix: number) => string;
};

const LOOKUP_PARALLEL = 6;
/** Payments looked up together: one part's worth. */
const LOOKUP_GROUP = 32;

function sameHex(a: unknown, b: bigint): boolean {
  try {
    return typeof a === "string" && BigInt(a) === b;
  } catch {
    return false;
  }
}

/** A 0x field element below p, or null. */
function fieldOf(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return null;
  const x = BigInt(v);
  return x < FIELD_PRIME ? x : null;
}

function signalsOf(part: PayrollProofPart): ReturnType<typeof readPayrollSignals> | null {
  const s = part?.publicSignals;
  if (!Array.isArray(s) || !s.every((x) => typeof x === "string" && /^\d{1,78}$/.test(x) && BigInt(x) < FIELD_PRIME)) {
    return null;
  }
  try {
    return readPayrollSignals(s);
  } catch {
    return null;
  }
}

type Looked = PaymentLookup | null;

/** Anything but a plain find ends the lookups: the result can no longer be a pass. */
const settled = (r: Looked) => r?.state !== "found";

/**
 * Looks the payments up in order, a group at a time, and stops after the first
 * group holding a payment that was not found as it should be (or could not be
 * read). null is a lookup the network did not answer.
 */
async function lookUp(payments: PayrollPayment[], deps: PayrollCheckDeps): Promise<Looked[]> {
  const out: Looked[] = [];
  for (let i = 0; i < payments.length; i += LOOKUP_GROUP) {
    const group = payments.slice(i, i + LOOKUP_GROUP);
    let got: Looked[];
    if (deps.findPayments) {
      try {
        got = (await deps.findPayments(group)).filter((r): r is PaymentLookup => r !== undefined);
      } catch {
        got = [null];
      }
    } else {
      got = [];
      for (let j = 0; j < group.length; j += LOOKUP_PARALLEL) {
        const batch = await Promise.all(group.slice(j, j + LOOKUP_PARALLEL).map((x) => deps.findPayment!(x).catch(() => null)));
        got.push(...batch);
        if (batch.some(settled)) break;
      }
    }
    out.push(...got);
    if (got.length < group.length || got.some(settled)) break;
  }
  return out;
}

/** When the first and last payment landed, reading at most two block times. */
async function paidSpan(found: Extract<PaymentLookup, { state: "found" }>[], deps: PayrollCheckDeps): Promise<[number, number]> {
  const times = found.flatMap((r) => (r.paidAt !== undefined ? [r.paidAt] : []));
  const blocks = found.flatMap((r) => (r.block !== undefined ? [r.block] : []));
  if (blocks.length) {
    if (!deps.blockTime) throw new Error("no block clock");
    let lo = blocks[0]!;
    let hi = blocks[0]!;
    for (const b of blocks) {
      if (b < lo) lo = b;
      if (b > hi) hi = b;
    }
    times.push(await deps.blockTime(lo));
    if (hi !== lo) times.push(await deps.blockTime(hi));
  }
  return [Math.min(...times), Math.max(...times)];
}

export async function checkPayrollProof(p: PayrollProof, deps: PayrollCheckDeps): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];
  const add = (label: string, state: CheckState, detail?: string) => checks.push({ label, state, detail });
  const expired = !(Number.isSafeInteger(p.expiresAt) && deps.now <= p.expiresAt);
  let paidBetween: [number, number] | undefined;
  const finish = (): VerifyResult => ({
    ok: !expired && checks.length > 0 && checks.every((c) => c.state === "pass"),
    kind: "payroll",
    checks,
    paidBetween,
    expired,
  });
  const expiry = () => add(expired ? "Expired" : "Not expired", expired ? "fail" : "pass", `Valid until ${deps.when(p.expiresAt)}.`);

  // 0) Size first: nothing below runs on a proof bigger than a real run.
  const parts = Array.isArray(p.parts) ? p.parts : [];
  const listed = Array.isArray(p.payments) ? p.payments : [];
  if (parts.length > PAYROLL_MAX_PARTS || listed.length > PAYROLL_MAX_PAYMENTS_TOTAL) {
    add("The proof checks out", "fail", `A payroll proof covers at most ${PAYROLL_MAX_PAYMENTS_TOTAL} payments.`);
    return finish();
  }
  const signals = parts.map(signalsOf);
  if (parts.length === 0 || signals.some((s) => s === null)) {
    add("The proof checks out", "fail", "This proof is damaged or incomplete.");
    return finish();
  }
  const sig = signals as NonNullable<(typeof signals)[number]>[];

  // 1) The zero-knowledge proofs, one per part.
  const valid = (await Promise.all(parts.map((part) => deps.verifySnark(part).catch(() => false)))).every(Boolean);
  add(
    "The proof checks out",
    valid ? "pass" : "fail",
    valid
      ? parts.length === 1
        ? "Verified with Gloam's zero-knowledge checking key."
        : `All ${parts.length} parts verified with Gloam's zero-knowledge checking key.`
      : "The math does not hold. It was edited or made for a different circuit."
  );

  // 2) Who it was made for (label, expiry, chain, vault are sealed into each part's context).
  let sealed = false;
  try {
    const context = proofContext({
      kind: "payroll",
      chainId: p.chainId,
      pool: p.pool,
      verifier: p.verifier,
      expiresAt: p.expiresAt,
    });
    sealed = typeof p.verifier === "string" && sig.every((s) => s.context === context);
  } catch {
    sealed = false;
  }
  add(
    `Made for "${displayLabel(p.verifier)}"`,
    sealed ? "pass" : "fail",
    sealed
      ? isPlainLabel(p.verifier)
        ? "The name, expiry and network are sealed into the proof."
        : "The name, expiry and network are sealed into the proof. Hidden characters in the name are not shown."
      : "The name, expiry or network was changed after the proof was made."
  );

  // 3) Gloam's own vault, or the chain checks below mean nothing.
  add(
    deps.vault ? `Made on Gloam's vault on ${deps.vault.label}` : "Made on Gloam's vault",
    deps.vault ? "pass" : "fail",
    deps.vault ? undefined : "The vault address is not Gloam's current vault, so its payments cannot be trusted."
  );

  // 4) The plain total, count and list are exactly what the parts prove.
  const payments = listed;
  const pairs = payments.map((x) => ({ commitment: fieldOf(x?.commitment), nullifier: fieldOf(x?.nullifier) }));
  const listOk = pairs.every((x) => x.commitment !== null && x.commitment !== 0n && x.nullifier !== null && x.nullifier !== 0n);
  let fieldsMatch =
    listOk &&
    Number.isSafeInteger(p.count) &&
    p.count === payments.length &&
    /^\d+$/.test(String(p.total)) &&
    sig.every((s) => sameHex(p.asset, s.asset) && s.count >= 1n && s.count <= BigInt(PAYROLL_PROOF_SLOTS)) &&
    sig.reduce((n, s) => n + s.count, 0n) === BigInt(payments.length) &&
    sig.reduce((t, s) => t + s.total, 0n) === BigInt(String(p.total || "0")) &&
    BigInt(String(p.total || "0")) > 0n;
  if (fieldsMatch) {
    let offset = 0;
    for (const s of sig) {
      const slice = pairs.slice(offset, offset + Number(s.count)) as { commitment: bigint; nullifier: bigint }[];
      offset += Number(s.count);
      if ((await payrollPaymentsHash(slice)) !== s.paymentsHash) {
        fieldsMatch = false;
        break;
      }
    }
  }
  add(
    "Total and count match the proof",
    fieldsMatch ? "pass" : "fail",
    fieldsMatch ? undefined : "The total, the number of payments or the list of payments was changed after the proof was made."
  );

  // 5) No payment counted twice, across parts too (each part only sees its own).
  const cs = new Set(pairs.map((x) => x.commitment));
  const ns = new Set(pairs.map((x) => x.nullifier));
  const distinct = listOk && cs.size === pairs.length && ns.size === pairs.length;
  add(
    "No payment counted twice",
    distinct ? "pass" : "fail",
    distinct
      ? `${payments.length} separate ${payments.length === 1 ? "payment" : "payments"}.`
      : "The same payment is listed more than once."
  );

  // The chain is only read for a proof that holds so far.
  if (!valid || !sealed || !deps.vault || !fieldsMatch || !distinct) {
    expiry();
    return finish();
  }
  // An expired proof is never ok, so nothing it lists is looked up.
  if (expired) {
    add("Each one is a private payment in the vault", "unknown", "Not looked up, because this proof has expired.");
    expiry();
    return finish();
  }

  // 6) Every payment is a private payment out of a note the prover spent, in that vault.
  const looked = await lookUp(payments, deps);
  const offline = looked.some((r) => r === null);
  const bad = looked.find((r) => r && r.state !== "found" && r.state !== "not-found" && r.state !== "over-limit");
  const missing = looked.some((r) => r?.state === "not-found");
  const capped = looked.some((r) => r?.state === "over-limit");
  let span: [number, number] | null = null;
  let spanUnread = false;
  const allFound = !offline && looked.length === payments.length && looked.every((r) => r?.state === "found");
  if (allFound) {
    try {
      span = await paidSpan(looked as Extract<PaymentLookup, { state: "found" }>[], deps);
    } catch {
      spanUnread = true;
    }
  }
  if (bad) {
    add(
      "Each one is a private payment in the vault",
      "fail",
      bad.state === "wrong-origin"
        ? bad.origin === "deposit"
          ? "One of these is a deposit into the vault, not a payment."
          : "One of these came out of a private trade, not a payment."
        : bad.state === "change"
          ? "One of these is change that went back to the sender, not a payment."
          : bad.state === "no-tx"
            ? "A transaction named in the proof is not on this network."
            : "A transaction named in the proof did not make that payment."
    );
  } else if (offline || capped || missing || !allFound) {
    add(
      "Each one is a private payment in the vault",
      "unknown",
      offline
        ? "Could not reach the network to find every payment. Try again."
        : capped
          ? "Could not finish: this proof needs more network reads than one check makes."
          : "Can't confirm every payment: at least one is older than the blocks this check reads, and the proof does not name its transaction."
    );
  } else {
    add(
      "Each one is a private payment in the vault",
      "pass",
      "Each was paid privately inside the vault, from a note the prover spent."
    );
    // 7) When they landed.
    if (span) {
      const [first, last] = span;
      paidBetween = [first, last];
      add(
        "When the payments landed",
        "pass",
        last - first < 60 ? `${deps.when(first)}.` : `Between ${deps.when(first)} and ${deps.when(last)}.`
      );
    } else if (spanUnread) {
      add("When the payments landed", "unknown", "Could not read when they landed. Try again.");
    }
  }

  // 8) Expiry.
  expiry();
  return finish();
}
