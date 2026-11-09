/**
 * Connected holders: the wallets that opened a vote page and connected, so the
 * team can count how many holders took part, not only how many voted. Server
 * only. Kept in the app's store (lib/partnersKv: Upstash Redis in production,
 * in-process for local runs and the self-tests), no expiry.
 *
 * One record per wallet: when it was first and last seen, its $GLOAM at the
 * snapshot (from the snapshot file, never from the browser), its $GLOAM now
 * (read here from Robinhood Chain, when the read answers), whether it can
 * vote (by the snapshot, or for a close-weighted vote by its $GLOAM now),
 * whether it is a team or contract address, and which votes it has signed.
 * Nothing else: no IP address, no browser details.
 */
import "server-only";
import { createPublicClient, erc20Abi, getAddress, type Address, type PublicClient } from "viem";
import { robinhood } from "../chain";
import { jsonOf, kv } from "../partnersKv";
import { serverTransport } from "../serverRpc";
import type { VoteConfig } from "./config";
import { GLOAM_TOKEN_ADDRESS, weightOf, weightingOf } from "./core";
import { excludedForVote, snapshotFor, visibleVotes } from "./registry";
import { getBallot } from "./store";

const PREFIX = "gloam:vote:v1:";
const holderKey = (address: string) => `${PREFIX}holder:${address.toLowerCase()}`;
const HOLDERS_SET = `${PREFIX}holders`;
/** A ceiling on new records, so a flood of made-up addresses can't fill the store. Known wallets still update. */
export const HOLDERS_MAX = 100_000;
const CHUNK = 500;
const READ_TIMEOUT_MS = 4_000;

export type HolderRecord = {
  address: string;
  firstSeen: number;
  lastSeen: number;
  /** Times the check ran for this wallet. */
  visits: number;
  /** GLOAM (wei) at the snapshot block, before exclusions. */
  snapshot: string;
  /** GLOAM (wei) at the last successful read, and when. null: never read. */
  current: string | null;
  currentAt: number | null;
  eligible: boolean;
  /** Why it doesn't count (team, contract, pool), or null. */
  excluded: string | null;
  /** Vote ids this wallet had signed when last seen. */
  signed: string[];
};

export type HolderFacts = Pick<HolderRecord, "address" | "snapshot" | "eligible" | "excluded" | "signed">;

/**
 * What the snapshot says about one wallet across the votes the site shows,
 * and which of them it has signed. In a close-weighted vote the wallet can
 * vote when `current` (its $GLOAM now, read on the server) is above zero.
 */
export async function holderFacts(address: Address, votes: VoteConfig[] = visibleVotes(), current: bigint | null = null): Promise<HolderFacts> {
  let held = 0n;
  let eligible = false;
  let excluded: string | null = null;
  const signed: string[] = [];
  await Promise.all(
    votes.map(async (v) => {
      const snapshot = snapshotFor(v);
      const ex = excludedForVote(v).get(address.toLowerCase());
      if (ex && !excluded) excluded = ex.reason;
      if (snapshot) {
        const w = weightOf(snapshot, excludedForVote(v), address);
        if (w.held > held) held = w.held;
        if (w.weight > 0n && weightingOf(v) === "snapshot") eligible = true;
      }
      if (weightingOf(v) === "close" && !ex && current !== null && current > 0n) eligible = true;
      if (!snapshot && weightingOf(v) === "snapshot") return;
      if (await getBallot(v.id, address)) signed.push(v.id);
    }),
  );
  return { address: getAddress(address), snapshot: held.toString(), eligible: eligible && !excluded, excluded, signed: signed.sort() };
}

let rhClient: PublicClient | null = null;

/** The wallet's $GLOAM on Robinhood Chain right now, or null when the read is off, slow or fails. */
export async function readGloamNow(address: Address): Promise<bigint | null> {
  if (process.env.GLOAM_VOTE_NO_CHAIN === "1") return null;
  rhClient ??= createPublicClient({
    chain: robinhood,
    ccipRead: false,
    transport: serverTransport({ chainId: robinhood.id, chain: robinhood, historyRpc: null }, { timeout: READ_TIMEOUT_MS, retryCount: 1 }),
  }) as PublicClient;
  try {
    return await Promise.race([
      rhClient.readContract({ address: GLOAM_TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

export async function getHolder(address: string): Promise<HolderRecord | null> {
  const [raw] = await kv([["GET", holderKey(address)]]);
  return jsonOf<HolderRecord>(raw);
}

/**
 * Whether a wallet not noted before is worth a new record: it held $GLOAM at a
 * snapshot, holds some now (read on the server), has signed a vote, or is a
 * listed team or contract address. Anyone can post any address to the seen
 * route, so a wallet with none of these is answered and not stored: made-up
 * addresses can't use up HOLDERS_MAX or slow the admin list. Pure.
 */
export function worthRecording(facts: HolderFacts, current: bigint | null): boolean {
  return BigInt(facts.snapshot) > 0n || (current !== null && current > 0n) || facts.signed.length > 0 || facts.excluded !== null;
}

/**
 * Notes a connected wallet: one record per wallet, its first-seen time kept,
 * everything else brought up to date. A failed balance read keeps the last
 * one. Returns the record, or null when this wallet is new and either holds no
 * $GLOAM (worthRecording) or the store is full.
 */
export async function recordHolder(facts: HolderFacts, current: bigint | null, now: number = Date.now()): Promise<HolderRecord | null> {
  const address = getAddress(facts.address);
  const [prevRaw, count] = await kv([
    ["GET", holderKey(address)],
    ["SCARD", HOLDERS_SET],
  ]);
  const prev = jsonOf<HolderRecord>(prevRaw);
  if (!prev && (!worthRecording(facts, current) || Number(count ?? 0) >= HOLDERS_MAX)) return null;
  const next: HolderRecord = {
    address,
    firstSeen: prev ? Math.min(prev.firstSeen, now) : now,
    lastSeen: prev ? Math.max(prev.lastSeen, now) : now,
    visits: (prev?.visits ?? 0) + 1,
    snapshot: facts.snapshot,
    current: current !== null ? current.toString() : prev?.current ?? null,
    currentAt: current !== null ? now : prev?.currentAt ?? null,
    eligible: facts.eligible,
    excluded: facts.excluded,
    signed: [...new Set([...(prev?.signed ?? []), ...facts.signed])].sort(),
  };
  await kv([
    ["SET", holderKey(address), JSON.stringify(next)],
    ["SADD", HOLDERS_SET, address.toLowerCase()],
  ]);
  return next;
}

/** Every connected wallet, most recently seen first. */
export async function listHolders(): Promise<HolderRecord[]> {
  const [members] = await kv([["SMEMBERS", HOLDERS_SET]]);
  const all = Array.isArray(members) ? members.map(String) : [];
  const out: HolderRecord[] = [];
  for (let i = 0; i < all.length; i += CHUNK) {
    const raws = await kv(all.slice(i, i + CHUNK).map((a) => ["GET", holderKey(a)]));
    for (const r of raws) {
      const h = jsonOf<HolderRecord>(r);
      if (h) out.push(h);
    }
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}

/** The admin export: one row per connected wallet. `voted` is the votes it has a ballot in now. */
export function holdersCsv(rows: (HolderRecord & { voted: string[] })[]): string {
  const cell = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : "");
  const header = ["wallet", "first_seen_utc", "last_seen_utc", "visits", "snapshot_gloam_wei", "current_gloam_wei", "current_read_utc", "eligible", "excluded", "voted"];
  const lines = rows.map((h) =>
    [h.address, iso(h.firstSeen), iso(h.lastSeen), String(h.visits), h.snapshot, h.current ?? "", iso(h.currentAt), h.eligible ? "yes" : "no", h.excluded ?? "", h.voted.join(" ")].map(cell),
  );
  return [header.map(cell), ...lines].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
