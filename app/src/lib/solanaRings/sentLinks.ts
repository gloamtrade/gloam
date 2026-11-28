/**
 * Sent links on Solana: the claim links a private account made (Pay > Claim
 * link), kept in this browser so a lost link is not lost money, with whether
 * each one's money has moved and Take back for one nobody used.
 *
 * A record holds the link itself, so it is money: the list is sealed like a
 * payroll run (lib/solanaRings/payrollStore runCipher, a domain of its own),
 * under a key from the private account's viewing secret, bound to its
 * address. Only that account opens it. It is saved before the payment is sent
 * and dropped again only when the send surely went nowhere, as on the other
 * chains (lib/sentLinks).
 *
 * Status comes from Solana: the one-time account is synced (lib/solanaRings/
 * claim linkState). A link once seen used stays used, so it is never read again.
 *
 * Pure records and a store with its storage and cipher passed in, so
 * scripts/selftest-solana-claim-links.mts runs it in Node.
 */
import { decodeClaim } from "./claimLink";
import type { LinkState } from "./claim";
import type { RunCipher, RunStorage } from "./payrollStore";
import type { RingsNetwork } from "./config";

/** Settled records kept per account, besides every one whose money may not have moved. */
export const SOLANA_SENT_LINKS_MAX = 100;
/** A link with nothing in it this long after it was made never got its money: it may leave the list. */
export const EMPTY_AFTER_MS = 15 * 60_000;

export type SolanaSentLink = {
  id: string;
  /** The link's body (lib/solanaRings/claimLink). Bearer: this is the money. */
  body: string;
  network: RingsNetwork;
  /** Asset id, and base units, as sent. */
  asset: string;
  amount: string;
  createdAt: number;
  /** The sender claimed it back into their own balance. */
  takenBackAt?: number;
  /** Seen claimed on Solana. A claimed link stays claimed. */
  usedAt?: number;
};

export type SolanaSentLinkStatus = "checking" | "unused" | "used" | "taken-back" | "arriving" | "empty" | "unknown";

export const SOLANA_SENT_LINK_LABEL: Record<SolanaSentLinkStatus, string> = {
  checking: "Checking",
  unused: "Not used yet",
  used: "Used",
  "taken-back": "Taken back",
  arriving: "On its way",
  empty: "Nothing in it",
  unknown: "Couldn't check",
};

export function makeSolanaSentLink(args: { body: string; now?: number; random?: () => string }): SolanaSentLink {
  const read = decodeClaim(args.body);
  if (!read.ok) throw new Error("Not a claim link.");
  const createdAt = args.now ?? Date.now();
  const rand = args.random?.() ?? Math.random().toString(36).slice(2, 8);
  return {
    id: `ssl-${createdAt.toString(36)}-${rand}`,
    body: read.body,
    network: read.claim.network,
    asset: read.claim.asset.id,
    amount: read.claim.amount.toString(),
    createdAt,
  };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** Stored records back, dropping anything that is not a whole one. Network, asset and amount always follow the link. */
export function parseSolanaSentLinks(value: unknown): SolanaSentLink[] {
  if (!Array.isArray(value)) return [];
  const out: SolanaSentLink[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || typeof r.body !== "string") continue;
    const read = decodeClaim(r.body);
    const createdAt = num(r.createdAt);
    if (!read.ok || !createdAt) continue;
    const takenBackAt = num(r.takenBackAt);
    const usedAt = num(r.usedAt);
    out.push({
      id: r.id,
      body: read.body,
      network: read.claim.network,
      asset: read.claim.asset.id,
      amount: read.claim.amount.toString(),
      createdAt,
      ...(takenBackAt ? { takenBackAt } : {}),
      ...(usedAt ? { usedAt } : {}),
    });
  }
  return out;
}

/** Rows whose money may still be in the link: read again on Solana. */
export function needsCheck(r: Pick<SolanaSentLink, "takenBackAt" | "usedAt">): boolean {
  return !r.takenBackAt && !r.usedAt;
}

/**
 * Newest first. A link whose money may not have moved is never dropped (this
 * record may be its only copy); only used and taken-back ones make room,
 * oldest first.
 */
export function capSolanaSentLinks(list: readonly SolanaSentLink[], max = SOLANA_SENT_LINKS_MAX): SolanaSentLink[] {
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
  let settled = 0;
  return sorted.filter((r) => needsCheck(r) || ++settled <= max);
}

/**
 * What a row shows. `read` is the last read of its one-time account: undefined
 * while none has come back, null when it failed. A failed read never guesses.
 */
export function solanaSentLinkStatus(
  rec: Pick<SolanaSentLink, "takenBackAt" | "usedAt" | "createdAt">,
  read: LinkState | null | undefined,
  now = Date.now()
): SolanaSentLinkStatus {
  if (rec.takenBackAt) return "taken-back";
  if (rec.usedAt || read === "used") return "used";
  if (read === "unused") return "unused";
  if (read === "empty") return now - rec.createdAt < EMPTY_AFTER_MS ? "arriving" : "empty";
  if (read === null) return "unknown";
  return "checking";
}

/** Only a link with money waiting in it can be taken back. */
export function canTakeBack(status: SolanaSentLinkStatus): boolean {
  return status === "unused";
}

/** Only a row whose money has moved, or that never got any, may leave the list. */
export function canRemove(status: SolanaSentLinkStatus): boolean {
  return status === "used" || status === "taken-back" || status === "empty";
}

// ------------------------------------------------------------------ the sealed store

const DOMAIN = "gloam/solana-sent-links/v1\n";

/** The cipher domain (lib/solanaRings/payrollStore runCipher) these records are sealed under. */
export const SENT_LINKS_DOMAIN = DOMAIN;

export function sentLinksKey(network: RingsNetwork, owner: string): string {
  return `gloam:solana-sent-links:v1:${network}:${owner}`;
}

type Locks = { request<T>(name: string, fn: () => Promise<T>): Promise<T> };

function locks(): Locks | null {
  const l = (globalThis.navigator as { locks?: Locks } | undefined)?.locks;
  return l?.request ? l : null;
}

/**
 * One private account's sent links. Writes take turns across tabs (Web
 * Locks), resolve only once the sealed list reads back, and a list this
 * account can't open is set aside, never written over.
 */
export function solanaSentLinksStore(opts: { key: string; cipher: RunCipher; storage?: RunStorage }) {
  const storage = opts.storage ?? globalThis.localStorage;
  const unreadableKey = `${opts.key}:unreadable`;

  async function read(raw: string | null): Promise<SolanaSentLink[]> {
    if (!raw) return [];
    try {
      const plain = await opts.cipher.open(raw);
      if (!plain.startsWith(DOMAIN)) throw new Error("not a sent links list");
      return parseSolanaSentLinks(JSON.parse(plain.slice(DOMAIN.length)));
    } catch {
      if (!storage.getItem(unreadableKey)) storage.setItem(unreadableKey, raw);
      return [];
    }
  }

  async function write(change: (all: SolanaSentLink[]) => SolanaSentLink[]): Promise<void> {
    const task = async () => {
      const next = capSolanaSentLinks(change(await read(storage.getItem(opts.key))));
      const sealed = await opts.cipher.seal(DOMAIN + JSON.stringify(next));
      storage.setItem(opts.key, sealed); // throws when storage is full or off
      if (storage.getItem(opts.key) !== sealed) throw new Error("The link didn't save in this browser.");
    };
    const l = locks();
    await (l ? l.request(`gloam-solana-sent-links:${opts.key}`, task) : task());
  }

  const patch = (ids: readonly string[], p: Partial<SolanaSentLink>) =>
    write((all) => all.map((r) => (ids.includes(r.id) ? { ...r, ...p } : r)));

  return {
    /** The links, newest first. */
    load: async () => capSolanaSentLinks(await read(storage.getItem(opts.key))),
    /** Keep a link (one with the same body is replaced, not doubled). Resolves once it reads back. */
    add: (rec: SolanaSentLink) => write((all) => [rec, ...all.filter((r) => r.id !== rec.id && r.body !== rec.body)]),
    remove: (id: string) => write((all) => all.filter((r) => r.id !== id)),
    markUsed: (ids: readonly string[], now = Date.now()) => (ids.length ? patch(ids, { usedAt: now }) : Promise.resolve()),
    markTakenBack: (id: string, now = Date.now()) => patch([id], { takenBackAt: now }),
  };
}

export type SolanaSentLinksStore = ReturnType<typeof solanaSentLinksStore>;
