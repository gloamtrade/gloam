/**
 * Spike: Gloam's account layer on the Helius Default Ring, localnet only.
 *
 * Each Gloam user gets a private Solana account that is not their main wallet:
 * a fresh Ed25519 key derived from the main wallet's signature over a fixed
 * Gloam message (lib.ts deriveAccount). The wallet is the backup: the same
 * signature reopens the same account on any device. Gloam's relayer pays the
 * fees, so the private account never needs SOL from the main wallet.
 *
 * Flow (Alice pays Bob, then rotates to a fresh account and cashes out):
 *  1. Alice's main wallet signs the account message for accounts 0 and 1;
 *     Bob's for account 0. Re-deriving gives the same addresses.
 *  2. Register Alice-0, Alice-1 and Bob-0, the relayer paying.
 *  3. Alice's main wallet deposits SOL into Alice-0.
 *  4. Alice-0 pays Bob-0 privately (relayer pays the fee).
 *  5. Rotation: Alice-0 moves its whole balance to Alice-1.
 *  6. Alice-1 cashes out to a fresh public address.
 * After each transaction it lists which of the named addresses appear in the
 * transaction's bytes: that is what anyone reading the chain can link.
 *
 *   pnpm account-layer
 */
import { LocalKeys, MergeEncryptionScheme, SOL_MINT, SigningKey, ShieldedKeypair, createSprClient, initializePoseidon } from "@heliuslabs/spr";
import { getRegisterInstructionAsync, getSetMergeEncryptionInstructionAsync } from "@heliuslabs/spr/instructions";
import { DepositAsset, TransactWithdrawal, depositInstruction, transactInstruction } from "@heliuslabs/spr/interface";
import { AssetRegistry, ConfidentialTransfer, ProofInputUtxo, WithdrawalTarget } from "@heliuslabs/spr/transaction";
import { isWalletRegistered } from "@heliuslabs/spr/wallet";
import { generateKeyPairSigner, type Address, type TransactionSigner } from "@solana/kit";
import {
  INDEXER,
  PROVER,
  RPC,
  accountMessage,
  addressesIn,
  airdrop,
  balanceOf,
  deriveAccount,
  sendWith,
  sha256Hex,
  short,
  walletSignMessage,
  type Client,
  type Confirmed,
} from "./lib.js";

const DEPOSIT = 10_000_000n;
const PAY = 3_000_000n;
const CASH_OUT = 2_000_000n;

async function register(client: Client, relayer: TransactionSigner, account: ShieldedKeypair) {
  const owner = account.toSolanaSigner();
  const addr = account.shieldedAddress();
  const tx = await sendWith(client, relayer)([
    await getRegisterInstructionAsync({
      owner,
      payer: relayer,
      nullifierPublicKey: addr.nullifierPublicKey,
      viewingPublicKey: addr.viewingPublicKey.toBytes(),
    }),
    await getSetMergeEncryptionInstructionAsync({ owner, scheme: MergeEncryptionScheme.PoseidonCtrV1 }),
  ]);
  if (!(await isWalletRegistered({ rpc: client, owner: owner.address }))) throw new Error("registration failed");
  return tx;
}

/** A private transfer out of `from`, the relayer paying the fee; `to` null means a cash out to `cashOut`. */
async function spend(
  client: Client,
  relayer: TransactionSigner,
  assets: AssetRegistry,
  from: ShieldedKeypair,
  inputs: Parameters<typeof ProofInputUtxo.fromKeypair>[0][],
  move: { to: ShieldedKeypair; amount: bigint } | { cashOut: Address; amount: bigint },
): Promise<Confirmed> {
  const owner = from.toSolanaSigner();
  const keys = LocalKeys.fromKeypair(from, client.proofService);
  try {
    // The fee payer is bound into the proof, so a sponsored transfer names the relayer here.
    const t = new ConfidentialTransfer(
      from.shieldedAddress(),
      inputs.map((u) => ProofInputUtxo.fromKeypair(u, from)),
      relayer.address,
    );
    if ("to" in move) t.send(move.to.shieldedAddress(), SOL_MINT, move.amount);
    else t.withdraw(SOL_MINT, move.amount, WithdrawalTarget.sol({ recipient: move.cashOut }));
    const data = await client.proveTransact(t.sign(from, assets), keys);
    return await sendWith(client, relayer)([
      await transactInstruction({
        payer: relayer,
        ownerSigners: [owner],
        inputTree: client.tree,
        outputTree: client.tree,
        ...("cashOut" in move ? { withdrawal: TransactWithdrawal.sol({ recipient: move.cashOut }) } : {}),
        data,
      }),
    ]);
  } finally {
    keys.destroy();
  }
}

async function main() {
  await initializePoseidon();
  const client = await createSprClient({ solanaRpcUrl: RPC, indexerUrl: INDEXER, proverUrl: PROVER });
  const assets = new AssetRegistry();

  // Main wallets (stand-ins for Phantom / Solflare), Gloam's relayer, a cash-out address
  const aliceMain = SigningKey.generate("ed25519");
  const bobMain = SigningKey.generate("ed25519");
  const aliceMainSigner = ShieldedKeypair.fromKeypair(aliceMain).toSolanaSigner(); // used only as a plain Solana signer
  const bobMainAddress = ShieldedKeypair.fromKeypair(bobMain).toSolanaSigner().address;
  const relayer = await generateKeyPairSigner();
  const cashOut = (await generateKeyPairSigner()).address;
  await airdrop(client, relayer.address, 2_000_000_000n);
  await airdrop(client, aliceMainSigner.address, 1_000_000_000n);

  // 1. Derive the private accounts from main-wallet signatures
  const aliceSig0 = walletSignMessage(aliceMain, accountMessage(0));
  const aliceSig1 = walletSignMessage(aliceMain, accountMessage(1));
  const bobSig0 = walletSignMessage(bobMain, accountMessage(0));
  const alice0 = deriveAccount(aliceSig0, 0);
  const alice1 = deriveAccount(aliceSig1, 1);
  const bob0 = deriveAccount(bobSig0, 0);
  const again = deriveAccount(walletSignMessage(aliceMain, accountMessage(0)), 0);
  const deterministic = again.toSolanaSigner().address === alice0.toSolanaSigner().address;
  again.destroy();
  const names: Record<string, Address> = {
    "Alice main wallet": aliceMainSigner.address,
    "Bob main wallet": bobMainAddress,
    "Alice private #0": alice0.toSolanaSigner().address,
    "Alice private #1": alice1.toSolanaSigner().address,
    "Bob private #0": bob0.toSolanaSigner().address,
    "Gloam relayer": relayer.address,
    "cash-out address": cashOut,
  };
  for (const [n, a] of Object.entries(names)) console.log(`${n.padEnd(18)} ${a}`);
  console.log(`1. re-derived from the same wallet signature: ${deterministic ? "same account" : "DIFFERENT"} (signature sha256 ${sha256Hex(aliceSig0)}…)`);
  if (!deterministic) throw new Error("account derivation is not deterministic");

  const report = async (label: string, tx: Confirmed) => {
    const { bytes, seen } = await addressesIn(client, tx.signature, names);
    console.log(`   [public] ${label}: ${bytes} bytes; addresses in the transaction: ${seen.join(", ")}`);
  };

  // 2. Register the private accounts, the relayer paying (the accounts hold no SOL)
  for (const [n, acc] of [["Alice private #0", alice0], ["Alice private #1", alice1], ["Bob private #0", bob0]] as const) {
    await report(`register ${n}`, await register(client, relayer, acc));
  }
  console.log(`2. registered; private accounts' public SOL: ${await client.getBalance(names["Alice private #0"]!)} / ${await client.getBalance(names["Bob private #0"]!)}`);

  // 3. Alice's main wallet deposits into Alice private #0
  const a0 = alice0.shieldedAddress();
  const deposit = await sendWith(client, aliceMainSigner)([
    await depositInstruction({
      tree: client.tree,
      depositor: aliceMainSigner,
      deposits: [{ asset: DepositAsset.sol(), viewTag: a0.confidentialViewTag(), recipientOwnerHash: a0.ownerHash(), amount: DEPOSIT }],
    }),
  ]);
  const afterDeposit = await balanceOf(client, alice0, assets, deposit);
  console.log(`3. deposit ${DEPOSIT} from Alice's main wallet into Alice private #0: private balance ${afterDeposit.amount}`);
  await report("deposit", deposit);

  // 4. Alice private #0 pays Bob private #0
  const pay = await spend(client, relayer, assets, alice0, [afterDeposit.utxos[0]!], { to: bob0, amount: PAY });
  const bobHas = await balanceOf(client, bob0, assets, pay);
  const aliceChange = await balanceOf(client, alice0, assets, pay);
  console.log(`4. Alice #0 paid Bob #0 ${PAY}: Bob #0 decrypts ${bobHas.amount}; Alice #0 change ${aliceChange.amount}`);
  await report("payment", pay);

  // 5. Rotation: Alice private #0 moves its whole balance to Alice private #1
  const rotate = await spend(client, relayer, assets, alice0, [aliceChange.utxos[0]!], { to: alice1, amount: aliceChange.amount });
  const a1 = await balanceOf(client, alice1, assets, rotate);
  const a0Left = await balanceOf(client, alice0, assets, rotate);
  console.log(`5. rotated: Alice #1 now ${a1.amount}; Alice #0 left ${a0Left.amount}`);
  await report("rotation", rotate);

  // 6. Alice private #1 cashes out to a fresh public address
  const out = await spend(client, relayer, assets, alice1, [a1.utxos[0]!], { cashOut, amount: CASH_OUT });
  const a1Left = await balanceOf(client, alice1, assets, out);
  console.log(`6. cashed out ${CASH_OUT}: cash-out address holds ${await client.getBalance(cashOut)}; Alice #1 left ${a1Left.amount}`);
  await report("cash out", out);

  for (const k of [alice0, alice1, bob0]) k.destroy();
  console.log("account-layer spike: ok");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
