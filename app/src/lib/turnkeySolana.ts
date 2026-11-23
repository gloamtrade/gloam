/**
 * A Gloam wallet's Solana account: the same Turnkey wallet as its Ethereum
 * account (lib/embeddedWallet), one more account in it at m/44'/501'/0'/0', so
 * someone who signed in with an email or a passkey uses Solana without
 * installing a Solana wallet.
 *
 * It reaches the app's Solana code as a Wallet Standard wallet called "Gloam
 * account", announced on the page the way Phantom announces itself
 * (registerStandardWallet), so lib/solanaWallet finds it and everything built on
 * that (opening the private account, adding money, paying a bridge order from
 * Solana) works unchanged. Its key stays in Turnkey: a message or a transaction
 * is signed through Turnkey's raw Ed25519 signing (sign_raw_payload, no hash).
 *
 * The private account (lib/solanaRings/account) is derived from the signature
 * over a fixed message, so that signature has to come out the same every time.
 * Ed25519 signing is deterministic (RFC 8032) and Turnkey's is too, but a
 * Gloam account still signs a message twice and hands it over only when both
 * match and check out against its key: a signature that would open some other
 * account next visit is never used.
 *
 * Turnkey keeps a record of every signature it makes, and Gloam's Turnkey
 * account can read those records (the /privacy page says so). The signature
 * that opens the private account is one of them, so the app says so before a
 * Gloam account opens one (GLOAM_ACCOUNT_NOTE).
 *
 * Plain logic, with no React and no Turnkey SDK, so scripts/selftest-turnkey-solana.mts
 * runs it with a stand-in Turnkey.
 */
import { isPlainSignature } from "./solanaRings/account";
import { pickEmbeddedWallet, type WalletLike } from "./embeddedWallet";

/** What the app calls a Gloam wallet's Solana account wherever a Solana wallet is named. */
export const GLOAM_ACCOUNT_NAME = "Gloam account";

/** The Gloam mark, as a Wallet Standard icon must be: a data URL. */
export const GLOAM_ACCOUNT_ICON = `data:image/svg+xml;base64,${b64(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0B0C0E"/><rect x="15" y="4" width="12" height="12" rx="3.5" fill="#FFFFFF"/></svg>',
)}`;

/** Said before a Gloam account opens a private account on Solana (components/app/GloamAccountNote). */
export const GLOAM_ACCOUNT_NOTE =
  "Turnkey makes and keeps the signature that opens it, so Turnkey, and anyone with access to Gloam's Turnkey account, could open this private account. A Solana wallet you hold yourself avoids that.";

/** The Solana account's path in the Gloam wallet: Turnkey's first Solana account. Never change it. */
export const GLOAM_SOLANA_PATH = "m/44'/501'/0'/0'";

/** The Solana account Turnkey makes in a Gloam wallet (Turnkey's DEFAULT_SOLANA_ACCOUNTS[0]). */
export const GLOAM_SOLANA_ACCOUNT = {
  curve: "CURVE_ED25519",
  pathFormat: "PATH_FORMAT_BIP32",
  path: GLOAM_SOLANA_PATH,
  addressFormat: "ADDRESS_FORMAT_SOLANA",
} as const;

/** A Gloam wallet's Ethereum account, as the app has always made it (Turnkey's DEFAULT_ETHEREUM_ACCOUNTS[0]). */
export const GLOAM_ETHEREUM_ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
} as const;

/** What a new Gloam wallet is made with: the Ethereum account it always had, and its Solana account. */
export const NEW_WALLET_ACCOUNTS = [GLOAM_ETHEREUM_ACCOUNT, GLOAM_SOLANA_ACCOUNT];

/* ---------------------------------------------------------------- which account */

/** A Turnkey wallet with the account fields this reads. */
export type SolanaWalletLike = Omit<WalletLike, "accounts"> & {
  accounts?: readonly { address?: string; addressFormat?: string; path?: string }[];
};

/**
 * Where the Gloam wallet's Solana account stands:
 * - none: no Gloam wallet yet (or the list hasn't come back)
 * - create: the Gloam wallet has no Solana account at GLOAM_SOLANA_PATH; make it in `walletId`
 * - ready: it has, at `address`
 * The Gloam wallet is the one lib/embeddedWallet signs Ethereum with (the oldest
 * embedded wallet with an Ethereum account), so both accounts share one wallet.
 */
export type SolanaAccountPlan = { kind: "none" } | { kind: "create"; walletId: string } | { kind: "ready"; walletId: string; address: string };

export function solanaAccountPlan(wallets: readonly SolanaWalletLike[] | undefined): SolanaAccountPlan {
  const picked = pickEmbeddedWallet(wallets);
  if (!picked || !picked.walletId) return { kind: "none" };
  const wallet = (wallets ?? []).find((w) => w.source === "embedded" && w.walletId === picked.walletId);
  const account = wallet?.accounts?.find(
    (a) => a.addressFormat === "ADDRESS_FORMAT_SOLANA" && a.path === GLOAM_SOLANA_PATH && typeof a.address === "string" && solanaPublicKey(a.address) !== null,
  );
  return account?.address ? { kind: "ready", walletId: picked.walletId, address: account.address } : { kind: "create", walletId: picked.walletId };
}

/** Plain words for a Solana account that was not made. Never the SDK's own text. */
export function createSolanaErrorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? "");
  if (/session|expired|unauthori[sz]ed|not authenticated/i.test(text)) return "Your sign-in ran out. Sign in again to use your Gloam account on Solana.";
  if (/network|fetch|timed? ?out/i.test(text)) return "Couldn't reach the wallet service. Check your connection and try again.";
  return "Your Gloam account couldn't open on Solana. Try again.";
}

/* ---------------------------------------------------------------- bytes */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The 32-byte Ed25519 key a Solana address spells, or null when it isn't one. */
export function solanaPublicKey(address: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  let n = 0n;
  for (const c of address) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < address.length && address[zeros] === "1") zeros++;
  if (zeros + bytes.length !== 32) return null;
  const out = new Uint8Array(32);
  out.set(bytes, zeros);
  return out;
}

function b64(text: string): string {
  return btoa(text);
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const v of b) s += v.toString(16).padStart(2, "0");
  return s;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The 64-byte Ed25519 signature from Turnkey's answer: R then S, 32 bytes each,
 * in hex (Turnkey names them r and s for every curve). Null when it isn't that.
 */
export function ed25519FromParts(r: unknown, s: unknown): Uint8Array | null {
  const part = (x: unknown) => (typeof x === "string" ? x.replace(/^0x/i, "") : "");
  const hex = part(r) + part(s);
  if (!/^[0-9a-fA-F]{128}$/.test(hex) || part(r).length !== 64) return null;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether `signature` is `publicKey`'s Ed25519 signature over `message`. Null
 * when this browser can't check Ed25519 (the chain still checks a transaction;
 * the private account's own check, lib/solanaRings/client, refuses a message).
 */
async function ed25519Check(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    await subtle.importKey("raw", publicKey.slice().buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
  return isPlainSignature(publicKey, message, signature);
}

/* ---------------------------------------------------------------- signing through Turnkey */

/** Signs `payload` exactly as given with the account's Ed25519 key; resolves to the 64-byte signature. */
export type Ed25519Signer = (payload: Uint8Array) => Promise<Uint8Array>;

/** The one Turnkey call this uses (the kit's httpClient has it). */
export type RawPayloadClient = {
  signRawPayload(input: {
    organizationId?: string;
    signWith: string;
    payload: string;
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL";
    hashFunction: "HASH_FUNCTION_NOT_APPLICABLE";
  }): Promise<{ r?: string; s?: string; v?: string }>;
};

/** Plain words for a signature Turnkey did not make. Never the SDK's own text. */
export function signErrorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? "");
  if (/cancel|abort|not ?allowed|reject/i.test(text)) return "You cancelled it.";
  if (/session|expired|unauthori[sz]ed|not authenticated/i.test(text)) return "Your sign-in ran out. Sign in again, then try again.";
  if (/network|fetch|timed? ?out/i.test(text)) return "Couldn't reach the wallet service. Check your connection and try again.";
  return "Your Gloam account couldn't sign that. Try again.";
}

/**
 * Signs with the Solana account `address` of the signed-in Gloam wallet:
 * Turnkey's sign_raw_payload over the bytes themselves (hex, no hash), which
 * is a plain Ed25519 signature. `current` gives the kit's client and the
 * session's organization at the moment of signing.
 */
export function turnkeyEd25519Signer(
  current: () => { client: RawPayloadClient | null | undefined; organizationId: string | null | undefined },
  address: string,
): Ed25519Signer {
  return async (payload) => {
    const { client, organizationId } = current();
    if (!client || !organizationId) throw new Error("Sign in to your Gloam wallet first.");
    let out: { r?: string; s?: string };
    try {
      out = await client.signRawPayload({
        organizationId,
        signWith: address,
        payload: toHex(payload),
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
      });
    } catch (e) {
      throw new Error(signErrorText(e));
    }
    const sig = ed25519FromParts(out?.r, out?.s);
    if (!sig) throw new Error("Your Gloam account couldn't sign that. Try again.");
    return sig;
  };
}

/* ---------------------------------------------------------------- the wallet */

const CHAINS = ["solana:mainnet", "solana:devnet"] as const;
const FEATURES = ["solana:signMessage", "solana:signTransaction"] as const;

type StandardAccount = {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
};
type TxInput = { account: StandardAccount; chain?: string; transaction: Uint8Array };
type MessageInput = { account: StandardAccount; message: Uint8Array };
type ChangeListener = (props: { accounts?: readonly StandardAccount[] }) => void;

/** A Gloam account as a Wallet Standard wallet (the shape lib/solanaWallet reads). */
export type GloamSolanaWallet = {
  readonly version: "1.0.0";
  readonly name: string;
  readonly icon: `data:image/${string}`;
  readonly chains: readonly string[];
  readonly accounts: readonly StandardAccount[];
  readonly features: {
    "standard:connect": { version: "1.0.0"; connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }> };
    "standard:disconnect": { version: "1.0.0"; disconnect(): Promise<void> };
    "standard:events": { version: "1.0.0"; on(event: "change", listener: ChangeListener): () => void };
    "solana:signMessage": { version: "1.0.0"; signMessage(...inputs: MessageInput[]): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]> };
    "solana:signTransaction": {
      version: "1.0.0";
      supportedTransactionVersions: readonly ("legacy" | 0)[];
      signTransaction(...inputs: TxInput[]): Promise<{ signedTransaction: Uint8Array }[]>;
    };
  };
  /** Marks a Gloam account among the page's Solana wallets. */
  readonly gloamAccount: true;
  /** The Turnkey session ended: nothing signs any more, and listeners hear the account go. */
  end(): void;
};

export const SIGNED_TWO_WAYS =
  "Your Gloam account signed the same message two different ways, so it can't open a private account. Nothing was opened. Try again later.";
const SIGNED_WRONG = "Your Gloam account's signature didn't check out, so nothing was signed. Try again.";
const NOT_A_SIGNER = "This transaction doesn't ask your Gloam account to sign it.";
const ENDED = "Sign in to your Gloam wallet first.";

/** The Solana wallet for the Gloam account `address`, signing with `sign` (turnkeyEd25519Signer). */
export function makeGloamSolanaWallet(opts: { address: string; sign: Ed25519Signer; name?: string; icon?: string }): GloamSolanaWallet {
  const publicKey = solanaPublicKey(opts.address);
  if (!publicKey) throw new Error("That isn't a Solana address.");
  const account: StandardAccount = Object.freeze({
    address: opts.address,
    publicKey,
    chains: CHAINS,
    features: FEATURES,
  });
  const listeners = new Set<ChangeListener>();
  let ended = false;

  const live = () => {
    if (ended) throw new Error(ENDED);
  };
  const mine = (a: { address?: string } | undefined) => {
    if (!a || a.address !== opts.address) throw new Error("That isn't your Gloam account.");
  };

  async function signMessage(message: Uint8Array): Promise<Uint8Array> {
    live();
    const bytes = new Uint8Array(message);
    // twice, and only when both match: the private account comes from this signature
    const first = await opts.sign(bytes);
    const second = await opts.sign(bytes);
    if (!sameBytes(first, second)) throw new Error(SIGNED_TWO_WAYS);
    if ((await ed25519Check(publicKey!, bytes, first)) === false) throw new Error(SIGNED_WRONG);
    return first;
  }

  async function signTransaction(wire: Uint8Array): Promise<Uint8Array> {
    live();
    const { getTransactionDecoder, getTransactionEncoder } = await import("@solana/kit");
    const tx = getTransactionDecoder().decode(wire);
    if (!Object.prototype.hasOwnProperty.call(tx.signatures, opts.address)) throw new Error(NOT_A_SIGNER);
    const message = new Uint8Array(tx.messageBytes);
    const signature = await opts.sign(message);
    if ((await ed25519Check(publicKey!, message, signature)) === false) throw new Error(SIGNED_WRONG);
    const signed = { ...tx, signatures: { ...tx.signatures, [opts.address]: signature } } as unknown as typeof tx;
    return new Uint8Array(getTransactionEncoder().encode(signed));
  }

  return {
    version: "1.0.0",
    name: opts.name ?? GLOAM_ACCOUNT_NAME,
    icon: (opts.icon ?? GLOAM_ACCOUNT_ICON) as `data:image/${string}`,
    chains: CHAINS,
    get accounts() {
      return ended ? [] : [account];
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        // Signed in already, so there is nothing to ask: a silent connect gets the same answer.
        async connect() {
          return { accounts: ended ? [] : [account] };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        // The Gloam wallet stays signed in: leaving Solana's account is the app's to do.
        async disconnect() {},
      },
      "standard:events": {
        version: "1.0.0",
        on(event, listener) {
          if (event !== "change") return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        async signMessage(...inputs) {
          const out: { signedMessage: Uint8Array; signature: Uint8Array }[] = [];
          for (const input of inputs) {
            mine(input?.account);
            const signature = await signMessage(input.message);
            out.push({ signedMessage: new Uint8Array(input.message), signature });
          }
          return out;
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        async signTransaction(...inputs) {
          const out: { signedTransaction: Uint8Array }[] = [];
          for (const input of inputs) {
            mine(input?.account);
            out.push({ signedTransaction: await signTransaction(input.transaction) });
          }
          return out;
        },
      },
    },
    gloamAccount: true,
    end() {
      if (ended) return;
      ended = true;
      for (const l of [...listeners]) {
        try {
          l({ accounts: [] });
        } catch {
          /* a listener's own failure is its own */
        }
      }
      listeners.clear();
    },
  };
}

/** Whether a wallet the page found (lib/solanaWallet) is a Gloam account. */
export function isGloamAccount(w: { name: string; wallet?: unknown } | null | undefined): boolean {
  const inner = w?.wallet as { gloamAccount?: unknown } | null | undefined;
  return Boolean(w && w.name === GLOAM_ACCOUNT_NAME && inner && inner.gloamAccount === true);
}

/**
 * Announce `wallet` to the page's Wallet Standard apps, the way a wallet
 * extension does: to the apps listening now (register-wallet) and to any that
 * start later (they ask with app-ready). Returns the undo, which takes it out
 * of every app it reached.
 */
export function registerStandardWallet(wallet: object, target: EventTarget = window): () => void {
  const undo: (() => void)[] = [];
  let done = false;
  const callback = (api: { register?: (...w: object[]) => () => void } | null | undefined) => {
    if (done || typeof api?.register !== "function") return;
    try {
      undo.push(api.register(wallet));
    } catch {
      /* an app that refuses it doesn't get it */
    }
  };
  const onReady = (e: Event) => callback((e as CustomEvent).detail);
  target.addEventListener("wallet-standard:app-ready", onReady);
  target.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  return () => {
    if (done) return;
    done = true;
    target.removeEventListener("wallet-standard:app-ready", onReady);
    for (const u of undo.splice(0)) {
      try {
        u();
      } catch {
        /* already gone */
      }
    }
  };
}

/* ---------------------------------------------------------------- for the rest of the app */

/**
 * Where the signed-in Gloam wallet's Solana account is, published by the kit
 * (components/app/TurnkeySolanaSync) for the parts of the app outside it:
 * - off: no Gloam wallet signed in, or it has no Solana account and Solana isn't picked
 * - starting: signed in, the wallet list not read yet
 * - making: its Solana account is being made
 * - ready: announced as a Solana wallet, at `address`
 * - failed: it wasn't made; `error` says why, and retryGloamSolana tries again
 */
export type GloamSolanaStatus = "off" | "starting" | "making" | "ready" | "failed";
export type GloamSolanaState = { status: GloamSolanaStatus; address: string | null; error: string | null };

export const GLOAM_SOLANA_OFF: GloamSolanaState = Object.freeze({ status: "off", address: null, error: null });
let state: GloamSolanaState = GLOAM_SOLANA_OFF;
const stateListeners = new Set<() => void>();

export function setGloamSolana(next: GloamSolanaState) {
  if (next.status === state.status && next.address === state.address && next.error === state.error) return;
  state = next.status === "off" ? GLOAM_SOLANA_OFF : Object.freeze({ ...next });
  stateListeners.forEach((fn) => fn());
}

export function gloamSolana(): GloamSolanaState {
  return state;
}

export function onGloamSolana(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

let retries = 0;
const retryListeners = new Set<() => void>();

/** Ask the kit to make the Solana account again, after a failure. */
export function retryGloamSolana() {
  retries++;
  retryListeners.forEach((fn) => fn());
}

export function gloamSolanaRetries(): number {
  return retries;
}

export function onGloamSolanaRetry(fn: () => void): () => void {
  retryListeners.add(fn);
  return () => retryListeners.delete(fn);
}

const signOutListeners = new Set<() => void>();

/** The Gloam wallet signed out (or its session ended) while the page was open: Solana leaves its account too. */
export function gloamSolanaSignedOut() {
  signOutListeners.forEach((fn) => fn());
}

export function onGloamSolanaSignedOut(fn: () => void): () => void {
  signOutListeners.add(fn);
  return () => signOutListeners.delete(fn);
}

/* ---------------------------------------------------------------- connecting it on its own */

/**
 * Someone signed in with a Gloam wallet who picks Solana is connected to their
 * Gloam account at once, unless they left it for another wallet (or Disconnected
 * it): that choice is kept in this browser per account, until they pick it again.
 */
export const DECLINED_KEY = "gloam:solana:gloam-account-declined";

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export function gloamAccountDeclined(storage: Pick<Store, "getItem"> | null | undefined, address: string): boolean {
  try {
    return storage?.getItem(DECLINED_KEY) === address;
  } catch {
    return false;
  }
}

export function setGloamAccountDeclined(storage: Store | null | undefined, address: string, declined: boolean) {
  try {
    if (declined) storage?.setItem(DECLINED_KEY, address);
    else if (storage?.getItem(DECLINED_KEY) === address) storage.removeItem(DECLINED_KEY);
  } catch {
    /* private mode: the choice lasts the visit */
  }
}

/**
 * What a change of the Solana main wallet says about the Gloam account: true
 * when the person left it (picked another wallet, or disconnected it), false
 * when they use it, null when it says nothing (a sign-out of the Gloam wallet
 * is not a choice against it).
 */
export function declinedAfter(prev: { gloam: boolean } | null, next: { gloam: boolean } | null, signedOut: boolean): boolean | null {
  if (next?.gloam) return false;
  if (next && !next.gloam) return true;
  if (prev?.gloam && !next && !signedOut) return true;
  return null;
}

/** Whether to connect the Gloam account now, with nothing asked. */
export function shouldAutoConnect(s: {
  on: boolean;
  demo: boolean;
  connected: boolean;
  busy: boolean;
  restoring: boolean;
  ready: boolean;
  declined: boolean;
  triedAlready: boolean;
}): boolean {
  return s.on && !s.demo && !s.connected && !s.busy && !s.restoring && s.ready && !s.declined && !s.triedAlready;
}
