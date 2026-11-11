"use client";

import type { Address, Hex, LocalAccount } from "viem";
import { EMBEDDED_WALLETS, storedTurnkeySession } from "./embeddedWallet";

/**
 * Bridge between Turnkey's embedded wallet (react-wallet-kit) and viem/wagmi.
 *
 * A sign-in gives a Turnkey client and a wallet account address. `buildTurnkeyAccount`
 * turns that into a viem LocalAccount that signs inside Turnkey, which the wagmi
 * connector (lib/turnkeyConnector) uses, so the app's shield, pay and send code
 * works unchanged with a Gloam wallet.
 *
 * This module imports no Turnkey code, so anything can read it (the wallet menu,
 * the connector) without pulling the kit into the bundle.
 */

/** A transaction Turnkey's gas station sends, paying the network fee. */
export type SponsoredTx = {
  chainId: number;
  from: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
  /** The chain's gas coin, for the message when Turnkey refuses. */
  coin: string;
};

export type EmbeddedSigner = {
  account: LocalAccount;
  /** Sends through Turnkey's gas station. Absent when sponsorship is off. */
  sponsoredSend?: (tx: SponsoredTx) => Promise<Hex>;
};

// Module-level holder so the (module-level) wagmi connector can read the signer
// that the React layer builds after sign-in.
let active: EmbeddedSigner | null = null;
const listeners = new Set<() => void>();

export function setActiveTurnkeySigner(signer: EmbeddedSigner | null) {
  if (signer === active) return;
  active = signer;
  listeners.forEach((fn) => fn());
}

export function getActiveTurnkeySigner(): EmbeddedSigner | null {
  return active;
}

export function getActiveTurnkeyAccount(): LocalAccount | null {
  return active?.account ?? null;
}

export function onTurnkeyAccountChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Build a viem signer from a logged-in Turnkey client + wallet address. */
export async function buildTurnkeyAccount(
  // react-wallet-kit's httpClient is the TurnkeySDKClientBase @turnkey/viem takes;
  // the two packages' declared types differ, so widen here.
  client: unknown,
  organizationId: string,
  signWith: string
): Promise<LocalAccount> {
  // Lazy import: keeps @turnkey/viem out of the wagmi config's SSR import graph.
  const { createAccount } = await import("@turnkey/viem");
  return createAccount({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    organizationId,
    signWith,
  });
}

/* ---------------------------------------------------------------- session */

let signOut: (() => Promise<void>) | null = null;

/** Set by the Turnkey layer: ends the Turnkey session (wagmi then disconnects by itself). */
export function setEmbeddedSignOut(fn: (() => Promise<void>) | null) {
  signOut = fn;
}

/**
 * Signs out of the Gloam wallet. A wagmi disconnect alone would not do: the
 * Turnkey session is still there, so the wallet would connect again at once.
 */
export async function signOutEmbedded(): Promise<void> {
  await signOut?.();
}

/* ---------------------------------------------------------------- sign-in */

/** What the place that opened the sign-in sheet offers beside it. */
export type SignInSheetOptions = {
  /**
   * Its own browser-wallet connect. The sheet then shows "Use a browser wallet
   * instead", which closes the sheet and calls this.
   */
  onUseWallet?: () => void;
  /** The words for that link, when they differ (a wallet app on a phone). */
  walletLabel?: string;
};

type SignInListener = (opts: SignInSheetOptions) => void;
const signInListeners = new Set<SignInListener>();

/** How long a Sign in tapped before the sheet was there waits for it. */
export const SIGN_IN_PENDING_MS = 30_000;
/** A Sign in tapped while no sheet was listening yet (the kit's code still loading): the sheet opens with it. */
let pendingSignIn: { opts: SignInSheetOptions; at: number } | null = null;
const pendingListeners = new Set<() => void>();

function setPendingSignIn(next: { opts: SignInSheetOptions; at: number } | null) {
  if (next === pendingSignIn) return;
  pendingSignIn = next;
  pendingListeners.forEach((fn) => fn());
}

/**
 * Opens Gloam's sign-in sheet (email code or passkey), drawn by
 * components/app/GloamSignInSheet inside the Turnkey provider. In the app the kit
 * loads only when it is needed (TurnkeyKitGate), so this asks for it too. A tap
 * is never dropped: when no sheet is listening yet, the request waits (up to
 * SIGN_IN_PENDING_MS) and the sheet opens with it as soon as it mounts, showing
 * "Getting sign-in ready…" until the kit is up. Says whether a sheet was there.
 */
export function openSignInSheet(opts: SignInSheetOptions = {}, now = Date.now()): boolean {
  wantEmbeddedKit();
  if (signInListeners.size === 0) {
    setPendingSignIn({ opts, at: now });
    return false;
  }
  setPendingSignIn(null);
  signInListeners.forEach((fn) => fn(opts));
  return true;
}

/** Listen for sign-in requests; one made just before (openSignInSheet with no listener) is handed over at once. */
export function onSignInSheetRequest(fn: SignInListener, now = Date.now()): () => void {
  signInListeners.add(fn);
  const waiting = pendingSignIn;
  setPendingSignIn(null);
  if (waiting && now - waiting.at <= SIGN_IN_PENDING_MS) fn(waiting.opts);
  return () => signInListeners.delete(fn);
}

/** A Sign in was tapped and waits for the sheet (the kit is still loading): the button shows it is working. */
export function signInWaiting(now = Date.now()): boolean {
  return pendingSignIn !== null && now - pendingSignIn.at <= SIGN_IN_PENDING_MS;
}

export function onSignInWaiting(fn: () => void): () => void {
  pendingListeners.add(fn);
  return () => pendingListeners.delete(fn);
}

/** Forgets a Sign in that is waiting: the kit could not load, so no sheet will take it. */
export function dropSignInWaiting() {
  setPendingSignIn(null);
}

/* ---------------------------------------------------------------- the kit */

/**
 * Whether the Turnkey kit should run on this page. It is a large download, so the
 * app (components/app/TurnkeyKitGate) starts it only for someone with a stored
 * sign-in (lib/embeddedWallet storedTurnkeySession) or once they ask to sign in.
 * Once wanted, it stays wanted for the page's life.
 */
let kitWanted = false;
const kitListeners = new Set<() => void>();

export function wantEmbeddedKit() {
  if (kitWanted) return;
  kitWanted = true;
  kitListeners.forEach((fn) => fn());
}

export function embeddedKitWanted(): boolean {
  return kitWanted;
}

export function onEmbeddedKitWanted(fn: () => void): () => void {
  kitListeners.add(fn);
  return () => kitListeners.delete(fn);
}

/**
 * On load: this browser holds a sign-in that may still be good, so the kit is
 * wanted at once, to sign the person back in, and until it has looked the header
 * says the wallet is opening (never Sign in to someone who is signed in). Says
 * whether it was.
 */
export function wantEmbeddedKitIfSignedIn(
  storage: { getItem(key: string): string | null } | null | undefined,
  enabled: boolean = EMBEDDED_WALLETS,
  now: number = Date.now(),
): boolean {
  if (!enabled || !storedTurnkeySession(storage, now)) return false;
  if (auth === "signed-out") setEmbeddedAuth("restoring");
  wantEmbeddedKit();
  return true;
}

/* ---------------------------------------------------------------- signed in */

/**
 * Whether the kit holds a session, published by the kit (TurnkeyWagmiSync) for
 * the parts of the app outside it: the header's Sign in reads this, not the kit,
 * so it never has to load the kit to know someone is signed out. "restoring": a
 * sign-in is stored in this browser and the kit, still loading or starting, has
 * not said yet whether it is good.
 */
export type EmbeddedAuth = "signed-out" | "restoring" | "signed-in";
let auth: EmbeddedAuth = "signed-out";
const authListeners = new Set<() => void>();

export function setEmbeddedAuth(a: EmbeddedAuth) {
  if (a === auth) return;
  auth = a;
  authListeners.forEach((fn) => fn());
}

export function embeddedAuth(): EmbeddedAuth {
  return auth;
}

export function onEmbeddedAuth(fn: () => void): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

/* ---------------------------------------------------------------- the sheet */

export type EmbeddedSheetRequest = "create" | "funding";
type SheetListener = (req: EmbeddedSheetRequest) => void;
const sheetListeners = new Set<SheetListener>();

/** Opens the create-a-wallet sheet, or its Add funds step (from the wallet menu). */
export function openEmbeddedSheet(req: EmbeddedSheetRequest) {
  sheetListeners.forEach((fn) => fn(req));
}

export function onEmbeddedSheetRequest(fn: SheetListener): () => void {
  sheetListeners.add(fn);
  return () => sheetListeners.delete(fn);
}

/**
 * Signed in, the wallet list read, and no Gloam wallet in it: the header offers
 * Create wallet. Set by the sheet (EmbeddedWalletFlow), which does that check.
 */
let needsWallet = false;
const needsWalletListeners = new Set<() => void>();

export function setEmbeddedNeedsWallet(v: boolean) {
  if (v === needsWallet) return;
  needsWallet = v;
  needsWalletListeners.forEach((fn) => fn());
}

export function embeddedNeedsWallet(): boolean {
  return needsWallet;
}

export function onEmbeddedNeedsWallet(fn: () => void): () => void {
  needsWalletListeners.add(fn);
  return () => needsWalletListeners.delete(fn);
}

/* ---------------------------------------------------------------- availability */

/**
 * Whether email and passkey sign-in can work on this page. "unavailable" when the
 * kit failed to start, most often because Turnkey's auth proxy refused this
 * site's origin (Allowed Origins in the dashboard).
 */
export type EmbeddedAvailability = "starting" | "ready" | "unavailable";
let availability: EmbeddedAvailability = "starting";
const availabilityListeners = new Set<() => void>();

export function setEmbeddedAvailability(a: EmbeddedAvailability) {
  if (a === availability) return;
  availability = a;
  availabilityListeners.forEach((fn) => fn());
}

export function embeddedAvailability(): EmbeddedAvailability {
  return availability;
}

export function onEmbeddedAvailability(fn: () => void): () => void {
  availabilityListeners.add(fn);
  return () => availabilityListeners.delete(fn);
}

/* ---------------------------------------------------------------- the signer */

/**
 * Whether the Gloam wallet's signer started after sign-in: "failed" lets the
 * header offer Try again and Sign out instead of waiting forever.
 */
export type EmbeddedSignerState = "idle" | "starting" | "ready" | "failed";
let signerState: EmbeddedSignerState = "idle";
let signerRetries = 0;
const signerListeners = new Set<() => void>();

export function setEmbeddedSignerState(s: EmbeddedSignerState) {
  if (s === signerState) return;
  signerState = s;
  signerListeners.forEach((fn) => fn());
}

export function embeddedSignerState(): EmbeddedSignerState {
  return signerState;
}

export function onEmbeddedSignerState(fn: () => void): () => void {
  signerListeners.add(fn);
  return () => signerListeners.delete(fn);
}

/** Asks the Turnkey layer to build the signer again. */
export function retryEmbeddedSigner() {
  signerRetries++;
  signerListeners.forEach((fn) => fn());
}

export function embeddedSignerRetries(): number {
  return signerRetries;
}

export const onEmbeddedSignerRetry = onEmbeddedSignerState;

/* ---------------------------------------------------------------- sign-in email */

/**
 * The email a Gloam wallet signed in with, as the kit reports it, so Settings can
 * fill in the updates field. Held in memory only: never saved, never sent with
 * anything. Null when signed out, or signed in with a passkey alone.
 */
let signInEmail: string | null = null;
const emailListeners = new Set<() => void>();

export function setEmbeddedSignInEmail(email: string | null) {
  const next = email?.trim() || null;
  if (next === signInEmail) return;
  signInEmail = next;
  emailListeners.forEach((fn) => fn());
}

export function embeddedSignInEmail(): string | null {
  return signInEmail;
}

export function onEmbeddedSignInEmail(fn: () => void): () => void {
  emailListeners.add(fn);
  return () => emailListeners.delete(fn);
}
