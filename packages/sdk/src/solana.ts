/**
 * @gloamtrade/sdk/solana: Gloam on Solana for apps and agents, in Node and in
 * browsers. The same private account as the Gloam app: one signature from the
 * main wallet opens it (solanaInfo.ts has the derivation), and it lives on
 * Helius Solana Privacy Rings (the permissionless Default Ring).
 *
 * What it hides, said plainly: the asset and the amount of a private payment.
 * The two private accounts a payment moves between are public, adding money
 * shows the main wallet it came from, a cash out shows its destination, asset
 * and amount, and proofs are made by Helius's prover. It never hides who paid
 * whom.
 *
 * Every call goes to Gloam's endpoints (https://www.gloam.trade/api/solana/*,
 * or `baseUrl`): a Solana RPC and the Rings indexer and prover behind Gloam's
 * Helius key, and Gloam's relay, which pays the fees of registering, paying and
 * cashing out, so the private account never holds SOL. Adding money is the one
 * transaction the main wallet pays for. Gloam's endpoints answer servers and
 * gloam.trade's own pages; a page on another site gets a refusal (pass the
 * `baseUrl` of your own server that forwards to Gloam's).
 *
 * Needs @heliuslabs/spr (0.9.0-alpha) and @solana/kit next to this package.
 *
 *   const wallet = await solanaKeypairWallet(secretKeyBytes);
 *   const account = await openSolanaAccount({ wallet });
 *   await registerSolanaAccount(account);                 // once, so it can be paid
 *   await solanaBalances(account);                         // { sol, usdc, usdt, zec } in base units
 *   await addToSolanaPrivate(account, { asset: "usdc", amount: 5_000_000n });
 *   await paySolanaPrivately(account, { to, asset: "usdc", amount: 1_000_000n });
 *   await cashOutSolana(account, { to: wallet.address, asset: "usdc", amount: 1_000_000n });
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  type Address,
  type Instruction,
  type Transaction,
} from "@solana/kit";
import type { LocalKeys, ShieldedKeypair, Wallet } from "@heliuslabs/spr";
import type { SprClient } from "@heliuslabs/spr/client";
import {
  GLOAM_SOLANA_BASE_URL,
  SOLANA_ASSETS,
  SOLANA_RINGS_SOL_MINT,
  base58Decode,
  isPlainSolanaSignature,
  isSolanaAddress,
  solanaAccountMessage,
  solanaAccountSeed,
  solanaAsset,
  solanaEndpoints,
  type SolanaAsset,
  type SolanaNetworkKey,
} from "./solanaInfo.js";

export * from "./solanaInfo.js";

// Public Solana program ids (Compute Budget, SPL Token, Token-2022), not secrets.
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address; // ggignore
/** What the relay pays as priority fee on each transaction it sponsors (its cap is 25,000 lamports). */
export const SOLANA_RELAYED_PRIORITY_FEE = 10_000n;
/** Compute unit price on an add, which the main wallet pays for, in micro-lamports. */
const ADD_CU_PRICE = 20_000n;
/** How long a send waits for Solana by default. A blockhash lasts about 60 to 90 seconds, so this nearly always ends landed or dropped. */
export const SOLANA_DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 2_000;

// ------------------------------------------------------------------ the main wallet

/**
 * The main wallet: an agent's keypair, or any wallet that signs a message and
 * a transaction. It opens the private account (one message signature) and
 * pays for adding money. It is never asked to sign anything else.
 */
export interface SolanaMainWallet {
  /** The wallet's Solana address (base58). */
  address: string;
  /** The plain Ed25519 signature (64 bytes) over `message`, no prefix or envelope. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Sign a serialized transaction (wire bytes) and return it signed, other signatures kept. */
  signTransaction(wire: Uint8Array): Promise<Uint8Array>;
}

/**
 * A main wallet from a Solana keypair: 64 bytes (a Solana CLI keypair file's
 * numbers: secret then public key), its base58 text, or a 32-byte seed. The
 * key stays in this object; it is never logged or sent anywhere.
 */
export async function solanaKeypairWallet(secret: Uint8Array | readonly number[] | string): Promise<SolanaMainWallet> {
  const bytes = solanaSecretKeyBytes(secret);
  try {
    const signer = bytes.length === 64 ? await createKeyPairSignerFromBytes(bytes) : await createKeyPairSignerFromPrivateKeyBytes(bytes);
    return {
      address: signer.address,
      signMessage: async (message) => new Uint8Array(await signBytes(signer.keyPair.privateKey, message)),
      signTransaction: async (wire) => {
        const tx = getTransactionDecoder().decode(wire);
        const signed = await partiallySignTransaction([signer.keyPair], tx as never);
        return new Uint8Array(getTransactionEncoder().encode(signed as never));
      },
    };
  } finally {
    bytes.fill(0);
  }
}

/**
 * A Solana secret key's bytes from a JSON array of 64 numbers, a 64-byte
 * base58 string, or bytes (64, or a 32-byte seed). Throws without echoing it.
 */
export function solanaSecretKeyBytes(secret: Uint8Array | readonly number[] | string): Uint8Array {
  let bytes: Uint8Array;
  if (typeof secret === "string") {
    const v = secret.trim();
    try {
      if (v.startsWith("[")) {
        const arr = JSON.parse(v) as unknown;
        if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
        bytes = Uint8Array.from(arr as number[]);
      } else {
        bytes = base58Decode(v);
      }
    } catch {
      throw new Error("That is not a Solana secret key (a JSON array of 64 numbers, or base58).");
    }
  } else {
    bytes = Uint8Array.from(secret);
  }
  if (bytes.length !== 64 && bytes.length !== 32) {
    bytes.fill(0);
    throw new Error("A Solana secret key is 64 bytes (or a 32-byte seed).");
  }
  return bytes;
}

// ------------------------------------------------------------------ endpoints and the relay

export interface SolanaOptions {
  /** "mainnet" (default) or "devnet". It must match what `baseUrl` serves. */
  network?: SolanaNetworkKey;
  /** Where Gloam's Solana endpoints are: https://www.gloam.trade by default. */
  baseUrl?: string;
  /** Custom fetch (tests, edge runtimes). */
  fetch?: typeof fetch;
}

export interface SolanaRelayStatus {
  /** The relay is set up on this network. */
  on: boolean;
  /** It holds enough SOL to pay fees. */
  funded: boolean;
  /** Its address: the fee payer on every transaction it sponsors. */
  relayer: string | null;
  network: SolanaNetworkKey;
}

/** The relay refused, or its answer was lost. `maybeSent`: check the chain (solanaTxStatus) before sending those funds again. */
export class SolanaRelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly maybeSent: boolean,
    /** What tells later whether it landed, when it may have been sent. */
    readonly pending?: { signature?: string; blockhash: string }
  ) {
    super(message);
    this.name = "SolanaRelayError";
  }
}

/** Relay refusals that come before it sends anything (app/api/solana/relay). */
const RELAY_NOT_SENT: ReadonlySet<string> = new Set(["relay_off", "relay_unavailable", "relay_empty", "simulate_failed"]);

/** Whether Gloam's Solana relay is on and funded, and its fee-payer address. */
export async function solanaRelayStatus(opts: SolanaOptions = {}): Promise<SolanaRelayStatus> {
  const f = opts.fetch ?? fetch;
  const network = opts.network ?? "mainnet";
  try {
    const res = await f(solanaEndpoints(opts.baseUrl).relay, { method: "GET", cache: "no-store" } as RequestInit);
    const json = (await res.json()) as Partial<SolanaRelayStatus>;
    return { on: Boolean(json.on && json.relayer), funded: Boolean(json.funded), relayer: json.relayer ?? null, network: json.network ?? network };
  } catch {
    return { on: false, funded: false, relayer: null, network };
  }
}

/** The body Gloam's relay takes: the transaction the private account signed, base64, relay's signature slot empty. */
export function solanaRelayRequest(wire: Uint8Array): { tx: string } {
  return { tx: getBase64Decoder().decode(wire) };
}

async function relaySend(opts: SolanaOptions, wire: Uint8Array, blockhash: string): Promise<string> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(solanaEndpoints(opts.baseUrl).relay, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(solanaRelayRequest(wire)),
    });
  } catch {
    throw new SolanaRelayError("Gloam's relay didn't answer. Check the transaction's status before sending again.", 0, "network", true, { blockhash });
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; signature?: string; error?: { code?: string; message?: string } } | null;
  if (!json?.ok || !json.signature) {
    const code = json?.error?.code ?? "unknown";
    // 4xx and the 5xx codes above come before the send; any other 5xx (or a reply that isn't the relay's) may come after it.
    const maybeSent = res.ok || (res.status >= 500 && !RELAY_NOT_SENT.has(code));
    throw new SolanaRelayError(json?.error?.message ?? `Gloam's relay didn't take it (${res.status}).`, res.status, code, maybeSent, maybeSent ? { blockhash } : undefined);
  }
  return json.signature;
}

async function rpc<T>(opts: SolanaOptions, method: string, params: unknown[]): Promise<T> {
  const f = opts.fetch ?? fetch;
  const res = await f(solanaEndpoints(opts.baseUrl).rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!json || json.error || json.result === undefined) throw new Error(`Solana RPC ${method} failed: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  return json.result;
}

// ------------------------------------------------------------------ transaction status

export type SolanaTxState =
  /** Confirmed on Solana. */
  | { state: "landed"; signature: string; slot: bigint }
  /** Landed and failed: nothing moved. Safe to send again. */
  | { state: "failed"; signature: string; error: unknown }
  /** Its blockhash expired and Solana never saw it: it can never land. Safe to send again. */
  | { state: "dropped"; signature: string }
  /** Not settled yet: ask again (it settles within about 90 seconds of being built). */
  | { state: "pending"; signature: string };

/**
 * Where a sent transaction stands, read once. With its `blockhash` (every send
 * here returns it) a transaction Solana never saw counts as dropped once that
 * blockhash expires; without it, it stays pending.
 */
export async function solanaTxStatus(input: { signature: string; blockhash?: string }, opts: SolanaOptions = {}): Promise<SolanaTxState> {
  const read = async () => {
    const st = await rpc<{ value: ({ err: unknown; confirmationStatus?: string | null; slot: number } | null)[] }>(opts, "getSignatureStatuses", [
      [input.signature],
      { searchTransactionHistory: true },
    ]);
    return st.value?.[0] ?? null;
  };
  const decide = (v: NonNullable<Awaited<ReturnType<typeof read>>>): SolanaTxState | null => {
    if (v.err) return { state: "failed", signature: input.signature, error: v.err };
    if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return { state: "landed", signature: input.signature, slot: BigInt(v.slot) };
    return null;
  };
  const v = await read();
  if (v) return decide(v) ?? { state: "pending", signature: input.signature };
  if (!input.blockhash) return { state: "pending", signature: input.signature };
  const valid = await rpc<{ value: boolean }>(opts, "isBlockhashValid", [input.blockhash, { commitment: "confirmed" }]);
  if (valid.value) return { state: "pending", signature: input.signature };
  // Expired: from now on it can never land. Look once more, in case it landed just before.
  const again = await read();
  if (again) return decide(again) ?? { state: "pending", signature: input.signature };
  return { state: "dropped", signature: input.signature };
}

/**
 * Wait for a sent transaction until it lands, fails or is dropped, or until
 * `timeoutMs` (default 120 s): never longer. Returns "pending" at the deadline.
 */
export async function waitForSolanaTx(
  input: { signature: string; blockhash?: string; timeoutMs?: number },
  opts: SolanaOptions & { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<SolanaTxState> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = now() + (input.timeoutMs ?? SOLANA_DEFAULT_TIMEOUT_MS);
  for (;;) {
    let st: SolanaTxState;
    try {
      st = await solanaTxStatus(input, opts);
    } catch {
      st = { state: "pending", signature: input.signature }; // the RPC hiccuped: keep asking until the deadline
    }
    if (st.state !== "pending" || now() + POLL_MS > deadline) return st;
    await sleep(POLL_MS);
  }
}

/** A send that did not land: `failed` or `dropped` means nothing moved and it is safe to send again. */
export class SolanaTxError extends Error {
  constructor(
    message: string,
    readonly state: "failed" | "dropped",
    readonly signature: string
  ) {
    super(message);
    this.name = "SolanaTxError";
  }
}

/** What a send returns. "pending": it may still land; check solanaTxStatus({ signature, blockhash }) before sending again. */
export interface SolanaSendResult {
  signature: string;
  state: "landed" | "pending";
  /** Its blockhash, for solanaTxStatus. */
  blockhash: string;
  slot?: bigint;
  explorer: string;
}

// ------------------------------------------------------------------ the private account

/** Keeps the account's sealed balance snapshot between runs (sealed with the account's viewing key). */
export interface SolanaSnapshotStore {
  load(): Promise<string | undefined>;
  save(snapshot: string): Promise<void>;
}

/** An open private account. Close it (closeSolanaAccount) to wipe its keys from memory. */
export interface GloamSolanaAccount {
  readonly network: SolanaNetworkKey;
  readonly index: number;
  /** The main wallet that opened it, and that adds money. */
  readonly mainAddress: string;
  /** The private account's Solana address: what someone pays privately. */
  readonly address: string;
  /** @internal */
  readonly _: AccountState;
}

type AccountState = {
  opts: SolanaOptions;
  wallet: SolanaMainWallet;
  keypair: ShieldedKeypair;
  keys: LocalKeys;
  rings: Wallet;
  client: SprClient;
  store: SolanaSnapshotStore;
};

function memoryStore(): SolanaSnapshotStore {
  let kept: string | undefined;
  return { load: async () => kept, save: async (s) => void (kept = s) };
}

const clients = new Map<string, Promise<SprClient>>();

/** The Privacy Rings client behind Gloam's endpoints, one per base URL and network. */
export function solanaRingsClient(opts: SolanaOptions = {}): Promise<SprClient> {
  const network = opts.network ?? "mainnet";
  const base = opts.baseUrl ?? GLOAM_SOLANA_BASE_URL;
  const key = `${network}:${base}`;
  let c = opts.fetch ? undefined : clients.get(key);
  if (!c) {
    c = (async () => {
      const [{ createSprClient }, { SignedTeePolicy }] = await Promise.all([import("@heliuslabs/spr"), import("@heliuslabs/spr/client")]);
      const urls = solanaEndpoints(base);
      return createSprClient({
        solanaRpcUrl: urls.rpc,
        indexerUrl: urls.spr,
        proverUrl: urls.spr,
        proverTee: SignedTeePolicy.forNetwork(network),
        commitment: "confirmed",
        priorityFeeLamports: SOLANA_RELAYED_PRIORITY_FEE,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
    })();
    if (!opts.fetch) {
      c.catch(() => clients.delete(key));
      clients.set(key, c);
    }
  }
  return c;
}

/**
 * The private account's keys from the main wallet's signature over
 * solanaAccountMessage(index): the same derivation as the Gloam app.
 */
export async function deriveSolanaAccount(walletSignature: Uint8Array, index: number): Promise<ShieldedKeypair> {
  const { ShieldedKeypair, SigningKey, initializePoseidon } = await import("@heliuslabs/spr");
  await initializePoseidon(); // the account's shielded address hashes with it
  const seed = await solanaAccountSeed(walletSignature, index);
  try {
    return ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as never));
  } finally {
    seed.fill(0);
  }
}

/** The private account's address for a main wallet's signature, without opening anything. */
export async function solanaAccountAddress(walletSignature: Uint8Array, index = 0): Promise<string> {
  const keypair = await deriveSolanaAccount(walletSignature, index);
  try {
    return keypair.toSolanaSigner().address;
  } finally {
    keypair.destroy();
  }
}

/**
 * Open private account `index` (default 0) of `wallet`: one message signature,
 * nothing stored. The same wallet reopens the same account here and in the
 * Gloam app. Reads nothing private until a sync (solanaBalances).
 */
export async function openSolanaAccount(input: SolanaOptions & { wallet: SolanaMainWallet; index?: number; store?: SolanaSnapshotStore }): Promise<GloamSolanaAccount> {
  const index = input.index ?? 0;
  const network = input.network ?? "mainnet";
  const opts: SolanaOptions = { network, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) };
  if (!isSolanaAddress(input.wallet.address)) throw new Error("The main wallet's address is not a Solana address.");
  const message = solanaAccountMessage(index);
  const signature = await input.wallet.signMessage(message);
  try {
    if (!(await isPlainSolanaSignature(base58Decode(input.wallet.address), message, signature))) {
      throw new Error("This wallet signs messages in a way that can't open a Gloam private account (not a plain Ed25519 signature).");
    }
    const keypair = await deriveSolanaAccount(signature, index);
    const [client, spr] = await Promise.all([solanaRingsClient(opts), import("@heliuslabs/spr")]);
    const keys = spr.LocalKeys.fromKeypair(keypair, client.proofService);
    const store = input.store ?? memoryStore();
    let saved: Wallet | undefined;
    try {
      saved = await spr.loadPersistedWallet({ store, cipher: spr.walletSnapshotCipher(keypair) });
    } catch {
      saved = undefined; // a snapshot this account can't open: start over
    }
    const rings = saved ?? new spr.Wallet({ identity: keypair.shieldedAddress() });
    const account: GloamSolanaAccount = {
      network,
      index,
      mainAddress: input.wallet.address,
      address: keypair.toSolanaSigner().address,
      _: { opts, wallet: input.wallet, keypair, keys, rings, client, store },
    };
    await knowAssets(account);
    return account;
  } finally {
    signature.fill(0);
  }
}

/** Wipe the account's keys from memory. The wallet reopens it with the same signature. */
export function closeSolanaAccount(account: GloamSolanaAccount): void {
  try {
    account._.keys.destroy();
  } catch {}
  try {
    account._.keypair.destroy();
  } catch {}
}

/** Tell the Rings wallet the asset ids of the tokens Gloam lists, so a sync never has to scan for them. */
async function knowAssets(account: GloamSolanaAccount): Promise<void> {
  const [{ getSplAssetRegistryAddress }, { decodeSplAssetRegistry }] = await Promise.all([
    import("@heliuslabs/spr/addresses"),
    import("@heliuslabs/spr/interface"),
  ]);
  for (const a of SOLANA_ASSETS[account.network]) {
    if (!a.mint) continue;
    try {
      const acct = await account._.client.getAccount(await getSplAssetRegistryAddress(a.mint as Address));
      if (!acct?.data?.length) continue;
      const reg = decodeSplAssetRegistry(acct.data);
      if (reg.mint === a.mint) account._.rings.ensureAsset(reg.assetId, reg.mint);
    } catch {
      // read again on the next open; the sync can still name it
    }
  }
}

/** Read the account's private history from the indexer and decrypt it here. */
export async function syncSolanaAccount(account: GloamSolanaAccount, requireSlot?: bigint): Promise<void> {
  const spr = await import("@heliuslabs/spr");
  const s = account._;
  await spr.syncPersistedWallet({
    wallet: s.rings,
    keys: s.keys,
    client: s.client,
    store: s.store,
    cipher: spr.walletSnapshotCipher(s.keypair),
    ...(requireSlot === undefined ? {} : { config: { requireSlot } }),
  });
}

/** The private balance of each listed asset, in base units ({ sol, usdc, usdt, zec }). Syncs first unless `sync: false`. */
export async function solanaBalances(account: GloamSolanaAccount, opts: { sync?: boolean } = {}): Promise<Record<string, bigint>> {
  if (opts.sync !== false) await syncSolanaAccount(account);
  const byMint = new Map(account._.rings.balances(true).map((b) => [b.mint as string, b.amount]));
  const out: Record<string, bigint> = {};
  for (const a of SOLANA_ASSETS[account.network]) out[a.id] = byMint.get(a.mint ?? SOLANA_RINGS_SOL_MINT) ?? 0n;
  return out;
}

/** Whether `owner` (this account by default) can be paid privately: it has a Rings registry record. */
export async function isSolanaAccountRegistered(account: GloamSolanaAccount, owner: string = account.address): Promise<boolean> {
  const { isWalletRegistered } = await import("@heliuslabs/spr/wallet");
  return isWalletRegistered({ rpc: account._.client, owner: owner as Address });
}

const encodeTx = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));

/** A serialized transaction's blockhash (its lifetime). */
export function solanaTxBlockhash(wire: Uint8Array): string {
  const tx = getTransactionDecoder().decode(wire);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as { lifetimeToken?: string };
  if (!compiled.lifetimeToken) throw new Error("This transaction has no blockhash.");
  return compiled.lifetimeToken;
}

async function relayer(opts: SolanaOptions): Promise<Address> {
  const st = await solanaRelayStatus(opts);
  if (!st.on || !st.relayer) throw new Error("Gloam's Solana relay isn't on right now.");
  if (!st.funded) throw new Error("Gloam's Solana relay is out of SOL for fees right now. Try again later.");
  return st.relayer as Address;
}

/**
 * The registration (a version 1 transaction, `payer` paying the record's
 * rent), signed by the private account with the payer's slot empty: what
 * registerSolanaAccount hands the relay. Null when it is already registered
 * with these keys; rejects when it is registered with other keys.
 */
export async function buildSolanaRegistration(account: GloamSolanaAccount, payer?: string): Promise<Uint8Array | null> {
  const [w, ix, spr] = await Promise.all([import("@heliuslabs/spr/wallet"), import("@heliuslabs/spr/instructions"), import("@heliuslabs/spr")]);
  const s = account._;
  const feePayer = (payer ?? (await relayer(s.opts))) as Address;
  const existing = await w.fetchUserRecord({ rpc: s.client, owner: account.address as Address });
  if (existing) {
    await w.validateRegisteredKeypair({ rpc: s.client, owner: account.address as Address, keypair: s.keypair });
    return null;
  }
  const owner = s.keypair.toSolanaSigner();
  const shielded = s.keypair.shieldedAddress();
  const instructions = [
    await ix.getRegisterInstructionAsync({
      owner,
      payer: feePayer,
      nullifierPublicKey: shielded.nullifierPublicKey,
      viewingPublicKey: shielded.viewingPublicKey.toBytes(),
    }),
    await ix.getSetMergeEncryptionInstructionAsync({ owner, scheme: spr.MergeEncryptionScheme.PoseidonCtrV1 }),
  ];
  const lifetime = await s.client.getLatestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime as never, m),
    // as the SDK compiles: version 1 counts loaded account data against this, and the default is too small
    (m) => setTransactionMessageConfig({ computeUnitLimit: 200_000, priorityFeeLamports: SOLANA_RELAYED_PRIORITY_FEE, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 }, m),
    (m) => appendTransactionMessageInstructions(instructions as Instruction[], m)
  );
  return encodeTx((await partiallySignTransactionMessageWithSigners(message as never)) as Transaction);
}

/**
 * Publish the private account in the Rings registry, so it can be paid
 * privately by its address. Gloam's relay pays the record's rent (about
 * 0.0016 SOL). Nothing to do (signature null) when it is already registered.
 */
export async function registerSolanaAccount(account: GloamSolanaAccount, opts: { timeoutMs?: number } = {}): Promise<{ signature: string | null; alreadyRegistered: boolean }> {
  const wire = await buildSolanaRegistration(account);
  if (!wire) return { signature: null, alreadyRegistered: true };
  const blockhash = solanaTxBlockhash(wire);
  const signature = await relaySend(account._.opts, wire, blockhash);
  const st = await waitForSolanaTx({ signature, blockhash, timeoutMs: opts.timeoutMs ?? SOLANA_DEFAULT_TIMEOUT_MS }, account._.opts);
  if (st.state === "failed" || st.state === "dropped") throw new SolanaTxError(`The registration was ${st.state}. Nothing was registered; try again.`, st.state, signature);
  return { signature, alreadyRegistered: false };
}

function assetOf(account: GloamSolanaAccount, asset: string | SolanaAsset): SolanaAsset {
  const a = typeof asset === "string" ? solanaAsset(asset, account.network) : asset;
  if (!a) throw new Error(`Gloam on Solana lists ${SOLANA_ASSETS[account.network].map((x) => x.symbol).join(", ")}; "${String(asset)}" is not one of them.`);
  return a;
}

function positive(amount: bigint): bigint {
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("The amount must be a positive bigint in base units.");
  return amount;
}

/**
 * Add money: the main wallet deposits `amount` (base units) of `asset` into
 * the private account and pays Solana's fee. Public on chain: the main
 * wallet, the asset and the amount. Built as a version 0 transaction with
 * compute-budget instructions, which every wallet signs.
 */
export async function addToSolanaPrivate(
  account: GloamSolanaAccount,
  input: { asset: string | SolanaAsset; amount: bigint; timeoutMs?: number }
): Promise<SolanaSendResult> {
  const asset = assetOf(account, input.asset);
  const amount = positive(input.amount);
  const s = account._;
  const [{ buildDepositTransaction }, { getAssociatedTokenAddress }] = await Promise.all([import("@heliuslabs/spr/wallet"), import("@heliuslabs/spr/addresses")]);
  const main = account.mainAddress as Address;
  const spl = asset.mint
    ? {
        asset: asset.mint as Address,
        splTokenAccount: await getAssociatedTokenAddress(main, asset.mint as Address, TOKEN_PROGRAM),
        splTokenProgram: TOKEN_PROGRAM,
        // the mint's one-time setup is Gloam's to do, never a user's
        createSplInterface: false,
      }
    : {};
  const built = await buildDepositTransaction({ client: s.client, feePayer: main, depositor: main, recipient: s.keypair.shieldedAddress(), amount, ...spl });
  const wire = await asVersion0(account, built, main);
  const blockhash = solanaTxBlockhash(wire);
  const signed = await s.wallet.signTransaction(wire);
  const signature = await rpc<string>(s.opts, "sendTransaction", [getBase64Decoder().decode(signed), { encoding: "base64" }]);
  return settle(account, signature, blockhash, input.timeoutMs, async () => {});
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

/** The Rings SDK's version 1 transaction rebuilt as version 0, its compute limit as an instruction, the main wallet paying. */
async function asVersion0(account: GloamSolanaAccount, built: Transaction, feePayer: Address): Promise<Uint8Array> {
  const compiled = getCompiledTransactionMessageDecoder().decode(built.messageBytes);
  const message = decompileTransactionMessage(compiled as never) as unknown as { instructions: readonly Instruction[]; config?: { computeUnitLimit?: number } };
  const units = message.config?.computeUnitLimit ?? 200_000;
  const lifetime = await account._.client.getLatestBlockhash();
  const budget: Instruction[] = [
    { programAddress: COMPUTE_BUDGET, data: Uint8Array.of(2, ...u32le(units)) },
    { programAddress: COMPUTE_BUDGET, data: Uint8Array.of(3, ...u64le(ADD_CU_PRICE)) },
  ];
  const v0 = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime as never, m),
    (m) => appendTransactionMessageInstructions([...budget, ...message.instructions], m)
  );
  return encodeTx(compileTransaction(v0 as never) as Transaction);
}

/** Wait for a send to settle; a landed one is read back into the balance, a failed or dropped one frees its funds and throws. */
async function settle(account: GloamSolanaAccount, signature: string, blockhash: string, timeoutMs: number | undefined, release: () => Promise<void>): Promise<SolanaSendResult> {
  const explorer = `https://solscan.io/tx/${signature}${account.network === "devnet" ? "?cluster=devnet" : ""}`;
  const st = await waitForSolanaTx({ signature, blockhash, timeoutMs: timeoutMs ?? SOLANA_DEFAULT_TIMEOUT_MS }, account._.opts);
  if (st.state === "landed") {
    await syncSolanaAccount(account, st.slot).catch(() => undefined); // paid either way; the next read catches up
    return { signature, state: "landed", blockhash, slot: st.slot, explorer };
  }
  if (st.state === "pending") return { signature, state: "pending", blockhash, explorer };
  await release();
  throw new SolanaTxError(
    st.state === "failed" ? "It failed on Solana, so nothing moved. You can send it again." : "Solana dropped it (its blockhash expired unseen), so nothing moved. You can send it again.",
    st.state,
    signature
  );
}

/** Reopen the last saved snapshot, freeing notes a build set aside but never sent. */
async function reloadWallet(account: GloamSolanaAccount): Promise<void> {
  const spr = await import("@heliuslabs/spr");
  const s = account._ as AccountState;
  try {
    const w = await spr.loadPersistedWallet({ store: s.store, cipher: spr.walletSnapshotCipher(s.keypair) });
    s.rings = w ?? new spr.Wallet({ identity: s.keypair.shieldedAddress() });
  } catch {
    s.rings = new spr.Wallet({ identity: s.keypair.shieldedAddress() });
  }
  await knowAssets(account);
}

/** Build with the relay as fee payer, sign as the private account, hand to the relay, then wait. */
async function relayed(account: GloamSolanaAccount, timeoutMs: number | undefined, build: (feePayer: Address) => Promise<Transaction>): Promise<SolanaSendResult> {
  const s = account._;
  const feePayer = await relayer(s.opts);
  await syncSolanaAccount(account);
  const tx = await build(feePayer);
  const [sigs] = await s.keypair.toSolanaSigner().signTransactions([tx as never]);
  const wire = encodeTx({ ...tx, signatures: { ...tx.signatures, ...sigs } } as Transaction);
  const blockhash = solanaTxBlockhash(wire);
  let signature: string;
  try {
    signature = await relaySend(s.opts, wire, blockhash);
  } catch (e) {
    // Refused before the send: free the notes. Maybe sent: keep them set aside, the caller checks the chain first.
    if (e instanceof SolanaRelayError && !e.maybeSent) await reloadWallet(account);
    throw e;
  }
  return settle(account, signature, blockhash, timeoutMs, () => reloadWallet(account));
}

/**
 * Pay `amount` (base units) of `asset` privately to another Gloam private
 * account on Solana (a registered Privacy Rings address). Gloam's relay pays
 * the fee. Public on chain: both private accounts. Hidden: the asset and the
 * amount.
 */
export async function paySolanaPrivately(
  account: GloamSolanaAccount,
  input: { to: string; asset: string | SolanaAsset; amount: bigint; timeoutMs?: number }
): Promise<SolanaSendResult> {
  if (!isSolanaAddress(input.to)) throw new Error("`to` is not a Solana address.");
  if (input.to === account.address) throw new Error("That is this private account itself.");
  const asset = assetOf(account, input.asset);
  const amount = positive(input.amount);
  const { buildTransferTransaction } = await import("@heliuslabs/spr/wallet");
  return relayed(account, input.timeoutMs, (feePayer) =>
    buildTransferTransaction({
      client: account._.client,
      wallet: account._.rings,
      keys: account._.keys,
      feePayer,
      recipient: input.to as Address,
      amount,
      ...(asset.mint ? { asset: asset.mint as Address } : {}),
    })
  );
}

/**
 * Cash out `amount` (base units) of `asset` to any Solana address (the main
 * wallet, say). Gloam's relay pays the fee, and the rent of the destination's
 * token account if it has none yet. Public on chain: the private account, the
 * destination, the asset and the amount.
 */
export async function cashOutSolana(
  account: GloamSolanaAccount,
  input: { to: string; asset: string | SolanaAsset; amount: bigint; timeoutMs?: number }
): Promise<SolanaSendResult> {
  if (!isSolanaAddress(input.to)) throw new Error("`to` is not a Solana address.");
  const asset = assetOf(account, input.asset);
  const amount = positive(input.amount);
  const { buildWithdrawalTransaction } = await import("@heliuslabs/spr/wallet");
  return relayed(account, input.timeoutMs, (feePayer) =>
    buildWithdrawalTransaction({
      client: account._.client,
      wallet: account._.rings,
      keys: account._.keys,
      feePayer,
      recipient: input.to as Address,
      amount,
      ...(asset.mint ? { asset: asset.mint as Address, splTokenProgram: TOKEN_PROGRAM } : {}),
    })
  );
}

/** Plain words for the Rings SDK's error codes (walks `cause`). */
export function solanaErrorMessage(e: unknown): string {
  if (e instanceof SolanaRelayError || e instanceof SolanaTxError) return e.message;
  const codes = new Set<string>();
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    const x = cur as { code?: unknown; causeCode?: unknown; causeCodes?: unknown; cause?: unknown };
    for (const c of [x.code, x.causeCode, ...(Array.isArray(x.causeCodes) ? x.causeCodes : [])]) if (typeof c === "string") codes.add(c);
    cur = x.cause;
  }
  const text = e instanceof Error ? e.message : String(e);
  const has = (c: string) => codes.has(c) || text.includes(c);
  if (has("WALLET_INSUFFICIENT_BALANCE")) return "The private balance is too low for that.";
  if (has("WALLET_RECIPIENT_NOT_REGISTERED")) return "That address has no registered private account yet (it must register before it can be paid privately).";
  if (has("WALLET_TOO_MANY_INPUTS")) return "That needs too many small amounts at once. Try a smaller amount.";
  if (has("WALLET_NOTE_RESERVED")) return "A payment is still settling. Try again in a minute.";
  if (has("WALLET_MISSING_SPL_TOKEN_ACCOUNT")) return "The main wallet doesn't hold that token yet.";
  if (has("WALLET_USER_RECORD_KEYS_MISMATCH") || has("WALLET_REGISTERED_KEYPAIR_MISMATCH")) return "This private account is registered with other keys.";
  return text;
}
