/**
 * Reading a Solana Privacy Rings payment straight from its transaction, for a
 * proof of payment on Solana (lib/proofs/solanaPayment). Pure: no network.
 *
 * A private payment is one `transact` instruction (tag 16) to the shielded pool
 * program. Its data, written by the SDK's encodeTransactInstructionData
 * (@heliuslabs/spr interface/codecs) and read the same way by the program:
 *
 *   u8 tag (16) · u64 expiry · 33 tx viewing key · 16 salt
 *   u8 n · n × interface transfer (u8 kind · u64 amount · [u8 bump if SPL])
 *   option 32 data hash · option 32 ring data hash
 *   u8 n · n × output (32 utxo hash · owner tag · option u16-prefixed data)
 *   u8 n · n × message (32 view tag · u16-prefixed data)
 *   32 private tx hash
 *   circuit: u16 kind · u8 inputs · u8 outputs · u8 asset slots · [proof data] · [cache access]
 *   proof: 32 a · 128 b · 32 c
 *   u8 n · n × input (32 nullifier · u8 tree index)
 *   u8 n · n × tree context (u16 · u16)
 *
 * The decode is strict: every byte is read in that order and nothing may be
 * left over, so a hash planted inside a ciphertext or a message is never taken
 * for an output. Checked against live mainnet transactions on 2026-11-27.
 */

export const SHIELDED_POOL_PROGRAM = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
export const TRANSACT_TAG = 16;
/** Write slots a cached circuit always carries (SDK MAX_CACHE_WRITES), unused ones as (255, 255). */
const MAX_CACHE_WRITES = 16;

export type OwnerTag = { kind: "inline"; key: Uint8Array } | { kind: "account"; index: number };

export type TransactOutput = { utxoHash: Uint8Array; tag: OwnerTag };

/**
 * Who spent the inputs, as far as the circuit publishes it:
 *  - "owner": one key, bound by the proof (the default ring's hidden owner tag,
 *    or an in-proof Ed25519 owner).
 *  - "signers": the inputs belong to signers of the transaction (the
 *    confidential signer circuits), so an account that did not sign spent nothing.
 *  - "hidden": a ring circuit that does not say.
 */
export type Spender = { kind: "owner"; key: Uint8Array } | { kind: "signers" } | { kind: "hidden" };

export type Transact = {
  circuit: number;
  outputs: TransactOutput[];
  spender: Spender;
};

class Reader {
  private at = 0;
  constructor(private readonly b: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.b.length) throw new Error("short");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u16(): number {
    const s = this.take(2);
    return s[0]! | (s[1]! << 8);
  }
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new Error("bool");
    return v === 1;
  }
  done(): void {
    if (this.at !== this.b.length) throw new Error("trailing bytes");
  }
}

/** Circuit kinds (SDK circuitTag): which publish the spender, which carry proof data or a cache selection. */
const CONFIDENTIAL_SIGNER = new Set([0, 4]);
const ANONYMOUS_RING_EDDSA = new Set([3, 6]);
const CONFIDENTIAL_EDDSA = new Set([7, 8]);
const CACHED = new Set([4, 5, 6, 8]);
const KNOWN_CIRCUITS = 8;

/** The transact instruction in `data` (tag byte first), or null for anything else or anything malformed. */
export function decodeTransact(data: Uint8Array): Transact | null {
  try {
    const r = new Reader(data);
    if (r.u8() !== TRANSACT_TAG) return null;
    r.take(8 + 33 + 16);
    const transfers = r.u8();
    for (let i = 0; i < transfers; i++) {
      const kind = r.u8();
      if (kind > 3) return null;
      r.take(8);
      if (kind === 2 || kind === 3) r.u8();
    }
    if (r.bool()) r.take(32);
    if (r.bool()) r.take(32);
    const outputs: TransactOutput[] = [];
    const n = r.u8();
    for (let i = 0; i < n; i++) {
      const utxoHash = new Uint8Array(r.take(32));
      const kind = r.u8();
      let tag: OwnerTag;
      if (kind === 0) tag = { kind: "inline", key: new Uint8Array(r.take(32)) };
      else if (kind === 1) tag = { kind: "account", index: r.u8() };
      else return null;
      if (r.bool()) r.take(r.u16());
      outputs.push({ utxoHash, tag });
    }
    const messages = r.u8();
    for (let i = 0; i < messages; i++) {
      r.take(32);
      r.take(r.u16());
    }
    r.take(32);
    const circuit = r.u16();
    if (circuit > KNOWN_CIRCUITS) return null;
    r.take(3);
    let spender: Spender = { kind: "hidden" };
    if (CONFIDENTIAL_SIGNER.has(circuit)) spender = { kind: "signers" };
    if (CONFIDENTIAL_EDDSA.has(circuit)) {
      r.take(64);
      spender = { kind: "owner", key: new Uint8Array(r.take(32)) };
    }
    if (ANONYMOUS_RING_EDDSA.has(circuit)) {
      r.take(64);
      const flag = r.u8();
      const key = new Uint8Array(r.take(32));
      if (flag > 1) return null;
      if (flag === 1) spender = { kind: "owner", key };
    }
    if (CACHED.has(circuit)) {
      r.take(8);
      r.take(2 * MAX_CACHE_WRITES);
    }
    r.take(32 + 128 + 32);
    const inputs = r.u8();
    for (let i = 0; i < inputs; i++) r.take(33);
    const trees = r.u8();
    for (let i = 0; i < trees; i++) r.take(4);
    r.done();
    return { circuit, outputs, spender };
  } catch {
    return null;
  }
}

/** The parts of a getTransaction answer (encoding "json", version 1 allowed) these checks read. */
export type RpcTransaction = {
  blockTime?: number | null;
  slot?: number;
  meta?: { err?: unknown } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: string[];
      header?: { numRequiredSignatures?: number };
      instructions?: { programIdIndex?: number; data?: string }[];
    };
  };
};

export type FoundTransact = {
  transact: Transact;
  /** Every signer of the transaction (base58 addresses), the fee payer first. */
  signers: string[];
  /** The account keys, to resolve an owner tag that points at one. */
  keys: string[];
};

/**
 * The pool's transact instruction at top-level position `ix`, decoded, or why
 * it could not be read. `base58` turns the instruction's text into bytes.
 */
export function transactAt(
  tx: RpcTransaction,
  ix: number,
  base58: (text: string) => Uint8Array
): { ok: true; found: FoundTransact } | { ok: false; why: "failed" | "not-pool" | "not-transact" } {
  if (tx.meta?.err != null) return { ok: false, why: "failed" };
  const m = tx.transaction?.message;
  const keys = Array.isArray(m?.accountKeys) ? m!.accountKeys!.map(String) : [];
  const ins = Array.isArray(m?.instructions) ? m!.instructions! : [];
  const one = Number.isSafeInteger(ix) && ix >= 0 ? ins[ix] : undefined;
  if (!one || typeof one.programIdIndex !== "number" || keys[one.programIdIndex] !== SHIELDED_POOL_PROGRAM) {
    return { ok: false, why: "not-pool" };
  }
  let bytes: Uint8Array;
  try {
    bytes = base58(String(one.data ?? ""));
  } catch {
    return { ok: false, why: "not-transact" };
  }
  const transact = decodeTransact(bytes);
  if (!transact) return { ok: false, why: "not-transact" };
  const signerCount = Number(m?.header?.numRequiredSignatures ?? 0);
  return { ok: true, found: { transact, signers: keys.slice(0, Math.max(0, signerCount)), keys } };
}

/** Every top-level pool transact in the transaction, with its position (for the prover to find its own output). */
export function transactsIn(tx: RpcTransaction, base58: (text: string) => Uint8Array): { ix: number; found: FoundTransact }[] {
  const ins = tx.transaction?.message?.instructions ?? [];
  const out: { ix: number; found: FoundTransact }[] = [];
  ins.forEach((_, ix) => {
    const r = transactAt(tx, ix, base58);
    if (r.ok) out.push({ ix, found: r.found });
  });
  return out;
}

/** The owner tag's key: inline, or the account it points at. Null when it points nowhere. */
export function tagKey(tag: OwnerTag, keys: readonly string[], base58: (text: string) => Uint8Array): Uint8Array | null {
  if (tag.kind === "inline") return tag.key;
  const k = keys[tag.index];
  if (!k) return null;
  try {
    return base58(k);
  } catch {
    return null;
  }
}
