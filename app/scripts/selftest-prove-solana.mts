/**
 * Self-test: a proof of payment on Solana (lib/proofs/solanaPayment), with no
 * network. Payments are built with the SDK's own encoder and UTXO hash
 * (@heliuslabs/spr), wrapped the way getTransaction answers, and checked the
 * way /verify checks them:
 *
 *  - the strict transact decoder reads a real mainnet transaction (read
 *    2026-11-27) and the SDK's own encoding, and refuses trailing bytes, other
 *    instructions and a planted hash;
 *  - a payment from Alice to Bob, proven by Bob, verifies (the Default Ring's
 *    owner tag names Alice; a confidential-signer payment Bob did not sign);
 *  - tampered fails: the amount, the asset, the label, the expiry, the output,
 *    the transaction, the network; a proof signed by someone else; Bob's own
 *    change; a payment Bob signed; a deposit; a failed transaction; a spender
 *    the circuit hides is never a pass;
 *  - wrong chain fails: a devnet proof on a mainnet page, a mainnet proof
 *    whose transaction is not on the network read; a network that can't be
 *    reached is "could not check", never a pass.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-prove-solana.mts
 */
import assert from "node:assert/strict";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { initializePoseidon, ShieldedKeypair, SigningKey, Utxo } from "@heliuslabs/spr";
import { encodeTransactInstructionData } from "@heliuslabs/spr/internal";

const pay = await import("../src/lib/proofs/solanaPayment");
const dec = await import("../src/lib/proofs/solanaTransact");
const client = await import("../src/lib/proofs/solanaPaymentClient");
const { isPlainSignature } = await import("../src/lib/solanaRings/account");
const chain = await import("../src/lib/proofs/chainProofs");

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert.ok(c, m);
  pass++;
};
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  pass++;
};

await initializePoseidon();
const b58e = getBase58Encoder();
const b58d = getBase58Decoder();
const toB58 = (b: Uint8Array) => b58d.decode(b);
const fromB58 = (s: string) => new Uint8Array(b58e.encode(s));
const seed = (n: number) => new Uint8Array(32).fill(n);
const kp = (n: number) => ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed(n) as never));
const alice = kp(11);
const bob = kp(22);
const relay = toB58(new Uint8Array(32).fill(33));
const addrOf = (k: ReturnType<typeof kp>) => k.toSolanaSigner().address as string;
const keyOf = (k: ReturnType<typeof kp>) => fromB58(addrOf(k));
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL = dec.SHIELDED_POOL_PROGRAM;
const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

/* ------------------------------------------------------------------ the decoder, on a real mainnet transaction */
{
  // Zg6svQYx… (slot 474450720): a confidential-signer transact, both outputs tagged to the fee payer.
  const data =
    "BSG12Nhjf5EnkaLytkDS6LcuLD6U8FEWW4W5reugn8e1YSMeX3VFa7tqnuQtAajqNm8bdk6T93spq23qHCW8r2ye9nJkzMx3fqphAwp7sKaHaoBm5rr3toyP1Uyg1auaZuCWHotCgebZ9jYbJ95xs3gvwJqze7fc95Vvyikiy9QjmxjjKtipjbJE1N8RUM6tqmsRoGu1Yzw7iCFv3SEENu612o8bsApvuWpWQojuZU2Fzjup3NYrpPB5KWZk1SF2oCdJUq3TAyy88AK9Ggk8SbFYNnUfeDV23PkHZb6xqWNKSVjj6FGrvTadPTK8DLuddJUuTcxCfEWgLaWehSMuRCvmHHED2sgB26Jjt2MTghVY1w4EvQSEabdAxQ4Voi9EJVZUT31QdCcmQP3dfJE15wLJWowYBHfTavUXoZ5Xrpu7diLcDwKT8HU4WZGnFpaKZYvQe8bCr39ko6MS5WFNTs3pZXwDTBU74NTvQP8LqMRNiPmJpQoEe7N482t6zecBequ9H3MgEYCgTanNGegr9dxNVmQzQU6ozMhHDyJ8ChdypET9evmnpj3eAGWgcrKM8df7vDP3XuqQL7ewV4VYMNBPUnBBQ6LDfLgTWggg4R8HzpzjqGqwjBq18PSRaG8ZwR5ydotDu9FL1CoTqm2ysgmMCTbnCKFt96kaLPg1bRRNwMQ3y6Cvz86J2LUjz9WAS8xmaL3gTkYUfcwYcty11NdsEP7UvZDvdt2bcLwVdsQVN5fJ6Deiq8ZdU5gBEiiRMVVRHcdnHTHC1WMW2UcgzZiCUAmHgrWmDRGu7MvVTKXEtxRNPpiiHn7rpAdZ6k8F7q2vSrsQj";
  const real = dec.decodeTransact(fromB58(data));
  ok(real, "a real mainnet transact decodes, every byte read");
  eq(real!.circuit, 0, "its circuit is the confidential signer");
  eq(real!.outputs.length, 2, "it has two outputs");
  eq(real!.outputs.map((o) => o.tag), [{ kind: "account", index: 0 }, { kind: "account", index: 0 }], "both tagged to the fee payer");
  eq(real!.spender, { kind: "signers" }, "a confidential signer spends signers' money");
  const raw = fromB58(data);
  eq(dec.decodeTransact(new Uint8Array([...raw, 0])), null, "a trailing byte is refused");
  eq(dec.decodeTransact(raw.subarray(0, raw.length - 1)), null, "a short instruction is refused");
  const other = new Uint8Array(raw);
  other[0] = 15;
  eq(dec.decodeTransact(other), null, "a deposit (tag 15) is not a transact");
}

/* ------------------------------------------------------------------ payments built with the SDK */

type Out = { owner: ReturnType<typeof kp>; asset: string; amount: bigint; blinding: Uint8Array; tag?: "inline" | "account0"; data?: Uint8Array };

function utxoHashOf(o: Out): Uint8Array {
  const u = new Utxo({ owner: o.owner.shieldedAddress().signingPublicKey, asset: o.asset as never, amount: o.amount, blinding: o.blinding as never });
  return new Uint8Array(u.hash(o.owner.shieldedAddress().nullifierPublicKey, 0));
}

type Circuit = { kind: "anon"; owner: Uint8Array | null } | { kind: "signer" } | { kind: "ring" } | { kind: "eddsa"; owner: Uint8Array };

function instruction(outs: Out[], circuit: Circuit, tagByte = 16): string {
  const zero = (n: number) => new Uint8Array(n);
  const shape = { inputs: 2, outputs: outs.length, publicAssetSlots: 3 };
  const c =
    circuit.kind === "anon"
      ? { kind: "anonymousRingEddsa", ...shape, proofData: { bsb22Commitment: { commitment: zero(32), commitmentPok: zero(32) }, ...(circuit.owner ? { defaultOwnerTag: circuit.owner } : {}) } }
      : circuit.kind === "eddsa"
        ? { kind: "confidentialEddsa", ...shape, proofData: { bsb22Commitment: { commitment: zero(32), commitmentPok: zero(32) }, ownerPk: circuit.owner } }
        : circuit.kind === "ring"
          ? { kind: "confidentialRingEddsa", ...shape }
          : { kind: "confidentialSigner", ...shape };
  const body = encodeTransactInstructionData({
    expiryUnixTs: 0xffffffffffffffffn,
    txViewingPk: bytes(33, 2),
    salt: bytes(16, 3),
    interfaceTransfers: [],
    outputs: outs.map((o) => ({
      utxoHash: utxoHashOf(o),
      ownerTag: o.tag === "account0" ? { kind: "account", index: 0 } : { kind: "inline", value: keyOf(o.owner) },
      data: o.data ?? bytes(89, 7),
    })),
    messages: [],
    privateTxHash: bytes(32, 4),
    circuit: c as never,
    proof: { a: zero(32), b: zero(128), c: zero(32) },
    inputs: [
      { nullifierHash: bytes(32, 5), treeIndex: 0 },
      { nullifierHash: bytes(32, 6), treeIndex: 0 },
    ],
    treeContexts: [{ utxoTreeRootIndex: 1, nullifierTreeRootIndex: 2 }],
  } as never);
  return toB58(new Uint8Array([tagByte, ...body]));
}

const SIG = toB58(bytes(64, 9));
function txOf(data: string, signers: string[], extra: { err?: unknown; blockTime?: number } = {}): import("../src/lib/proofs/solanaTransact").RpcTransaction {
  return {
    blockTime: extra.blockTime ?? 1_795_000_000,
    slot: 474_000_000,
    meta: { err: extra.err ?? null },
    transaction: {
      signatures: [SIG],
      message: { accountKeys: [...signers, "11111111111111111111111111111111", POOL], header: { numRequiredSignatures: signers.length }, instructions: [{ programIdIndex: signers.length + 1, data }] },
    },
  };
}

const NOW = 1_795_000_100;
function deps(txs: Record<string, import("../src/lib/proofs/solanaTransact").RpcTransaction | null | "offline">, readable = "mainnet"): import("../src/lib/proofs/solanaPayment").SolanaPaymentDeps {
  return {
    getTransaction: async (_n, sig) => {
      const t = txs[sig];
      if (t === "offline") throw new Error("down");
      return t ?? null;
    },
    utxoHash: client.solanaUtxoHash,
    verifyEd25519: isPlainSignature,
    base58Encode: fromB58,
    base58Decode: toB58,
    readable: (n) => n === readable,
    now: () => NOW,
    when: (u) => `t${u}`,
  };
}

function sign(p: Omit<import("../src/lib/proofs/solanaPayment").SolanaPaymentProof, "signature">, by = bob) {
  const s = by.sign(pay.solanaPaymentMessage(p));
  let b = "";
  for (const x of s) b += String.fromCharCode(x);
  return { ...p, signature: btoa(b) } as import("../src/lib/proofs/solanaPayment").SolanaPaymentProof;
}

const blinding = bytes(32, 1);
blinding[0] = 0; // a field element
const toBob: Out = { owner: bob, asset: USDC, amount: 2_500_000n, blinding };
const change: Out = { owner: alice, asset: USDC, amount: 7_500_000n, blinding: (() => { const b = bytes(32, 8); b[0] = 0; return b; })() };
const base = {
  v: 1 as const,
  kind: "solana-payment" as const,
  network: "mainnet" as const,
  tx: SIG,
  ix: 0,
  output: 1,
  account: addrOf(bob),
  asset: USDC,
  amount: "2500000",
  nullifierKey: pay.hexOf(bob.shieldedAddress().nullifierPublicKey),
  blinding: pay.hexOf(blinding),
  tree: 0,
  dataHash: null,
  verifier: "Acme Bank",
  expiresAt: NOW + 3600,
};

const verdict = (r: Awaited<ReturnType<typeof pay.verifySolanaPayment>>) => r.checks.map((c) => `${c.state}:${c.label}`);
const failed = (r: Awaited<ReturnType<typeof pay.verifySolanaPayment>>, label: string) => !r.ok && r.checks.some((c) => c.state === "fail" && c.label.startsWith(label));

{
  // The Default Ring: the circuit names the hidden owner who spent (Alice).
  const anon = txOf(instruction([change, toBob], { kind: "anon", owner: keyOf(alice) }), [relay]);
  const good = sign(base);
  const r = await pay.verifySolanaPayment(good, deps({ [SIG]: anon }));
  ok(r.ok, `a payment from Alice to Bob, proven by Bob, verifies: ${verdict(r).join(" | ")}`);
  eq(r.paidAt, 1_795_000_000, "it says when the payment landed");
  eq(r.from, addrOf(alice), "and who paid, as the Default Ring shows it");
  eq(
    r.checks.map((c) => c.label),
    ['Made for "Acme Bank"', "A private payment on Solana", "Asset and amount match the payment", "Paid to this private account", "From another account", "Not expired"],
    "the checks, in order"
  );

  // The text form round trips, and the dispatcher knows it.
  const text = pay.encodeSolanaPayment(good);
  ok(text.startsWith("gloamsolpay1:"), "its prefix");
  eq(pay.decodeSolanaPayment(text), good, "it decodes to the same proof");
  ok(chain.isChainProofText(text) && chain.decodeChainProof(text).kind === "solana-payment", "the verify page's dispatcher reads it");
  assert.throws(() => pay.decodeSolanaPayment(text.slice(0, 40)), /damaged/);
  pass++;
  assert.throws(() => pay.decodeSolanaPayment(pay.encodeSolanaPayment({ ...good, amount: "-1" })), /damaged/);
  pass++;

  // A confidential-signer payment Bob did not sign: Alice and the relay signed it.
  const signer = txOf(instruction([change, toBob], { kind: "signer" }), [relay, addrOf(alice)]);
  ok((await pay.verifySolanaPayment(good, deps({ [SIG]: signer }))).ok, "a confidential-signer payment Bob didn't sign verifies");
  // An in-proof Ed25519 owner (Alice).
  const eddsa = txOf(instruction([change, toBob], { kind: "eddsa", owner: keyOf(alice) }), [relay]);
  ok((await pay.verifySolanaPayment(good, deps({ [SIG]: eddsa }))).ok, "an in-proof owner payment verifies");

  /* tampered */
  const edited = { ...good, amount: "9900000" };
  ok(failed(await pay.verifySolanaPayment(edited, deps({ [SIG]: anon })), "Made for"), "an edited amount breaks the signature");
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, amount: "9900000" }), deps({ [SIG]: anon })), "Asset and amount"), "a bigger amount, signed again by Bob, doesn't open the payment");
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }), deps({ [SIG]: anon })), "Asset and amount"), "another asset doesn't open it");
  ok(failed(await pay.verifySolanaPayment({ ...good, verifier: "Someone Else" }, deps({ [SIG]: anon })), "Made for"), "an edited label breaks the signature");
  ok(failed(await pay.verifySolanaPayment({ ...good, expiresAt: good.expiresAt + 99_999 }, deps({ [SIG]: anon })), "Made for"), "an edited expiry breaks the signature");
  ok(failed(await pay.verifySolanaPayment(sign(base, alice), deps({ [SIG]: anon })), "Made for"), "Bob's payment signed by Alice fails: only the account paid can prove it");
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, account: addrOf(alice) }, alice), deps({ [SIG]: anon })), "Asset and amount"), "Alice can't claim Bob's payment as hers");
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, output: 0 }), deps({ [SIG]: anon })), "Asset and amount"), "another output of the same transaction fails");
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, output: 5 }), deps({ [SIG]: anon })), "A private payment"), "an output that isn't there fails");
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, ix: 1 }), deps({ [SIG]: anon })), "A private payment"), "an instruction that isn't the pool's fails");
  const expired = await pay.verifySolanaPayment(sign({ ...base, expiresAt: NOW - 1 }), deps({ [SIG]: anon }));
  ok(!expired.ok && expired.expired && expired.checks.at(-1)?.label === "Expired", "an expired proof is not ok");
  ok(failed(await pay.verifySolanaPayment({ ...good, signature: btoa("x".repeat(64)) }, deps({ [SIG]: anon })), "Made for"), "a junk signature fails");

  /* not a payment from someone else */
  const selfAnon = txOf(instruction([toBob, toBob], { kind: "anon", owner: keyOf(bob) }), [relay]);
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, output: 0 }), deps({ [SIG]: selfAnon })), "From another account"), "Bob's own change fails");
  const bobSigned = txOf(instruction([change, toBob], { kind: "signer" }), [relay, addrOf(bob)]);
  ok(failed(await pay.verifySolanaPayment(good, deps({ [SIG]: bobSigned })), "From another account"), "a payment Bob signed himself fails");
  const hidden = await pay.verifySolanaPayment(good, deps({ [SIG]: txOf(instruction([change, toBob], { kind: "ring" }), [relay]) }));
  ok(!hidden.ok && hidden.checks.find((c) => c.label === "From another account")?.state === "unknown", "a circuit that hides who paid is never a pass");
  const anonNoTag = txOf(instruction([change, toBob], { kind: "anon", owner: null }), [relay]);
  ok(!(await pay.verifySolanaPayment(good, deps({ [SIG]: anonNoTag }))).ok, "a ring spend with no owner tag is never a pass");
  const wrongTag = txOf(instruction([change, { ...toBob, tag: "account0" }], { kind: "anon", owner: keyOf(alice) }), [relay]);
  ok(failed(await pay.verifySolanaPayment(good, deps({ [SIG]: wrongTag })), "Paid to this private account"), "an output whose public tag names another account fails");

  /* not a private payment */
  ok(failed(await pay.verifySolanaPayment(good, deps({ [SIG]: txOf(instruction([change, toBob], { kind: "anon", owner: keyOf(alice) }, 15), [relay]) })), "A private payment"), "a deposit instruction fails");
  ok(failed(await pay.verifySolanaPayment(good, deps({ [SIG]: txOf(anon.transaction!.message!.instructions![0]!.data!, [relay], { err: { InstructionError: [0, "Custom"] } }) })), "A private payment"), "a failed transaction paid nothing");
  // A planted hash: Bob's commitment hidden inside an output's ciphertext, not an output.
  const planted = txOf(instruction([{ ...change, data: new Uint8Array([...utxoHashOf(toBob), ...bytes(57, 1)]) }], { kind: "anon", owner: keyOf(alice) }), [relay]);
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, output: 0 }), deps({ [SIG]: planted })), "Asset and amount"), "a hash planted in a ciphertext is never read as an output");

  /* wrong chain */
  ok(failed(await pay.verifySolanaPayment(sign({ ...base, network: "devnet" }), deps({ [SIG]: anon })), "Made on Solana devnet"), "a devnet proof on a mainnet page fails");
  ok(failed(await pay.verifySolanaPayment({ ...good, network: "devnet" }, deps({ [SIG]: anon }, "devnet")), "Made for"), "switching the network breaks the signature");
  ok(failed(await pay.verifySolanaPayment(good, deps({})), "A private payment"), "a transaction the network doesn't have fails");
  const down = await pay.verifySolanaPayment(good, deps({ [SIG]: "offline" }));
  ok(!down.ok && down.checks.some((c) => c.state === "unknown") && !down.checks.some((c) => c.state === "fail"), "an unreachable network is 'could not check', never a pass");
}

/* ------------------------------------------------------------------ the signed message can't pass for a transaction */
{
  const m = pay.solanaPaymentMessage({ ...base });
  eq(m[0], 0xff, "it starts with 0xff, never the first byte of a Solana transaction message");
  ok(new TextDecoder().decode(m.subarray(1)).startsWith('["gloam proof of payment on solana v1"'), "then its own domain");
}

console.log(`selftest-prove-solana: ${pass} checks passed`);
