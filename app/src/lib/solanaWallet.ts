"use client";

/**
 * Solana wallets in this browser (Phantom, Solflare, Backpack and the rest),
 * found through the Wallet Standard: each wallet announces itself with a window
 * event, so no wallet SDK is bundled. Used to pay a private bridge order from
 * Solana (lib/bridgePrivate), and as the main wallet behind a Gloam private
 * account on Solana (lib/solanaRings/client). Inside a phone wallet's own
 * browser this finds that wallet too.
 */
import { useSyncExternalStore } from "react";

const CHAIN = "solana:mainnet";

type StandardAccount = { address: string; chains: readonly string[] };
type TxInput = { account: StandardAccount; chain: string; transaction: Uint8Array };
type StandardFeatures = {
  "standard:connect"?: { connect(input?: { silent?: boolean }): Promise<{ accounts?: readonly StandardAccount[] } | undefined> };
  "standard:disconnect"?: { disconnect(): Promise<void> };
  "standard:events"?: { on(event: "change", listener: (props: { accounts?: readonly StandardAccount[] }) => void): () => void };
  "solana:signAndSendTransaction"?: { signAndSendTransaction(input: TxInput): Promise<unknown> };
  "solana:signTransaction"?: { signTransaction(input: TxInput): Promise<readonly { signedTransaction: Uint8Array }[]> };
  "solana:signMessage"?: {
    signMessage(input: { account: StandardAccount; message: Uint8Array }): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
  };
};
type StandardWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: StandardFeatures;
};

export type SolanaWallet = { name: string; icon: string; wallet: StandardWallet };
export type SolanaAccount = { address: string; account: StandardAccount };

const registered = new Set<StandardWallet>();
const listeners = new Set<() => void>();
const EMPTY: SolanaWallet[] = [];
let snapshot: SolanaWallet[] = EMPTY;
let started = false;

function usable(w: StandardWallet): boolean {
  return (
    Array.isArray(w.chains) &&
    w.chains.includes(CHAIN) &&
    Boolean(w.features?.["standard:connect"]) &&
    Boolean(w.features?.["solana:signAndSendTransaction"] || w.features?.["solana:signTransaction"])
  );
}

function publish() {
  const seen = new Set<string>();
  snapshot = [...registered]
    .filter(usable)
    .filter((w) => (seen.has(w.name) ? false : (seen.add(w.name), true)))
    .map((wallet) => ({ name: wallet.name, icon: wallet.icon, wallet }));
  for (const l of listeners) l();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const api = {
    register(...wallets: StandardWallet[]) {
      for (const w of wallets) registered.add(w);
      publish();
      return () => {
        for (const w of wallets) registered.delete(w);
        publish();
      };
    },
  };
  // Wallets that load after the page answer app-ready; ones already loaded
  // answer register-wallet. Both hand over the same register API.
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    const callback = (e as CustomEvent).detail;
    if (typeof callback === "function") callback(api);
  });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The Solana wallets that can pay a bridge order here, as they appear. */
export function useSolanaWallets(): SolanaWallet[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/** Ask the wallet to connect. Returns its Solana mainnet account. */
export async function connectSolana(w: SolanaWallet): Promise<SolanaAccount> {
  const connect = w.wallet.features["standard:connect"];
  if (!connect) throw new Error(`${w.name} can't connect here.`);
  const out = await connect.connect();
  const account = pickAccount(out?.accounts?.length ? out.accounts : w.wallet.accounts);
  if (!account) throw new Error(`${w.name} didn't share an account.`);
  return { address: account.address, account };
}

function pickAccount(accounts: readonly StandardAccount[]): StandardAccount | undefined {
  return accounts.find((a) => a.chains?.includes(CHAIN)) ?? accounts[0];
}

/**
 * Reconnect a wallet this site connected before, with no prompt: the Wallet
 * Standard's silent connect (a wallet's "only if trusted"). Null when the
 * wallet would have to ask, or can't connect quietly.
 */
export async function reconnectSolana(w: SolanaWallet): Promise<SolanaAccount | null> {
  const connect = w.wallet.features["standard:connect"];
  if (!connect) return null;
  try {
    const out = await connect.connect({ silent: true });
    const account = pickAccount(out?.accounts ?? []) ?? pickAccount(w.wallet.accounts);
    return account ? { address: account.address, account } : null;
  } catch {
    return null;
  }
}

/** Tell the wallet this site is done with it, where it listens. Never throws. */
export async function disconnectSolana(w: SolanaWallet): Promise<void> {
  try {
    await w.wallet.features["standard:disconnect"]?.disconnect();
  } catch {
    /* the wallet keeps its own list; nothing here depends on it */
  }
}

/** Call `onChange` with the wallet's account when it switches (or null when it disconnects). Returns the unsubscribe. */
export function watchSolanaAccount(w: SolanaWallet, onChange: (address: string | null) => void): () => void {
  const events = w.wallet.features["standard:events"];
  if (!events) return () => {};
  try {
    return events.on("change", (props) => {
      if (!props.accounts) return;
      onChange(pickAccount(props.accounts)?.address ?? null);
    });
  } catch {
    return () => {};
  }
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/**
 * Sign and send the order's transaction from this wallet. A wallet that only
 * signs hands it back, and the server sends it (/api/bridge/solana-send).
 */
export async function paySolana(w: SolanaWallet, a: SolanaAccount, txBase64: string): Promise<void> {
  const transaction = fromBase64(txBase64);
  const sendFeature = w.wallet.features["solana:signAndSendTransaction"];
  if (sendFeature) {
    await sendFeature.signAndSendTransaction({ account: a.account, chain: CHAIN, transaction });
    return;
  }
  const signFeature = w.wallet.features["solana:signTransaction"];
  if (!signFeature) throw new Error(`${w.name} can't sign this.`);
  const [signed] = await signFeature.signTransaction({ account: a.account, chain: CHAIN, transaction });
  if (!signed?.signedTransaction) throw new Error(`${w.name} didn't sign it.`);
  const res = await fetch("/api/bridge/solana-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx: toBase64(signed.signedTransaction) }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
  if (!json?.ok) throw new Error(json?.error?.message ?? "Couldn't send it to Solana. Try again.");
}

/** Whether this wallet can sign a plain message (what opens a Gloam private account). */
export function canSignMessage(w: SolanaWallet): boolean {
  return Boolean(w.wallet.features["solana:signMessage"]);
}

/** The wallet's Ed25519 signature over `message`, exactly as given. */
export async function signSolanaMessage(w: SolanaWallet, a: SolanaAccount, message: Uint8Array): Promise<Uint8Array> {
  const feature = w.wallet.features["solana:signMessage"];
  if (!feature) throw new Error(`${w.name} can't sign a message here.`);
  const [out] = await feature.signMessage({ account: a.account, message });
  if (!out?.signature) throw new Error(`${w.name} didn't sign it.`);
  // a wallet that signed different bytes than it was given did not sign this message
  if (out.signedMessage && !sameBytes(out.signedMessage, message)) throw new Error(`${w.name} signed something else.`);
  return new Uint8Array(out.signature);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Sign `transaction` with the wallet and send it, on `chain`. Returns the 64-byte
 * signature when the wallet sent it, or the signed transaction for the caller to
 * send when the wallet only signs.
 */
export async function signOrSendSolana(
  w: SolanaWallet,
  a: SolanaAccount,
  transaction: Uint8Array,
  chain: string,
): Promise<{ sent: Uint8Array } | { signed: Uint8Array }> {
  const sendFeature = w.wallet.features["solana:signAndSendTransaction"];
  if (sendFeature) {
    const out = (await sendFeature.signAndSendTransaction({ account: a.account, chain, transaction })) as unknown;
    const first = (Array.isArray(out) ? out[0] : out) as { signature?: Uint8Array } | undefined;
    if (!(first?.signature instanceof Uint8Array) || first.signature.length !== 64) throw new Error(`${w.name} didn't send it.`);
    return { sent: first.signature };
  }
  const signFeature = w.wallet.features["solana:signTransaction"];
  if (!signFeature) throw new Error(`${w.name} can't sign this.`);
  const [signed] = await signFeature.signTransaction({ account: a.account, chain, transaction });
  if (!signed?.signedTransaction) throw new Error(`${w.name} didn't sign it.`);
  return { signed: signed.signedTransaction };
}
