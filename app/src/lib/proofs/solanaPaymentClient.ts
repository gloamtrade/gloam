"use client";

/**
 * Proofs of payment on Solana in the browser: the checks' network side (Gloam's
 * Solana RPC proxy, read only; any Solana node gives the same answers) and the
 * prover, which builds a proof from a payment this private account received
 * and signs it with the account's key, on this device.
 */
import type { RingsSession } from "@/lib/solanaRings/client";
import { ringsAssets, ringsUrls, SOLANA_RINGS_NETWORK, RINGS_SOL_MINT } from "@/lib/solanaRings/config";
import { isPlainSignature } from "@/lib/solanaRings/account";
import {
  cleanSolanaLabel,
  hexOf,
  solanaPaymentMessage,
  verifySolanaPayment,
  type SolanaPaymentDeps,
  type SolanaPaymentProof,
  type SolanaPaymentResult,
  type SolanaProofNetwork,
} from "./solanaPayment";
import { transactsIn, type RpcTransaction } from "./solanaTransact";

async function kit() {
  const k = await import("@solana/kit");
  const enc = k.getBase58Encoder();
  const dec = k.getBase58Decoder();
  return {
    base58Encode: (text: string) => new Uint8Array(enc.encode(text)),
    base58Decode: (bytes: Uint8Array) => dec.decode(bytes),
  };
}

async function proxyTransaction(signature: string): Promise<RpcTransaction | null> {
  const res = await fetch(ringsUrls(location.origin).rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { result?: RpcTransaction | null; error?: unknown } | null;
  if (!res.ok || !json || json.error || json.result === undefined) throw new Error("Solana did not answer.");
  return json.result;
}

/** The UTXO hash of an opening, by the SDK's own code (what the pool's proof commits to). */
export async function solanaUtxoHash(o: Parameters<SolanaPaymentDeps["utxoHash"]>[0]): Promise<Uint8Array> {
  const { Utxo, ShieldedPublicKey, initializePoseidon } = await import("@heliuslabs/spr");
  await initializePoseidon();
  const utxo = new Utxo({
    owner: ShieldedPublicKey.fromEd25519(o.account as never),
    asset: o.asset as never,
    amount: o.amount,
    blinding: o.blinding as never,
  });
  return new Uint8Array(utxo.hash(o.nullifierKey as never, o.tree, (o.dataHash ?? undefined) as never, undefined));
}

/** The checks' outside world in this browser. */
export async function solanaBrowserDeps(): Promise<SolanaPaymentDeps> {
  const k = await kit();
  return {
    getTransaction: (_network, signature) => proxyTransaction(signature),
    utxoHash: solanaUtxoHash,
    verifyEd25519: isPlainSignature,
    ...k,
    readable: (network) => network === SOLANA_RINGS_NETWORK,
  };
}

export async function verifySolanaPaymentHere(p: SolanaPaymentProof): Promise<SolanaPaymentResult> {
  return verifySolanaPayment(p, await solanaBrowserDeps());
}

/** A listed asset's symbol and decimals on `network`, by mint. */
export function solanaAssetOf(mint: string, network: SolanaProofNetwork) {
  const list = ringsAssets(network);
  return list.find((a) => (a.mint ?? RINGS_SOL_MINT) === mint) ?? null;
}

/** One payment this private account received, as the Prove screen lists it. */
export type ReceivedSolanaPayment = {
  id: string;
  tx: string;
  asset: string;
  amount: bigint;
  slot: bigint;
  leafIndex: bigint;
};

/** Payments this account received from someone else, newest first, from its synced wallet. */
export function receivedSolanaPayments(s: RingsSession): ReceivedSolanaPayment[] {
  const utxos = s.wallet.utxos();
  const byLeaf = new Map(utxos.map((u) => [u.outputContext.leafIndex.toString(), u]));
  const out: ReceivedSolanaPayment[] = [];
  for (const t of s.wallet.privateTransactions()) {
    if (t.direction !== "inbound" || t.kind !== "privateTransfer") continue;
    const u = byLeaf.get(t.id.index.toString());
    if (!u || u.utxo.amount !== t.amount || u.utxo.asset !== t.asset) continue;
    out.push({
      id: `${t.id.signature}:${t.id.index.toString()}`,
      tx: String(t.id.signature),
      asset: String(t.asset),
      amount: t.amount,
      slot: t.id.slot,
      leafIndex: t.id.index,
    });
  }
  return out.sort((a, b) => (a.slot === b.slot ? 0 : a.slot < b.slot ? 1 : -1));
}

/**
 * The proof of one received payment, for `verifier` until `expiresAt`, signed
 * by this account. Reads the payment's transaction to name its instruction and
 * output, and checks the proof the way a reader will before handing it over.
 */
export async function makeSolanaPaymentProof(
  s: RingsSession,
  payment: ReceivedSolanaPayment,
  verifier: string,
  expiresAt: number
): Promise<SolanaPaymentProof> {
  const label = cleanSolanaLabel(verifier);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Pick an expiry in the future.");
  const u = s.wallet.utxos().find((x) => x.outputContext.leafIndex === payment.leafIndex);
  if (!u) throw new Error("This payment is no longer on this device. Refresh and try again.");
  const deps = await solanaBrowserDeps();
  const tx = await deps.getTransaction(s.network, payment.tx).catch(() => {
    throw new Error("Solana is slow to answer. Try again.");
  });
  if (!tx) throw new Error("Solana can't find this payment's transaction yet. Try again in a minute.");
  let place: { ix: number; output: number } | null = null;
  for (const { ix, found } of transactsIn(tx, deps.base58Encode)) {
    const output = found.transact.outputs.findIndex((o) => hexOf(o.utxoHash) === hexOf(u.outputContext.hash));
    if (output >= 0) {
      place = { ix, output };
      break;
    }
  }
  if (!place) throw new Error("This payment's transaction is not one this proof can point at.");
  if (u.utxo.ringProgramId !== undefined) throw new Error("This payment is held in a ring program, which this proof does not cover.");
  const unsigned: Omit<SolanaPaymentProof, "signature"> = {
    v: 1,
    kind: "solana-payment",
    network: s.network,
    tx: payment.tx,
    ix: place.ix,
    output: place.output,
    account: s.address,
    asset: String(u.utxo.asset),
    amount: u.utxo.amount.toString(),
    nullifierKey: hexOf(s.keypair.shieldedAddress().nullifierPublicKey),
    blinding: hexOf(u.utxo.blinding),
    tree: 0,
    dataHash: u.dataHash ? hexOf(u.dataHash) : null,
    verifier: label,
    expiresAt,
  };
  const signature = s.keypair.sign(solanaPaymentMessage(unsigned));
  let b64 = "";
  for (const b of signature) b64 += String.fromCharCode(b);
  const proof: SolanaPaymentProof = { ...unsigned, signature: btoa(b64) };
  const r = await verifySolanaPayment(proof, deps);
  if (!r.ok) {
    const bad = r.checks.find((c) => c.state !== "pass");
    throw new Error(bad?.detail ?? "This payment can't be proven.");
  }
  return proof;
}
