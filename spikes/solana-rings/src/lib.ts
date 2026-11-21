/** Shared localnet helpers for the account-layer spike. Localnet only. */
import { createHash, createPrivateKey, hkdfSync, sign as cryptoSign } from "node:crypto";
import { SOL_MINT, ShieldedKeypair, SigningKey, createSprClient } from "@heliuslabs/spr";
import { atSlot } from "@heliuslabs/spr/client";
import { AssetRegistry, decryptToBalances } from "@heliuslabs/spr/transaction";
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getAddressEncoder,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";

export const RPC = process.env["SPIKE_RPC_URL"] ?? "http://127.0.0.1:8899";
export const INDEXER = process.env["SPIKE_INDEXER_URL"] ?? "http://127.0.0.1:8784";
export const PROVER = process.env["SPIKE_PROVER_URL"] ?? "http://127.0.0.1:3001";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC)) {
  throw new Error("this spike runs on localnet only");
}

export type Client = Awaited<ReturnType<typeof createSprClient>>;
export type Confirmed = { signature: Signature; slot: bigint };

/** Sign with every signer the instructions carry, `feePayer` paying; wait for confirmation. */
export function sendWith(client: Client, feePayer: TransactionSigner) {
  const send = sendTransactionWithoutConfirmingFactory({ rpc: client.solanaRpc });
  return async (instructions: readonly Instruction[]): Promise<Confirmed> => {
    const { value: lifetime } = await client.solanaRpc.getLatestBlockhash().send();
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => setTransactionMessageConfig({ computeUnitLimit: 450_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 }, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );
    assertIsTransactionWithBlockhashLifetime(signed);
    await send(signed, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(signed);
    const slot = await client.confirmTransaction(signature);
    return { signature, slot };
  };
}

export async function airdrop(client: Client, to: Address, amount: bigint) {
  const sig = await client.solanaRpc.requestAirdrop(to, lamports(amount)).send();
  await client.confirmTransaction(sig);
}

/** The SOL balance this transaction gives `who`, decrypted locally with `who`'s viewing key. */
export async function balanceOf(client: Client, who: ShieldedKeypair, assets: AssetRegistry, tx: Confirmed) {
  const res = await client.getShieldedTransactionsBySignature(tx.signature, atSlot(tx.slot));
  const balances = await decryptToBalances({
    keypair: who,
    registry: assets,
    transactions: res.transactions.map(({ transaction }) => transaction),
  });
  return balances.balance(SOL_MINT);
}

/**
 * A stand-in for a browser wallet's `signMessage`: a plain Ed25519 signature
 * over `message` with the wallet's secret. The real app gets these bytes from
 * Phantom / Solflare and never sees the secret.
 */
export function walletSignMessage(wallet: SigningKey, message: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(wallet.secretBytes())]);
  return new Uint8Array(cryptoSign(null, message, createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })));
}

/** The text the main wallet signs to open private account `index`. Changing it changes every user's account. */
export function accountMessage(index: number): Uint8Array {
  return new TextEncoder().encode(
    `Gloam private account on Solana\n\nSign to open your private account. This signature is its key: only sign it on gloam.trade.\n\nVersion: 1\nAccount: ${index}`,
  );
}

/**
 * Gloam's account layer: private account `index` of a main wallet is a fresh
 * Ed25519 key whose 32-byte seed is HKDF-SHA256 over the main wallet's
 * signature of `accountMessage(index)`. Ed25519 signatures are deterministic,
 * so the same wallet always reopens the same accounts: the wallet is the
 * backup. The account's shielded nullifier and viewing keys then come from the
 * account key itself (the SDK's "TSPP/derive/v1" derivation), never from the
 * main wallet.
 */
export function deriveAccount(walletSignature: Uint8Array, index: number): ShieldedKeypair {
  const seed = new Uint8Array(
    hkdfSync("sha256", walletSignature, Buffer.from("gloam/solana-account/v1"), Buffer.from(`account/${index}`), 32),
  );
  try {
    return ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as never));
  } finally {
    seed.fill(0);
  }
}

/** Which of the named Solana addresses appear anywhere in a transaction's bytes (accounts or instruction data). */
export async function addressesIn(client: Client, signature: Signature, named: Record<string, Address>) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
    }),
  });
  const body = (await res.json()) as { result?: { transaction: [string, string]; meta: { preBalances: number[]; postBalances: number[] } } };
  if (!body.result) throw new Error(`transaction ${signature} not found`);
  const raw = Buffer.from(body.result.transaction[0], "base64");
  const enc = getAddressEncoder();
  const seen = Object.entries(named)
    .filter(([, a]) => raw.includes(Buffer.from(enc.encode(a))))
    .map(([n]) => n);
  return { bytes: raw.length, seen };
}

export function short(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function sha256Hex(b: Uint8Array) {
  return createHash("sha256").update(b).digest("hex").slice(0, 16);
}
