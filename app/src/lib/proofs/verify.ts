/**
 * Checking a proof of funds, payment, exact balance or payroll total, the way the /verify page
 * shows it: one plain-language line per check, in order. Nothing here trusts the proof's plain
 * fields on their own; each is matched against the proof's public signals, and
 * the signals against the snark, the context and the chain.
 *
 * `ok` means every check passed and the proof has not expired. A check that
 * could not finish ("unknown": the network did not answer, or a payment's
 * transaction could not be found) is never a pass.
 *
 * Cheap checks come first: the chain is only read for a proof whose math,
 * label and fields already hold, so a junk proof costs no network calls.
 *
 * What a proof of payment shows: a private send in Gloam's vault paid at least
 * this much into a note, and whoever made the proof knows that note's key. The
 * payer picks the payee note's key, so the payer can make the same proof, and a
 * send to yourself looks the same as one to someone else. It never shows that
 * a third party paid the holder.
 *
 * What an exact balance shows: one note of exactly this amount is in the vault
 * and whoever made the proof knows its key. Not that it is still unspent.
 */
import { ceremonyForChain, networkName } from "@/lib/networks";
import { FIELD_PRIME, fieldToHex, proofContext, readFundsSignals, readReceiptSignals } from "@gloamtrade/sdk";
import type { Hex } from "viem";
import { demoHolderChecks, isDemoProof } from "@/lib/demo/proof";
import { verificationKey } from "./artifacts";
import {
  clientFor,
  commitmentSeen,
  findNoteTx,
  isKnownRoot,
  isSpent,
  networkForChain,
  payrollLookups,
  type NoteTx,
} from "./chain";
import { displayLabel, isPlainLabel } from "./label";
import { checkPayrollProof, type PaymentLookup } from "./payrollCheck";
import type { AnyProof, BalanceProof, CheckState, FundsProof, PaymentProof, PayrollProof, VerifyResult } from "./types";

/** The check that ties a proof of payment to the send that made its note. */
export const PAID_BY_SEND = "Made by a private payment";

type Check = VerifyResult["checks"][number];

/** What checking a proof of funds, payment or balance needs from its host (browser page or server). */
export type HolderCheckDeps = {
  /** Groth16 check of the signals against the funds or receipt key of the proof's network's key set. */
  verifySnark: (circuit: "funds" | "receipt", signals: string[], proof: unknown, chainId: number) => Promise<boolean>;
  /** How a time reads in the result. */
  when?: (unix: number) => string;
};

function localWhen(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function sameHex(a: string, b: bigint): boolean {
  try {
    return BigInt(a) === b;
  } catch {
    return false;
  }
}

/** Signals as field elements, or null when any is not a canonical decimal below p. */
function fieldSignals(signals: unknown): string[] | null {
  if (!Array.isArray(signals)) return null;
  for (const s of signals) {
    if (typeof s !== "string" || !/^\d{1,78}$/.test(s) || BigInt(s) >= FIELD_PRIME) return null;
  }
  return signals as string[];
}

/** A result is ok only when every check passed and the proof has not expired. */
export function allPassed(checks: readonly Check[], expired: boolean): boolean {
  return !expired && checks.length > 0 && checks.every((c) => c.state === "pass");
}

/** The browser's snark check: the hash-pinned checking keys from /circuits. */
async function browserSnark(circuit: "funds" | "receipt", signals: string[], proof: unknown, chainId: number): Promise<boolean> {
  try {
    const snarkjs = await import("snarkjs");
    return await snarkjs.groth16.verify(await verificationKey(circuit, ceremonyForChain(chainId)), signals, proof);
  } catch {
    return false;
  }
}

/**
 * A payroll total: the checks live in ./payrollCheck; this wires the snark key,
 * the proof's own network and the demo stand-ins (a demo tab accepts only demo
 * proofs this device made, like the other proofs).
 */
async function verifyPayroll(p: PayrollProof): Promise<VerifyResult> {
  const parts = Array.isArray(p.parts) ? p.parts : [];
  const demo = parts.length > 0 && parts.every((x) => isDemoProof(x?.proof));
  const net = networkForChain(p.chainId);
  const official = Boolean(net?.pool && typeof p.pool === "string" && net.pool.toLowerCase() === p.pool.toLowerCase());

  let lookups: Pick<Parameters<typeof checkPayrollProof>[1], "findPayment" | "findPayments" | "blockTime">;
  if (demo) {
    // The run finished about two hours ago, a few seconds per payment.
    await demoHolderChecks();
    const start = Math.floor(Date.now() / 1000) - 2 * 3600;
    const index = new Map(p.payments.map((x, i) => [x.commitment, i]));
    lookups = {
      findPayment: async (x): Promise<PaymentLookup> => ({
        state: "found",
        txHash: (x.txHash ?? x.commitment) as Hex,
        paidAt: start + (index.get(x.commitment) ?? 0) * 9,
      }),
    };
  } else if (official && net) {
    const l = payrollLookups(clientFor(net), net, net.pool!);
    lookups = { findPayments: l.find, blockTime: l.blockTime };
  } else {
    // not Gloam's vault: the check fails before any lookup
    lookups = { findPayment: async () => ({ state: "not-found" }) };
  }

  return checkPayrollProof(p, {
    verifySnark: async (part) => {
      if (demo) return true;
      const snarkjs = await import("snarkjs");
      return snarkjs.groth16.verify(await verificationKey("payroll", ceremonyForChain(p.chainId)), part.publicSignals, part.proof);
    },
    vault: official && net ? { label: networkName(net) } : null,
    ...lookups,
    now: Math.floor(Date.now() / 1000),
    when: localWhen,
  });
}

/** Every check the /verify page runs, in the browser. */
export async function verifyProof(p: AnyProof): Promise<VerifyResult> {
  if (p.kind === "payroll") return verifyPayroll(p);
  return checkHolderProof(p, { verifySnark: browserSnark });
}

/** What the origin lookup of a payment note means for the reader. */
function paidCheck(tx: NoteTx | null, netLabel: string, when: (unix: number) => string): { state: CheckState; detail: string; paidAt?: number } {
  if (tx == null) return { state: "unknown", detail: `Can't confirm this payment: could not reach ${netLabel}. Try again.` };
  switch (tx.state) {
    case "found":
      switch (tx.origin) {
        case "payment":
          return { state: "pass", detail: `${when(tx.paidAt)}. The payment side of a private send.`, paidAt: tx.paidAt };
        case "change":
          return { state: "fail", detail: "This note is the change a sender kept from their own send, not a payment." };
        case "deposit":
          return { state: "fail", detail: "This note came from a deposit into the vault, not a payment." };
        case "trade":
          return { state: "fail", detail: "This note came out of a private trade, not a payment." };
      }
      break;
    case "mismatch":
      return { state: "fail", detail: "The transaction named in the proof did not make this payment." };
    case "no-tx":
      return { state: "fail", detail: `The transaction named in the proof is not on ${netLabel}.` };
    case "not-found":
      return {
        state: "unknown",
        detail:
          "Can't confirm this payment. It is older than the blocks this check reads, and the proof does not name its transaction. Ask for a new proof.",
      };
  }
  return { state: "unknown", detail: "Can't confirm this payment." };
}

/**
 * A proof of funds, payment or exact balance, with the snark check supplied by the host:
 * the page uses the hash-pinned keys from /circuits, the server its bundled
 * copies (lib/proofsServer).
 */
export async function checkHolderProof(
  p: FundsProof | PaymentProof | BalanceProof,
  deps: HolderCheckDeps
): Promise<VerifyResult> {
  const when = deps.when ?? localWhen;
  const checks: Check[] = [];
  const add = (label: string, state: CheckState, detail?: string) => checks.push({ label, state, detail });
  const expired = !(Number.isSafeInteger(p.expiresAt) && Math.floor(Date.now() / 1000) <= p.expiresAt);
  const finish = (paidAt?: number): VerifyResult => ({
    ok: allPassed(checks, expired),
    kind: p.kind,
    checks,
    paidAt,
    expired,
  });
  const expiry = () => add(expired ? "Expired" : "Not expired", expired ? "fail" : "pass", `Valid until ${when(p.expiresAt)}.`);

  const signals = fieldSignals(p.publicSignals);
  let funds: ReturnType<typeof readFundsSignals> | null = null;
  let receipt: ReturnType<typeof readReceiptSignals> | null = null;
  try {
    if (signals && p.kind === "funds") funds = readFundsSignals(signals);
    if (signals && (p.kind === "payment" || p.kind === "balance")) receipt = readReceiptSignals(signals);
  } catch {
    /* wrong signal count: reported below */
  }
  if (!signals || (!funds && !receipt)) {
    add("The proof checks out", "fail", "This proof is damaged or incomplete.");
    return finish();
  }
  const context = (funds ?? receipt)!.context;
  const demo = isDemoProof(p.proof);

  // 1) The zero-knowledge proof itself.
  const valid = demo ? true : await deps.verifySnark(funds ? "funds" : "receipt", signals, p.proof, Number(p.chainId)).catch(() => false);
  add(
    "The proof checks out",
    valid ? "pass" : "fail",
    valid ? "Verified with Gloam's zero-knowledge checking key." : "The math does not hold. It was edited or made for a different circuit."
  );

  // 2) Who it was made for (label, expiry, chain, pool are sealed into `context`).
  let sealed = false;
  try {
    sealed =
      typeof p.verifier === "string" &&
      proofContext({ kind: p.kind, chainId: p.chainId, pool: p.pool, verifier: p.verifier, expiresAt: p.expiresAt }) ===
        context;
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

  // 3) The vault it points at must be Gloam's own, or every chain check below is meaningless.
  const net = networkForChain(p.chainId);
  const official = Boolean(net?.pool && typeof p.pool === "string" && net.pool.toLowerCase() === p.pool.toLowerCase());
  add(
    // the testnet says so: a proof made with test funds never reads as mainnet
    official ? `Made on Gloam's vault on ${networkName(net!)}` : "Made on Gloam's vault",
    official ? "pass" : "fail",
    official ? undefined : "The vault address is not Gloam's current vault, so its balances cannot be trusted."
  );

  // 4) The plain fields shown to the reader match what the proof says.
  const fieldsMatch =
    p.kind === "funds"
      ? fundsFieldsMatch(p, funds!)
      : p.kind === "balance"
        ? balanceFieldsMatch(p, receipt!)
        : paymentFieldsMatch(p, receipt!);
  add(
    "Asset and amount match the proof",
    fieldsMatch ? "pass" : "fail",
    fieldsMatch ? undefined : "The asset or amount shown was changed after the proof was made."
  );

  // The chain is only read for a proof that holds so far.
  if (!valid || !sealed || !official || !fieldsMatch || !net?.pool) {
    expiry();
    return finish();
  }

  // 5) Chain checks, against the network the proof names.
  let paidAt: number | undefined;
  if (demo) {
    ({ paidAt } = await demoHolderChecks());
    add("Matches a real vault state", "pass");
    if (funds) {
      add("No balance counted twice", "pass");
      add("Balance is still unspent", "pass", "None of the backing notes has moved since.");
    } else if (p.kind === "balance") {
      add("Balance is in the vault", "pass");
    } else {
      add("Payment is in the vault", "pass");
      add(PAID_BY_SEND, "pass", `${when(paidAt)}. The payment side of a private send.`);
    }
  } else if (funds) {
    const used = funds.nullifiers.filter((n) => n !== 0n);
    const distinct = new Set(used).size === used.length;
    if (!distinct) {
      add("No balance counted twice", "fail", "The same note was counted more than once.");
      expiry();
      return finish();
    }
    const client = clientFor(net);
    const pool = net.pool;
    const offline = `Could not reach ${net.label}. Try again.`;
    const rootKnown = await isKnownRoot(client, pool, fieldToHex(funds.root)).catch(() => null);
    add(
      "Matches a real vault state",
      rootKnown == null ? "unknown" : rootKnown ? "pass" : "fail",
      rootKnown == null ? offline : rootKnown ? undefined : "The vault never had the state this proof was made against."
    );
    add("No balance counted twice", "pass", `Backed by ${used.length} separate ${used.length === 1 ? "note" : "notes"}.`);
    const spent = await Promise.all(used.map((n) => isSpent(client, pool, fieldToHex(n)))).catch(() => null);
    const anySpent = spent?.some(Boolean);
    add(
      "Balance is still unspent",
      spent == null ? "unknown" : anySpent ? "fail" : "pass",
      spent == null
        ? offline
        : anySpent
          ? "Some of this balance has moved since the proof was made."
          : "None of the backing notes has moved since."
    );
  } else if (p.kind === "balance") {
    const client = clientFor(net);
    const pool = net.pool;
    const offline = `Could not reach ${net.label}. Try again.`;
    const rootKnown = await isKnownRoot(client, pool, fieldToHex(receipt!.root)).catch(() => null);
    add(
      "Matches a real vault state",
      rootKnown == null ? "unknown" : rootKnown ? "pass" : "fail",
      rootKnown == null ? offline : rootKnown ? undefined : "The vault never had the state this proof was made against."
    );
    const seen = await commitmentSeen(client, pool, fieldToHex(receipt!.commitment)).catch(() => null);
    add(
      "Balance is in the vault",
      seen == null ? "unknown" : seen ? "pass" : "fail",
      seen == null ? offline : seen ? undefined : "The vault has no record of this balance."
    );
  } else {
    const client = clientFor(net);
    const pool = net.pool;
    const offline = `Could not reach ${net.label}. Try again.`;
    const rootKnown = await isKnownRoot(client, pool, fieldToHex(receipt!.root)).catch(() => null);
    add(
      "Matches a real vault state",
      rootKnown == null ? "unknown" : rootKnown ? "pass" : "fail",
      rootKnown == null ? offline : rootKnown ? undefined : "The vault never had the state this proof was made against."
    );
    const commitment = fieldToHex(receipt!.commitment);
    const seen = await commitmentSeen(client, pool, commitment).catch(() => null);
    add(
      "Payment is in the vault",
      seen == null ? "unknown" : seen ? "pass" : "fail",
      seen == null ? offline : seen ? undefined : "The vault has no record of this payment."
    );
    if (seen !== false) {
      // Knowing a note's key is all the circuit shows, so the note must be the
      // payment output of a private send: not change, a deposit or a trade.
      const txHash = (p as PaymentProof).txHash ?? null;
      const tx = await findNoteTx(client, net, pool, commitment, txHash).catch(() => null);
      const v = paidCheck(tx, net.label, when);
      paidAt = v.paidAt;
      add(PAID_BY_SEND, v.state, v.detail);
    }
  }

  // 6) Expiry.
  expiry();
  return finish(paidAt);
}

function fundsFieldsMatch(p: FundsProof, s: ReturnType<typeof readFundsSignals>): boolean {
  const used = s.nullifiers.filter((n) => n !== 0n);
  return (
    sameHex(p.asset, s.asset) &&
    /^\d+$/.test(String(p.threshold)) &&
    BigInt(p.threshold) === s.threshold &&
    s.threshold > 0n &&
    sameHex(p.root, s.root) &&
    Array.isArray(p.nullifiers) &&
    p.nullifiers.length === used.length &&
    p.nullifiers.every((n, i) => sameHex(n, used[i]!))
  );
}

/** Exact balance: the receipt statement with the amount shown, minimum equal to it. */
function balanceFieldsMatch(p: BalanceProof, s: ReturnType<typeof readReceiptSignals>): boolean {
  return (
    sameHex(p.asset, s.asset) &&
    sameHex(p.commitment, s.commitment) &&
    /^\d+$/.test(String(p.amount)) &&
    BigInt(p.amount) > 0n &&
    s.reveal === 1n &&
    s.shownAmount === BigInt(p.amount) &&
    s.minAmount === BigInt(p.amount)
  );
}

function paymentFieldsMatch(p: PaymentProof, s: ReturnType<typeof readReceiptSignals>): boolean {
  const shown = p.amount != null;
  return (
    sameHex(p.asset, s.asset) &&
    sameHex(p.commitment, s.commitment) &&
    /^\d+$/.test(String(p.minAmount)) &&
    BigInt(p.minAmount) === s.minAmount &&
    s.reveal === (shown ? 1n : 0n) &&
    (shown ? /^\d+$/.test(String(p.amount)) && BigInt(p.amount!) === s.shownAmount : s.shownAmount === 0n) &&
    (p.txHash == null || (typeof p.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(p.txHash)))
  );
}
