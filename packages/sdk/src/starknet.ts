/**
 * @gloamtrade/sdk/starknet: Gloam on Starknet for servers and agents. The same
 * private account as the Gloam app (starknetInfo.ts has the derivation), on
 * Starknet's own privacy pool (STRK20), through Gloam's routes: reads through
 * /api/starknet/rpc, proofs through /api/starknet/prove (Starkscan's prover on
 * mainnet), notes found through /api/starknet/discovery (sealed to Starknet's
 * discovery service), and every transaction sent by Gloam's relay
 * (/api/starknet/relay), which pays Starknet's fees. A private account never
 * holds STRK.
 *
 * What it hides, said plainly: a payment over a channel that is already open
 * hides who paid, who was paid and how much. The first payment to someone
 * shows their private account. Adding money shows the account and the amount;
 * a cash out shows where it went and how much. The pool's auditor key can read
 * what an account does (it cannot spend), and the prover sees what it proves.
 *
 * Not open yet: Gloam's Starknet routes are behind a switch until Starknet
 * opens on Gloam, and refuse until then (StarknetOffError). Proofs come from a
 * small daily quota (StarknetBusyError, code "quota", when it is used).
 *
 * Needs `starknet` (starknet.js 10.5) and `@starkware-libs/starknet-privacy-sdk`
 * (0.14.4-rc.2) next to this package. StarkWare publishes the privacy SDK on
 * GitHub Packages only; the Gloam repo vendors the build it runs
 * (app/vendor/starknet-privacy), which is also what a local devnet needs.
 *
 *   const account = await openStarknetAccount({ wallet: starknetViemWallet(privateKeyToAccount(key)) });
 *   await registerStarknetAccount(account);                      // once: deploy and open it (free, capped)
 *   await starknetBalances(account);                              // { usdc: { private, public } } in base units
 *   await addToStarknetPrivate(account, { amount: 5_000_000n });  // what sits at account.address
 *   await payStarknetPrivately(account, { to, amount: 1_000_000n });
 *   await payStarknetMany(account, { payments: [{ to, amount }, ...] });   // one proof, one fee
 *   await cashOutStarknet(account, { to: "0x...", amount: 1_000_000n });
 *   const link = await makeStarknetClaimLink(account, { amount: 1_000_000n, keep: (l) => save(l.url) });
 *   await claimStarknetLink({ link: url, to: otherAccount.address });
 */
import { Account, CallData, Contract, OutsideExecutionVersion, RpcProvider, Signer, ec, hash, num, outsideExecution, type Call } from "starknet";
import type { ExecuteOptions, ExecuteResult, PrivateTransfersInterface, ProvingBlockId } from "@starkware-libs/starknet-privacy-sdk";
import {
  GLOAM_STARKNET_BASE_URL,
  STARKNET_ACCOUNT_CLASS_HASH,
  STARKNET_ASSETS,
  STARKNET_CHAIN_IDS,
  STARKNET_MAINNET_POOL,
  STARKNET_UDC,
  STARKNET_UDC_ENTRYPOINT,
  isStarknetAddress,
  newStarknetClaimSecret,
  sameStarknetAddress,
  starknetAccountMessage,
  starknetAsset,
  starknetClaimFromLink,
  starknetClaimLinkUrl,
  starknetClaimSeed,
  starknetEndpoints,
  starknetEvmSignatureBytes,
  starknetExplorerTx,
  starknetHkdf,
  starknetSeedFromWalletSignature,
  type StarknetAsset,
  type StarknetClaim,
  type StarknetNetworkKey,
} from "./starknetInfo.js";

export * from "./starknetInfo.js";

/** Blocks a proof's state must sit behind the chain head (the privacy SDK's recipe and the sequencer's rule). */
export const STARKNET_PROOF_DEPTH = 10;
/** How long a send is followed before it says it can't tell yet. */
export const STARKNET_CONFIRM_MS = 5 * 60_000;
/** Most people one payStarknetMany proof is tried with (the app's payroll uses the same). */
export const STARKNET_PAY_MANY_MAX = 28;
/** The relay's cap on server actions in one proof (app relayPolicy MAX_ACTIONS). */
export const STARKNET_MAX_ACTIONS = 64;

const U128_MAX = (1n << 128n) - 1n;
const CURVE_ORDER: bigint = ec.starkCurve.CURVE.n;
const HALF_ORDER = CURVE_ORDER >> 1n;

// ------------------------------------------------------------------ errors

/**
 * Anything Gloam's Starknet routes or Starknet refused. `code` names it;
 * `maybeSent`: it may have reached Starknet, so check the balance (or
 * starknetTxStatus with `txHash`) before trying again.
 */
export class StarknetError extends Error {
  override name = "StarknetError";
  constructor(
    readonly code: string,
    message: string,
    readonly maybeSent = false,
    readonly txHash?: string
  ) {
    super(message);
  }
}

/** Starknet is not open on Gloam (its routes refuse), or the relay sends no moves yet. Nothing was sent. */
export class StarknetOffError extends StarknetError {
  override name = "StarknetOffError";
}

/**
 * Starknet is busy: Gloam's proofs for the day are used ("quota"), this
 * caller asked too often ("limited", "rate_limited"), or the relay or prover
 * is paused or busy for a moment. Nothing was sent; try again later.
 */
export class StarknetBusyError extends StarknetError {
  override name = "StarknetBusyError";
}

/** Gloam's relay fee changed since the account last read it, or is above `maxFee`. Nothing was proven or sent. */
export class StarknetFeeChangedError extends StarknetError {
  override name = "StarknetFeeChangedError";
  constructor(
    message: string,
    /** The fee the relay asks now, base units of the token (null when the relay only said it was too low). */
    readonly fee: bigint | null,
    /** The fee it asked before (or the caller's maxFee). */
    readonly was: bigint | null
  ) {
    super("fee_changed", message);
  }
}

/** Not enough to do that: the private balance (pay, cash out, link) or what sits at the account (add). Nothing was sent. */
export class StarknetInsufficientError extends StarknetError {
  override name = "StarknetInsufficientError";
  constructor(
    message: string,
    readonly have: bigint | null,
    readonly need: bigint | null
  ) {
    super("insufficient", message);
  }
}

/** Relay refusals that sent nothing and pass next time: the same proof goes again. */
const RESEND_SAME_PROOF = new Set(["relay_busy", "upstream_unavailable"]);
const BUSY_CODES = new Set([
  "rate_limited",
  "relay_busy",
  "relay_day_used",
  "relay_unavailable",
  "upstream_unavailable",
  "pool_changed",
  "pool_fee_high",
  "paused",
]);
const OFF_CODES = new Set(["off", "relay_off", "fee_unset", "moves_off"]);

/** A relay refusal as a typed error. */
function relayRefusal(status: number, code: string, message: string): StarknetError {
  if (status === 404 || OFF_CODES.has(code)) return new StarknetOffError(code === "fee_unset" ? "moves_off" : code, OFF_MESSAGE[code] ?? message);
  if (status === 429 || BUSY_CODES.has(code)) return new StarknetBusyError(code, message);
  if (code === "not_relayable" && /fee_too_low|fee_missing/.test(message)) return new StarknetFeeChangedError("Gloam's relay asks a higher fee now. Read it again (starknetRelayStatus) and try again.", null, null);
  // already_sent: a copy went out. relay_failed: no answer that could be read (a gateway timeout can follow a send).
  return new StarknetError(code, message, code === "already_sent" || code === "relay_failed");
}

const OFF_MESSAGE: Record<string, string> = {
  off: "Starknet is not open on Gloam yet. Nothing was sent.",
  relay_off: "Gloam's Starknet relay isn't set up yet. Nothing was sent.",
  fee_unset: "Adding, paying and cashing out on Starknet aren't open yet. Nothing was sent.",
  moves_off: "Adding, paying and cashing out on Starknet aren't open yet. Nothing was sent.",
};

/**
 * Any error from a Starknet call as a StarknetError, in plain words: the
 * prover's quota and rate limits, a route that is off, a screening refusal, a
 * balance too low. Walks `cause`.
 */
export function asStarknetError(e: unknown): StarknetError {
  if (e instanceof StarknetError) return e;
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    const x = cur as { name?: unknown; status?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    const name = typeof x.name === "string" ? x.name : "";
    const msg = typeof x.message === "string" ? x.message : "";
    if (name === "ProvingServiceHttpError") {
      if (x.status === 404) return new StarknetOffError("off", OFF_MESSAGE.off!);
      if (x.status === 429) return new StarknetBusyError("limited", "Too many proofs from here. Try again in a little while.");
      if (x.status === 503) return new StarknetBusyError("prover_unavailable", "Proving is paused for a moment. Try again shortly.");
      if (x.status === 403) return new StarknetError("forbidden", "Gloam's prover answers servers and gloam.trade's own pages only.");
    }
    if (name === "ProvingServiceError" || name === "ScreeningRejected" || name === "ScreeningUnavailable") {
      if (/Starknet is busy/.test(msg)) return new StarknetBusyError("quota", "Starknet is busy: Gloam's proofs for today are used. Try again later.");
      if (/isn't set up yet/.test(msg)) return new StarknetOffError("prover_off", "Proving on Starknet isn't set up on this server yet. Nothing was sent.");
      if (name === "ScreeningRejected" || x.code === 10000) return new StarknetError("screening_refused", "Starknet's deposit screening refused this add. Nothing was added.");
      if (name === "ScreeningUnavailable") return new StarknetBusyError("screening_unavailable", "Starknet's deposit check didn't answer. Try again shortly.");
      if (x.code === -32005) return new StarknetBusyError("prover_unavailable", "The prover is busy. Try again shortly.");
    }
    if (typeof x.code === "number" && x.code === -32005 && /rate limited|Too many/i.test(msg)) return new StarknetBusyError("rate_limited", "Too many requests. Try again in a little while.");
    if (/insufficient|not enough (notes|funds|balance)/i.test(msg)) return new StarknetInsufficientError("The private balance is too low for that.", null, null);
    cur = x.cause;
  }
  return new StarknetError("failed", e instanceof Error ? e.message : String(e));
}

/** Plain words for any Starknet error. */
export function starknetErrorMessage(e: unknown): string {
  return asStarknetError(e).message;
}

// ------------------------------------------------------------------ keys (same as app/src/lib/starknetPrivacy/account.ts)

export interface StarknetAccountKeys {
  /** Stark curve private key of the account. Never leaves this process. */
  accountKey: bigint;
  /** Its public key (x coordinate), the account's constructor argument and deploy salt. */
  publicKey: string;
  /** The pool viewing key, canonical (0 < key < n/2). */
  viewingKey: bigint;
  /** The account's address once Gloam's relay deploys it. */
  address: string;
}

const toBig = (b: Uint8Array): bigint => BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));

/** Reduce 512 HKDF bits mod the curve order to a non-zero scalar. */
function scalar(b: Uint8Array): bigint {
  const k = toBig(b) % CURVE_ORDER;
  return k === 0n ? 1n : k;
}

/** The pool's canonical form of a viewing key: below half the curve order, non-zero. */
export function canonicalStarknetViewingKey(k: bigint): bigint {
  let s = k % CURVE_ORDER;
  if (s >= HALF_ORDER) s = CURVE_ORDER - s;
  return s === 0n || s >= HALF_ORDER ? 1n : s;
}

/** Where the relay's deploy (salt = public key, not unique) puts the account for `publicKey`. */
export function starknetAccountAddress(publicKey: string, classHash: string = STARKNET_ACCOUNT_CLASS_HASH): string {
  return num.toHex(hash.calculateContractAddressFromHash(publicKey, classHash, CallData.compile([publicKey]), 0));
}

/**
 * The account's keys and address from its 32-byte seed (a wallet signature's,
 * a Gloam wallet root's, or a claim link's): HKDF-SHA256 with info
 * gloam/starknet/account/<index> for the account key and
 * gloam/starknet/viewing/<index> for the viewing key.
 */
export async function starknetAccountKeys(seed: Uint8Array, index = 0, classHash: string = STARKNET_ACCOUNT_CLASS_HASH): Promise<StarknetAccountKeys> {
  starknetAccountMessage(index); // validates the index
  if (seed.length < 16) throw new Error("An account seed is at least 16 bytes.");
  const empty = new Uint8Array(0);
  const accountKey = scalar(await starknetHkdf(seed, empty, `gloam/starknet/account/${index}`, 512));
  const viewingKey = canonicalStarknetViewingKey(toBig(await starknetHkdf(seed, empty, `gloam/starknet/viewing/${index}`, 512)));
  const publicKey = ec.starkCurve.getStarkKey(num.toHex(accountKey));
  return { accountKey, publicKey, viewingKey, address: starknetAccountAddress(publicKey, classHash) };
}

/** The one call that deploys the account for `publicKey` (Gloam's relay sends it and pays). */
export function starknetDeployAccountCall(publicKey: string, classHash: string = STARKNET_ACCOUNT_CLASS_HASH): Call {
  return { contractAddress: STARKNET_UDC, entrypoint: STARKNET_UDC_ENTRYPOINT, calldata: [classHash, publicKey, "0x0", "0x1", publicKey] };
}

/** The token approve an add needs, run as the account and sent by the relay. */
export function starknetApproveCall(token: string, pool: string, amount: bigint): Call {
  checkAmount(amount);
  return { contractAddress: token, entrypoint: "approve", calldata: [pool, num.toHex(amount), "0x0"] };
}

// ------------------------------------------------------------------ the main wallet

/**
 * A wallet that opens a private account: it signs starknetAccountMessage(index)
 * as a plain message (personal_sign on an EVM wallet), returning the hex
 * signature, or 64 bytes from a Solana wallet. It is never asked to sign anything else.
 */
export interface StarknetMainWallet {
  signMessage(message: string): Promise<string | Uint8Array>;
}

/** A main wallet from a viem account (privateKeyToAccount, a wallet client's account): personal_sign. */
export function starknetViemWallet(account: { signMessage(args: { message: string }): Promise<string> }): StarknetMainWallet {
  return { signMessage: (message) => account.signMessage({ message }) };
}

async function seedFromWallet(wallet: StarknetMainWallet, index: number): Promise<Uint8Array> {
  const message = starknetAccountMessage(index);
  const once = async () => {
    const sig = await wallet.signMessage(message);
    const bytes = typeof sig === "string" ? starknetEvmSignatureBytes(sig) : Uint8Array.from(sig);
    try {
      return await starknetSeedFromWalletSignature(bytes, index);
    } finally {
      bytes.fill(0);
    }
  };
  // Signed twice: a wallet that signs differently each time (some MPC and smart wallets)
  // would open an account no later signature reopens. The Gloam app refuses it too.
  const first = await once();
  const second = await once();
  const same = first.length === second.length && first.every((x, i) => x === second[i]);
  second.fill(0);
  if (!same) {
    first.fill(0);
    throw new StarknetError("unsteady_wallet", "This wallet signs differently each time, so it can't hold a private account on Starknet. Use another wallet.");
  }
  return first;
}

// ------------------------------------------------------------------ options and the relay

export interface StarknetOptions {
  /** "mainnet" (default) or "devnet". It must match what `baseUrl` serves. */
  network?: StarknetNetworkKey;
  /** Where Gloam's Starknet routes are: https://www.gloam.trade by default. */
  baseUrl?: string;
  /** Wait between polls of the chain, ms (default 1000; mainnet makes a block about every 2 seconds). */
  pollMs?: number;
  /** How long a send is followed before it is called unconfirmed, ms (default 5 minutes). */
  confirmMs?: number;
}

export interface StarknetRelayStatus {
  /** The relay answered. */
  reachable: boolean;
  /** Starknet is open on this server and the relay is set up. */
  on: boolean;
  /** It holds enough STRK to pay fees. */
  funded: boolean;
  /** "off": it sends no add, payment or cash out yet (an account can still be opened). */
  moves: "on" | "off";
  /** Its address: the sender of every transaction, and where the fee goes. */
  relayer: string | null;
  network: StarknetNetworkKey | null;
  pool: string | null;
  /** Its fee per move, base units, per token address (0x hex, no padding). */
  fee: Record<string, bigint>;
  /** Most one add may move, per token address. */
  maxApprove: Record<string, bigint>;
}

const tokenKey = (a: string | bigint): string => num.toHex(BigInt(a));

const bigMap = (x: unknown): Record<string, bigint> => {
  const out: Record<string, bigint> = {};
  if (!x || typeof x !== "object") return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    try {
      if (/^0x[0-9a-fA-F]{1,64}$/.test(k) && (typeof v === "string" || typeof v === "number") && /^\d+$/.test(String(v))) out[tokenKey(k)] = BigInt(String(v));
    } catch {
      /* skip */
    }
  }
  return out;
};

const NETWORKS: readonly StarknetNetworkKey[] = ["mainnet", "sepolia", "devnet"];

function parseRelay(json: unknown): StarknetRelayStatus {
  const j = (json ?? {}) as Record<string, unknown>;
  const relayer = typeof j.relayer === "string" && isStarknetAddress(j.relayer) ? j.relayer : null;
  return {
    reachable: true,
    on: j.on === true && relayer !== null,
    funded: j.funded === true,
    moves: j.moves === "off" ? "off" : "on",
    relayer,
    network: NETWORKS.includes(j.network as StarknetNetworkKey) ? (j.network as StarknetNetworkKey) : null,
    pool: typeof j.pool === "string" && isStarknetAddress(j.pool) ? j.pool : null,
    fee: bigMap(j.fee),
    maxApprove: bigMap(j.maxApprove),
  };
}

const OFF_STATUS = (network: StarknetNetworkKey | null): StarknetRelayStatus => ({
  reachable: false,
  on: false,
  funded: false,
  moves: "off",
  relayer: null,
  network,
  pool: null,
  fee: {},
  maxApprove: {},
});

/** Whether Gloam's Starknet relay is on and funded, whether it sends moves, its address and fee. Never throws. */
export async function starknetRelayStatus(opts: StarknetOptions = {}): Promise<StarknetRelayStatus> {
  try {
    return await readRelay(opts);
  } catch {
    return OFF_STATUS(opts.network ?? "mainnet");
  }
}

async function readRelay(opts: StarknetOptions): Promise<StarknetRelayStatus> {
  let res: Response;
  try {
    res = await fetch(starknetEndpoints(opts.baseUrl).relay, { method: "GET", cache: "no-store" } as RequestInit);
  } catch {
    throw new StarknetBusyError("relay_unavailable", "Gloam's Starknet relay can't be reached. Try again shortly.");
  }
  if (res.status === 429) throw new StarknetBusyError("rate_limited", "Too many requests. Try again in a little while.");
  if (res.status === 404) throw new StarknetOffError("off", OFF_MESSAGE.off!);
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !json) throw new StarknetBusyError("relay_unavailable", "Gloam's Starknet relay can't be reached. Try again shortly.");
  return parseRelay(json);
}

/** The relay's fee on `token` in `info` (0 when it asks none). */
export function starknetRelayFee(info: Pick<StarknetRelayStatus, "fee">, token: Pick<StarknetAsset, "address">): bigint {
  return info.fee[tokenKey(token.address)] ?? 0n;
}

async function relayPost(opts: StarknetOptions, calls: Call[], proof?: { proofFacts: readonly string[]; data: string }): Promise<string> {
  let res: Response;
  try {
    res = await fetch(starknetEndpoints(opts.baseUrl).relay, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        calls: calls.map((c) => ({ contractAddress: c.contractAddress, entrypoint: c.entrypoint, calldata: ((c.calldata ?? []) as (string | number | bigint)[]).map((x) => num.toHex(x)) })),
        ...(proof ? { proof: { proofFacts: proof.proofFacts.map((f) => num.toHex(f)), proof: proof.data } } : {}),
      }),
    });
  } catch {
    throw new StarknetError("relay_failed", "Gloam's Starknet relay didn't answer. Check the balance before sending again.", true);
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; txHash?: string; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !body?.ok || !body.txHash) {
    if (!body?.error?.code) {
      // Not the relay's own answer (a gateway in between): it may have been sent.
      if (res.status === 404) throw new StarknetOffError("off", OFF_MESSAGE.off!);
      throw new StarknetError("relay_failed", `Gloam's Starknet relay didn't take it (${res.status}). Check the balance before sending again.`, res.status >= 500 || res.ok);
    }
    throw relayRefusal(res.status, body.error.code, body.error.message ?? `Gloam's Starknet relay didn't take it (${res.status}).`);
  }
  return body.txHash;
}

// ------------------------------------------------------------------ the private account

export type StarknetStepReporter = (step: string, detail?: string) => void;

/** An open private account. Close it (closeStarknetAccount) to drop its keys. */
export interface GloamStarknetAccount {
  readonly network: StarknetNetworkKey;
  readonly index: number;
  /** The private account's Starknet address: what someone pays privately. */
  readonly address: string;
  readonly publicKey: string;
  /** @internal */
  readonly _: AccountState;
}

type Wired = {
  provider: RpcProvider;
  transfers: PrivateTransfersInterface;
  signer: Account;
  pool: string;
};

type AccountState = {
  opts: Required<Pick<StarknetOptions, "network" | "pollMs" | "confirmMs">> & { baseUrl: string };
  keys: StarknetAccountKeys;
  /** The relay as this account last read it (null: not yet). */
  relay: StarknetRelayStatus | null;
  /** Block of the last transaction this account saw land (0: none). */
  lastBlock: number;
  /** Registered with its own channel (cached once true). */
  ready: boolean;
  wired: Promise<Wired> | null;
  closed: boolean;
};

function options(o: StarknetOptions): AccountState["opts"] {
  const network = o.network ?? "mainnet";
  if (!NETWORKS.includes(network)) throw new Error(`Unknown Starknet network ${String(network)}.`);
  if (network === "sepolia") throw new StarknetOffError("off", "Gloam has no Starknet Sepolia pool or prover yet.");
  const baseUrl = (o.baseUrl ?? GLOAM_STARKNET_BASE_URL).replace(/\/+$/, "");
  starknetEndpoints(baseUrl); // validates it
  return { network, baseUrl, pollMs: o.pollMs ?? 1_000, confirmMs: o.confirmMs ?? STARKNET_CONFIRM_MS };
}

/**
 * Open private account `index` (default 0): from a wallet's signature (signed
 * twice, to be sure it signs the same way each time) or a 32-byte seed you
 * already hold (starknetSeedFromGloamRoot, or one kept from before). Nothing
 * is sent and nothing is read: the same wallet reopens the same account here
 * and in the Gloam app. registerStarknetAccount puts it on chain.
 */
export async function openStarknetAccount(input: StarknetOptions & ({ wallet: StarknetMainWallet; seed?: undefined } | { seed: Uint8Array; wallet?: undefined }) & { index?: number }): Promise<GloamStarknetAccount> {
  const opts = options(input);
  const index = input.index ?? 0;
  starknetAccountMessage(index);
  const seed = input.wallet ? await seedFromWallet(input.wallet, index) : Uint8Array.from(input.seed ?? []);
  try {
    const keys = await starknetAccountKeys(seed, index);
    return {
      network: opts.network,
      index,
      address: keys.address,
      publicKey: keys.publicKey,
      _: { opts, keys, relay: null, lastBlock: 0, ready: false, wired: null, closed: false },
    };
  } finally {
    seed.fill(0);
  }
}

/** Drop the account's keys from this object. The same wallet or seed reopens it. */
export function closeStarknetAccount(account: GloamStarknetAccount): void {
  const s = account._;
  s.closed = true;
  s.wired = null;
  s.keys = { ...s.keys, accountKey: 0n, viewingKey: 0n };
}

function live(account: GloamStarknetAccount): AccountState {
  if (account._.closed) throw new Error("This Starknet account was closed. Open it again.");
  return account._;
}

/** The SDK wired to Gloam's routes for this account, once: after the relay says Starknet is on. */
async function wired(account: GloamStarknetAccount): Promise<Wired> {
  const s = live(account);
  if (!s.wired) {
    const p = (async (): Promise<Wired> => {
      const relay = s.relay?.on ? s.relay : await readRelay(s.opts);
      s.relay = relay;
      if (!relay.on) throw new StarknetOffError("off", OFF_MESSAGE.off!);
      if (relay.network && relay.network !== s.opts.network) throw new StarknetError("network_mismatch", `${s.opts.baseUrl} serves Starknet ${relay.network}, not ${s.opts.network}.`);
      // On mainnet the SDK proves only into Starknet's canonical pool, whatever a server names.
      let pool: string;
      if (s.opts.network === "mainnet") {
        if (relay.pool && !sameStarknetAddress(relay.pool, STARKNET_MAINNET_POOL)) throw new StarknetError("pool_mismatch", "That server names a pool other than Starknet's canonical privacy pool. Nothing was sent.");
        pool = STARKNET_MAINNET_POOL;
      } else {
        if (!relay.pool) throw new StarknetOffError("off", "No Starknet privacy pool is set on that server.");
        pool = relay.pool;
      }
      const sdk = await import("@starkware-libs/starknet-privacy-sdk");
      const urls = starknetEndpoints(s.opts.baseUrl);
      const chainId = STARKNET_CHAIN_IDS[s.opts.network];
      const provider = new RpcProvider({ nodeUrl: urls.rpc, batch: 0 });
      // A proof can take minutes on mainnet: the route waits up to 270 s, then says busy, and a retry finds the same job.
      const prover = new sdk.ProvingServiceProofProvider(urls.prove, chainId as never, { nodeUrl: urls.rpc, poolAddress: pool, requestTimeoutMs: 290_000, retry: { maxRetries: 4, baseDelayMs: 2_000 } });
      let discovery: unknown;
      if (s.opts.network === "mainnet") {
        discovery = new sdk.IndexerDiscoveryProvider(urls.discovery, pool, { ohttp: true });
      } else {
        // Devnet reads the pool over RPC (the vendored build exposes the contract reader).
        const [{ ContractDiscoveryProvider }, { PrivacyPoolABI }] = await Promise.all([
          import("@starkware-libs/starknet-privacy-sdk/contract-discovery"),
          import("@starkware-libs/starknet-privacy-sdk/abi"),
        ]);
        const contract = new Contract({ abi: PrivacyPoolABI as never, address: pool, providerOrAccount: provider }).typedv2(PrivacyPoolABI as never);
        discovery = new ContractDiscoveryProvider(contract as never);
      }
      const viewingKey = s.keys.viewingKey;
      const transfers = sdk.createPrivateTransfers({
        account: { address: s.keys.address, signer: new Signer(num.toHex(s.keys.accountKey)) },
        viewingKeyProvider: { getViewingKey: async () => viewingKey },
        provingProvider: prover,
        discoveryProvider: discovery as never,
        poolContractAddress: pool,
      });
      const signer = new Account({ provider, address: s.keys.address, signer: num.toHex(s.keys.accountKey), cairoVersion: "1" });
      return { provider, transfers, signer, pool };
    })();
    p.catch(() => {
      if (s.wired === p) s.wired = null;
    });
    s.wired = p;
  }
  return s.wired;
}

function assetOf(account: GloamStarknetAccount, asset?: string | StarknetAsset): StarknetAsset {
  const list = STARKNET_ASSETS[account.network];
  const a = asset === undefined ? list[0] : typeof asset === "string" ? starknetAsset(asset, account.network) : asset;
  if (!a || !list.some((x) => sameStarknetAddress(x.address, a.address))) {
    throw new Error(`Gloam on Starknet lists ${list.map((x) => x.symbol).join(", ") || "nothing"} on ${account.network}; "${String(typeof asset === "string" ? asset : asset?.symbol)}" is not one of them.`);
  }
  return a;
}

function checkAmount(amount: bigint, what = "amount"): bigint {
  if (typeof amount !== "bigint" || amount <= 0n || amount > U128_MAX) throw new Error(`The ${what} must be a positive bigint in base units.`);
  return amount;
}

function checkTarget(v: string, what: string): string {
  if (!isStarknetAddress(v)) throw new Error(`\`${what}\` is not a Starknet address.`);
  return num.toHex(BigInt(v));
}

type Receipt = { finality_status?: string; execution_status?: string; block_number?: number; revert_reason?: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rpcCode(e: unknown): number | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "number" ? c : null;
}
const CONTRACT_NOT_FOUND = 20;
const BLOCK_NOT_FOUND = 24;

/**
 * Read the relay again before a move: on, funded, sending moves, and the fee
 * this account last read (or at most `maxFee`). Anything else stops the move
 * here, before a proof is made (a proof is one of a small daily quota).
 * Returns the fee for `token` (0n when it asks none).
 */
async function checkRelay(account: GloamStarknetAccount, token: StarknetAsset | null, maxFee?: bigint): Promise<bigint> {
  const s = live(account);
  const was = s.relay;
  const now = await readRelay(s.opts);
  s.relay = now;
  if (!now.on) throw new StarknetOffError("off", OFF_MESSAGE.off!);
  if (!now.funded || !now.relayer) throw new StarknetBusyError("paused", "Private payments on Starknet are paused for a moment. Try again later.");
  if (!token) return 0n;
  if (now.moves === "off") throw new StarknetOffError("moves_off", OFF_MESSAGE.moves_off!);
  const fee = starknetRelayFee(now, token);
  if (maxFee !== undefined) {
    if (fee > maxFee) throw new StarknetFeeChangedError(`Gloam's fee on Starknet is ${fee} base units of ${token.symbol}, above the ${maxFee} allowed. Nothing was sent.`, fee, maxFee);
    return fee;
  }
  if (was && was.relayer && (starknetRelayFee(was, token) !== fee || !sameStarknetAddress(was.relayer, now.relayer))) {
    throw new StarknetFeeChangedError(`Gloam's fee on Starknet just changed to ${fee} base units of ${token.symbol}. Nothing was sent; call again to pay it, or pass maxFee.`, fee, starknetRelayFee(was, token));
  }
  return fee;
}

/** Whether the account is deployed, at `block` or now. A node that can't answer throws: never "not deployed". */
async function deployedAt(account: GloamStarknetAccount, block?: number): Promise<boolean> {
  const w = await wired(account);
  try {
    await w.provider.getClassHashAt(account.address, block);
    return true;
  } catch (e) {
    const code = rpcCode(e);
    if (code === CONTRACT_NOT_FOUND || (block !== undefined && code === BLOCK_NOT_FOUND)) return false;
    throw asStarknetError(e);
  }
}

/** The SDK's word for whether `to` can be paid for `token`: never registered, a first payment, or ready. */
export type StarknetPayee = "closed" | "first" | "ready";

async function requirement(account: GloamStarknetAccount, to: string, token: StarknetAsset): Promise<StarknetPayee> {
  const w = await wired(account);
  const { SetupRequirement } = await import("@starkware-libs/starknet-privacy-sdk");
  const r = await w.transfers.discoverRequirement(to, token.address);
  return r === SetupRequirement.Register ? "closed" : r === SetupRequirement.Ready ? "ready" : "first";
}

/**
 * Whether the account is on chain and open (deployed, viewing key registered,
 * its own channel open): ready to add, pay, be paid and cash out.
 */
export async function isStarknetAccountOpen(account: GloamStarknetAccount, asset?: string | StarknetAsset): Promise<boolean> {
  const s = live(account);
  if (s.ready) return true;
  try {
    if (!(await deployedAt(account))) return false;
    s.ready = (await requirement(account, account.address, assetOf(account, asset))) === "ready";
    return s.ready;
  } catch (e) {
    throw asStarknetError(e);
  }
}

/**
 * Where `to` stands for a payment from this account: "closed" (no private
 * account on Starknet: it can't be paid privately), "first" (the payment opens
 * a channel to them, which shows their private account) or "ready" (a channel
 * is open: the payment shows neither side nor the amount).
 */
export async function starknetPayeeState(account: GloamStarknetAccount, to: string, asset?: string | StarknetAsset): Promise<StarknetPayee> {
  try {
    return await requirement(account, checkTarget(to, "to"), assetOf(account, asset));
  } catch (e) {
    throw asStarknetError(e);
  }
}

/** Wait for `txHash` to be accepted on Starknet; its block. Throws when it reverted or can't be told in time. */
async function confirm(account: GloamStarknetAccount, txHash: string): Promise<number> {
  const s = live(account);
  const w = await wired(account);
  const started = Date.now();
  for (let tries = 0; ; tries++) {
    if (tries) await sleep(s.opts.pollMs);
    let r: Receipt | null = null;
    try {
      r = (await w.provider.getTransactionReceipt(txHash)) as unknown as Receipt;
    } catch {
      // Not in a block yet, or the node didn't answer: ask again.
    }
    if (r && (r.finality_status === "ACCEPTED_ON_L2" || r.finality_status === "ACCEPTED_ON_L1")) {
      if (r.execution_status === "REVERTED") throw new StarknetError("reverted", `Starknet reverted it${r.revert_reason ? `: ${r.revert_reason.slice(0, 160)}` : "."}`, false, txHash);
      const block = Number(r.block_number ?? (await w.provider.getBlockNumber()));
      s.lastBlock = Math.max(s.lastBlock, block);
      return block;
    }
    if (Date.now() - started > s.opts.confirmMs) {
      throw new StarknetError("unconfirmed", "Starknet hasn't confirmed it yet. It may still go through, so check the balance (or starknetTxStatus) before you try again.", true, txHash);
    }
  }
}

/**
 * Wait until the last transaction is STARKNET_PROOF_DEPTH blocks behind the
 * head, and `until` (when given) holds at the block that leaves; the block to
 * prove at. Where notes are read from the pool directly (a devnet), a spend
 * waits for the whole head to settle; the hosted discovery service (mainnet)
 * reads at the proof's block.
 */
async function settle(account: GloamStarknetAccount, onStep: StarknetStepReporter | undefined, spend: boolean, until?: (at: number) => Promise<boolean>): Promise<number> {
  const s = live(account);
  const w = await wired(account);
  if (spend && s.opts.network !== "mainnet") s.lastBlock = Math.max(s.lastBlock, await w.provider.getBlockNumber());
  const started = Date.now();
  for (;;) {
    const head = await w.provider.getBlockNumber();
    const left = s.lastBlock + STARKNET_PROOF_DEPTH + 1 - head;
    if (left <= 0 && (!until || (await until(head - STARKNET_PROOF_DEPTH)))) return head - STARKNET_PROOF_DEPTH;
    onStep?.("waiting", left > 1 ? `${left} more blocks` : left === 1 ? "One more block" : "A few more blocks");
    if (Date.now() - started > 15 * 60_000) throw new StarknetBusyError("slow_blocks", "Starknet is slow to make blocks. Try again in a few minutes.");
    await sleep(s.opts.pollMs);
  }
}

/** Whether a note the proof at `at` would see has been spent since (another process sent with this account). */
async function spentSince(account: GloamStarknetAccount, at: number, token: StarknetAsset): Promise<boolean> {
  const w = await wired(account);
  const tokens = [BigInt(token.address)];
  const [then, now] = await Promise.all([
    w.transfers.discoverNotes({ tokens, blockIdentifier: at }),
    w.transfers.discoverNotes({ tokens, blockIdentifier: "latest" }),
  ]);
  const ids = (r: { notes: { get(k: string): { id: unknown }[] | undefined } }) => (r.notes.get(token.address) ?? []).map((n) => BigInt(n.id as bigint | string));
  const live = new Set(ids(now as never));
  return ids(then as never).some((id) => !live.has(id));
}

/** The block a payment or a cash out proves at. An account that didn't send the last transaction itself also checks nothing it would spend was spent since. */
function settleSpend(account: GloamStarknetAccount, token: StarknetAsset, onStep?: StarknetStepReporter): Promise<number> {
  const blind = account._.lastBlock === 0 && account.network === "mainnet";
  return settle(account, onStep, true, blind ? async (at) => !(await spentSince(account, at, token)) : undefined);
}

/** Send a proven call through the relay and wait for it; the same proof goes again while the relay says it sent nothing for a moment. */
async function sendProven(account: GloamStarknetAccount, r: ExecuteResult): Promise<{ txHash: string; block: number }> {
  const s = live(account);
  const cp = r.callAndProof as unknown as { call: Call; proof: { proofFacts: readonly string[]; data: string } };
  let txHash: string | null = null;
  for (let tries = 0; txHash === null; tries++) {
    try {
      txHash = await relayPost(s.opts, [cp.call], cp.proof);
    } catch (e) {
      if (tries >= 3 || !(e instanceof StarknetError) || !RESEND_SAME_PROOF.has(e.code)) throw e;
      await sleep(s.opts.pollMs * 2 ** (tries + 1));
    }
  }
  return { txHash, block: await confirm(account, txHash) };
}

const refresh = { notes: "refresh", channels: "refresh" } as const;
function execOpts(provingBlockId: ProvingBlockId | undefined, extra: ExecuteOptions = {}): ExecuteOptions {
  return { autoSetup: true, autoDiscover: refresh, ...(provingBlockId !== undefined ? { provingBlockId } : {}), ...extra };
}

/** The private balance of `token`: the sum of the account's unspent notes. */
async function privateOf(account: GloamStarknetAccount, token: StarknetAsset): Promise<bigint> {
  const w = await wired(account);
  const { notes } = await w.transfers.discoverNotes();
  return (notes.get(token.address) ?? []).reduce((sum, n) => sum + n.amount, 0n);
}

/** What sits at the account's own address (arrived, not yet private). */
async function publicOf(account: GloamStarknetAccount, token: StarknetAsset): Promise<bigint> {
  const w = await wired(account);
  const r = await w.provider.callContract({ contractAddress: token.address, entrypoint: "balance_of", calldata: [account.address] });
  return BigInt(r[0] ?? "0x0") + (BigInt(r[1] ?? "0x0") << 128n);
}

export interface StarknetBalance {
  /** The private balance (the account's unspent notes in the pool). */
  private: bigint;
  /** What sits at the account's own address, ready to add. */
  public: bigint;
}

/** Each listed asset's private balance and what sits at the account's address, base units ({ usdc: { private, public } }). */
export async function starknetBalances(account: GloamStarknetAccount): Promise<Record<string, StarknetBalance>> {
  try {
    const out: Record<string, StarknetBalance> = {};
    const open = await isStarknetAccountOpen(account);
    for (const a of STARKNET_ASSETS[account.network]) {
      // A token's balance_of answers for any address, deployed or not.
      out[a.id] = { private: open ? await privateOf(account, a) : 0n, public: await publicOf(account, a) };
    }
    return out;
  } catch (e) {
    throw asStarknetError(e);
  }
}

async function needOpen(account: GloamStarknetAccount, token: StarknetAsset): Promise<void> {
  if (!(await isStarknetAccountOpen(account, token))) {
    throw new StarknetError("not_open", "This private account isn't open on Starknet yet. Call registerStarknetAccount first.");
  }
}

async function needPrivate(account: GloamStarknetAccount, token: StarknetAsset, need: bigint): Promise<void> {
  const have = await privateOf(account, token);
  if (have < need) throw new StarknetInsufficientError(`The private balance is ${have} base units of ${token.symbol}; that needs ${need} (the amount and Gloam's fee).`, have, need);
}

export interface StarknetSendResult {
  txHash: string;
  /** The block it landed in. */
  block: number;
  /** What it paid Gloam's relay, base units (0n when it asked none). */
  fee: bigint;
  explorer: string | null;
}

const result = (account: GloamStarknetAccount, sent: { txHash: string; block: number }, fee: bigint): StarknetSendResult => ({
  ...sent,
  fee,
  explorer: starknetExplorerTx(sent.txHash, account.network),
});

// ------------------------------------------------------------------ moves

/**
 * Put the account on chain and open it, once: Gloam's relay deploys it (no
 * STRK from you), then one proof registers its viewing key (stored encrypted
 * to the pool's auditor key) and opens its own channel, so it can be paid and
 * its cash outs never name it. Free, and capped per day. Registering shows
 * the account's address. Does nothing when it is already open.
 */
export async function registerStarknetAccount(account: GloamStarknetAccount, opts: { onStep?: StarknetStepReporter } = {}): Promise<{ alreadyOpen: boolean; deployTx: string | null; openTx: string | null }> {
  try {
    const s = live(account);
    const token = assetOf(account);
    let fresh = false;
    let deployTx: string | null = null;
    if (!(await deployedAt(account))) {
      opts.onStep?.("deploying");
      await checkRelay(account, null);
      try {
        deployTx = await relayPost(s.opts, [starknetDeployAccountCall(account.publicKey)]);
        await confirm(account, deployTx);
        fresh = true;
      } catch (e) {
        // Deployed in the meantime (another process): open it as an account deployed before.
        if (!(e instanceof StarknetError && e.code === "already_deployed")) throw e;
      }
    }
    if (!fresh && (await isStarknetAccountOpen(account, token))) return { alreadyOpen: true, deployTx, openTx: null };
    if (!fresh) await checkRelay(account, null);
    const at = await settle(account, opts.onStep, false, fresh ? undefined : (b) => deployedAt(account, b));
    opts.onStep?.("opening");
    const w = await wired(account);
    let b = w.transfers.build(execOpts(at, { autoSetup: false })).register().setup(account.address);
    for (const t of STARKNET_ASSETS[account.network]) b = b.with(t.address, (tb) => void tb.setup(account.address));
    const sent = await sendProven(account, await b.execute());
    s.ready = true;
    return { alreadyOpen: false, deployTx, openTx: sent.txHash };
  } catch (e) {
    throw asStarknetError(e);
  }
}

/**
 * Sign `calls` as the account, as one SNIP-9 outside execution only Gloam's
 * relay may send, valid for `windowS` seconds: the call to hand the relay.
 * The add's approve is one; a bring-in route can send others it allows.
 */
export async function signStarknetOutsideCall(account: GloamStarknetAccount, calls: Call[], windowS = 600): Promise<Call> {
  const s = live(account);
  const w = await wired(account);
  const relayer = s.relay?.relayer;
  if (!relayer) throw new StarknetBusyError("paused", "Private payments on Starknet are paused for a moment. Try again later.");
  const now = Math.floor(Date.now() / 1000);
  const outside = await w.signer.getOutsideTransaction({ caller: relayer, execute_after: now - 60, execute_before: now + windowS }, calls, OutsideExecutionVersion.V2);
  return outsideExecution.buildExecuteFromOutsideCall(outside)[0]!;
}

/**
 * Add `amount` (base units) of what sits at the account's own address to its
 * private balance: the account approves the pool (signed here, sent by the
 * relay), then one proof deposits it and pays Gloam's fee from it. Public on
 * chain: the account and the amount. `approved`: the approve already landed
 * (a bring-in sends it with the money). Money reaches the account's address
 * from any wallet or exchange that sends USDC on Starknet.
 */
export async function addToStarknetPrivate(
  account: GloamStarknetAccount,
  input: { amount: bigint; asset?: string | StarknetAsset; approved?: boolean; maxFee?: bigint; onStep?: StarknetStepReporter }
): Promise<StarknetSendResult> {
  try {
    const s = live(account);
    const token = assetOf(account, input.asset);
    const amount = checkAmount(input.amount);
    const fee = await checkRelay(account, token, input.maxFee);
    await needOpen(account, token);
    const cap = s.relay?.maxApprove[tokenKey(token.address)] ?? 0n;
    if (amount > cap) throw new StarknetError("over_cap", `That is more than one add can move (${cap} base units). Add it in smaller parts.`);
    if (fee >= amount) throw new StarknetInsufficientError("Gloam's fee is more than that amount. Add more.", amount, fee + 1n);
    const have = await publicOf(account, token);
    if (have < amount) throw new StarknetInsufficientError(`The account holds ${have} base units of ${token.symbol} at its address; that add needs ${amount}.`, have, amount);
    const w = await wired(account);
    if (!input.approved) {
      input.onStep?.("approving");
      await confirm(account, await relayPost(s.opts, [await signStarknetOutsideCall(account, [starknetApproveCall(token.address, w.pool, amount)])]));
    }
    const at = await settle(account, input.onStep, false);
    // A deposit carries Starknet's screening attestation, good for 300 seconds: a proof that
    // came back too late to send is made again once (the relay refuses a stale one before paying).
    for (let tries = 0; ; tries++) {
      input.onStep?.("adding");
      const tb = w.transfers.build(execOpts(at)).with(token.address).deposit({ amount });
      if (fee > 0n) tb.withdraw({ recipient: s.relay!.relayer!, amount: fee });
      const r = await tb.surplusTo(account.address).execute();
      try {
        return result(account, await sendProven(account, r), fee);
      } catch (e) {
        if (tries === 0 && e instanceof StarknetError && e.code === "screening_expired") continue;
        throw e;
      }
    }
  } catch (e) {
    throw asStarknetError(e);
  }
}

/**
 * Pay `amount` (base units) privately to another Gloam private account on
 * Starknet. Gloam's fee comes from the private balance too. Over a channel
 * already open it shows neither side nor the amount; the first payment to
 * someone shows their private account (`firstPayment` says so).
 */
export async function payStarknetPrivately(
  account: GloamStarknetAccount,
  input: { to: string; amount: bigint; asset?: string | StarknetAsset; maxFee?: bigint; onStep?: StarknetStepReporter }
): Promise<StarknetSendResult & { firstPayment: boolean }> {
  try {
    const r = await payMany(account, { payments: [{ to: input.to, amount: input.amount }], ...(input.asset ? { asset: input.asset } : {}), ...(input.maxFee !== undefined ? { maxFee: input.maxFee } : {}), ...(input.onStep ? { onStep: input.onStep } : {}) });
    return { txHash: r.txHash, block: r.block, fee: r.fee, explorer: r.explorer, firstPayment: r.firstPayments.length > 0 };
  } catch (e) {
    throw asStarknetError(e);
  }
}

export interface StarknetPayManyResult extends StarknetSendResult {
  /** The payees this proof opened a channel to: their private accounts show in it. */
  firstPayments: string[];
}

/**
 * Pay several private accounts in one proof (payroll): a payment to each,
 * Gloam's fee once, the change back here. Up to STARKNET_PAY_MANY_MAX, and
 * only as many as fit the relay's cap: the payment is run on the pool first
 * (no proof made), and when not all fit it throws (code "too_many", with how
 * many fit) before any proof. First payments show those payees together.
 */
export async function payStarknetMany(
  account: GloamStarknetAccount,
  input: { payments: readonly { to: string; amount: bigint }[]; asset?: string | StarknetAsset; maxFee?: bigint; onStep?: StarknetStepReporter }
): Promise<StarknetPayManyResult> {
  try {
    return await payMany(account, input);
  } catch (e) {
    throw asStarknetError(e);
  }
}

/** Thrown by payStarknetMany when the payments don't fit one proof. */
export class StarknetTooManyError extends StarknetError {
  override name = "StarknetTooManyError";
  constructor(
    message: string,
    /** How many of the payments, from the first, fit one proof. */
    readonly fits: number
  ) {
    super("too_many", message);
  }
}

async function serverActions(call: Call): Promise<number | null> {
  const { PrivacyPoolABI } = await import("@starkware-libs/starknet-privacy-sdk/abi");
  try {
    const cd = ((call.calldata ?? []) as (string | number | bigint)[]).map((x) => num.toHex(x));
    const decoded = new CallData(PrivacyPoolABI as never).decodeParameters(
      ["core::array::Span::<privacy::actions::ServerAction>", "core::option::Option::<privacy::snip12::ScreeningAttestation>"],
      cd
    ) as unknown[];
    return Array.isArray(decoded?.[0]) ? (decoded[0] as unknown[]).length : null;
  } catch {
    return null;
  }
}

async function payMany(
  account: GloamStarknetAccount,
  input: {
    payments: readonly { to: string; amount: bigint }[];
    asset?: string | StarknetAsset;
    maxFee?: bigint;
    onStep?: StarknetStepReporter;
    /** Extra fee withdrawn to the relay in this proof (a claim link's open). */
    extraFee?: (fee: bigint) => bigint;
    /** Amount actually sent to a payee (a claim link carries its claim's fee on top). */
    gross?: (p: { to: string; amount: bigint }, fee: bigint) => bigint;
  }
): Promise<StarknetPayManyResult> {
  const s = live(account);
  const token = assetOf(account, input.asset);
  if (!input.payments.length) throw new Error("No one to pay.");
  if (input.payments.length > STARKNET_PAY_MANY_MAX) throw new StarknetTooManyError(`At most ${STARKNET_PAY_MANY_MAX} people go in one proof. Split the list.`, STARKNET_PAY_MANY_MAX);
  const payments = input.payments.map((p) => {
    const to = checkTarget(p.to, "to");
    if (sameStarknetAddress(to, account.address)) throw new Error("That is this account itself.");
    return { to, amount: checkAmount(p.amount) };
  });
  const fee = await checkRelay(account, token, input.maxFee);
  await needOpen(account, token);
  const reach = new Map<string, StarknetPayee>();
  for (const p of payments) if (!reach.has(p.to)) reach.set(p.to, await requirement(account, p.to, token));
  const closed = [...reach].filter(([, r]) => r === "closed").map(([a]) => a);
  if (closed.length) {
    throw new StarknetError("payee_not_open", `${closed.length === 1 ? "That address has" : `${closed.length} addresses have`} no private account on Starknet yet, so ${closed.length === 1 ? "it" : "they"} can't be paid privately: ${closed.join(", ")}. Nothing was sent.`);
  }
  const relayFee = fee + (input.extraFee?.(fee) ?? 0n);
  const sends = payments.map((p) => ({ recipient: p.to, amount: input.gross?.(p, fee) ?? p.amount }));
  const total = sends.reduce((sum, p) => sum + p.amount, 0n) + relayFee;
  await needPrivate(account, token, total);
  const at = await settleSpend(account, token, input.onStep);
  const w = await wired(account);
  const build = () => {
    const tb = w.transfers.build(execOpts(at, { autoSelectNotes: "naive" })).with(token.address).transfer(...sends);
    if (relayFee > 0n) tb.withdraw({ recipient: s.relay!.relayer!, amount: relayFee });
    return tb.surplusTo(account.address);
  };
  if (payments.length > 1) {
    // Run it on the pool first (no proof made): a proof the relay would refuse for its size is never made.
    input.onStep?.("checking");
    const sim = await build().simulate({ node: w.provider as never });
    const used = await serverActions((sim.callAndProof as unknown as { call: Call }).call);
    if (used === null) throw new StarknetError("failed", "Couldn't read the payment back. Nothing was sent; try again.");
    if (used > STARKNET_MAX_ACTIONS) {
      const fits = Math.max(1, Math.floor((payments.length * STARKNET_MAX_ACTIONS) / used) - 1);
      throw new StarknetTooManyError(`Those ${payments.length} payments don't fit one proof. Send about ${fits} at a time. Nothing was sent.`, fits);
    }
  }
  input.onStep?.("paying");
  const sent = await sendProven(account, await build().execute());
  return { ...result(account, sent, relayFee), firstPayments: [...reach].filter(([, r]) => r === "first").map(([a]) => a) };
}

/**
 * Cash out `amount` (base units) to any Starknet address (a wallet, an
 * exchange deposit address). Gloam's fee comes from the private balance too.
 * Public on chain: the destination and the amount, never the private account
 * it came from.
 */
export async function cashOutStarknet(
  account: GloamStarknetAccount,
  input: { to: string; amount: bigint; asset?: string | StarknetAsset; maxFee?: bigint; onStep?: StarknetStepReporter }
): Promise<StarknetSendResult> {
  try {
    const s = live(account);
    const token = assetOf(account, input.asset);
    const to = checkTarget(input.to, "to");
    const amount = checkAmount(input.amount);
    const fee = await checkRelay(account, token, input.maxFee);
    await needOpen(account, token);
    await needPrivate(account, token, amount + fee);
    const at = await settleSpend(account, token, input.onStep);
    input.onStep?.("cashing_out");
    const w = await wired(account);
    const tb = w.transfers.build(execOpts(at, { autoSelectNotes: "naive" })).with(token.address).withdraw({ recipient: to, amount });
    if (fee > 0n) tb.withdraw({ recipient: s.relay!.relayer!, amount: fee });
    return result(account, await sendProven(account, await tb.surplusTo(account.address).execute()), fee);
  } catch (e) {
    throw asStarknetError(e);
  }
}

// ------------------------------------------------------------------ claim links

export interface StarknetLinkToKeep {
  /** The link: https://www.gloam.trade/c#sn=<body>. Whoever holds it can claim the money. */
  url: string;
  /** The link's one-time private account. */
  address: string;
  /** What the claimer gets, base units. */
  amount: bigint;
  network: StarknetNetworkKey;
}

/**
 * Make a claim link of `amount` (base units): a one-time private account that
 * whoever opens the link moves into their own. `keep` stores the link first
 * (it is the only copy of the link's key); if it throws, nothing is sent.
 * Then the relay deploys the link's account and one proof opens it, and one
 * proof from this account pays it `amount` plus Gloam's fee for the later
 * claim, and Gloam's fee for this proof and for the link's open. So the
 * claimer gets exactly `amount`, and this account pays `amount` and three fees.
 * Paying the link shows the link's account, never this one. Take an unused
 * link back with claimStarknetLink into this account.
 */
export async function makeStarknetClaimLink(
  account: GloamStarknetAccount,
  input: { amount: bigint; keep: (link: StarknetLinkToKeep) => Promise<void> | void; maxFee?: bigint; onStep?: StarknetStepReporter }
): Promise<StarknetLinkToKeep & { txHash: string; openTx: string | null; fee: bigint; cost: bigint }> {
  try {
    const s = live(account);
    const token = assetOf(account);
    const amount = checkAmount(input.amount);
    if (amount > (1n << 64n) - 1n) throw new Error("That amount is too large for a link.");
    const fee = await checkRelay(account, token, input.maxFee);
    await needOpen(account, token);
    await needPrivate(account, token, amount + 3n * fee);
    const secret = newStarknetClaimSecret();
    const seed = await starknetClaimSeed(secret);
    const claim: StarknetClaim = { network: account.network, token: STARKNET_ASSETS[account.network].findIndex((t) => sameStarknetAddress(t.address, token.address)), amount, secret };
    const url = starknetClaimLinkUrl(claim, s.opts.baseUrl);
    secret.fill(0);
    let link: GloamStarknetAccount;
    try {
      link = await openStarknetAccount({ seed, network: account.network, baseUrl: s.opts.baseUrl, pollMs: s.opts.pollMs, confirmMs: s.opts.confirmMs });
    } finally {
      seed.fill(0);
    }
    const kept: StarknetLinkToKeep = { url, address: link.address, amount, network: account.network };
    await input.keep(kept);
    input.onStep?.("opening_link");
    const opened = await registerStarknetAccount(link, input.onStep ? { onStep: input.onStep } : {});
    closeStarknetAccount(link);
    const paid = await payMany(account, {
      payments: [{ to: kept.address, amount }],
      asset: token,
      ...(input.maxFee !== undefined ? { maxFee: input.maxFee } : {}),
      ...(input.onStep ? { onStep: input.onStep } : {}),
      gross: (p, f) => p.amount + f,
      extraFee: (f) => f,
    });
    return { ...kept, txHash: paid.txHash, openTx: opened.openTx, fee, cost: amount + 3n * fee };
  } catch (e) {
    throw asStarknetError(e);
  }
}

async function linkAccount(link: string, opts: StarknetOptions): Promise<{ claim: StarknetClaim; account: GloamStarknetAccount }> {
  const claim = starknetClaimFromLink(link);
  if (!claim) throw new StarknetError("bad_link", "That isn't a Starknet claim link (it may be cut short or mistyped).");
  const seed = await starknetClaimSeed(claim.secret);
  try {
    return { claim, account: await openStarknetAccount({ ...opts, network: claim.network, seed }) };
  } finally {
    seed.fill(0);
  }
}

/** What a claim link's account holds now: open (deployed and registered) and its private balance. */
export async function readStarknetLink(link: string, opts: Omit<StarknetOptions, "network"> = {}): Promise<{ network: StarknetNetworkKey; amount: bigint; address: string; open: boolean; balance: bigint }> {
  const { claim, account } = await linkAccount(link, opts);
  try {
    const token = STARKNET_ASSETS[claim.network][claim.token];
    if (!token) throw new StarknetError("bad_link", "That link names a token Gloam doesn't list on Starknet.");
    const open = (await deployedAt(account)) && (await isStarknetAccountOpen(account, token));
    return { network: claim.network, amount: claim.amount, address: account.address, open, balance: open ? await privateOf(account, token) : 0n };
  } catch (e) {
    throw asStarknetError(e);
  } finally {
    closeStarknetAccount(account);
  }
}

export type StarknetClaimResult =
  | { state: "claimed"; amount: bigint; txHash: string; fee: bigint }
  /** Nothing in it: claimed already, taken back, or not paid yet (`open` false). */
  | { state: "empty"; open: boolean }
  /** Less in it than Gloam's fee to move it. */
  | { state: "too_small"; balance: bigint; fee: bigint };

/**
 * Claim a link into `to` (a Gloam private account on Starknet; the sender's
 * own to take it back): the link's account pays `to` everything it holds,
 * less Gloam's fee for the move. Used once: a second claim finds it empty.
 * Over the channel this opens, the claim shows `to`'s account (a first
 * payment), never the link or who sent it.
 */
export async function claimStarknetLink(input: StarknetOptions & { link: string; to: string; onStep?: StarknetStepReporter }): Promise<StarknetClaimResult> {
  const to = checkTarget(input.to, "to");
  const { claim, account } = await linkAccount(input.link, input);
  try {
    if (input.network && input.network !== claim.network) throw new StarknetError("network_mismatch", `That link is for Starknet ${claim.network}.`);
    const token = STARKNET_ASSETS[claim.network][claim.token];
    if (!token) throw new StarknetError("bad_link", "That link names a token Gloam doesn't list on Starknet.");
    const read = async () => {
      const open = (await deployedAt(account)) && (await isStarknetAccountOpen(account, token));
      return { open, balance: open ? await privateOf(account, token) : 0n };
    };
    const h = await read();
    if (!h.open || h.balance === 0n) return { state: "empty", open: h.open };
    const fee = await checkRelay(account, token);
    if (h.balance <= fee) return { state: "too_small", balance: h.balance, fee };
    const amount = h.balance - fee;
    try {
      const r = await payMany(account, { payments: [{ to, amount }], asset: token, maxFee: fee, ...(input.onStep ? { onStep: input.onStep } : {}) });
      return { state: "claimed", amount, txHash: r.txHash, fee: r.fee };
    } catch (e) {
      // Read back: when it is empty by now, the money went (this answer was lost, or another claim landed first).
      const after = await read().catch(() => null);
      if (after && after.open && after.balance === 0n) throw new StarknetError("link_empty", "This link is empty now. If you just claimed it, it's in that private balance.", true);
      throw e;
    }
  } catch (e) {
    throw asStarknetError(e);
  } finally {
    closeStarknetAccount(account);
  }
}

// ------------------------------------------------------------------ transaction status

export type StarknetTxState =
  | { state: "accepted"; txHash: string; block: number }
  /** Landed and reverted: nothing moved. */
  | { state: "reverted"; txHash: string; reason: string | null }
  /** Not in a block yet, or not known to the node. */
  | { state: "pending"; txHash: string };

/** Where a Starknet transaction stands, read once through Gloam's RPC. */
export async function starknetTxStatus(txHash: string, opts: StarknetOptions = {}): Promise<StarknetTxState> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(txHash)) throw new Error("That isn't a Starknet transaction hash.");
  const provider = new RpcProvider({ nodeUrl: starknetEndpoints(opts.baseUrl).rpc, batch: 0 });
  let r: Receipt | null = null;
  try {
    r = (await provider.getTransactionReceipt(txHash)) as unknown as Receipt;
  } catch (e) {
    const code = rpcCode(e);
    if (code === 29) return { state: "pending", txHash }; // TXN_HASH_NOT_FOUND
    throw asStarknetError(e);
  }
  if (!r || (r.finality_status !== "ACCEPTED_ON_L2" && r.finality_status !== "ACCEPTED_ON_L1")) return { state: "pending", txHash };
  if (r.execution_status === "REVERTED") return { state: "reverted", txHash, reason: r.revert_reason ?? null };
  return { state: "accepted", txHash, block: Number(r.block_number ?? 0) };
}
