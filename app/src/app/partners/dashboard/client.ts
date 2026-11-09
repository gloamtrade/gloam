/**
 * Browser side of the partner portal: finding a wallet, signing in with it
 * (EIP-4361), and calling the portal's own endpoints. A Gloam wallet made with
 * an email (Turnkey) signs the same message through signInWithSigner.
 */
import { getAddress, toHex, type Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { ActivityRecord, PartnerStats } from "@/lib/partners";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export type WalletChoice = { id: string; name: string; icon: string | null; provider: Eip1193 };

/**
 * Wallets in this browser: EIP-6963 announcements first (so several installed
 * wallets each show up), then window.ethereum as a fallback.
 */
export function discoverWallets(waitMs = 350): Promise<WalletChoice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletChoice>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193 }>).detail;
      if (!d?.provider || typeof d.provider.request !== "function") return;
      const id = d.info?.rdns || d.info?.uuid || `wallet-${found.size}`;
      if (!found.has(id)) {
        found.set(id, {
          id,
          name: (d.info?.name || "Browser wallet").slice(0, 40),
          icon: typeof d.info?.icon === "string" && d.info.icon.startsWith("data:image/") ? d.info.icon : null,
          provider: d.provider,
        });
      }
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const injected = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      if (found.size === 0 && injected && typeof injected.request === "function") {
        found.set("injected", { id: "injected", name: "Browser wallet", icon: null, provider: injected });
      }
      resolve([...found.values()]);
    }, waitMs);
  });
}

export class PortalError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number
  ) {
    super(message);
  }
}

type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string } };

/** A portal call; returns `data` or throws PortalError with the server's plain message. */
export async function portal<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/partners${path}`, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new PortalError("Could not reach Gloam. Check your connection.", "network", 0);
  }
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json?.ok) {
    throw new PortalError(json?.error?.message ?? `Something went wrong (${res.status}).`, json?.error?.code ?? "error", res.status);
  }
  return json.data as T;
}

function walletError(e: unknown): PortalError {
  const err = e as { code?: number; message?: string } | null;
  if (err?.code === 4001) return new PortalError("You declined in your wallet. Nothing was signed.", "rejected", 0);
  if (err?.code === -32002) return new PortalError("Your wallet already has a request open. Check it, then try again.", "pending", 0);
  if (e instanceof PortalError) return e;
  return new PortalError("Your wallet did not answer. Unlock it and try again.", "wallet", 0);
}

/** Builds the sign-in message for this site, has `sign` sign it, and opens a session. */
export async function signInWithSigner(
  address: Address,
  chainId: number,
  sign: (message: string) => Promise<string>,
  fail: (e: unknown) => PortalError = walletError
): Promise<{ wallet: Address }> {
  const n = await portal<{ nonce: string; statement: string; maxLifetimeSec: number }>("/nonce");
  const now = new Date();
  const message = createSiweMessage({
    domain: window.location.host,
    address,
    statement: n.statement,
    uri: window.location.origin,
    version: "1",
    chainId,
    nonce: n.nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + Math.min(n.maxLifetimeSec, 600) * 1000),
  });
  let signature: string;
  try {
    signature = await sign(message);
  } catch (e) {
    throw fail(e);
  }
  return portal<{ wallet: Address }>("/session", { method: "POST", body: { message, signature } });
}

/** Connect, build the sign-in message, have the wallet sign it, and open a session. */
export async function signInWith(provider: Eip1193): Promise<{ wallet: Address }> {
  let address: Address;
  let chainId = 46630;
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!Array.isArray(accounts) || !accounts[0]) throw new PortalError("No account was shared by your wallet.", "no_account", 0);
    address = getAddress(accounts[0]);
    const raw = await provider.request({ method: "eth_chainId" }).catch(() => null);
    const id = typeof raw === "string" ? Number.parseInt(raw, 16) : Number(raw);
    if (Number.isSafeInteger(id) && id > 0) chainId = id;
  } catch (e) {
    throw walletError(e);
  }
  return signInWithSigner(address, chainId, async (message) =>
    (await provider.request({ method: "personal_sign", params: [toHex(message), address] })) as string
  );
}

export type FeeSetting = { privatePaymentCents: number; cashoutBps: number; depositBps: number };

export type PartnerAccount = {
  id: string;
  owner: Address;
  name: string;
  website: string | null;
  payout: Partial<Record<"robinhood" | "tempo", Address>>;
  fees: FeeSetting;
  /** The name Gloam approved to show in links, or null. */
  approvedName?: string | null;
  /** The account's name differs from the approved one (or none is approved yet). */
  nameAwaitingApproval?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type KeyView = {
  id: string;
  name: string;
  env: "test" | "live";
  display: string;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
};

/** One counted transaction (lib/partners ActivityRecord): public facts only. */
export type Activity = ActivityRecord;

/** The signed-in partner's own figures (GET /api/partners/stats). */
export type Stats = PartnerStats & {
  recent: Activity[];
  days: number;
  charged: false;
  notMatched?: { privatePayments: string; swaps: string };
};

/** A partner link code, as its partner sees it. */
export type LinkCodeView = {
  code: string;
  label: string;
  createdAt: number;
  createdBy: "partner" | "admin";
  expiresAt: number | null;
  revokedAt: number | null;
  state: "live" | "revoked" | "expired";
};
