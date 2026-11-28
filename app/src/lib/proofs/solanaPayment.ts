/**
 * A proof of payment on Solana (Helius Solana Privacy Rings, the Default Ring):
 * one private payment, its exact amount and asset, into one private account,
 * checked by anyone against the Solana transaction that made it.
 *
 * What a Rings payment puts on chain: a `transact` instruction whose outputs
 * are UTXO hashes, Poseidon(domain, tree, asset, amount, data hash, ring hash,
 * Poseidon(Poseidon(owner identity, nullifier key), blinding)). The asset and
 * the amount are hidden; the two private accounts are public on the Default
 * Ring (lib/solanaRings/config). The person paid holds the opening of their
 * own output (the SDK decrypts it on sync). Showing that opening shows this one
 * payment and nothing else: the blinding of every other output comes from a
 * seed that stays private, and spending still needs the account's own keys,
 * so the opening can't move the money or show when it is spent.
 *
 * The proof is that opening plus the transaction and output it belongs to,
 * signed by the private account that was paid (Ed25519 over the whole
 * statement, domain separated so it can never pass for a transaction). The
 * check (verifySolanaPayment):
 *  1. the paid account's signature holds: the label, the expiry and every
 *     field are its own, made for this reader;
 *  2. the transaction is on Solana, it succeeded, and the instruction named is
 *     the pool's transact;
 *  3. the opening hashes to the output named (the asset and the amount);
 *  4. the output's public owner tag is the account paid, and the opening is
 *     owned by it on the Default Ring (no ring program that could move it);
 *  5. the money came from another account: the circuit names who spent
 *     (the Default Ring's owner tag or an in-proof owner), or the circuit only
 *     spends signers' money and the paid account did not sign. Change, or a
 *     transfer to itself, fails here.
 *  6. not expired.
 * Every network read goes through `deps`, so a reader can run the same checks
 * against any Solana node.
 *
 * Not provable on Solana with what Rings gives (said where it shows): a
 * minimum with the amount hidden, a balance, that money is still there.
 */
import { displayLabel, isPlainLabel, MAX_LABEL, plainLabel } from "./label";
import { SHIELDED_POOL_PROGRAM, tagKey, transactAt, type RpcTransaction } from "./solanaTransact";

export const SOLANA_PAYMENT_PREFIX = "gloamsolpay1:";

export type SolanaProofNetwork = "mainnet" | "devnet";

export type SolanaPaymentProof = {
  v: 1;
  kind: "solana-payment";
  network: SolanaProofNetwork;
  /** The transaction that made the payment (base58 signature). */
  tx: string;
  /** The pool instruction's position in it, and the output's among its outputs. */
  ix: number;
  output: number;
  /** The private account paid: its Solana address, which also signs this proof. */
  account: string;
  /** The asset's mint (the system program's address for SOL). */
  asset: string;
  /** Exact amount, base units. */
  amount: string;
  /** The rest of the output's opening, hex. */
  nullifierKey: string;
  blinding: string;
  tree: number;
  dataHash: string | null;
  /** Who it is for, in plain words, and until when (unix seconds). */
  verifier: string;
  expiresAt: number;
  /** The account's Ed25519 signature over solanaPaymentMessage(proof), base64. */
  signature: string;
};

export type ChainCheckState = "pass" | "fail" | "unknown";
export type ChainCheck = { label: string; state: ChainCheckState; detail?: string };

export type SolanaPaymentResult = {
  ok: boolean;
  checks: ChainCheck[];
  expired: boolean;
  /** When the payment landed, from the block. */
  paidAt?: number;
  /** The account that paid, when the transaction names it. */
  from?: string;
};

/** What the checks need from the outside world. */
export type SolanaPaymentDeps = {
  /** getTransaction (encoding json, version 1), or null when Solana says there is none. Throws when it can't be reached. */
  getTransaction(network: SolanaProofNetwork, signature: string): Promise<RpcTransaction | null>;
  /** The UTXO hash of an opening (the SDK's own Utxo.hash). */
  utxoHash(o: { account: Uint8Array; asset: string; amount: bigint; blinding: Uint8Array; nullifierKey: Uint8Array; tree: number; dataHash: Uint8Array | null }): Promise<Uint8Array>;
  /** Plain Ed25519 over `message` by the 32-byte key. */
  verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
  base58Encode(text: string): Uint8Array;
  base58Decode(bytes: Uint8Array): string;
  /** The network this page reads (a proof from another can't be checked here). */
  readable: (network: SolanaProofNetwork) => boolean;
  now?: () => number;
  when?: (unix: number) => string;
};

const NAMES: Record<SolanaProofNetwork, string> = { mainnet: "Solana", devnet: "Solana devnet" };
export const solanaNetworkName = (n: SolanaProofNetwork) => NAMES[n] ?? "Solana";

const HEX32 = /^[0-9a-f]{64}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const isStr = (v: unknown): v is string => typeof v === "string";

/** Who it is for: cleaned the way every Gloam proof label is (lib/proofs/label). */
export function cleanSolanaLabel(label: string): string {
  const v = plainLabel(label);
  if (!v) throw new Error("Say who this proof is for.");
  if (Array.from(v).length > MAX_LABEL) throw new Error(`Keep the name under ${MAX_LABEL} characters.`);
  return v;
}

/**
 * The exact bytes the paid account signs: 0xff (never the first byte of a
 * Solana transaction message, legacy or versioned), a domain line, then every
 * field but the signature, in a fixed order.
 */
export function solanaPaymentMessage(p: Omit<SolanaPaymentProof, "signature">): Uint8Array {
  const body = JSON.stringify([
    "gloam proof of payment on solana v1",
    p.network,
    p.tx,
    p.ix,
    p.output,
    p.account,
    p.asset,
    p.amount,
    p.nullifierKey,
    p.blinding,
    p.tree,
    p.dataHash,
    p.verifier,
    p.expiresAt,
  ]);
  const text = new TextEncoder().encode(body);
  const out = new Uint8Array(text.length + 1);
  out[0] = 0xff;
  out.set(text, 1);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function encodeSolanaPayment(p: SolanaPaymentProof): string {
  return SOLANA_PAYMENT_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify(p)));
}

export function isSolanaPaymentText(text: string): boolean {
  return text.trim().startsWith(SOLANA_PAYMENT_PREFIX);
}

/** Shape only; verifySolanaPayment decides whether it holds. */
function wellFormed(p: SolanaPaymentProof): boolean {
  return (
    p.v === 1 &&
    p.kind === "solana-payment" &&
    (p.network === "mainnet" || p.network === "devnet") &&
    isStr(p.tx) &&
    B58.test(p.tx) &&
    Number.isSafeInteger(p.ix) &&
    p.ix >= 0 &&
    p.ix < 64 &&
    Number.isSafeInteger(p.output) &&
    p.output >= 0 &&
    p.output < 256 &&
    isStr(p.account) &&
    B58.test(p.account) &&
    isStr(p.asset) &&
    B58.test(p.asset) &&
    isStr(p.amount) &&
    /^\d{1,20}$/.test(p.amount) &&
    isStr(p.nullifierKey) &&
    HEX32.test(p.nullifierKey) &&
    isStr(p.blinding) &&
    HEX32.test(p.blinding) &&
    Number.isSafeInteger(p.tree) &&
    p.tree >= 0 &&
    p.tree <= 0xffff &&
    (p.dataHash === null || (isStr(p.dataHash) && HEX32.test(p.dataHash))) &&
    isStr(p.verifier) &&
    Number.isSafeInteger(p.expiresAt) &&
    isStr(p.signature)
  );
}

export function decodeSolanaPayment(text: string): SolanaPaymentProof {
  const t = text.trim();
  if (!t.startsWith(SOLANA_PAYMENT_PREFIX)) throw new Error("Not a Gloam proof.");
  let p: SolanaPaymentProof;
  try {
    p = JSON.parse(new TextDecoder().decode(fromBase64(t.slice(SOLANA_PAYMENT_PREFIX.length)))) as SolanaPaymentProof;
  } catch {
    throw new Error("This proof is damaged. Ask for it again.");
  }
  if (!p || typeof p !== "object" || !wellFormed(p)) throw new Error("This proof is damaged. Ask for it again.");
  return p;
}

function localWhen(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** Every check, in order. A check that could not run is never a pass. */
export async function verifySolanaPayment(p: SolanaPaymentProof, deps: SolanaPaymentDeps): Promise<SolanaPaymentResult> {
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const when = deps.when ?? localWhen;
  const checks: ChainCheck[] = [];
  const add = (label: string, state: ChainCheckState, detail?: string) => checks.push({ label, state, detail });
  const expired = !(Number.isSafeInteger(p.expiresAt) && now <= p.expiresAt);
  const expiry = () => add(expired ? "Expired" : "Not expired", expired ? "fail" : "pass", `Valid until ${when(p.expiresAt)}.`);
  const finish = (extra: Partial<SolanaPaymentResult> = {}): SolanaPaymentResult => ({
    ok: !expired && checks.length > 0 && checks.every((c) => c.state === "pass"),
    checks,
    expired,
    ...extra,
  });
  const net = solanaNetworkName(p.network);

  // 1) The paid account signed this exact statement, for this reader.
  let account: Uint8Array | null = null;
  let signed = false;
  try {
    account = deps.base58Encode(p.account);
    const sig = fromBase64(p.signature);
    const { signature: _drop, ...rest } = p;
    void _drop;
    signed = account.length === 32 && sig.length === 64 && (await deps.verifyEd25519(account, solanaPaymentMessage(rest), sig));
  } catch {
    signed = false;
  }
  add(
    `Made for "${displayLabel(p.verifier)}"`,
    signed ? "pass" : "fail",
    signed
      ? isPlainLabel(p.verifier)
        ? "Signed by the private account that was paid. The name, the expiry and the payment are sealed into it."
        : "Signed by the private account that was paid. Hidden characters in the name are not shown."
      : "The signature does not match. The proof was edited, or the account paid did not make it."
  );
  if (!signed || !account) {
    expiry();
    return finish();
  }

  // 2) The transaction, on the network the proof names.
  if (!deps.readable(p.network)) {
    add(`Made on ${net}`, "fail", `This page checks a different Solana network. This proof was made on ${net}.`);
    expiry();
    return finish();
  }
  let tx: RpcTransaction | null;
  try {
    tx = await deps.getTransaction(p.network, p.tx);
  } catch {
    add("A private payment on Solana", "unknown", `Could not reach ${net}. Try again.`);
    expiry();
    return finish();
  }
  const at = tx ? transactAt(tx, p.ix, deps.base58Encode) : null;
  if (!tx || !at || !at.ok) {
    add(
      "A private payment on Solana",
      "fail",
      !tx
        ? `${net} has no such transaction.`
        : at && !at.ok && at.why === "failed"
          ? "That transaction failed, so it paid nothing."
          : "That transaction is not a private payment in Solana's private pool."
    );
    expiry();
    return finish();
  }
  const { transact, signers, keys } = at.found;
  const out = transact.outputs[p.output];
  const paidAt = typeof tx.blockTime === "number" ? tx.blockTime : undefined;
  add(
    "A private payment on Solana",
    out ? "pass" : "fail",
    out
      ? `${paidAt ? `${when(paidAt)}. ` : ""}A private transfer in Solana's private pool (${SHIELDED_POOL_PROGRAM.slice(0, 4)}…${SHIELDED_POOL_PROGRAM.slice(-4)}), which succeeded.`
      : "That transaction has no such payment in it."
  );
  if (!out) {
    expiry();
    return finish({ paidAt });
  }

  // 3) The opening is this output: asset and amount.
  let hashOk = false;
  try {
    const hash = await deps.utxoHash({
      account,
      asset: p.asset,
      amount: BigInt(p.amount),
      blinding: bytesOf(p.blinding),
      nullifierKey: bytesOf(p.nullifierKey),
      tree: p.tree,
      dataHash: p.dataHash ? bytesOf(p.dataHash) : null,
    });
    hashOk = sameBytes(hash, out.utxoHash) && BigInt(p.amount) > 0n;
  } catch {
    hashOk = false;
  }
  add(
    "Asset and amount match the payment",
    hashOk ? "pass" : "fail",
    hashOk ? "They open the payment's hidden value on chain exactly." : "They don't open this payment. The asset or the amount was changed."
  );

  // 4) The output belongs to the account paid (its public tag, and the opening's owner).
  const tag = tagKey(out.tag, keys, deps.base58Encode);
  const toAccount = Boolean(tag && sameBytes(tag, account));
  add(
    "Paid to this private account",
    hashOk && toAccount ? "pass" : "fail",
    hashOk && toAccount
      ? `${p.account}, on the Default Ring.`
      : "The payment went to a different account."
  );

  // 5) Someone else paid: not change, not a transfer to itself.
  let from: string | undefined;
  if (transact.spender.kind === "owner") {
    const spender = transact.spender.key;
    const self = sameBytes(spender, account);
    if (!self) from = deps.base58Decode(spender);
    add(
      "From another account",
      self ? "fail" : "pass",
      self ? "The account paid itself: change, or a transfer to itself." : `Paid from the private account ${from}.`
    );
  } else if (transact.spender.kind === "signers") {
    const self = signers.includes(p.account);
    add(
      "From another account",
      self ? "fail" : "pass",
      self
        ? "The account paid signed this transaction itself, so this may be its own change."
        : "The account paid did not sign the transaction, so the money came from another account."
    );
  } else {
    add("From another account", "unknown", "This transaction does not show who paid, so it may be a transfer to itself.");
  }

  // 6) Expiry.
  expiry();
  return finish({ paidAt, from });
}
