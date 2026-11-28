/**
 * The Starknet claim links this account sent, sealed in this browser
 * (lib/starknetPrivacy/payrollStore's sealedList, a domain of its own), so the
 * sender can copy one again or take back one nobody used. A link is kept here
 * before anything is sent for it (lib/starknetPrivacy/payroll's link step), so
 * a closed tab never loses money: what was paid into a link can always be
 * moved again by whoever holds it, the sender included.
 *
 * A link's secret is the one-time account's key, so it is a bearer secret:
 * sealed at rest, never sent anywhere, shown only when the sender copies it.
 */
import { claimLinkUrl, bytesOf, type StarknetClaim } from "./claimLink";
import type { StarknetNetwork } from "./config";
import { sealedList, type RunCipher, type RunStorage } from "./payrollStore";

export const SENT_LINKS_DOMAIN = "gloam/starknet-sent-links/v1\n";
/** Links kept besides the ones still waiting. */
const KEEP_SETTLED = 50;

export type SentLinkState =
  /** Kept; its one-time account isn't open yet. */
  | "new"
  /** Its one-time account is open, nothing paid into it yet (or the payment is in flight). */
  | "open"
  /** Paid: waiting to be claimed. */
  | "paid"
  /** Claimed, or taken back: empty. */
  | "used";

export type StarknetSentLink = {
  v: 1;
  id: string;
  network: StarknetNetwork;
  /** The sender's private account. */
  owner: string;
  /** The link's secret, hex (16 bytes). */
  secret: string;
  /** The one-time account's address. */
  address: string;
  /** What the person gets, base units (the link shows it). */
  amount: string;
  /** Gloam's fee paid into the link for its claim, base units. */
  claimFee: string;
  /** Who it is for, as the sender named them (payroll's name column), or "". */
  name: string;
  createdAt: number;
  state: SentLinkState;
  /** The payment that paid it. */
  txHash?: string;
  /** The payroll run it belongs to. */
  runId?: string;
  /** The sender took it back. */
  takenBack?: boolean;
};

export function sentLinkClaim(l: Pick<StarknetSentLink, "network" | "amount" | "secret">): StarknetClaim {
  return { network: l.network, token: 0, amount: BigInt(l.amount), secret: bytesOf(l.secret) };
}

export function sentLinkUrl(l: Pick<StarknetSentLink, "network" | "amount" | "secret">, origin?: string): string {
  return claimLinkUrl(sentLinkClaim(l), origin);
}

const STATES: ReadonlySet<string> = new Set(["new", "open", "paid", "used"]);

export function isSentLink(v: unknown): v is StarknetSentLink {
  const l = v as Partial<StarknetSentLink> | null;
  return (
    Boolean(l) &&
    l!.v === 1 &&
    typeof l!.id === "string" &&
    (l!.network === "mainnet" || l!.network === "sepolia" || l!.network === "devnet") &&
    typeof l!.owner === "string" &&
    typeof l!.secret === "string" &&
    /^[0-9a-f]{32}$/.test(l!.secret) &&
    typeof l!.address === "string" &&
    /^0x[0-9a-f]{1,64}$/.test(l!.address) &&
    typeof l!.amount === "string" &&
    /^\d+$/.test(l!.amount) &&
    typeof l!.claimFee === "string" &&
    /^\d+$/.test(l!.claimFee) &&
    typeof l!.name === "string" &&
    typeof l!.createdAt === "number" &&
    typeof l!.state === "string" &&
    STATES.has(l!.state)
  );
}

export function sentLinksKey(network: StarknetNetwork, owner: string): string {
  return `gloam:starknet-sent-links:v1:${network}:${BigInt(owner).toString(16)}`;
}

/** This account's sent links. A link not known to be used is never dropped to make room. */
export function sentLinksStore(opts: { key: string; cipher: RunCipher; storage?: RunStorage }) {
  const list = sealedList<StarknetSentLink>({ ...opts, domain: SENT_LINKS_DOMAIN, isItem: isSentLink, keep: (l) => l.state !== "used", keepOthers: KEEP_SETTLED });
  return {
    load: list.load,
    save: list.save,
    remove: list.remove,
    /** Change one link under the store's lock. */
    update: list.edit,
  };
}

export type SentLinksStore = ReturnType<typeof sentLinksStore>;
