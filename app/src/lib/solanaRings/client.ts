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
 *    instructions, which every wallet signs (the SDK builds version 1). A
 *    wallet with no SOL for the fee adding a token signs only, and Gloam's
 *    relay pays the fee and sends it (relayPolicy's one version 0 shape).
 *  - Registering, paying and cashing out: the private account signs, and
 *    Gloam's relay (/api/solana/relay) adds its signature as fee payer and
 *    sends. The private account never holds SOL.
 *  - Every send is waited on here, never by the SDK's confirmTransaction (a
 *    count of timers and fetches with no deadline, which can wait forever): the
 *    page reads its status, sends the same signed transaction again until it is
 *    confirmed, and once its blockhash has expired unseen it was dropped for
 *    good, so it is built and sent once more (lib/solanaRings/landing). Each
 *    step is told to the page through onStep.
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
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
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
import { accountFromSeed, accountMessage, deriveAccount, isPlainSignature } from "./account";
import { SNAPSHOT_PREFIX } from "./opened";
import { noteWalletAdd } from "./addReport";
import { addFeePayer, ringsAssets, ringsBalancesFrom, ringsUrls, SOLANA_RINGS_NETWORK, walletChain, type RingsAsset, type RingsNetwork } from "./config";
import {
  awaitLanding,
  blockhashOfMessage,
  blockhashOfWire,
  computeUnitsOf,
  feeLamportsOfWire,
  landWithOneResend,
  priorityFeeFor,
  REGISTER_COMPUTE_UNITS,
  RELAY_PRIORITY_FEE_FLOOR,
  relayUnitPrice,
  signatureOfWire,
  sigStatusFrom,
  withPriorityFee,
  type Landing,
  type LandingDeps,
} from "./landing";
import { canSignOnly, signOnlySolana, signOrSendSolana, signSolanaMessage, type SolanaAccount, type SolanaWallet } from "@/lib/solanaWallet";

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
// Public Solana program ids (SPL Token, Token-2022), not secrets.
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address; // ggignore
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address; // ggignore
/** Compute unit price on a deposit the main wallet pays for, micro-lamports. */
const DEPOSIT_CU_PRICE = 20_000n;
/** A wallet that sends a deposit itself: extra wait after its blockhash expired before calling it dropped. */
const WALLET_SENT_GRACE_MS = 15_000;

export type RelayStatus = {
  on: boolean;
  funded: boolean;
  relayer: string | null;
  network: RingsNetwork;
  /** Helius's recommended priority fee price (micro-lamports per compute unit), or null. */
  priorityMicroLamports: number | null;
};

/** Whether Gloam's relay is set up, its fee-payer address, and the fee price to build with. */
export async function relayStatus(): Promise<RelayStatus> {
  try {
    const res = await fetch(ringsUrls(location.origin).relay, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as Partial<RelayStatus>;
    const price = json.priorityMicroLamports;
    return {
      on: Boolean(json.on && json.relayer),
      funded: Boolean(json.funded),
      relayer: json.relayer ?? null,
      network: json.network ?? SOLANA_RINGS_NETWORK,
      priorityMicroLamports: typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : null,
    };
  } catch {
    return { on: false, funded: false, relayer: null, network: SOLANA_RINGS_NETWORK, priorityMicroLamports: null };
  }
}

/** A step of a send, for the page to show while it waits. */
export type RingsStep = "sending" | "waiting" | "resending" | "confirm_again" | "checking";

export type StepOptions = {
  /** Called at each step of a send, with plain words for it. */
  onStep?: (step: RingsStep, label: string) => void;
};

/** Plain words for each step (the page adds "Keep this tab open"). */
export function ringsStepLabel(step: RingsStep, walletName = "your wallet"): string {
  switch (step) {
    case "sending":
      return "Sending to Solana";
    case "waiting":
      return "Waiting for Solana to confirm";
    case "resending":
      return "Solana dropped it. Sending it again";
    case "confirm_again":
      return `It didn't reach Solana. Confirm it again in ${walletName}`;
    case "checking":
      return "Checking on Solana whether it went through";
  }
}

function tell(opts: StepOptions | undefined, step: RingsStep, walletName?: string): void {
  try {
    opts?.onStep?.(step, ringsStepLabel(step, walletName));
  } catch {
    // a page's handler never stops a send
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
        // the floor: what the relay pays is set per transaction before it is signed (withRelayFee)
        priorityFeeLamports: RELAY_PRIORITY_FEE_FLOOR,
      });
    })();
    c.catch(() => clients.delete(network));
    clients.set(network, c);
  }
  return c;
}

/** One call to Gloam's Solana RPC proxy. Never waits more than 15 seconds. */
async function proxyRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ringsUrls(location.origin).rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
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

const storeKey = (network: RingsNetwork, owner: string) => `${SNAPSHOT_PREFIX}${network}:${owner}`;

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
 * same account on any device. `onSeed` sees the account's seed before it is
 * wiped, for a caller that keeps it sealed on this device (lib/solanaRings/keep).
 */
export async function openRingsAccount(input: {
  wallet: SolanaWallet;
  account: SolanaAccount;
  index?: number;
  network?: RingsNetwork;
  onSeed?: (seed: Uint8Array) => void;
}): Promise<RingsSession> {
  const index = input.index ?? 0;
  const message = accountMessage(index);
  const signature = await signSolanaMessage(input.wallet, input.account, message);
  try {
    const publicKey = new Uint8Array(getAddressEncoder().encode(input.account.address as Address));
    if (!(await isPlainSignature(publicKey, message, signature))) {
      throw new Error(`${input.wallet.name} signs messages in a way that can't open a private account. Try another wallet.`);
    }
    const keypair = await deriveAccount(signature, index, input.onSeed);
    return await sessionFor(input, index, keypair);
  } finally {
    signature.fill(0);
  }
}

/** Open private account `index` again from its kept seed (lib/solanaRings/keep): no signature. */
export async function reopenRingsAccount(input: {
  wallet: SolanaWallet;
  account: SolanaAccount;
  index: number;
  network?: RingsNetwork;
  seed: Uint8Array;
}): Promise<RingsSession> {
  return sessionFor(input, input.index, await accountFromSeed(input.seed));
}

async function sessionFor(
  input: { wallet: SolanaWallet; account: SolanaAccount; network?: RingsNetwork },
  index: number,
  keypair: ShieldedKeypair
): Promise<RingsSession> {
  const network = input.network ?? SOLANA_RINGS_NETWORK;
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
const fromB64 = (text: string) => new Uint8Array(getBase64Encoder().encode(text));

/** Add the private account's signature to `tx`, the relay's slot left empty. */
export async function ownerSigned(s: RingsSession, tx: Transaction): Promise<Uint8Array> {
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

/** What the relay sent: its signature, and the signed transaction to send again while it waits. */
export type Sent = { signature: string; signed: string | null };

/** The signed transactions the relay handed back, by signature, so a later confirm can rebroadcast them. */
const signedBySignature = new Map<string, string>();

function remember(sent: Sent): void {
  if (!sent.signed) return;
  signedBySignature.delete(sent.signature);
  signedBySignature.set(sent.signature, sent.signed);
  while (signedBySignature.size > 32) signedBySignature.delete(signedBySignature.keys().next().value!);
}

/** Hand a transaction the private account signed to Gloam's relay. */
export async function relay(wire: Uint8Array): Promise<Sent> {
  let res: Response;
  try {
    res = await fetch(ringsUrls(location.origin).relay, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: b64(wire) }),
      // past the relay's own limit (45 seconds): a lost answer, which may come after the send
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    throw new RingsRelayError("Gloam's relay didn't answer. Check your connection.", 0, "network", true);
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; signature?: string; tx?: unknown; error?: { code?: string; message?: string } } | null;
  if (!json?.ok || !json.signature) {
    const code = json?.error?.code ?? "unknown";
    // 4xx and the 5xx codes above are refused before the send; any other 5xx (or a reply that isn't the relay's) may come after it.
    const maybeSent = res.ok || (res.status >= 500 && !RELAY_NOT_SENT.has(code));
    throw new RingsRelayError(json?.error?.message ?? "Gloam's relay didn't take it. Try again.", res.status, code, maybeSent);
  }
  const sent: Sent = { signature: json.signature, signed: typeof json.tx === "string" ? json.tx : null };
  remember(sent);
  return sent;
}

/** A sleep that ends early when the tab is shown again, so a wait picks up at once after it was in the background. */
function wakeableSleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const doc = typeof document === "undefined" ? null : document;
    const finish = () => {
      clearTimeout(timer);
      doc?.removeEventListener("visibilitychange", onShow);
      done();
    };
    const onShow = () => {
      if (doc?.visibilityState === "visible") finish();
    };
    const timer = setTimeout(finish, ms);
    doc?.addEventListener("visibilitychange", onShow);
  });
}

/**
 * How the page waits on one sent transaction: its status through Gloam's
 * proxy, its blockhash when known, and the signed transaction sent again
 * while it is unconfirmed when the page holds it.
 */
function landingDeps(signature: string, blockhash: string | null, signed: string | null): LandingDeps {
  return {
    status: async () => {
      const st = await proxyRpc<{ value?: unknown[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (!Array.isArray(st.value)) throw new Error("no answer");
      return sigStatusFrom(st.value[0] as never);
    },
    blockhashValid: blockhash ? async () => (await proxyRpc<{ value: boolean }>("isBlockhashValid", [blockhash, { commitment: "confirmed" }])).value : null,
    ...(signed ? { rebroadcast: () => proxyRpc<string>("sendTransaction", [signed, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]) } : {}),
    sleep: wakeableSleep,
    now: () => Date.now(),
  };
}

/** Wait on something the relay sent: landed, failed, dropped for good, or unknown when the chain didn't answer in time. */
export function waitForSent(sent: Sent, blockhash: string | null): Promise<Landing> {
  return awaitLanding(landingDeps(sent.signature, blockhash ?? (sent.signed ? blockhashOfWire(fromB64(sent.signed)) : null), sent.signed));
}

type RelayInfo = { address: Address; price: number | null };

async function relayInfo(): Promise<RelayInfo> {
  const st = await relayStatus();
  if (!st.on || !st.relayer) throw new Error("Gloam's Solana relay isn't set up yet.");
  return { address: st.relayer as Address, price: st.priorityMicroLamports };
}

/**
 * `tx` (built by the SDK, not signed yet) with the priority fee the relay
 * pays set from Helius's recommended price. Built as it was if that can't be
 * read: then it carries the floor the SDK client was made with.
 */
export function withRelayFee<T extends Transaction>(tx: T, price: number | null): T {
  try {
    const units = computeUnitsOf(tx.messageBytes);
    return units ? withPriorityFee(tx, priorityFeeFor(price, units)) : tx;
  } catch {
    return tx;
  }
}

/**
 * The registration transaction (version 1, `payer` paying the record's rent
 * and `priorityFeeLamports`), signed by the private account. Null when it is
 * already registered with these keys; rejects when it is registered with
 * other keys.
 */
export async function buildRegistration(s: RingsSession, payer: Address, priorityFeeLamports: bigint = RELAY_PRIORITY_FEE_FLOOR): Promise<Uint8Array | null> {
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
    (m) => setTransactionMessageConfig({ computeUnitLimit: REGISTER_COMPUTE_UNITS, priorityFeeLamports, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 }, m),
    (m) => appendTransactionMessageInstructions(instructions as Instruction[], m),
  );
  return encodeTx((await partiallySignTransactionMessageWithSigners(message as never)) as Transaction);
}

export const SETUP_DIDNT_LAND = "Solana didn't take your setup, twice. Nothing changed. Try again in a minute.";
export const SETUP_NOT_CONFIRMED = "Solana hasn't confirmed your setup yet. Try again in a minute.";

/**
 * Publish the private account in the registry, so it can be paid privately by
 * its address. The relay pays the record's rent. Nothing to do when it is
 * already registered with these keys. A registration Solana dropped (or that
 * failed there) is built and sent once more: the registry is read first, so
 * it can never be made twice.
 */
export async function ensureRegistered(s: RingsSession, opts: StepOptions = {}): Promise<void> {
  const r = await landWithOneResend<{ wire: Uint8Array; blockhash: string | null }>({
    build: async () => {
      const relay = await relayInfo();
      const wire = await buildRegistration(s, relay.address, priorityFeeFor(relay.price, REGISTER_COMPUTE_UNITS));
      return wire ? { wire, blockhash: blockhashOfWire(wire) } : null;
    },
    sendAndWait: async ({ wire, blockhash }) => {
      tell(opts, "sending");
      let sent: Sent | null = null;
      try {
        sent = await relay(wire);
      } catch (e) {
        if (!(e instanceof RingsRelayError) || !e.maybeSent) throw e;
      }
      tell(opts, "waiting");
      // Without the relay's answer there is no signature to read: the registry record is the evidence.
      const out = sent
        ? await waitForSent(sent, blockhash)
        : await awaitLanding({
            ...landingDeps("", blockhash, null),
            status: async () => ((await isRegistered(s)) ? { seen: true, failed: false, confirmed: true, slot: 0n } : { seen: false }),
          });
      // failed: nothing changed, and the next build reads the registry first, so it goes again like a drop
      return out.state === "failed" ? { state: "dropped" } : out;
    },
    onResend: () => tell(opts, "resending"),
    recheck: true,
  });
  if (r.state === "done" || r.state === "landed") return;
  if (r.state === "unknown") throw new Error(SETUP_NOT_CONFIRMED);
  throw new Error(SETUP_DIDNT_LAND);
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
 * fee (`unitPrice` for that limit, micro-lamports a unit). Wallets sign
 * version 0; `feePayer` pays: the main wallet, or Gloam's relay.
 */
async function asVersion0(s: RingsSession, built: Transaction, feePayer: Address, unitPrice: (units: number) => bigint = () => DEPOSIT_CU_PRICE): Promise<Uint8Array> {
  const compiled = getCompiledTransactionMessageDecoder().decode(built.messageBytes);
  const message = decompileTransactionMessage(compiled as never) as unknown as {
    instructions: readonly Instruction[];
    config?: { computeUnitLimit?: number };
  };
  const units = message.config?.computeUnitLimit ?? 200_000;
  const lifetime = await s.client.getLatestBlockhash();
  const budget: Instruction[] = [
    { programAddress: COMPUTE_BUDGET, data: Uint8Array.of(2, ...u32le(units)) },
    { programAddress: COMPUTE_BUDGET, data: Uint8Array.of(3, ...u64le(unitPrice(units))) },
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
 * into the private account, as an unsigned version 0 transaction. `from` pays
 * the fee, or with `relay`, Gloam's relay does (its address as fee payer, the
 * priority fee from Helius's price within the relay's cap): the one version 0
 * shape the relay pays for (lib/solanaRings/relayPolicy).
 */
export async function buildAddTransaction(
  s: RingsSession,
  asset: RingsAsset,
  amount: bigint,
  from?: Address,
  relay?: { address: Address; price: number | null }
): Promise<Uint8Array> {
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
    feePayer: relay?.address ?? main,
    depositor: main,
    recipient: s.keypair.shieldedAddress(),
    amount,
    ...spl,
  });
  return relay ? asVersion0(s, built, relay.address, (units) => relayUnitPrice(relay.price, units)) : asVersion0(s, built, main);
}

export const ADD_FAILED = "That didn't go through on Solana, and nothing moved. Try again.";
export const ADD_NOT_CONFIRMED = "Solana hasn't confirmed it yet. Check your balance in a minute before you add again.";
export const ADD_DIDNT_LAND = "Solana didn't take it, twice, and nothing moved. Try again in a minute.";
export const ADD_NEEDS_SOL = "Your wallet needs a little SOL for the network fee. Add some SOL to it and try again.";
export const ADD_RELAY_BUSY = "Gloam can't pay the network fee right now, and nothing moved. Add a little SOL to your wallet for the fee, or try again later.";

/** Relay refusals that mean it can't pay a fee now (nothing was sent): the wallet's own SOL is the way through. */
const RELAY_CANT_PAY = new Set(["relay_off", "relay_empty", "relay_unavailable", "rate_limited"]);

/** An add as built, and who pays its fee. */
export type BuiltAdd = { wire: Uint8Array; via: "wallet" | "relay" };

/**
 * Build the add and pick who pays its fee, from the wallet's SOL read through
 * Gloam's RPC proxy just before: the wallet whenever it can pay the exact fee
 * of the add built and be left empty or rent-exempt (config walletPaysFee);
 * else, for a token, Gloam's relay (built again with the relay as fee payer).
 * SOL itself, or a balance that can't be read: the wallet, as before. Rejects
 * with ADD_NEEDS_SOL when neither can pay.
 */
export async function buildAddFor(s: RingsSession, asset: RingsAsset, amount: bigint): Promise<BuiltAdd> {
  const main = s.main.account.address as Address;
  const [wire, lamports] = await Promise.all([
    buildAddTransaction(s, asset, amount),
    asset.mint
      ? proxyRpc<{ value?: unknown }>("getBalance", [main, { commitment: "confirmed" }]).then(
          (r) => (typeof r.value === "number" && Number.isSafeInteger(r.value) && r.value >= 0 ? BigInt(r.value) : null),
          () => null
        )
      : null,
  ]);
  const fee = feeLamportsOfWire(wire) ?? undefined;
  const pick = (relay: RelayStatus | null) => addFeePayer({ asset, walletLamports: lamports, ...(fee === undefined ? {} : { fee }), relay, signOnly: canSignOnly(s.main.wallet) });
  if (pick(null) === "wallet") return { wire, via: "wallet" };
  const st = await relayStatus();
  if (pick(st) !== "relay" || !st.relayer) throw new Error(ADD_NEEDS_SOL);
  return { wire: await buildAddTransaction(s, asset, amount, undefined, { address: st.relayer as Address, price: st.priorityMicroLamports }), via: "relay" };
}

/**
 * An add Gloam's relay pays the fee for: the main wallet signs only (never
 * sends it: the relay signs last, as fee payer), the relay checks, signs and
 * sends it, and the page waits as on every relayed send. A relay answer lost
 * after a send can't be told apart from here, so it ends as not confirmed yet
 * ("unknown"), never sent again on its own.
 */
export async function relayPaidAdd(s: RingsSession, wire: Uint8Array, opts: StepOptions = {}): Promise<{ signature: string; landing: Landing }> {
  const signed = await signOnlySolana(s.main.wallet, s.main.account, wire, walletChain(s.network));
  // The wallet signs what was built, nothing else: a changed transaction is one the relay won't pay for.
  let same = false;
  try {
    const [a, b] = [getTransactionDecoder().decode(wire).messageBytes, getTransactionDecoder().decode(signed).messageBytes];
    same = a.length === b.length && a.every((x, i) => x === b[i]);
  } catch {
    same = false;
  }
  if (!same) throw new Error(`${s.main.wallet.name} changed the transaction, so Gloam can't pay its fee. ${ADD_NEEDS_SOL}`);
  tell(opts, "sending");
  let sent: Sent;
  try {
    sent = await relay(signed);
  } catch (e) {
    if (!(e instanceof RingsRelayError)) throw e;
    if (e.maybeSent) return { signature: "", landing: { state: "unknown" } };
    throw new Error(RELAY_CANT_PAY.has(e.code) ? ADD_RELAY_BUSY : e.message);
  }
  tell(opts, "waiting");
  return { signature: sent.signature, landing: await waitForSent(sent, blockhashOfWire(signed)) };
}

/**
 * Add money: the main wallet deposits `amount` of `asset` into the private
 * account. Public on chain: the main wallet, the asset and the amount (and
 * Gloam's relay as fee payer, when the wallet has no SOL for the fee:
 * buildAddFor). One Solana dropped (its blockhash expired, never seen) is
 * built again and the wallet asked once more; it could never land, so nothing
 * is added twice.
 */
export async function addToPrivate(s: RingsSession, asset: RingsAsset, amount: bigint, opts: StepOptions = {}): Promise<string> {
  let signature = "";
  const r = await landWithOneResend<BuiltAdd>({
    build: () => buildAddFor(s, asset, amount),
    sendAndWait: async ({ wire, via }) => {
      if (via === "relay") {
        const paid = await relayPaidAdd(s, wire, opts);
        signature = paid.signature;
        return paid.landing;
      }
      const out = await signOrSendSolana(s.main.wallet, s.main.account, wire, walletChain(s.network));
      let deps: LandingDeps;
      if ("sent" in out) {
        // The wallet sent it: the page can't send it again, and waits a little past the blockhash it was built with.
        signature = getBase58Decoder().decode(out.sent);
        deps = { ...landingDeps(signature, blockhashOfWire(wire), null), graceMs: WALLET_SENT_GRACE_MS };
      } else {
        const signedTx = getTransactionDecoder().decode(out.signed);
        signature = signatureOfWire(out.signed) ?? "";
        if (!signature) throw new Error(`${s.main.wallet.name} didn't sign it.`);
        const signed = b64(out.signed);
        await proxyRpc<string>("sendTransaction", [signed, { encoding: "base64" }]);
        deps = landingDeps(signature, blockhashOfMessage(signedTx.messageBytes), signed);
      }
      tell(opts, "waiting");
      return awaitLanding(deps);
    },
    onResend: () => tell(opts, "confirm_again", s.main.wallet.name),
  });
  if (r.state === "landed") {
    noteWalletAdd(signature);
    await syncRings(s, r.slot);
    return signature;
  }
  if (r.state === "failed") throw new Error(ADD_FAILED);
  if (r.state === "unknown") throw new Error(ADD_NOT_CONFIRMED);
  throw new Error(ADD_DIDNT_LAND);
}

export type SendOptions = StepOptions & {
  /** Called while it waits on Solana to learn whether a payment went through (up to about two minutes). */
  onChecking?: () => void;
};

/**
 * Send one payment the private account signs through Gloam's relay, so it
 * can never go out twice (lib/solanaRings/send): stored as pending first, its
 * notes freed only after a refusal that sent nothing or once the chain shows
 * it never landed and never can.
 */
async function relayed(s: RingsSession, build: (feePayer: Address) => Promise<Transaction>, opts: SendOptions = {}): Promise<string> {
  const { sendGuarded, pendingStore, pendingKey } = await import("./send");
  const pending = pendingStore({ key: pendingKey(s.network, s.address), cipher: await accountCipher(s, PENDING_DOMAIN) });
  return sendGuarded({
    build: async () => {
      const relay = await relayInfo();
      await syncRings(s);
      const unspent = s.wallet.utxos().filter((u) => !u.spent);
      return checkedBuild(s, unspent, withRelayFee(await build(relay.address), relay.price));
    },
    send: async (wire) => {
      tell(opts, "sending");
      const sent = await relay(wire);
      tell(opts, "waiting");
      return sent.signature;
    },
    release: () => reloadWallet(s),
    confirm: (sig) => confirmPayments(s, sig),
    resolve: (p) => settlePayments(s, p),
    pending,
    sleep: wakeableSleep,
    now: () => Date.now(),
    onChecking: () => {
      opts.onChecking?.();
      tell(opts, "checking");
    },
    onResend: () => tell(opts, "resending"),
  });
}

const PENDING_DOMAIN = "gloam/solana-pending/v1\n";

/** A cipher of this account's own, under `domain` (lib/solanaRings/payrollStore runCipher). */
async function accountCipher(s: RingsSession, domain?: string) {
  const { runCipher } = await import("./payrollStore");
  const viewing = s.keypair.viewingKey();
  const secret = viewing.secretBytes();
  try {
    return await runCipher(secret, s.address, domain);
  } finally {
    secret.fill(0);
    viewing.destroy();
  }
}

/**
 * A built transaction, signed by the private account, with the nullifiers of
 * the notes it spends (from `unspent`, read before the build) and its
 * blockhash: what tells later whether it landed. Refused, and its notes freed,
 * when those can't be read.
 */
async function checkedBuild(
  s: RingsSession,
  unspent: readonly { nullifier: Uint8Array }[],
  tx: Transaction
): Promise<{ wire: Uint8Array; nullifiers: string[]; blockhash: string }> {
  const message = new Uint8Array(tx.messageBytes);
  const nullifiers = unspent.filter((u) => containsBytes(message, u.nullifier)).map((u) => hex(u.nullifier));
  const blockhash = (getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as { lifetimeToken?: string }).lifetimeToken;
  if (!nullifiers.length || !blockhash) {
    await reloadWallet(s);
    throw new Error("This payment couldn't be checked before sending, so it wasn't sent.");
  }
  return { wire: await ownerSigned(s, tx), nullifiers, blockhash };
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
export async function payPrivately(s: RingsSession, to: string, asset: RingsAsset, amount: bigint, opts?: SendOptions): Promise<string> {
  const { buildTransferTransaction } = await import("@heliuslabs/spr/wallet");
  return relayed(
    s,
    (feePayer) =>
    buildTransferTransaction({
      client: s.client,
      wallet: s.wallet,
      keys: s.keys,
      feePayer,
      recipient: to as Address,
      amount,
      ...(asset.mint ? { asset: asset.mint as Address } : {}),
    }),
    opts
  );
}

/**
 * Cash out `amount` of `asset` to any Solana address (the main wallet by
 * default). Public on chain: the private account, the address, the asset and
 * the amount.
 */
export async function cashOut(s: RingsSession, to: string, asset: RingsAsset, amount: bigint, opts?: SendOptions): Promise<string> {
  const { buildWithdrawalTransaction } = await import("@heliuslabs/spr/wallet");
  return relayed(
    s,
    (feePayer) =>
    buildWithdrawalTransaction({
      client: s.client,
      wallet: s.wallet,
      keys: s.keys,
      feePayer,
      recipient: to as Address,
      amount,
      ...(asset.mint ? { asset: asset.mint as Address, splTokenProgram: tokenProgram(asset) } : {}),
    }),
    opts
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
  const relay = await relayInfo();
  await syncRings(s);
  const { buildMultiTransferTransaction } = await import("@heliuslabs/spr/wallet");
  const unspent = s.wallet.utxos().filter((u) => !u.spent);
  const tx = await buildMultiTransferTransaction({
    client: s.client,
    wallet: s.wallet,
    keys: s.keys,
    feePayer: relay.address,
    payments: payments.map((p) => ({ recipient: p.address as Address, amount: p.amount })),
    ...(asset.mint ? { asset: asset.mint as Address } : {}),
  });
  return checkedBuild(s, unspent, withRelayFee(tx, relay.price));
}

/** Send what buildPayments built through Gloam's relay. Rejects with RingsRelayError. */
export async function sendPayments(wire: Uint8Array): Promise<string> {
  return (await relay(wire)).signature;
}

/** After a refusal that sent nothing: free the notes buildPayments set aside. */
export function releasePayments(s: RingsSession): Promise<void> {
  return reloadWallet(s);
}

/**
 * Wait for a sent payment to land (sending it again while it waits), then
 * read it back. Rejects when it failed, was dropped, or the chain didn't
 * answer in time: the caller then settles it on chain (settlePayments).
 */
export async function confirmPayments(s: RingsSession, signature: string): Promise<void> {
  const signed = signedBySignature.get(signature) ?? null;
  const r = await waitForSent({ signature, signed }, null);
  if (r.state !== "landed") throw new Error(`Solana: ${r.state}`);
  await syncRings(s, r.slot);
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
        await releaseNotes(s, f.nullifiers);
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
  await releaseNotes(s, f.nullifiers);
  return { state: "dropped" };
}

type Reservations = {
  _activeReservations?(nowMs: bigint): readonly { id: string; utxoHashes: readonly Uint8Array[] }[];
  _releaseReservation?(id: string): void;
};

/**
 * Free the notes `nullifiers` names, once a payment spending them can never
 * land. The SDK keeps the build's reservation (two minutes) in the snapshot
 * every sync saves, so reopening the snapshot would bring it back and the next
 * payment would read as a low balance until it expired: drop the reservations
 * that hold these notes instead, and save. With an SDK that no longer has
 * those calls, reopen the snapshot (the reservation then lapses on its own).
 */
async function releaseNotes(s: RingsSession, nullifiers: readonly string[]): Promise<void> {
  const w = s.wallet as unknown as Reservations;
  if (typeof w._activeReservations !== "function" || typeof w._releaseReservation !== "function") return reloadWallet(s);
  const held = new Set(s.wallet.utxos().filter((u) => nullifiers.includes(hex(u.nullifier))).map((u) => hex(u.outputContext.hash)));
  for (const r of w._activeReservations(BigInt(Date.now()))) {
    if (r.utxoHashes.some((h) => held.has(hex(h)))) w._releaseReservation(r.id);
  }
  const [spr, { savePersistedWallet }] = await Promise.all([import("@heliuslabs/spr"), import("@heliuslabs/spr/wallet")]);
  await savePersistedWallet({ wallet: s.wallet, store: snapshotStore(s.network, s.address), cipher: spr.walletSnapshotCipher(s.keypair) }).catch(() => undefined);
}

/** A build error that fewer people per transaction would get past. */
export function paymentsTooBig(e: unknown): boolean {
  const codes = ringsErrorCodes(e);
  return codes.has("INTERFACE_TRANSACTION_TOO_LARGE") || codes.has("WALLET_TOO_MANY_INPUTS") || codes.has("WALLET_INVALID_PAYMENT_COUNT");
}

/** This private account's payroll runs in this browser, sealed under a key from its viewing secret. */
export async function ringsPayrollStore(s: RingsSession) {
  const { payrollStore, payrollStoreKey } = await import("./payrollStore");
  return payrollStore({ key: payrollStoreKey(s.network, s.address), cipher: await accountCipher(s) });
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
