/**
 * Spike: a Gloam private balance on Solana through Helius Solana Privacy Rings
 * (permissionless confidential Default Ring), run end to end on a localnet.
 *
 * Localnet: `zolana dev start` (zolana CLI cli-v0.10.0) runs surfpool on :8899,
 * the Photon indexer on :8784 and a local prover on :3001. No API key, no
 * mainnet, no real money: every key here is generated fresh and thrown away.
 *
 *   pnpm install --ignore-workspace
 *   pnpm spike
 *
 * What it does, and what each step shows on the public chain:
 *  0. Two fresh wallets (sender, recipient) and one fresh public address.
 *  1. Wallet as backup: the shielded keys re-derived from nothing but the
 *     wallet's signature over the "TSPP/derive/v1" off-chain message, as a
 *     browser wallet's signMessage would give it, match the keypair's own.
 *  2. Register both private wallets in the user registry.
 *  3. Deposit SOL into the sender's private balance.
 *  4. Read the private balance by decrypting locally.
 *  5. Private transfer to the recipient; the recipient decrypts it.
 *  6. Withdraw to the fresh public address.
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import {
  LocalKeys,
  SOL_MINT,
  ShieldedKeypair,
  SigningKey,
  MergeEncryptionScheme,
  createSprClient,
  initializePoseidon,
} from "@heliuslabs/spr";
import { atSlot } from "@heliuslabs/spr/client";
import {
  getRegisterInstructionAsync,
  getSetMergeEncryptionInstructionAsync,
} from "@heliuslabs/spr/instructions";
import { DepositAsset, TransactWithdrawal, depositInstruction, transactInstruction } from "@heliuslabs/spr/interface";
import { ed25519DerivationMessage } from "@heliuslabs/spr/keypair";
import {
  AssetRegistry,
  ConfidentialTransfer,
  ProofInputUtxo,
  WithdrawalTarget,
  decryptToBalances,
} from "@heliuslabs/spr/transaction";
import { isWalletRegistered } from "@heliuslabs/spr/wallet";
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  generateKeyPairSigner,
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

const RPC = process.env["SPIKE_RPC_URL"] ?? "http://127.0.0.1:8899";
const INDEXER = process.env["SPIKE_INDEXER_URL"] ?? "http://127.0.0.1:8784";
const PROVER = process.env["SPIKE_PROVER_URL"] ?? "http://127.0.0.1:3001";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC)) {
  throw new Error("this spike runs on localnet only");
}

const DEPOSIT = 10_000_000n; // 0.01 SOL
const TRANSFER = 3_000_000n;
const WITHDRAW = 3_000_000n;

type Client = Awaited<ReturnType<typeof createSprClient>>;
type Confirmed = { signature: Signature; slot: bigint };

/** What a public observer sees in one transaction: signers, accounts and every lamport change. */
async function publicView(client: Client, label: string, signature: Signature, watch: Record<string, Address>) {
  const tx = await client.solanaRpc
    .getTransaction(signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" } as never)
    .send();
  if (!tx) throw new Error(`${label}: transaction not found`);
  const t = tx as unknown as {
    meta: { fee: bigint | number; preBalances: (bigint | number)[]; postBalances: (bigint | number)[] };
    transaction: { message: { accountKeys: string[]; header: { numRequiredSignatures: number } } };
  };
  const keys = t.transaction.message.accountKeys;
  const signers = keys.slice(0, t.transaction.message.header.numRequiredSignatures);
  const named = new Map(Object.entries(watch).map(([k, v]) => [v as string, k]));
  const deltas = keys
    .map((k, i) => ({ k, d: BigInt(t.meta.postBalances[i] ?? 0) - BigInt(t.meta.preBalances[i] ?? 0) }))
    .filter((x) => x.d !== 0n)
    .map((x) => `${named.get(x.k) ?? x.k.slice(0, 8) + "…"} ${x.d > 0n ? "+" : ""}${x.d}`);
  console.log(`  [public] ${label}`);
  console.log(`    signers: ${signers.map((s) => named.get(s) ?? s.slice(0, 8) + "…").join(", ")}`);
  console.log(`    accounts touched: ${keys.length}; fee: ${t.meta.fee} lamports`);
  console.log(`    lamport changes: ${deltas.join("; ") || "none"}`);
}

function sender(client: Client, feePayer: TransactionSigner) {
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

async function airdrop(client: Client, to: Address, amount: bigint) {
  const sig = await client.solanaRpc.requestAirdrop(to, lamports(amount)).send();
  await client.confirmTransaction(sig);
}

async function balanceOf(client: Client, who: ShieldedKeypair, assets: AssetRegistry, tx: Confirmed) {
  const res = await client.getShieldedTransactionsBySignature(tx.signature, atSlot(tx.slot));
  const balances = await decryptToBalances({
    keypair: who,
    registry: assets,
    transactions: res.transactions.map(({ transaction }) => transaction),
  });
  return balances.balance(SOL_MINT);
}

async function main() {
  await initializePoseidon();
  const client = await createSprClient({ solanaRpcUrl: RPC, indexerUrl: INDEXER, proverUrl: PROVER });
  const assets = new AssetRegistry();

  // 0. Fresh throwaway wallets
  const senderKey = SigningKey.generate("ed25519");
  const alice = ShieldedKeypair.fromKeypair(senderKey);
  const bob = ShieldedKeypair.generate();
  const aliceSigner = alice.toSolanaSigner();
  const bobSigner = bob.toSolanaSigner();
  const cashOut = (await generateKeyPairSigner()).address;
  const watch = { sender: aliceSigner.address, recipient: bobSigner.address, cashOut };
  console.log(`sender ${aliceSigner.address}\nrecipient ${bobSigner.address}\ncash-out address ${cashOut}`);
  await airdrop(client, aliceSigner.address, 1_000_000_000n);
  await airdrop(client, bobSigner.address, 100_000_000n);

  // 1. Wallet as backup: only the wallet's signature over the derivation message is needed
  // The SDK's own SigningKey refuses to sign a derivation message (KEYPAIR_DERIVATION_INPUT),
  // so a plain Ed25519 signer stands in for the browser wallet's signMessage here.
  const pubkeyBytes = new Uint8Array(getAddressEncoder().encode(aliceSigner.address));
  const derivationMessage = ed25519DerivationMessage(pubkeyBytes as never);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(senderKey.secretBytes())]);
  const walletKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const walletSignature = new Uint8Array(cryptoSign(null, derivationMessage, walletKey)); // what signMessage returns
  const fromSignature = LocalKeys.fromDerivationSeed(
    { solanaPublicKey: aliceSigner.address, derivationSeed: walletSignature },
    client.proofService,
  );
  const same =
    Buffer.from(fromSignature.address().toBytes()).equals(Buffer.from(alice.shieldedAddress().toBytes())) &&
    Buffer.from(walletSignature).equals(Buffer.from(senderKey.derivationSeed()));
  console.log(`1. shielded keys re-derived from the wallet's signature alone: ${same ? "MATCH" : "DIFFERENT"}`);
  fromSignature.destroy();
  if (!same) throw new Error("derivation from the wallet signature did not reproduce the shielded address");

  // 2. Register both private wallets
  for (const [who, kp] of [["sender", alice], ["recipient", bob]] as const) {
    const signer = kp.toSolanaSigner();
    const addr = kp.shieldedAddress();
    const reg = await sender(client, signer)([
      await getRegisterInstructionAsync({
        owner: signer,
        nullifierPublicKey: addr.nullifierPublicKey,
        viewingPublicKey: addr.viewingPublicKey.toBytes(),
      }),
      await getSetMergeEncryptionInstructionAsync({ owner: signer, scheme: MergeEncryptionScheme.PoseidonCtrV1 }),
    ]);
    const ok = await isWalletRegistered({ rpc: client, owner: signer.address });
    console.log(`2. registered ${who}: ${ok}`);
    await publicView(client, `register ${who}`, reg.signature, watch);
  }

  // 3. Deposit
  const aliceAddress = alice.shieldedAddress();
  const deposit = await sender(client, aliceSigner)([
    await depositInstruction({
      tree: client.tree,
      depositor: aliceSigner,
      deposits: [
        {
          asset: DepositAsset.sol(),
          viewTag: aliceAddress.confidentialViewTag(),
          recipientOwnerHash: aliceAddress.ownerHash(),
          amount: DEPOSIT,
        },
      ],
    }),
  ]);
  console.log(`3. deposited ${DEPOSIT} lamports, tx ${deposit.signature}`);
  await publicView(client, "deposit", deposit.signature, watch);

  // 4. Private balance, decrypted locally
  const afterDeposit = await balanceOf(client, alice, assets, deposit);
  console.log(`4. sender private balance (decrypted locally): ${afterDeposit.amount} in ${afterDeposit.utxos.length} UTXO(s)`);

  // 5. Private transfer to the recipient
  const aliceKeys = LocalKeys.fromKeypair(alice, client.proofService);
  const t = new ConfidentialTransfer(aliceAddress, [ProofInputUtxo.fromKeypair(afterDeposit.utxos[0]!, alice)], aliceSigner.address);
  t.send(bob.shieldedAddress(), SOL_MINT, TRANSFER);
  const tProof = await client.proveTransact(t.sign(alice, assets), aliceKeys);
  const transfer = await sender(client, aliceSigner)([
    await transactInstruction({ payer: aliceSigner, ownerSigners: [aliceSigner], inputTree: client.tree, outputTree: client.tree, data: tProof }),
  ]);
  console.log(`5. private transfer of ${TRANSFER}, tx ${transfer.signature}`);
  await publicView(client, "private transfer", transfer.signature, watch);
  const bobGot = await balanceOf(client, bob, assets, transfer);
  const aliceLeft = await balanceOf(client, alice, assets, transfer);
  console.log(`   recipient decrypts: ${bobGot.amount}; sender change: ${aliceLeft.amount}`);

  // 6. Withdraw to a fresh public address
  const w = new ConfidentialTransfer(aliceAddress, [ProofInputUtxo.fromKeypair(aliceLeft.utxos[0]!, alice)], aliceSigner.address);
  w.withdraw(SOL_MINT, WITHDRAW, WithdrawalTarget.sol({ recipient: cashOut }));
  const wProof = await client.proveTransact(w.sign(alice, assets), aliceKeys);
  const withdrawal = await sender(client, aliceSigner)([
    await transactInstruction({
      payer: aliceSigner,
      ownerSigners: [aliceSigner],
      inputTree: client.tree,
      outputTree: client.tree,
      withdrawal: TransactWithdrawal.sol({ recipient: cashOut }),
      data: wProof,
    }),
  ]);
  console.log(`6. withdrew ${WITHDRAW} to ${cashOut}, tx ${withdrawal.signature}`);
  await publicView(client, "withdraw", withdrawal.signature, watch);
  const left = await balanceOf(client, alice, assets, withdrawal);
  const publicCashOut = await client.getBalance(cashOut);
  console.log(`   sender private balance now ${left.amount}; cash-out address public balance ${publicCashOut}`);

  aliceKeys.destroy();
  alice.destroy();
  bob.destroy();
  console.log("spike: ok");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
