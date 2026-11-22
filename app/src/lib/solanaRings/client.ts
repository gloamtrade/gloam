"use client";

/**
 * Gloam on Solana in the browser: a private account (lib/solanaRings/account)
 * on Helius Solana Privacy Rings, through Gloam's proxy and relay.
 *
 *  - Every Solana, indexer and prover call goes to /api/solana/*, which adds the
 *    Helius key on the server. Prover requests are encrypted by the SDK to the
 *    attested Helius enclave (SignedTeePolicy), so the proxy carries ciphertext;
 *    the enclave itself sees the witness.
 *  - Adding money: the main wallet signs and sends a deposit to the private
 *    account. Rebuilt as a version 0 transaction with compute-budget
 *    instructions, which every wallet signs (the SDK builds version 1).
 *  - Registering, paying and cashing out: the private account signs, and
 *    Gloam's relay (/api/solana/relay) adds its signature as fee payer and
 *    sends. The private account never holds SOL.
 *  - The private balance is decrypted here, on this device, and kept between
 *    visits as a snapshot sealed with the account's viewing key.
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Transaction,
} from "@solana/kit";
import type { LocalKeys, ShieldedKeypair, Wallet } from "@heliuslabs/spr";
import type { SprClient } from "@heliuslabs/spr/client";
import { accountMessage, deriveAccount, isPlainSignature } from "./account";
import { ringsAssets, ringsBalancesFrom, ringsUrls, SOLANA_RINGS_NETWORK, walletChain, type RingsAsset, type RingsNetwork } from "./config";
import { signOrSendSolana, signSolanaMessage, type SolanaAccount, type SolanaWallet } from "@/lib/solanaWallet";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
// Public Solana program ids (SPL Token, Token-2022), not secrets.
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address; // ggignore
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address; // ggignore
/** What the relay pays as priority fee on each transaction (its cap is 25,000). */
const RELAYED_PRIORITY_FEE = 10_000n;
/** Compute unit price on a deposit the main wallet pays for, micro-lamports. */
const DEPOSIT_CU_PRICE = 20_000n;

export type RelayStatus = { on: boolean; funded: boolean; relayer: string | null; network: RingsNetwork };

/** Whether Gloam's relay is set up, and its fee-payer address. */
export async function relayStatus(): Promise<RelayStatus> {
  try {
    const res = await fetch(ringsUrls(location.origin).relay, { cache: "no-store" });
    const json = (await res.json()) as Partial<RelayStatus>;
    return {
      on: Boolean(json.on && json.relayer),
      funded: Boolean(json.funded),
      relayer: json.relayer ?? null,
      network: json.network ?? SOLANA_RINGS_NETWORK,
    };
  } catch {
    return { on: false, funded: false, relayer: null, network: SOLANA_RINGS_NETWORK };
  }
}

const clients = new Map<RingsNetwork, Promise<SprClient>>();

/** The SDK client for `network`, through Gloam's proxy. One per page. */
export function ringsClient(network: RingsNetwork = SOLANA_RINGS_NETWORK): Promise<SprClient> {
  let c = clients.get(network);
  if (!c) {
    c = (async () => {
      const [{ createSprClient }, { SignedTeePolicy }] = await Promise.all([import("@heliuslabs/spr"), import("@heliuslabs/spr/client")]);
      const urls = ringsUrls(location.origin);
      return createSprClient({
        solanaRpcUrl: urls.rpc,
        indexerUrl: urls.spr,
        proverUrl: urls.spr,
        proverTee: SignedTeePolicy.forNetwork(network),
        commitment: "confirmed",
        priorityFeeLamports: RELAYED_PRIORITY_FEE,
      });
    })();
    c.catch(() => clients.delete(network));
    clients.set(network, c);
  }
  return c;
}

/** One call to Gloam's Solana RPC proxy. */
async function proxyRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ringsUrls(location.origin).rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!json || json.error || json.result === undefined) throw new Error("Solana is slow to answer. Try again.");
  return json.result;
}

export type RingsSession = {
  network: RingsNetwork;
  index: number;
  /** The main wallet that opened it, and that adds money. */
  main: { wallet: SolanaWallet; account: SolanaAccount };
  /** The private account's Solana address: what someone pays privately. */
  address: Address;
  keypair: ShieldedKeypair;
  keys: LocalKeys;
  wallet: Wallet;
  client: SprClient;
};

const storeKey = (network: RingsNetwork, owner: string) => `gloam:solana-rings:v1:${network}:${owner}`;

function snapshotStore(network: RingsNetwork, owner: string) {
  const key = storeKey(network, owner);
  return {
    async load() {
      try {
        return localStorage.getItem(key) ?? undefined;
      } catch {
        return undefined;
      }
    },
    async save(snapshot: string) {
      try {
        localStorage.setItem(key, snapshot);
      } catch {
        // private mode or full storage: the next visit syncs from the start
      }
    },
  };
}

/**
 * Open private account `index` of the connected main wallet: one signature,
 * nothing stored but the sealed balance snapshot. The same wallet reopens the
 * same account on any device.
 */
export async function openRingsAccount(input: {
  wallet: SolanaWallet;
  account: SolanaAccount;
  index?: number;
  network?: RingsNetwork;
}): Promise<RingsSession> {
  const index = input.index ?? 0;
  const network = input.network ?? SOLANA_RINGS_NETWORK;
  const message = accountMessage(index);
  const signature = await signSolanaMessage(input.wallet, input.account, message);
  try {
    const publicKey = new Uint8Array(getAddressEncoder().encode(input.account.address as Address));
    if (!(await isPlainSignature(publicKey, message, signature))) {
      throw new Error(`${input.wallet.name} signs messages in a way that can't open a private account. Try another wallet.`);
    }
    const keypair = await deriveAccount(signature, index);
    const [client, spr] = await Promise.all([ringsClient(network), import("@heliuslabs/spr")]);
    const address = keypair.toSolanaSigner().address;
    const keys = spr.LocalKeys.fromKeypair(keypair, client.proofService);
    const store = snapshotStore(network, address);
    let saved: Wallet | undefined;
    try {
      saved = await spr.loadPersistedWallet({ store, cipher: spr.walletSnapshotCipher(keypair) });
    } catch {
      saved = undefined; // a snapshot this account can't open: start over
    }
    const wallet = saved ?? new spr.Wallet({ identity: keypair.shieldedAddress() });
    const session: RingsSession = { network, index, main: { wallet: input.wallet, account: input.account }, address, keypair, keys, wallet, client };
    await knowAssets(session);
    return session;
  } finally {
    signature.fill(0);
  }
}

/** Forget the keys in memory. The account reopens with the same signature. */
export function closeRingsAccount(s: RingsSession): void {
  try {
    s.keys.destroy();
  } catch {}
  try {
    s.keypair.destroy();
  } catch {}
}

/** Tell the wallet the asset ids of the tokens Gloam lists, so a sync never has to scan for them. */
async function knowAssets(s: RingsSession): Promise<void> {
  const [{ getSplAssetRegistryAddress }, { decodeSplAssetRegistry }] = await Promise.all([
    import("@heliuslabs/spr/addresses"),
    import("@heliuslabs/spr/interface"),
  ]);
  for (const a of ringsAssets(s.network)) {
    if (!a.mint) continue;
    try {
      const account = await s.client.getAccount(await getSplAssetRegistryAddress(a.mint as Address));
      if (!account?.data?.length) continue;
      const reg = decodeSplAssetRegistry(account.data);
      if (reg.mint === a.mint) s.wallet.ensureAsset(reg.assetId, reg.mint);
    } catch {
      // read again on the next open; the sync can still name it
    }
  }
}

/** Which listed assets are set up on chain (the one-time SPL interface per mint). SOL always is. */
export async function assetsReady(network: RingsNetwork = SOLANA_RINGS_NETWORK): Promise<Record<string, boolean>> {
  const { getSplAssetRegistryAddress } = await import("@heliuslabs/spr/addresses");
  const assets = ringsAssets(network);
  const spl = assets.filter((a) => a.mint);
  const addrs = await Promise.all(spl.map((a) => getSplAssetRegistryAddress(a.mint as Address)));
  const out: Record<string, boolean> = { sol: true };
  try {
    const found = await proxyRpc<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [addrs, { encoding: "base64" }]);
    spl.forEach((a, i) => {
      const v = found.value?.[i];
      out[a.id] = Boolean(v && v.data?.[0]);
    });
  } catch {
    for (const a of spl) out[a.id] = false;
  }
  return out;
}

/** Read this account's private history from the indexer and decrypt it here. */
export async function syncRings(s: RingsSession, requireSlot?: bigint): Promise<void> {
  const spr = await import("@heliuslabs/spr");
  await spr.syncPersistedWallet({
    wallet: s.wallet,
    keys: s.keys,
    client: s.client,
    store: snapshotStore(s.network, s.address),
    cipher: spr.walletSnapshotCipher(s.keypair),
    ...(requireSlot === undefined ? {} : { config: { requireSlot } }),
  });
}

/** The private balance of each listed asset, in base units. */
export function ringsBalances(s: RingsSession): Record<string, bigint> {
  return ringsBalancesFrom(s.wallet.balances(true), s.network);
}

/** Whether this private account can be paid privately (it has a registry record). */
export async function isRegistered(s: RingsSession, owner: string = s.address): Promise<boolean> {
  const { isWalletRegistered } = await import("@heliuslabs/spr/wallet");
  return isWalletRegistered({ rpc: s.client, owner: owner as Address });
}

const encodeTx = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));
const b64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);

/** Add the private account's signature to `tx`, the relay's slot left empty. */
async function ownerSigned(s: RingsSession, tx: Transaction): Promise<Uint8Array> {
  const [sigs] = await s.keypair.toSolanaSigner().signTransactions([tx as never]);
  return encodeTx({ ...tx, signatures: { ...tx.signatures, ...sigs } } as Transaction);
}

/** Relay refusals that come before it sends anything (app/api/solana/relay). */
const RELAY_NOT_SENT = new Set(["relay_off", "relay_unavailable", "relay_empty", "simulate_failed"]);

/**
 * The relay said no, or its answer was lost. `maybeSent`: it may have sent the
 * transaction first (a lost answer, a timeout, a failure after the send), so
 * the caller must check the chain before sending those notes again.
 */
export class RingsRelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly maybeSent: boolean
  ) {
    super(message);
    this.name = "RingsRelayError";
  }
}

/** Hand a transaction the private account signed to Gloam's relay. Returns its signature. */
async function relay(wire: Uint8Array): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ringsUrls(location.origin).relay, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: b64(wire) }),
    });
  } catch {
    throw new RingsRelayError("Gloam's relay didn't answer. Check your connection.", 0, "network", true);
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; signature?: string; error?: { code?: string; message?: string } } | null;
  if (!json?.ok || !json.signature) {
    const code = json?.error?.code ?? "unknown";
    // 4xx and the 5xx codes above are refused before the send; any other 5xx (or a reply that isn't the relay's) may come after it.
    const maybeSent = res.ok || (res.status >= 500 && !RELAY_NOT_SENT.has(code));
    throw new RingsRelayError(json?.error?.message ?? "Gloam's relay didn't take it. Try again.", res.status, code, maybeSent);
  }
  return json.signature;
}

async function landed(s: RingsSession, signature: string): Promise<bigint> {
  return s.client.confirmTransaction(signature as never);
}

async function relayer(): Promise<Address> {
  const st = await relayStatus();
  if (!st.on || !st.relayer) throw new Error("Gloam's Solana relay isn't set up yet.");
  return st.relayer as Address;
}

/**
 * The registration transaction (version 1, `payer` paying the record's rent),
 * signed by the private account. Null when it is already registered with these
 * keys; rejects when it is registered with other keys.
 */
export async function buildRegistration(s: RingsSession, payer: Address): Promise<Uint8Array | null> {
  const [w, ix, spr] = await Promise.all([import("@heliuslabs/spr/wallet"), import("@heliuslabs/spr/instructions"), import("@heliuslabs/spr")]);
  const existing = await w.fetchUserRecord({ rpc: s.client, owner: s.address });
  if (existing) {
    await w.validateRegisteredKeypair({ rpc: s.client, owner: s.address, keypair: s.keypair });
    return null;
  }
  const owner = s.keypair.toSolanaSigner();
  const shielded = s.keypair.shieldedAddress();
  const instructions = [
    await ix.getRegisterInstructionAsync({
      owner,
      payer,
      nullifierPublicKey: shielded.nullifierPublicKey,
      viewingPublicKey: shielded.viewingPublicKey.toBytes(),
    }),
    await ix.getSetMergeEncryptionInstructionAsync({ owner, scheme: spr.MergeEncryptionScheme.PoseidonCtrV1 }),
  ];
  const lifetime = await s.client.getLatestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime as never, m),
    // as the SDK compiles: version 1 counts loaded account data against this, and the default is too small
    (m) => setTransactionMessageConfig({ computeUnitLimit: 200_000, priorityFeeLamports: RELAYED_PRIORITY_FEE, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 }, m),
    (m) => appendTransactionMessageInstructions(instructions as Instruction[], m),
  );
  return encodeTx((await partiallySignTransactionMessageWithSigners(message as never)) as Transaction);
}

/**
 * Publish the private account in the registry, so it can be paid privately by
 * its address. The relay pays the record's rent. Nothing to do when it is
 * already registered with these keys.
 */
export async function ensureRegistered(s: RingsSession): Promise<void> {
  const wire = await buildRegistration(s, await relayer());
  if (wire) await landed(s, await relay(wire));
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/**
 * The SDK's version 1 transaction rebuilt as version 0: the same instructions,
 * with its compute limit as a ComputeBudget instruction and a small priority
 * fee. Wallets sign version 0; the main wallet pays.
 */
async function asVersion0(s: RingsSession, built: Transaction, feePayer: Address): Promise<Uint8Array> {
  const compiled = getCompiledTransactionMessageDecoder().decode(built.messageBytes);
  const message = decompileTransactionMessage(compiled as never) as unknown as {
    instructions: readonly Instruction[];
    config?: { computeUnitLimit?: number };
  };
  const units = message.config?.computeUnitLimit ?? 200_000;
  const lifetime = await s.client.getLatestBlockhash();
  const budget: Instruction[] = [
    { programAddress: COMPUTE_BUDGET, data: Uint8Array.of(2, ...u32le(units)) },
    { programAddress: COMPUTE_BUDGET, data: Uint8Array.of(3, ...u64le(DEPOSIT_CU_PRICE)) },
  ];
  const v0 = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime as never, m),
    (m) => appendTransactionMessageInstructions([...budget, ...message.instructions], m),
  );
  return encodeTx(compileTransaction(v0 as never) as Transaction);
}

function tokenProgram(a: RingsAsset): Address {
  return a.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
}

/**
 * The deposit of `amount` of `asset` from `from` (the main wallet by default)
 * into the private account, as an unsigned version 0 transaction.
 */
export async function buildAddTransaction(s: RingsSession, asset: RingsAsset, amount: bigint, from?: Address): Promise<Uint8Array> {
  const [{ buildDepositTransaction }, { getAssociatedTokenAddress }] = await Promise.all([
    import("@heliuslabs/spr/wallet"),
    import("@heliuslabs/spr/addresses"),
  ]);
  const main = from ?? (s.main.account.address as Address);
  const spl = asset.mint
    ? {
        asset: asset.mint as Address,
        splTokenAccount: await getAssociatedTokenAddress(main, asset.mint as Address, tokenProgram(asset)),
        splTokenProgram: tokenProgram(asset),
        // the mint's one-time setup is Gloam's to do (scripts/solana-rings-setup-asset.mts), never a user's
        createSplInterface: false,
      }
    : {};
  const built = await buildDepositTransaction({
    client: s.client,
    feePayer: main,
    depositor: main,
    recipient: s.keypair.shieldedAddress(),
    amount,
    ...spl,
  });
  return asVersion0(s, built, main);
}

/**
 * Add money: the main wallet deposits `amount` of `asset` into the private
 * account. Public on chain: the main wallet, the asset and the amount.
 */
export async function addToPrivate(s: RingsSession, asset: RingsAsset, amount: bigint): Promise<string> {
  const wire = await buildAddTransaction(s, asset, amount);
  const out = await signOrSendSolana(s.main.wallet, s.main.account, wire, walletChain(s.network));
  const signature =
    "sent" in out ? getBase58Decoder().decode(out.sent) : await proxyRpc<string>("sendTransaction", [b64(out.signed), { encoding: "base64" }]);
  const slot = await landed(s, signature);
  await syncRings(s, slot);
  return signature;
}

async function relayed(s: RingsSession, build: (feePayer: Address) => Promise<Transaction>): Promise<string> {
  const feePayer = await relayer();
  await syncRings(s);
  const tx = await build(feePayer);
  let signature: string;
  try {
    signature = await relay(await ownerSigned(s, tx));
  } catch (e) {
    // the build reserved the notes it spends; drop that by reopening the saved state
    await reloadWallet(s);
    throw e;
  }
  const slot = await landed(s, signature);
  await syncRings(s, slot);
  return signature;
}

async function reloadWallet(s: RingsSession): Promise<void> {
  const spr = await import("@heliuslabs/spr");
  try {
    const w = await spr.loadPersistedWallet({ store: snapshotStore(s.network, s.address), cipher: spr.walletSnapshotCipher(s.keypair) });
    s.wallet = w ?? new spr.Wallet({ identity: s.keypair.shieldedAddress() });
    await knowAssets(s);
  } catch {
    s.wallet = new spr.Wallet({ identity: s.keypair.shieldedAddress() });
  }
}

/**
 * Pay `amount` of `asset` privately to another Gloam private account on
 * Solana, by its address. Public on chain: both private accounts. Hidden: the
 * asset and the amount.
 */
export async function payPrivately(s: RingsSession, to: string, asset: RingsAsset, amount: bigint): Promise<string> {
  const { buildTransferTransaction } = await import("@heliuslabs/spr/wallet");
  return relayed(s, (feePayer) =>
    buildTransferTransaction({
      client: s.client,
      wallet: s.wallet,
      keys: s.keys,
      feePayer,
      recipient: to as Address,
      amount,
      ...(asset.mint ? { asset: asset.mint as Address } : {}),
    })
  );
}

/**
 * Cash out `amount` of `asset` to any Solana address (the main wallet by
 * default). Public on chain: the private account, the address, the asset and
 * the amount.
 */
export async function cashOut(s: RingsSession, to: string, asset: RingsAsset, amount: bigint): Promise<string> {
  const { buildWithdrawalTransaction } = await import("@heliuslabs/spr/wallet");
  return relayed(s, (feePayer) =>
    buildWithdrawalTransaction({
      client: s.client,
      wallet: s.wallet,
      keys: s.keys,
      feePayer,
      recipient: to as Address,
      amount,
      ...(asset.mint ? { asset: asset.mint as Address, splTokenProgram: tokenProgram(asset) } : {}),
    })
  );
}

// ------------------------------------------------------------------ payroll (lib/solanaRings/payroll)

/**
 * Which of `owners` can be paid privately: each has a Rings registry record.
 * One getMultipleAccounts per hundred addresses, not one read each.
 */
export async function registeredMany(s: RingsSession, owners: readonly string[]): Promise<Map<string, boolean>> {
  const [{ getUserRecordAddress }, { USER_REGISTRY_PROGRAM }] = await Promise.all([import("@heliuslabs/spr/addresses"), import("./relayPolicy")]);
  const out = new Map<string, boolean>();
  const unique = [...new Set(owners)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const pdas = await Promise.all(chunk.map((o) => getUserRecordAddress(o as Address)));
    const found = await s.client.getMultipleAccounts(pdas);
    chunk.forEach((o, j) => {
      const acct = found[j];
      out.set(o, Boolean(acct && acct.owner === USER_REGISTRY_PROGRAM && acct.data.length > 0));
    });
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * One private transfer of `asset` paying each of `payments` (one to fifteen
 * Gloam private accounts), built and signed by the private account, not sent.
 * Names the notes it spends (their nullifiers) and its blockhash, so a run
 * can tell later whether it landed. The notes stay set aside until it is sent
 * and settled, or releasePayments.
 */
export async function buildPayments(
  s: RingsSession,
  asset: RingsAsset,
  payments: readonly { address: string; amount: bigint }[]
): Promise<{ wire: Uint8Array; nullifiers: string[]; blockhash: string }> {
  const feePayer = await relayer();
  await syncRings(s);
  const { buildMultiTransferTransaction } = await import("@heliuslabs/spr/wallet");
  const unspent = s.wallet.utxos().filter((u) => !u.spent);
  const tx = await buildMultiTransferTransaction({
    client: s.client,
    wallet: s.wallet,
    keys: s.keys,
    feePayer,
    payments: payments.map((p) => ({ recipient: p.address as Address, amount: p.amount })),
    ...(asset.mint ? { asset: asset.mint as Address } : {}),
  });
  const message = new Uint8Array(tx.messageBytes);
  const nullifiers = unspent.filter((u) => containsBytes(message, u.nullifier)).map((u) => hex(u.nullifier));
  const blockhash = (getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as { lifetimeToken?: string }).lifetimeToken;
  if (!nullifiers.length || !blockhash) {
    await reloadWallet(s);
    throw new Error("This payment couldn't be checked before sending, so it wasn't sent.");
  }
  return { wire: await ownerSigned(s, tx), nullifiers, blockhash };
}

/** Send what buildPayments built through Gloam's relay. Rejects with RingsRelayError. */
export function sendPayments(wire: Uint8Array): Promise<string> {
  return relay(wire);
}

/** After a refusal that sent nothing: free the notes buildPayments set aside. */
export function releasePayments(s: RingsSession): Promise<void> {
  return reloadWallet(s);
}

/** Wait for a sent payment to land, then read it back. */
export async function confirmPayments(s: RingsSession, signature: string): Promise<void> {
  const slot = await landed(s, signature);
  await syncRings(s, slot);
}

const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * Where a payment left in flight stands (a closed tab, a lost answer). By its
 * signature when there is one; else by its notes: spent means it landed. It
 * counts as dropped only once its blockhash has expired (so it can never land)
 * and, read up to then, its notes are still unspent.
 */
export async function settlePayments(
  s: RingsSession,
  f: { signature?: string; nullifiers: readonly string[]; blockhash: string }
): Promise<import("./payroll").InflightResult> {
  if (f.signature) {
    const st = await proxyRpc<{ value: ({ err: unknown; confirmationStatus?: string | null; slot: number } | null)[] }>("getSignatureStatuses", [
      [f.signature],
      { searchTransactionHistory: true },
    ]);
    const v = st.value?.[0];
    if (v) {
      if (v.err) {
        await reloadWallet(s);
        return { state: "failed", message: "That batch failed on Solana, so nobody in it was paid. Resume to try again." };
      }
      if (v.confirmationStatus !== "confirmed" && v.confirmationStatus !== "finalized") return { state: "pending" };
      await syncRings(s, BigInt(v.slot));
      return { state: "landed", signature: f.signature };
    }
  }
  const spentBy = async (): Promise<{ spent: boolean; signature?: string; known: boolean }> => {
    const mine = new Map(s.wallet.utxos().map((u) => [hex(u.nullifier), u.spent]));
    const known = f.nullifiers.every((n) => mine.has(n));
    const spent = f.nullifiers.some((n) => mine.get(n) === true);
    let signature: string | undefined;
    if (spent) {
      try {
        const page = await s.client.getShieldedTransactionsByNullifiers({ nullifiers: f.nullifiers.map(fromHex) as never });
        signature = page.data[0]?.signature as string | undefined;
      } catch {
        signature = undefined; // paid either way; the signature is a nicety
      }
    }
    return { spent, known, ...(signature ? { signature } : {}) };
  };
  await syncRings(s);
  const now = await spentBy();
  if (now.spent) return { state: "landed", ...(now.signature ? { signature: now.signature } : {}) };
  const valid = await proxyRpc<{ value: boolean }>("isBlockhashValid", [f.blockhash, { commitment: "confirmed" }]);
  if (valid.value) return { state: "pending" };
  // Expired: from here it can never land. Read up to now and look once more.
  const slot = await proxyRpc<number>("getSlot", [{ commitment: "confirmed" }]);
  await syncRings(s, BigInt(slot));
  const after = await spentBy();
  if (after.spent) return { state: "landed", ...(after.signature ? { signature: after.signature } : {}) };
  if (!after.known) return { state: "unknown" };
  await reloadWallet(s);
  return { state: "dropped" };
}

/** A build error that fewer people per transaction would get past. */
export function paymentsTooBig(e: unknown): boolean {
  const codes = ringsErrorCodes(e);
  return codes.has("INTERFACE_TRANSACTION_TOO_LARGE") || codes.has("WALLET_TOO_MANY_INPUTS") || codes.has("WALLET_INVALID_PAYMENT_COUNT");
}

/** This private account's payroll runs in this browser, sealed under a key from its viewing secret. */
export async function ringsPayrollStore(s: RingsSession) {
  const { payrollStore, payrollStoreKey, runCipher } = await import("./payrollStore");
  const viewing = s.keypair.viewingKey();
  const secret = viewing.secretBytes();
  try {
    return payrollStore({ key: payrollStoreKey(s.network, s.address), cipher: await runCipher(secret, s.address) });
  } finally {
    secret.fill(0);
    viewing.destroy();
  }
}

/** A Solana address, by shape. */
export function isSolanaAddress(v: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
  try {
    return getAddressEncoder().encode(v as Address).length === 32;
  } catch {
    return false;
  }
}

/**
 * Every SDK error code on `e` and its causes: the SDK wraps an operation's
 * error (WALLET_BUILD_TRANSFER) around the one that says why
 * (WALLET_INSUFFICIENT_BALANCE), in causeCode, causeCodes and cause.
 */
export function ringsErrorCodes(e: unknown): Set<string> {
  const out = new Set<string>();
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    const x = cur as { code?: unknown; causeCode?: unknown; causeCodes?: unknown; cause?: unknown };
    for (const c of [x.code, x.causeCode, ...(Array.isArray(x.causeCodes) ? x.causeCodes : [])]) if (typeof c === "string") out.add(c);
    cur = x.cause;
  }
  return out;
}

/** Plain words for the SDK's error codes. */
export function ringsErrorMessage(e: unknown): string {
  if (e instanceof RingsRelayError) return e.message;
  const text = e instanceof Error ? e.message : String(e);
  const codes = ringsErrorCodes(e);
  const has = (c: string) => codes.has(c) || text.includes(c);
  if (has("WALLET_INSUFFICIENT_BALANCE")) return "Your private balance is too low for that.";
  if (has("WALLET_RECIPIENT_NOT_REGISTERED")) return "That address has no Gloam private account yet.";
  if (has("WALLET_TOO_MANY_INPUTS")) return "That needs too many small amounts at once. Try a smaller amount.";
  if (has("WALLET_NOTE_RESERVED")) return "A payment is still settling. Try again in a minute.";
  if (has("WALLET_MISSING_SPL_TOKEN_ACCOUNT")) return "Your wallet doesn't hold that token yet.";
  if (has("WALLET_USER_RECORD_KEYS_MISMATCH") || has("WALLET_REGISTERED_KEYPAIR_MISMATCH")) {
    return "This private account is registered with other keys. Contact Gloam support.";
  }
  if (/reject|denied|cancel/i.test(text)) return "You cancelled it in your wallet.";
  return text.length < 160 && !/^[A-Z_]+$/.test(text) ? text : "Something went wrong on Solana. Try again.";
}
