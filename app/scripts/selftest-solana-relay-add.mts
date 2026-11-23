/**
 * Self-test: a wallet with no SOL adding a token to its private balance on
 * Solana, Gloam's relay paying the network fee (lib/solanaRings/relayPolicy's
 * one version 0 shape, client buildAddFor and relayPaidAdd, config
 * addFeePayer, /api/solana/relay).
 *
 *  - who pays: the wallet whenever it can pay the fee and be left empty or
 *    rent-exempt; the relay only for a token, only when it is on and funded
 *    and the wallet can sign without sending; otherwise the wallet is told it
 *    needs a little SOL;
 *  - the fee: what a wallet's own add costs it, and the relay's unit price
 *    keeping the fee Solana charges within the relay's cap;
 *  - the policy: the add the client builds passes once the wallet signed, as a
 *    deposit with no rent. Refused: an extra instruction (a transfer, a memo,
 *    a payment, a second deposit), an address lookup table, a third signer,
 *    the relay named in the deposit or as depositor, the relay's signature
 *    already there or the wallet's missing, another fee payer, a priority fee
 *    over the cap, two unit prices or two unit limits, a unit limit over the
 *    cap, any other compute budget instruction, one naming an account, a
 *    deposit under the floor or of an unlisted asset, a legacy transaction. A
 *    SOL deposit passes, as it does in version 1; version 1 rules unchanged;
 *  - the client against a fake chain and the real relay route (Helius faked):
 *    a wallet with SOL pays and the relay is never asked; a wallet with none
 *    signs only and the relay sends; relay off, unfunded, or a wallet that can
 *    only sign and send: it says the wallet needs SOL; a wallet that changes
 *    the transaction is stopped before the relay; a relay that can't pay says
 *    so plainly; a lost answer ends as not confirmed, never sent again;
 *  - the route: such an add counts as a payment (no rent) and by its
 *    depositor, 20 a day, from any IP; fails closed on mainnet without Redis.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-relay-add.mts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";
env.HELIUS_API_KEY = "selftest-helius-key-0000";
delete env.CHAINALYSIS_API_KEY;
delete env.UPSTASH_REDIS_REST_URL;
delete env.UPSTASH_REDIS_REST_TOKEN;
// The relay's key: a throwaway made here, in this process only.
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  env.GLOAM_SOLANA_RELAYER_SECRET = getBase58Decoder().decode(new Uint8Array([...seed, ...pub]));
}
// A browser for the client: its origin and storage.
const ORIGIN = "http://localhost:3999";
{
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    location: { origin: ORIGIN },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
}

const policy = await import("../src/lib/solanaRings/relayPolicy");
const config = await import("../src/lib/solanaRings/config");
const landing = await import("../src/lib/solanaRings/landing");
const server = await import("../src/lib/solanaRings/server");
const arrivals = await import("../src/lib/solanaRings/arrivals");
const client = await import("../src/lib/solanaRings/client");
const spr = await import("@heliuslabs/spr");
const { getTreeAddress, getAssociatedTokenAddress } = await import("@heliuslabs/spr/addresses");

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};

const relayer = (await server.relayerSigner())!;
ok(relayer, "the throwaway relay key loads");
await spr.initializePoseidon();
const priv = spr.ShieldedKeypair.fromKeypair(spr.SigningKey.fromEd25519Bytes(crypto.getRandomValues(new Uint8Array(32)) as never));
const owner = priv.toSolanaSigner();
const mainSigner = await generateKeyPairSigner();
const main = mainSigner.address;
const stranger = await generateKeyPairSigner();
const assets = config.ringsAssets("mainnet");
const USDC = assets.find((a) => a.id === "usdc")!;
const USDT = assets.find((a) => a.id === "usdt")!;
const ZEC = assets.find((a) => a.id === "zec")!;
const SOL = assets.find((a) => a.id === "sol")!;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address; // ggignore
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const lifetime = { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(7)) as never, lastValidBlockHeight: 1_000n };
const fakeClient = { tree: getTreeAddress(0), treeId: 0, getLatestBlockhash: async () => lifetime, getAccount: async () => undefined };

const encode = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));
const decode = (w: Uint8Array) => getTransactionDecoder().decode(w);
async function signedBy(tx: Transaction, ...signers: KeyPairSigner[]): Promise<Uint8Array> {
  let out = tx;
  for (const s of signers) {
    const [sigs] = await s.signTransactions([out as never]);
    out = { ...out, signatures: { ...out.signatures, ...sigs } } as Transaction;
  }
  return encode(out);
}
const resign = (w: Uint8Array, ...signers: KeyPairSigner[]) => signedBy(decode(w) as Transaction, ...signers);
const feePayerOf = (w: Uint8Array) => (getCompiledTransactionMessageDecoder().decode(decode(w).messageBytes).staticAccounts as readonly string[])[0];
const versionOf = (w: Uint8Array) => getCompiledTransactionMessageDecoder().decode(decode(w).messageBytes).version;
const check = (w: Uint8Array) => policy.checkSponsoredTransaction(w, relayer.address);

// ---------------------------------------------------------------- a stand-in wallet

type WalletMode = { signOnly?: boolean; sendToo?: boolean; tamper?: boolean };
const walletLog = { signed: 0, sent: 0 };
function fakeWallet(mode: WalletMode = { signOnly: true }) {
  const account = { address: main, chains: ["solana:mainnet"] as const };
  const sign = async (transaction: Uint8Array) => {
    walletLog.signed++;
    let tx = decode(transaction) as Transaction;
    if (mode.tamper) {
      // what a wallet adding its own guard instruction would hand back
      const m = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as never);
      const memo = { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: Uint8Array.of(1) } as Instruction;
      tx = compileTransaction(appendTransactionMessageInstructions([memo], m as never) as never) as Transaction;
    }
    return signedBy(tx, mainSigner);
  };
  const features: Record<string, unknown> = { "standard:connect": { connect: async () => ({ accounts: [account] }) } };
  if (mode.signOnly) features["solana:signTransaction"] = { signTransaction: async (i: { transaction: Uint8Array }) => [{ signedTransaction: await sign(i.transaction) }] };
  if (mode.sendToo) {
    features["solana:signAndSendTransaction"] = {
      signAndSendTransaction: async (i: { transaction: Uint8Array }) => {
        walletLog.sent++;
        const w = await sign(i.transaction);
        return [{ signature: (decode(w).signatures as Record<string, Uint8Array>)[main] }];
      },
    };
  }
  const name = "Test Wallet";
  return { name, icon: "", wallet: { name, icon: "", chains: ["solana:mainnet"], accounts: [account], features } };
}
function session(mode?: WalletMode) {
  const w = fakeWallet(mode);
  return {
    network: "mainnet",
    index: 0,
    main: { wallet: w, account: { address: main, account: { address: main, chains: ["solana:mainnet"] } } },
    address: owner.address,
    keypair: priv,
    client: fakeClient,
  } as unknown as import("../src/lib/solanaRings/client").RingsSession;
}

// ---------------------------------------------------------------- who pays

{
  const fee = config.WALLET_ADD_FEE_LAMPORTS;
  const rent = config.RENT_EXEMPT_WALLET_LAMPORTS;
  ok(rent === 890_880n, "a wallet stays rent-exempt at 890,880 lamports (a system account with no data)");
  ok(config.walletPaysFee(fee, fee), "a wallet with exactly the fee pays it and is left empty");
  ok(config.walletPaysFee(fee + rent, fee) && config.walletPaysFee(1_000_000_000n, fee), "a wallet left rent-exempt pays");
  ok(!config.walletPaysFee(fee + rent - 1n, fee), "a wallet left with dust under rent-exempt can't pay: Solana would refuse it");
  ok(!config.walletPaysFee(fee - 1n, fee) && !config.walletPaysFee(0n, fee), "a wallet short of the fee can't pay");

  const relayOn = { on: true, funded: true, relayer: relayer.address as string };
  const pick = (o: Partial<Parameters<typeof config.addFeePayer>[0]>) =>
    config.addFeePayer({ asset: USDC, walletLamports: 0n, relay: relayOn, signOnly: true, ...o });
  ok(pick({}) === "relay", "a token, a wallet with no SOL, the relay on and funded, a wallet that signs only: the relay pays");
  ok(pick({ walletLamports: 5_000_000n }) === "wallet", "a wallet with SOL pays itself");
  ok(pick({ walletLamports: null }) === "wallet", "a balance that couldn't be read: the wallet, as before");
  ok(pick({ asset: SOL }) === "wallet", "SOL itself: always the wallet (no SOL means nothing to add)");
  ok(pick({ asset: USDT }) === "relay" && pick({ asset: ZEC }) === "relay", "USDT and ZEC too");
  ok(pick({ relay: { ...relayOn, funded: false } }) === "needs_sol", "the relay unfunded: the wallet needs SOL");
  ok(pick({ relay: { ...relayOn, on: false } }) === "needs_sol" && pick({ relay: null }) === "needs_sol", "the relay off or unknown: the wallet needs SOL");
  ok(pick({ relay: { ...relayOn, relayer: null } }) === "needs_sol", "no relay address: the wallet needs SOL");
  ok(pick({ signOnly: false }) === "needs_sol", "a wallet that can only sign and send: the wallet needs SOL");
  ok(pick({ walletLamports: fee + rent - 1n }) === "relay" && pick({ walletLamports: fee + rent }) === "wallet", "the line is exactly rent-exempt after the fee");
}

// ---------------------------------------------------------------- the fee

{
  ok(landing.relayUnitPrice(null, 200_000) === 50_000n, "no Helius price: the relay's floor fee (10,000 lamports) as a unit price");
  const high = landing.relayUnitPrice(1_000_000, 200_000);
  ok((high * 200_000n + 999_999n) / 1_000_000n === policy.RELAY_LIMITS.maxPriorityFeeLamports, "a high Helius price: the fee Solana charges is exactly the cap");
  for (const units of [1, 199_999, 200_000, 333_333, 400_000]) {
    for (const price of [null, 1, 7_777, 123_456, 10_000_000]) {
      const p = landing.relayUnitPrice(price, units);
      ok((p * BigInt(units) + 999_999n) / 1_000_000n <= policy.RELAY_LIMITS.maxPriorityFeeLamports, `${units} units at ${price}: never over the cap`);
    }
  }
}

// ---------------------------------------------------------------- what the client builds

const s0 = session();
const walletWire = await client.buildAddTransaction(s0, USDC, 1_000_000n);
ok(versionOf(walletWire) === 0 && feePayerOf(walletWire) === main, "a wallet's own add: version 0, the wallet as fee payer");
ok(landing.feeLamportsOfWire(walletWire) === config.WALLET_ADD_FEE_LAMPORTS, "it costs the wallet 9,000 lamports, what the page goes by");
{
  const v = check(await resign(walletWire, mainSigner));
  ok(!v.ok && /fee payer/.test(v.reason), "the relay never pays for a wallet-paid add");
}
const relayWire = await client.buildAddTransaction(s0, USDC, 1_000_000n, undefined, { address: relayer.address, price: 1_000_000 });
ok(versionOf(relayWire) === 0 && feePayerOf(relayWire) === relayer.address, "the relay-paid add: version 0, the relay as fee payer");
{
  const fee = landing.feeLamportsOfWire(relayWire)!;
  ok(fee === 2n * 5_000n + policy.RELAY_LIMITS.maxPriorityFeeLamports, "what the relay pays: two signatures and the capped priority fee, nothing more");
  const tx = decode(relayWire);
  ok(Object.keys(tx.signatures).length === 2 && Object.keys(tx.signatures).includes(main), "two signers: the relay and the wallet");
  ok(!check(relayWire).ok, "unsigned by the wallet, the relay refuses it");
  const v = check(await resign(relayWire, mainSigner));
  ok(v.ok && v.kind === "deposit" && v.ataAccounts.length === 0, "signed by the wallet, the relay takes it as a deposit with no rent");
  ok(v.ok && v.depositor === main, "the depositor is the wallet");
  ok(v.ok && v.accounts.includes(main) && !v.accounts.includes(relayer.address) && !v.accounts.includes(COMPUTE_BUDGET), "it screens the wallet, not the relay or the programs");
}

// ---------------------------------------------------------------- the policy's version 0 rule

const parts = (() => {
  const m = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decode(relayWire).messageBytes) as never) as unknown as { instructions: Instruction[] };
  const [limit, price, deposit] = m.instructions;
  ok(limit!.programAddress === COMPUTE_BUDGET && price!.programAddress === COMPUTE_BUDGET && deposit!.programAddress === policy.SHIELDED_POOL_PROGRAM, "built as: unit limit, unit price, the deposit");
  return { limit: limit!, price: price!, deposit: deposit! };
})();
const cbLimit = (units: number) => ({ programAddress: COMPUTE_BUDGET, data: Uint8Array.of(2, ...new Uint8Array(new Uint32Array([units]).buffer)) }) as Instruction;
const cbPrice = (micro: bigint) => ({ programAddress: COMPUTE_BUDGET, data: Uint8Array.of(3, ...new Uint8Array(new BigUint64Array([micro]).buffer)) }) as Instruction;

/** A version 0 transaction from instructions, the relay paying unless said, signed by the wallet unless said. */
async function v0(ixs: Instruction[], o: { feePayer?: Address; signers?: KeyPairSigner[]; version?: 0 | "legacy"; lookup?: Record<string, Address[]> } = {}): Promise<Uint8Array> {
  let m = pipe(
    createTransactionMessage({ version: o.version ?? 0 }),
    (x) => setTransactionMessageFeePayer(o.feePayer ?? relayer.address, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash(lifetime, x),
    (x) => appendTransactionMessageInstructions(ixs, x)
  ) as unknown;
  if (o.lookup) m = compressTransactionMessageUsingAddressLookupTables(m as never, o.lookup as never);
  return signedBy(compileTransaction(m as never) as Transaction, ...(o.signers ?? [mainSigner]));
}
const refuse = async (what: string, w: Uint8Array | Promise<Uint8Array>, reason?: RegExp) => {
  const r = check(await w);
  ok(!r.ok && (!reason || reason.test(r.reason)), `refused: ${what}${r.ok ? "" : ` (${r.reason})`}`);
};
const { limit, price, deposit } = parts;

{
  let v = check(await v0([limit, price, deposit]));
  ok(v.ok && v.kind === "deposit", "rebuilt from its parts it passes (the rule reads the wire, not the builder)");
  v = check(await v0([deposit]));
  ok(v.ok, "the deposit alone, no compute budget (no priority fee) passes");
  v = check(await v0([deposit, price, limit]));
  ok(v.ok, "the compute budget in any order passes");
  v = check(await v0([cbLimit(200_000), cbPrice(250_000n), deposit]));
  ok(v.ok, "a priority fee of exactly the cap passes");
  for (const [asset, amount] of [
    [USDT, 1_000_000n],
    [ZEC, 2_271_865n],
  ] as const) {
    const w = await client.buildAddTransaction(s0, asset, amount, undefined, { address: relayer.address, price: null });
    v = check(await resign(w, mainSigner));
    ok(v.ok && v.kind === "deposit", `${asset.symbol} from a wallet passes`);
  }
  // SOL: the policy already pays the fee for a SOL deposit in version 1 (the depositor's own lamports move, not the relay's), so the same holds here. The page never asks for it.
  const solWire = await client.buildAddTransaction(s0, SOL, 5_000_000n, undefined, { address: relayer.address, price: null });
  v = check(await resign(solWire, mainSigner));
  ok(v.ok && v.kind === "deposit", "a SOL deposit from a wallet passes, as it does in version 1");
}

// extra instructions
await refuse("a System transfer beside the deposit", v0([limit, price, deposit, {
  programAddress: address("11111111111111111111111111111111"),
  data: Uint8Array.of(2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0),
  accounts: [{ address: main, role: AccountRole.WRITABLE_SIGNER }, { address: stranger.address, role: AccountRole.WRITABLE }],
} as Instruction]), /only a deposit/);
await refuse("a memo beside the deposit", v0([deposit, { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: Uint8Array.of(1) } as Instruction]), /only a deposit/);
await refuse("a payment (pool transact) beside the deposit", v0([deposit, { ...deposit, data: Uint8Array.of(16, 1, 2, 3) } as Instruction]), /only a deposit/);
await refuse("a payment alone", v0([{ ...deposit, data: Uint8Array.of(16, 1, 2, 3) } as Instruction]), /only a deposit/);
await refuse("two deposits", v0([limit, deposit, deposit]), /one deposit/);
await refuse("compute budget and no deposit (nothing for the wallet to sign)", v0([limit, price], { signers: [] }));
await refuse("the mint's one-time setup beside the deposit", v0([deposit, { ...deposit, data: Uint8Array.of(7) } as Instruction]), /only a deposit/);
{
  const ata = {
    programAddress: address(policy.ATA_PROGRAM),
    data: Uint8Array.of(1),
    accounts: [
      { address: relayer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: await getAssociatedTokenAddress(main, USDC.mint as Address, TOKEN), role: AccountRole.WRITABLE },
      { address: main, role: AccountRole.READONLY },
      { address: USDC.mint as Address, role: AccountRole.READONLY },
      { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
      { address: TOKEN, role: AccountRole.READONLY },
    ],
  } as Instruction;
  await refuse("a token account created on the relay's SOL beside the deposit", v0([ata, deposit]), /only a deposit/);
}

// lookup tables
{
  const lut = address("4VxubgvasVNWnhQ4nMfm2pxAVZKamXYB9dZwfNrS6rRW");
  const w = await v0([limit, price, deposit], { lookup: { [lut]: [USDC.mint as Address] } });
  const c = getCompiledTransactionMessageDecoder().decode(decode(w).messageBytes) as { addressTableLookups?: unknown[] };
  ok((c.addressTableLookups?.length ?? 0) === 1, "the stand-in really loads an account from a lookup table");
  await refuse("an address lookup table", Promise.resolve(w), /lookup tables/);
}

// signers and fee payer
{
  const withStranger = { ...deposit, accounts: [...(deposit.accounts ?? []), { address: stranger.address, role: AccountRole.READONLY_SIGNER }] } as Instruction;
  await refuse("a third signer", v0([limit, price, withStranger], { signers: [mainSigner, stranger] }), /only the private account signs/);
  const cbSigner = { ...limit, accounts: [{ address: stranger.address, role: AccountRole.READONLY_SIGNER }] } as Instruction;
  await refuse("a third signer hung on a compute budget instruction", v0([cbSigner, price, deposit], { signers: [mainSigner, stranger] }), /only the private account signs/);
  const noSigner = { ...limit, accounts: [{ address: stranger.address, role: AccountRole.READONLY }] } as Instruction;
  await refuse("a compute budget instruction naming an account", v0([noSigner, price, deposit]), /compute budget instruction not allowed/);
  await refuse("the wallet as fee payer", v0([limit, price, deposit], { feePayer: main }), /fee payer/);
  await refuse("someone else as fee payer", v0([limit, price, deposit], { feePayer: stranger.address, signers: [mainSigner, stranger] }), /fee payer/);
  await refuse("without the wallet's signature", v0([limit, price, deposit], { signers: [] }), /signature is missing/);
  await refuse("already signed by the relay", v0([limit, price, deposit], { signers: [mainSigner, relayer] }), /signs last/);
  await refuse("a legacy transaction", v0([limit, price, deposit], { version: "legacy" }), /only version 1 transactions, or version 0/);
}

// the relay named in the deposit
{
  const swap = (i: number, who: Address, role = AccountRole.WRITABLE) =>
    ({ ...deposit, accounts: deposit.accounts!.map((a, j) => (j === i ? { address: who, role } : a)) }) as Instruction;
  await refuse("the relay's address as the token account the money comes from", v0([limit, price, swap(5, relayer.address)]), /relay is never part of a deposit/);
  await refuse("the relay as depositor", v0([limit, price, swap(1, relayer.address, AccountRole.WRITABLE_SIGNER)], { signers: [] }));
  await refuse("the relay as the vault", v0([limit, price, swap(6, relayer.address)]), /relay is never part of a deposit/);
  // the wallet named as depositor without signing, another account in the deposit signing in its place
  const unsigned = { ...deposit, accounts: deposit.accounts!.map((a, j) => (j === 1 ? { address: main, role: AccountRole.WRITABLE } : j === 5 ? { address: stranger.address, role: AccountRole.WRITABLE_SIGNER } : a)) } as Instruction;
  await refuse("a depositor that doesn't sign", v0([limit, price, unsigned], { signers: [stranger] }), /depositor must sign/);
}

// the priority fee and compute budget
await refuse("a priority fee one lamport over the cap", v0([cbLimit(200_000), cbPrice(250_005n), deposit]), /priority fee/);
await refuse("a huge unit price", v0([cbLimit(200_000), cbPrice(2n ** 63n), deposit]), /priority fee/);
await refuse("no unit limit and a price that would pass at 200,000 units (priced at the most a transaction can ask)", v0([cbPrice(40_000n), deposit]), /priority fee/);
await refuse("two unit prices", v0([cbPrice(1n), cbPrice(1n), deposit]), /one compute unit price/);
await refuse("two unit limits", v0([cbLimit(200_000), cbLimit(200_000), deposit]), /one compute unit limit/);
await refuse("a unit limit over the cap for a deposit", v0([cbLimit(policy.WALLET_DEPOSIT_MAX_UNITS + 1), cbPrice(1n), deposit]), /compute limit/);
ok(check(await v0([cbLimit(policy.WALLET_DEPOSIT_MAX_UNITS), cbPrice(1n), deposit])).ok, "a unit limit of exactly the cap passes");
await refuse("a heap frame request", v0([{ programAddress: COMPUTE_BUDGET, data: Uint8Array.of(1, 0, 0, 1, 0) } as Instruction, deposit]), /compute budget instruction not allowed/);
await refuse("a loaded-accounts size limit", v0([{ programAddress: COMPUTE_BUDGET, data: Uint8Array.of(4, 0, 0, 1, 0) } as Instruction, deposit]), /compute budget instruction not allowed/);
await refuse("a unit price with trailing bytes", v0([{ programAddress: COMPUTE_BUDGET, data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0, 0) } as Instruction, deposit]), /compute budget instruction not allowed/);
await refuse("four instructions", v0([limit, price, deposit, price]));

// the deposit itself
{
  const small = await client.buildAddTransaction(s0, USDC, policy.RELAYED_DEPOSIT_MIN.usdc! - 1n, undefined, { address: relayer.address, price: null });
  await refuse("a deposit under the floor", resign(small, mainSigner), /too small/);
  const solSmall = await client.buildAddTransaction(s0, SOL, policy.RELAYED_DEPOSIT_MIN.sol! - 1n, undefined, { address: relayer.address, price: null });
  await refuse("a SOL deposit under the floor", resign(solSmall, mainSigner), /too small/);
  const other = { ...USDC, id: "other", mint: "So11111111111111111111111111111111111111112" };
  const unlisted = await client.buildAddTransaction(s0, other, 5_000_000n, undefined, { address: relayer.address, price: null });
  await refuse("an asset Gloam doesn't list", resign(unlisted, mainSigner), /lists/);
  const memo = { ...deposit, data: Uint8Array.of(...deposit.data!.slice(0, -1), 3, 1, 2, 3) } as Instruction;
  await refuse("a deposit with a memo", v0([limit, price, memo]), /one deposit, no memo/);
}

// version 1 unchanged: a private account's own deposit still passes, a version 1 add from a wallet still doesn't
{
  const usdcAccount = await getAssociatedTokenAddress(owner.address, USDC.mint as Address, TOKEN);
  const own = await arrivals.buildRelayedDeposit({ client: fakeClient as never, feePayer: relayer.address, depositor: owner.address, recipient: priv.shieldedAddress(), asset: USDC, amount: 19_840_000n, tokenAccount: usdcAccount });
  const v = check(await signedBy(own, owner as unknown as KeyPairSigner));
  ok(v.ok && v.kind === "deposit" && v.depositor === owner.address, "version 1: a private account's own deposit still passes, its depositor named");
}

// ---------------------------------------------------------------- the client, against a fake chain and the real relay route

const chain = {
  walletLamports: 0 as number | null,
  relayLamports: 1_000_000_000,
  relayOff: false,
  postLost: false,
  simulateErr: null as unknown,
  ip: "198.51.100.10",
  proxied: [] as string[],
  helius: [] as string[],
  relayGets: 0,
  relayPosts: 0,
  sent: [] as string[],
};
const realFetch = globalThis.fetch;
const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
const relayRoute = await import("../src/app/api/solana/relay/route");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("helius")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    chain.helius.push(body.method);
    if (body.method === "getBalance") return reply({ value: chain.relayLamports });
    if (body.method === "getPriorityFeeEstimate") return reply({ priorityFeeEstimate: 1_000_000 });
    if (body.method === "simulateTransaction") return reply({ value: { err: chain.simulateErr, logs: [] } });
    if (body.method === "sendTransaction") {
      chain.sent.push(String(body.params[0]));
      return reply(getBase58Decoder().decode(new Uint8Array(64).fill(chain.sent.length)));
    }
    if (body.method === "getSignatureStatuses") return reply({ value: [{ err: null, confirmationStatus: "confirmed", slot: 7 }] });
    return reply(null);
  }
  if (url === `${ORIGIN}/api/solana/relay`) {
    if ((init?.method ?? "GET") === "GET") {
      chain.relayGets++;
      if (chain.relayOff) return new Response(JSON.stringify({ ok: true, on: false, funded: false, relayer: null, network: "mainnet", priorityMicroLamports: null }));
      return relayRoute.GET();
    }
    chain.relayPosts++;
    if (chain.postLost) throw new TypeError("fetch failed");
    return relayRoute.POST(new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": chain.ip }, body: init?.body as string }));
  }
  if (url === `${ORIGIN}/api/solana/rpc`) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    chain.proxied.push(body.method);
    if (body.method === "getBalance") {
      if (chain.walletLamports === null) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "busy" } }));
      assert.equal(body.params[0], main, "the wallet's own balance is read");
      return reply({ value: chain.walletLamports });
    }
    if (body.method === "isBlockhashValid") return reply({ value: true });
    if (body.method === "getSignatureStatuses") return reply({ value: [{ err: null, confirmationStatus: "confirmed", slot: 7 }] });
    if (body.method === "sendTransaction") return reply("sent");
    return reply(null);
  }
  throw new Error(`no network in this test: ${url}`);
}) as typeof fetch;

const realRelayClock = server.ringsRelayClock.now;
const relayAt = realRelayClock();
server.ringsRelayClock.now = () => relayAt;
try {
  const reset = () => Object.assign(chain, { relayGets: 0, relayPosts: 0, proxied: [], helius: [], sent: [] });

  // A wallet with SOL pays, and the relay is never asked.
  reset();
  chain.walletLamports = 5_000_000;
  let built = await client.buildAddFor(session(), USDC, 1_000_000n);
  ok(built.via === "wallet" && feePayerOf(built.wire) === main, "a wallet with SOL: the wallet pays");
  ok(chain.proxied.includes("getBalance") && chain.relayGets === 0, "its SOL is read through Gloam's proxy, and the relay isn't asked");

  // A wallet left with dust under rent-exempt after the fee: the relay pays.
  chain.walletLamports = Number(config.WALLET_ADD_FEE_LAMPORTS + config.RENT_EXEMPT_WALLET_LAMPORTS - 1n);
  built = await client.buildAddFor(session(), USDC, 1_000_000n);
  ok(built.via === "relay", "a wallet that would be left under rent-exempt: the relay pays");

  // SOL itself, or a balance that can't be read: the wallet.
  chain.walletLamports = 0;
  reset();
  built = await client.buildAddFor(session(), SOL, 5_000_000n);
  ok(built.via === "wallet" && !chain.proxied.includes("getBalance"), "a SOL add: the wallet, and no balance read");
  chain.walletLamports = null;
  built = await client.buildAddFor(session(), USDC, 1_000_000n);
  ok(built.via === "wallet", "Solana slow to answer the balance: the wallet pays, as before");

  // No SOL, a wallet that signs only: the relay pays, end to end through the real route.
  reset();
  chain.walletLamports = 0;
  const s = session({ signOnly: true, sendToo: true });
  built = await client.buildAddFor(s, USDC, 1_000_000n);
  ok(built.via === "relay" && feePayerOf(built.wire) === relayer.address && chain.relayGets === 1, "no SOL: built with the relay as fee payer, its address read from the relay");
  {
    const fee = landing.feeLamportsOfWire(built.wire)!;
    ok(fee === 10_000n + policy.RELAY_LIMITS.maxPriorityFeeLamports, "at Helius's high price the relay's fee stops at its cap");
  }
  walletLog.signed = 0;
  walletLog.sent = 0;
  const steps: string[] = [];
  const paid = await client.relayPaidAdd(s, built.wire, { onStep: (st) => steps.push(st) });
  ok(walletLog.signed === 1 && walletLog.sent === 0, "the wallet signs only, even though it could send (the relay signs last)");
  ok(paid.landing.state === "landed" && paid.signature.length > 0, "the relay sends it and it lands");
  ok(steps.join() === "sending,waiting", "the steps the page shows: sending, then waiting");
  ok(chain.sent.length >= 1 && chain.helius.includes("simulateTransaction") && !chain.helius.includes("getMultipleAccounts"), "the route simulates, reads no token accounts (no rent) and sends");
  {
    const out = decode(new Uint8Array(getBase64Encoder().encode(chain.sent[0]!)));
    ok(Object.values(out.signatures).every((x) => x && x.some((b) => b !== 0)), "what went out carries both signatures");
    ok(getBase58Decoder().decode((out.signatures as Record<string, Uint8Array>)[relayer.address]!) === paid.signature, "its signature is the relay's, the fee payer's");
  }

  // A wallet that can only sign and send, or a relay that is off or unfunded: the wallet needs SOL.
  const needsSol = async (what: string, sess: ReturnType<typeof session>) => {
    let msg = "";
    try {
      await client.buildAddFor(sess, USDC, 1_000_000n);
    } catch (e) {
      msg = (e as Error).message;
    }
    ok(msg === client.ADD_NEEDS_SOL, `${what}: it says the wallet needs a little SOL`);
  };
  await needsSol("a wallet that only signs and sends", session({ signOnly: false, sendToo: true }));
  chain.relayLamports = 0;
  await needsSol("the relay unfunded", session());
  chain.relayLamports = 1_000_000_000;
  chain.relayOff = true;
  await needsSol("the relay off", session());
  chain.relayOff = false;

  // A wallet that changes what it signs: stopped before the relay.
  {
    reset();
    const t = session({ signOnly: true, tamper: true });
    const b = await client.buildAddFor(t, USDC, 1_000_000n);
    let msg = "";
    try {
      await client.relayPaidAdd(t, b.wire);
    } catch (e) {
      msg = (e as Error).message;
    }
    ok(/changed the transaction/.test(msg) && chain.relayPosts === 0, "a wallet that changed the transaction: refused before the relay, with the reason");
  }

  // The relay can't pay right now (out of SOL in its check run): said plainly, nothing moved.
  {
    reset();
    chain.simulateErr = "InsufficientFundsForFee";
    chain.ip = "198.51.100.11";
    const b = await client.buildAddFor(s, USDC, 1_000_000n);
    let msg = "";
    try {
      await client.relayPaidAdd(s, b.wire);
    } catch (e) {
      msg = (e as Error).message;
    }
    ok(msg === client.ADD_RELAY_BUSY && chain.sent.length === 0, "the relay out of SOL: it says Gloam can't pay the fee right now and to add a little SOL");
    chain.simulateErr = null;
  }

  // The relay's answer lost: it may have been sent, so it ends as not confirmed, never sent again.
  {
    reset();
    chain.postLost = true;
    const b = await client.buildAddFor(s, USDC, 1_000_000n);
    const r = await client.relayPaidAdd(s, b.wire);
    ok(r.landing.state === "unknown" && r.signature === "" && chain.relayPosts === 1, "a lost relay answer: not confirmed yet, never sent a second time");
    chain.postLost = false;
  }

  // The route: a deposit counts as a payment and by its depositor.
  {
    chain.ip = "198.51.100.20";
    const depositorSubject = main;
    // One went through above; count the rest of today's 20 directly, then the route refuses the 21st from a fresh IP.
    let counted = 0;
    for (let i = 0; i < 40 && (await server.ringsDepositorRate(depositorSubject)) === "ok"; i++) counted++;
    // two reached the count through the route above: the one sent, and the one its check run refused
    ok(counted === server.RINGS_RELAY_LIMITS.deposit.perDepositorPerDay - 2, "the adds above were counted by their wallet");
    reset();
    chain.ip = "198.51.100.21";
    const b = await client.buildAddFor(s, USDC, 1_000_000n);
    const signed = await resign(b.wire, mainSigner);
    const res = await relayRoute.POST(
      new Request(`${ORIGIN}/api/solana/relay`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.22", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ tx: getBase64Decoder().decode(signed) }),
      })
    );
    ok(res.status === 429 && chain.sent.length === 0 && !chain.helius.includes("simulateTransaction"), `the same wallet past ${server.RINGS_RELAY_LIMITS.deposit.perDepositorPerDay} a day: refused from a fresh IP, before any check run or send`);
    ok((await server.ringsDepositorRate(stranger.address)) === "ok", "another wallet still gets its fee paid");
    ok((await server.ringsDepositorRate("not an address")) === "limited", "something that isn't an address is never counted as one");
    server.ringsRelayClock.now = () => relayAt + 86_400_000;
    ok((await server.ringsDepositorRate(depositorSubject)) === "ok", "the next day the same wallet is paid for again");
    server.ringsRelayClock.now = () => relayAt;
  }
  {
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    ok((await server.ringsDepositorRate(stranger.address, relayAt, "mainnet")) === "unavailable", "mainnet without Redis: the depositor count fails closed");
    ok((await server.ringsDepositorRate(stranger.address, relayAt, "devnet")) === "ok", "devnet without Redis: counted on this instance");
    env.NODE_ENV = nodeEnv;
  }
} finally {
  server.ringsRelayClock.now = realRelayClock;
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------- the words

for (const text of [client.ADD_NEEDS_SOL, client.ADD_RELAY_BUSY]) {
  ok(!/—|happy to/i.test(text), `no em dash, no stock phrase: "${text}"`);
  ok(!/hidden|anonymous|private sender|untraceable/i.test(text), `no privacy claim: "${text}"`);
}
{
  const { readFileSync } = await import("node:fs");
  const view = readFileSync(new URL("../src/components/app/SolanaVault.tsx", import.meta.url), "utf8");
  ok(view.includes("Gloam pays the network fee. The deposit shows it came through Gloam."), "the add says when Gloam pays the fee, and that the deposit shows it");
  ok(/addFeePayer\(/.test(view), "the add screen picks who pays by the same rule as the client");
}

console.log(`selftest-solana-relay-add: ${n} checks passed`);
process.exit(0);
