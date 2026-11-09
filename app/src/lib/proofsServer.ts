/**
 * Server-side checking of Gloam proofs. Used by POST /api/v1/proofs/verify
 * (app/api/v1/_lib/verify) and by the hosted MCP server's gloam_verify_proof
 * (lib/mcpRemote). Server only.
 *
 * Formats: gloamfunds1 (proof of funds), gloampay1 (proof of payment),
 * gloamroll1 (payroll total), gloambal1 (exact balance) and gloamdisc1 (the
 * older balance disclosure).
 *
 * This runs the checks the /verify page runs (lib/proofs), with the snark step
 * swapped for the server's own bundled keys (the page loads its keys with a
 * relative fetch, which only works in a browser):
 *  - funds, payment and exact balance proofs go through checkHolderProof;
 *  - payroll totals go through checkPayrollProof;
 *  - balance disclosures (gloamdisc1) are never ok. They reuse the deposit
 *    statement, and every deposit publishes a valid proof of it on chain, so
 *    anyone can make one for anyone's deposit. The result says so plainly.
 * Size and format checks and the snark come before any chain read.
 *
 * Checking keys are the same files as /public/circuits, bundled at build time
 * (scripts/selftest-partners.mts checks them against the pinned hashes).
 */
import { LEGACY_DISCLOSURE, decodeDisclosure } from "@/lib/disclosure";
import { decodeProof, isGloamProof, type AnyProof, type VerifyResult } from "@/lib/proofs";
import { clientFor, networkForChain, payrollLookups } from "@/lib/proofs/chain";
import { checkPayrollProof } from "@/lib/proofs/payrollCheck";
import { checkHolderProof } from "@/lib/proofs/verify";
import fundsVkey from "../../public/circuits/funds_vkey.json";
import receiptVkey from "../../public/circuits/receipt_vkey.json";
import payrollVkey from "../../public/circuits/payroll_total_vkey.json";
import shieldVkey from "../../public/circuits/shield_vkey.json";
import fundsVkeyFinal from "../../public/circuits/final/funds_vkey.json";
import receiptVkeyFinal from "../../public/circuits/final/receipt_vkey.json";
import payrollVkeyFinal from "../../public/circuits/final/payroll_total_vkey.json";
import { ceremonyForChain, networkName } from "@/lib/networks";

/** Checking keys by key set: a proof is checked with its own network's (dev on testnet, final on mainnet). */
const VKEYS = {
  dev: { funds: fundsVkey, receipt: receiptVkey, payroll: payrollVkey },
  production: { funds: fundsVkeyFinal, receipt: receiptVkeyFinal, payroll: payrollVkeyFinal },
} as const;

/**
 * Input that is not a proof at all (empty, damaged, too large). Callers map it
 * to their own error shape: the v1 API turns it into an ApiError with the same
 * status and code.
 */
export class ProofInputError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ProofInputError";
  }
}

export const SNARK_CHECK = "The proof checks out";

/**
 * Longest proof text taken. The largest real proof, a payroll total of 256
 * payments in 8 parts, is about 95 KB as text.
 */
export const MAX_PROOF_TEXT = 160_000;


export type ProofFormat = "gloamfunds1" | "gloampay1" | "gloamroll1" | "gloambal1" | "gloamdisc1";

export type ApiVerifyResult = {
  format: ProofFormat;
  kind: "funds" | "payment" | "payroll" | "balance";
  ok: boolean;
  expired: boolean;
  checks: VerifyResult["checks"];
  /** Unix seconds the payment landed (proof of payment), when found. */
  paidAt: number | null;
  /** Unix seconds of the first and last payroll payment, when all were found. */
  paidBetween: [number, number] | null;
  /** The proof's plain fields, as the holder shared them. */
  claims: Record<string, unknown>;
  /**
   * The network the proof names, when Gloam runs on it; null otherwise.
   * `testnet` is true for a proof made with test funds: Base Sepolia uses the
   * mainnet keys, so its proofs pass every check, and only this tells them apart.
   */
  network: ProofNetwork | null;
};

export type ProofNetwork = { chainId: number; key: string; name: string; testnet: boolean };

function proofNetwork(chainId: unknown): ProofNetwork | null {
  const net = networkForChain(Number(chainId));
  return net ? { chainId: net.chainId, key: net.key, name: networkName(net), testnet: net.testnet } : null;
}

type Snarkjs = typeof import("snarkjs") & {
  curves?: { getCurveFromName(name: string, opts?: { singleThread?: boolean }): Promise<unknown> };
};

/**
 * snarkjs with a single-threaded curve. groth16.verify reuses a curve cached
 * on globalThis; seeding it single-threaded keeps a serverless function from
 * spawning worker threads it never cleans up.
 */
async function snark(): Promise<Snarkjs> {
  const snarkjs = (await import("snarkjs")) as Snarkjs;
  const g = globalThis as { curve_bn128?: unknown };
  if (!g.curve_bn128 && snarkjs.curves) {
    g.curve_bn128 = await snarkjs.curves.getCurveFromName("bn128", { singleThread: true });
  }
  return snarkjs;
}

export async function groth16Verify(vkey: unknown, signals: unknown, proof: unknown): Promise<boolean> {
  if (!Array.isArray(signals) || !signals.every((s) => typeof s === "string" && /^\d{1,78}$/.test(s))) return false;
  if (!proof || typeof proof !== "object") return false;
  try {
    return await (await snark()).groth16.verify(vkey, signals as string[], proof);
  } catch {
    return false;
  }
}

function when(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

function claimsOf(p: AnyProof): Record<string, unknown> {
  const base = { chainId: p.chainId, pool: p.pool, verifier: p.verifier, expiresAt: p.expiresAt, asset: p.asset };
  if (p.kind === "funds") return { ...base, threshold: p.threshold };
  if (p.kind === "payment") return { ...base, amount: p.amount, minAmount: p.minAmount, commitment: p.commitment, txHash: p.txHash };
  if (p.kind === "balance") return { ...base, amount: p.amount, commitment: p.commitment };
  return { ...base, total: p.total, count: p.count };
}

const FORMAT: Record<AnyProof["kind"], ProofFormat> = {
  funds: "gloamfunds1",
  payment: "gloampay1",
  payroll: "gloamroll1",
  balance: "gloambal1",
};

async function verifyPayrollServer(p: Extract<AnyProof, { kind: "payroll" }>): Promise<VerifyResult> {
  const net = networkForChain(p.chainId);
  const official = Boolean(net?.pool && typeof p.pool === "string" && net.pool.toLowerCase() === p.pool.toLowerCase());
  // one check's lookups share its reads and its limit (PAYROLL_MAX_READS)
  const lookups = official && net ? payrollLookups(clientFor(net), net, net.pool!) : null;
  return checkPayrollProof(p, {
    verifySnark: (part) => groth16Verify(VKEYS[ceremonyForChain(p.chainId)].payroll, part.publicSignals, part.proof),
    vault: official && net ? { label: networkName(net) } : null,
    findPayments: lookups ? lookups.find : async (pays) => pays.map(() => undefined),
    blockTime: lookups?.blockTime,
    now: Math.floor(Date.now() / 1000),
    when,
  });
}

async function verifyHolderServer(p: Extract<AnyProof, { kind: "funds" | "payment" | "balance" }>): Promise<VerifyResult> {
  return checkHolderProof(p, {
    verifySnark: (circuit, signals, proof, chainId) => groth16Verify(VKEYS[ceremonyForChain(chainId)][circuit], signals, proof),
    when,
  });
}

/**
 * gloamdisc1: the shield statement [commitment, amount, asset]. Every deposit
 * puts a valid proof of exactly that in public calldata, so a copy proves
 * nothing about who holds the note. The snark and the vault are still checked
 * so a broken one reads as broken, then the verdict is "can't confirm".
 */
async function verifyDisclosureServer(text: string): Promise<ApiVerifyResult> {
  let d: ReturnType<typeof decodeDisclosure>;
  try {
    d = decodeDisclosure(text);
  } catch {
    throw new ProofInputError(400, "invalid_proof", "That is not a Gloam proof.");
  }
  const checks: VerifyResult["checks"] = [];
  const valid = await groth16Verify(shieldVkey, [d.commitment, d.amount, d.asset].map(String), d.proof);
  checks.push({
    label: SNARK_CHECK,
    state: valid ? "pass" : "fail",
    detail: valid ? "Verified with Gloam's zero-knowledge checking key." : "The proof did not verify.",
  });
  const net = networkForChain(Number(d.chainId));
  const official = Boolean(net?.pool && typeof d.pool === "string" && net.pool.toLowerCase() === d.pool.toLowerCase());
  checks.push({
    label: official ? `Made on Gloam's vault on ${networkName(net!)}` : "Made on Gloam's vault",
    state: official ? "pass" : "fail",
    detail: official ? undefined : "The vault address is not Gloam's current vault, so its balance cannot be trusted.",
  });
  checks.push({ label: "Shows who holds it", state: "fail", detail: LEGACY_DISCLOSURE });
  return {
    format: "gloamdisc1",
    kind: "balance",
    ok: false,
    expired: false,
    checks,
    paidAt: null,
    paidBetween: null,
    claims: { chainId: d.chainId, pool: d.pool, asset: d.asset, amount: d.amount, commitment: d.commitment },
    network: proofNetwork(d.chainId),
  };
}

/** Checks any Gloam proof text. Malformed input throws a ProofInputError (400 or 413). */
export async function verifyProofText(raw: unknown): Promise<ApiVerifyResult> {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ProofInputError(400, "invalid_proof", 'Send the proof text as { "proof": "gloamfunds1:..." }.');
  }
  if (raw.length > MAX_PROOF_TEXT) throw new ProofInputError(413, "too_large", "That proof is too large.");
  const text = raw.trim();
  if (!isGloamProof(text)) return verifyDisclosureServer(text);

  let p: AnyProof;
  try {
    p = decodeProof(text);
  } catch (e) {
    throw new ProofInputError(400, "invalid_proof", e instanceof Error ? e.message : "That is not a Gloam proof.");
  }
  const r = p.kind === "payroll" ? await verifyPayrollServer(p) : await verifyHolderServer(p);
  return {
    format: FORMAT[p.kind],
    kind: p.kind,
    ok: r.ok,
    expired: r.expired,
    checks: r.checks,
    paidAt: r.paidAt ?? null,
    paidBetween: r.paidBetween ?? null,
    claims: claimsOf(p),
    network: proofNetwork(p.chainId),
  };
}
