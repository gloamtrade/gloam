/**
 * Gloam wallets: a wallet made inside the app after signing in with an email
 * or a passkey. Its key is made and kept by Turnkey in secure hardware, so the
 * page never sees it and there is no seed phrase. Signing in again, on any
 * device, opens the same wallet.
 *
 * Everything here is plain logic, with no React and no Turnkey SDK, so the
 * self-tests run it (scripts/selftest-embedded-flow.mts) and a server page can
 * read the switch.
 *
 * The switch: NEXT_PUBLIC_TURNKEY_ENABLED must be exactly "true", and both
 * dashboard ids must be set. Until then nothing in the app changes.
 */

/** The wagmi connector id of a Gloam wallet. */
export const EMBEDDED_CONNECTOR_ID = "gloam-turnkey";

export type EmbeddedEnv = {
  enabled?: string | undefined;
  organizationId?: string | undefined;
  authProxyConfigId?: string | undefined;
  /** Google's OAuth Web client ID. Unset: no Google button. */
  googleClientId?: string | undefined;
};

/**
 * Written out with each variable read by its full name, so Next inlines the
 * values into the browser bundle (it does not for process.env read any other way).
 */
const BUILD_ENV: EmbeddedEnv = {
  enabled: process.env.NEXT_PUBLIC_TURNKEY_ENABLED,
  organizationId: process.env.NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID,
  authProxyConfigId: process.env.NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID,
  googleClientId: process.env.NEXT_PUBLIC_TURNKEY_GOOGLE_CLIENT_ID,
};

/** Gloam wallets are on: the flag says exactly "true" and both dashboard ids are there. */
export function embeddedWalletsOn(env: EmbeddedEnv = BUILD_ENV): boolean {
  return env.enabled?.trim() === "true" && Boolean(env.organizationId?.trim()) && Boolean(env.authProxyConfigId?.trim());
}

export const EMBEDDED_WALLETS = embeddedWalletsOn();
export const TURNKEY_ORGANIZATION_ID = BUILD_ENV.organizationId?.trim() ?? "";
export const TURNKEY_AUTH_PROXY_CONFIG_ID = BUILD_ENV.authProxyConfigId?.trim() ?? "";

/**
 * Continue with Google: the Web client ID from Google Cloud (DEPLOY-TURNKEY.md),
 * or "" to leave the button out. Only a value shaped like a Google client ID counts.
 */
export function googleClientIdFrom(env: EmbeddedEnv = BUILD_ENV): string {
  const id = env.googleClientId?.trim() ?? "";
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id) ? id : "";
}
export const TURNKEY_GOOGLE_CLIENT_ID = googleClientIdFrom();

/**
 * Where Google sends the sign-in window back to after Continue with Google: this
 * origin itself, with no path and no trailing slash, exactly as it is listed under
 * Authorized redirect URIs in Google Cloud (DEPLOY-TURNKEY.md). The window is never
 * read as a page: the kit reads the token off its address the moment it is back on
 * this origin, then closes it.
 */
export function oauthRedirectFor(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * The passkey's relying party. On gloam.trade and its subdomains it is the bare
 * domain, so a passkey made on www.gloam.trade (where the apex redirects) also
 * works if the site ever drops the www. WebAuthn lets a page claim its parent
 * domain. Everywhere else (localhost, a preview deployment) it is the page's own
 * host. Never change it once people have passkeys: theirs would stop working.
 */
export function embeddedRpId(hostname: string): string {
  const h = hostname.toLowerCase();
  return h === "gloam.trade" || h.endsWith(".gloam.trade") ? "gloam.trade" : h;
}

/**
 * Where the Turnkey kit keeps a sign-in in localStorage (@turnkey/core's
 * WebStorageManager): the list of session keys, the active one, and the default
 * session's own key. scripts/selftest-embedded-flow.mts checks them against the
 * installed kit, so an upgrade that moves them fails there first.
 */
export const TURNKEY_SESSION_LIST_KEY = "@turnkey/all-session-keys";
export const TURNKEY_ACTIVE_SESSION_KEY = "@turnkey/active-session-key";
export const TURNKEY_DEFAULT_SESSION_KEY = "@turnkey/session/v3";

/**
 * Whether this browser holds a Gloam wallet sign-in that may still be good, read
 * from storage without the kit. The kit is a large download, so the app starts it
 * on load only for someone who signed in before (the kit then restores the session
 * and signs them in) and otherwise waits for a Sign in.
 *
 * Cautious on purpose: a stored session counts unless its expiry is known and has
 * passed (the kit's own test: `expiry` in seconds, still ahead), so someone signed
 * in is never left signed out. One that turns out stale only costs loading the kit,
 * which then clears it. Storage that can't be read counts as none: the kit could
 * not read it either.
 */
export function storedTurnkeySession(
  storage: { getItem(key: string): string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const read = (key: string): unknown => {
      const raw = storage.getItem(key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    };
    const listed = read(TURNKEY_SESSION_LIST_KEY);
    const active = read(TURNKEY_ACTIVE_SESSION_KEY);
    const keys = new Set<string>([TURNKEY_DEFAULT_SESSION_KEY]);
    if (Array.isArray(listed)) for (const k of listed) if (typeof k === "string") keys.add(k);
    if (typeof active === "string") keys.add(active);
    for (const key of keys) {
      const session = read(key);
      if (session === undefined || session === null) continue;
      const expiry = typeof session === "object" ? (session as { expiry?: unknown }).expiry : undefined;
      const seconds = typeof expiry === "number" ? expiry : typeof expiry === "string" && /^\d+$/.test(expiry) ? Number(expiry) : NaN;
      // a session in a shape this doesn't know: the kit decides
      if (!Number.isFinite(seconds)) return true;
      if (seconds * 1000 > now) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The slice of a Turnkey wallet this app reads. */
export type WalletLike = {
  source?: string;
  walletId?: string;
  walletName?: string;
  accounts?: readonly { address?: string; addressFormat?: string }[];
  /** Turnkey's timestamp: seconds and nanoseconds, as strings. */
  createdAt?: { seconds?: string | number; nanos?: string | number } | null;
};

/** A wallet's creation time in nanoseconds, or null when Turnkey didn't say. */
function createdNs(w: WalletLike): bigint | null {
  const s = w.createdAt?.seconds;
  if (s === undefined || s === null || !/^\d+$/.test(String(s))) return null;
  const n = w.createdAt?.nanos;
  return BigInt(String(s)) * 1_000_000_000n + (n !== undefined && /^\d+$/.test(String(n)) ? BigInt(String(n)) : 0n);
}

/**
 * The Gloam wallet to sign with: the oldest embedded wallet (Turnkey can also list
 * wallets it connected from the browser, which are not this) that has an Ethereum
 * account. Oldest by Turnkey's createdAt, so the address never depends on the order
 * a list comes back in; wallets with no timestamp come after, in list order. Null
 * when there is none yet.
 */
export function pickEmbeddedWallet(wallets: readonly WalletLike[] | undefined): { walletId: string; walletName: string; address: string } | null {
  const usable = (wallets ?? [])
    .map((w, i) => ({ w, i, at: createdNs(w), acct: w.accounts?.find((a) => a.addressFormat === "ADDRESS_FORMAT_ETHEREUM" && typeof a.address === "string") }))
    .filter((x) => x.w.source === "embedded" && x.acct?.address);
  usable.sort((a, b) => {
    if (a.at !== null && b.at !== null && a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.at === null && b.at !== null) return 1;
    if (a.at !== null && b.at === null) return -1;
    return a.i - b.i;
  });
  const first = usable[0];
  return first ? { walletId: first.w.walletId ?? "", walletName: first.w.walletName ?? "", address: first.acct!.address! } : null;
}

/** What a wallet is called when the name field is left empty. */
export const DEFAULT_WALLET_NAME = "Gloam wallet";
export const WALLET_NAME_MAX = 40;

/** Why this name can't be used, or null. An empty name is fine: the default is used. */
export function walletNameProblem(name: string): string | null {
  const n = name.trim();
  if (n.length > WALLET_NAME_MAX) return `Keep the name to ${WALLET_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(n)) return "Use letters, numbers and spaces.";
  return null;
}

/** The name sent to Turnkey: what was typed, tidied, or the default. */
export function walletNameFor(typed: string): string {
  const n = typed.trim().replace(/\s+/g, " ");
  return n || DEFAULT_WALLET_NAME;
}

/**
 * Where the create-a-wallet sheet is, from what is known about the session:
 * - hidden: nothing to show (signed out, or a wallet that is set up)
 * - checking: signed in, and the wallet list hasn't come back yet (or a read
 *   failed and another is on its way). Nothing is shown, so someone with a
 *   wallet never sees "Create wallet" because a read failed
 * - unreadable: the reads kept failing. The sheet says so and offers to try
 *   again; it never offers to create a wallet on an unknown list
 * - create: signed in, the list read, and no Gloam wallet in it
 * - creating: the wallet is being made
 * - failed: it was not made; the sheet says why and offers to try again
 * - funding: just made, so the next step is Add funds
 * - backup: a wallet made before, and this browser could back up its private
 *   balance (lib/embeddedRecovery): offered once
 */
export type EmbeddedFlowStep = "hidden" | "checking" | "unreadable" | "create" | "creating" | "failed" | "funding" | "backup";

/** "read": the list came back since signing in. "unknown": not yet. "failed": the reads failed and stopped. */
export type WalletListState = "unknown" | "read" | "failed";

export type EmbeddedFlowState = {
  signedIn: boolean;
  list: WalletListState;
  /** A Gloam wallet with an Ethereum account exists. */
  hasWallet: boolean;
  creating: boolean;
  error: string | null;
  /** Made in this visit, or Add funds was asked for from the wallet menu. */
  funding: boolean;
  /** A backup offer is waiting for a wallet made before this visit. */
  backup: boolean;
  /** The person closed the sheet. */
  dismissed: boolean;
};

export function embeddedFlowStep(s: EmbeddedFlowState): EmbeddedFlowStep {
  if (!s.signedIn) return "hidden";
  if (s.creating) return "creating";
  if (s.error) return "failed";
  if (s.hasWallet) {
    if (s.dismissed) return "hidden";
    if (s.funding) return "funding";
    return s.backup ? "backup" : "hidden";
  }
  // Only a list that came back says "no wallet": anything else is still unknown.
  if (s.list === "failed") return s.dismissed ? "hidden" : "unreadable";
  if (s.list !== "read") return "checking";
  return s.dismissed ? "hidden" : "create";
}

/** Plain words for a wallet that was not made. Never the SDK's own text, which names internals. */
export function createWalletErrorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? "");
  if (/cancel|abort|not ?allowed/i.test(text)) return "Nothing was made. Try again when you're ready.";
  if (/session|expired|unauthori[sz]ed|not authenticated/i.test(text)) return "Your sign-in ran out. Sign in again, then create the wallet.";
  if (/network|fetch|timed? ?out/i.test(text)) return "Couldn't reach the wallet service. Check your connection and try again.";
  if (/already has a wallet|wallet list/i.test(text)) return "Couldn't check your wallets, so nothing was made. Try again.";
  return "The wallet wasn't made. Try again.";
}
