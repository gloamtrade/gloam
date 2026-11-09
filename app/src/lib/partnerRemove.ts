/**
 * Admin only: removes a partner account, for clearing out test accounts and ones
 * that should not be in the program. Server only.
 *
 * What removing does, in this order:
 *  1. Marks the account removed (removed:<id>). From that write on, getPartner
 *     reads it as no account, so every API key of it is refused by the v1 API and
 *     the relay, and none of its link codes counts, before anything else is done.
 *  2. Revokes every API key it holds, so the keys are unknown even to a lookup.
 *  3. Revokes every live link code, so links with them stop counting.
 *  4. Drops its receiving addresses, proven ones included, so the on-chain match
 *     no longer counts cash outs to them for it, and another account can prove them.
 *  5. Takes back the relay approval and the name in links.
 *  6. Takes it off the admin list and out of the program's totals, and frees its
 *     wallet: signing in with it shows that the account was removed, and the
 *     wallet can make a new account, which starts with nothing (no keys, codes,
 *     addresses or approvals).
 *
 * Past activity is kept, not deleted: its counters, its activity list and its claims
 * on transactions stay under the old id, marked by removed:<id>. Totals are summed
 * over the listed accounts only, so none of it counts anywhere once the account is
 * off the list, and a transaction it was counted for can't be counted again for
 * another account (first claim wins), except by the on-chain match, which moves a
 * link's count to the owner of a proven address as it does for any account.
 *
 * Safe to run again: an account marked removed but not finished (a store error
 * partway) is finished by the next call.
 */
import { listApiKeys, revokeApiKey } from "./apiKeys";
import { getPartnerAddresses } from "./partnerAddresses";
import { linkCodeState, listLinkCodes, revokeLinkCode } from "./partnerLinks";
import { isPartnerId, type Partner } from "./partners";
import { jsonOf, k, kv, kv1, type KvCommand } from "./partnersKv";

/** How long the portal notice for a removed account's wallet is kept. */
const NOTICE_TTL_SEC = 365 * 86_400;

export type RemovedPartner = {
  id: string;
  owner: string;
  name: string;
  createdAt: number | null;
  removedAt: number;
};

export type RemoveResult = RemovedPartner & {
  keysRevoked: number;
  codesRevoked: number;
  addressesDropped: number;
};

/** The removal mark of an account, or null. */
export async function removedPartner(id: string): Promise<RemovedPartner | null> {
  if (!isPartnerId(id)) return null;
  return jsonOf<RemovedPartner>(await kv1(["GET", k("removed", id)]));
}

/** Removes the account (see the top of this file). Null when there is no such account, removed or not. */
export async function removePartner(id: string, now = Date.now()): Promise<RemoveResult | null> {
  if (!isPartnerId(id)) return null;
  const [raw, mark] = await kv([
    ["GET", k("partner", id)],
    ["GET", k("removed", id)],
  ]);
  const record = jsonOf<Partner>(raw);
  const earlier = jsonOf<RemovedPartner>(mark);
  if (!record && !earlier) return null;

  // 1. the mark first: from here on the account reads as gone everywhere
  const removed: RemovedPartner = earlier ?? {
    id,
    owner: record!.owner.toLowerCase(),
    name: record!.name,
    createdAt: record!.createdAt ?? null,
    removedAt: now,
  };
  if (!earlier) await kv1(["SET", k("removed", id), JSON.stringify(removed)]);

  // 2. every key that is still active
  let keysRevoked = 0;
  for (const key of await listApiKeys(id)) {
    if (key.revokedAt !== null) continue;
    await revokeApiKey({ partnerId: id, keyId: key.id });
    keysRevoked++;
  }

  // 3. every live link code
  let codesRevoked = 0;
  for (const c of await listLinkCodes(id, now)) {
    if (linkCodeState(c, now) !== "live") continue;
    await revokeLinkCode({ code: c.code, partnerId: id, now });
    codesRevoked++;
  }

  // 4. receiving addresses: a proven one is freed only if this account still holds it
  const addresses = await getPartnerAddresses(id);
  const proven = Object.entries(addresses).flatMap(([chain, byAddr]) =>
    Object.entries(byAddr)
      .filter(([, e]) => e.verifiedAt)
      .map(([a]) => k("addr-owner", chain, a))
  );
  const holders = proven.length ? await kv(proven.map((key) => ["GET", key] as KvCommand)) : [];
  const addressesDropped = Object.values(addresses).reduce((n, byAddr) => n + Object.keys(byAddr).length, 0);

  // 5 and 6. approvals, the list, the wallet; the record goes last
  const owner = removed.owner;
  const ownerClaim = await kv1(["GET", k("owner", owner)]);
  const cmds: KvCommand[] = [
    ...proven.filter((_, i) => holders[i] === id).map((key) => ["DEL", key] as KvCommand),
    ["DEL", k("addrs", id)],
    ["DEL", k("relay-approved", id)],
    ["DEL", k("name-ok", id)],
    ["SREM", k("partners"), id],
    ["SET", k("removed-owner", owner), JSON.stringify({ id, name: removed.name, removedAt: removed.removedAt }), "EX", NOTICE_TTL_SEC],
  ];
  // the wallet's claim, unless it already made a new account
  if (ownerClaim === id) cmds.push(["DEL", k("owner", owner)]);
  cmds.push(["DEL", k("partner", id)]);
  await kv(cmds);

  return { ...removed, keysRevoked, codesRevoked, addressesDropped };
}
