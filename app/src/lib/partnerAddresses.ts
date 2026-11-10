/**
 * A partner's own receiving addresses, per mainnet, set by a Gloam admin only.
 * The on-chain match (lib/partnerBackfill) counts a past cash out to the
 * partner when it paid one of these. Server only.
 *
 * An address counts only once it is proven: the address signs an EIP-191 message
 * naming the partner, the chain and the date (addressMessage), and the signature
 * is checked on that chain (a contract wallet through ERC-1271). Until then it
 * waits, matches nothing and reserves nothing. A proven address belongs to one
 * partner, so a cash out can never be matched to two.
 *
 * Only the partner's own addresses are kept, with their signatures. Nothing about
 * who sent money to them.
 *
 * Storage (lib/partnersKv), under gloam:partners:v1:
 *   addrs:<partnerId>                 { [chainId]: { [address]: AddressEntry } } (JSON)
 *   addr-owner:<chainId>:<address>    partner id, for proven addresses only
 */
import { getAddress, isAddress, verifyMessage, zeroAddress, type Address, type Hex } from "viem";
import { jsonOf, k, kv, kv1, type KvCommand } from "./partnersKv";
import { getPartner, listPartners, PartnerError, utcDay, type Partner } from "./partners";
import { getNetwork, NETWORK_KEYS, networkName, type GloamNetwork } from "./networks";

/** Addresses one partner can list on one chain, and in all. */
export const MAX_ADDRESSES_PER_CHAIN = 2_000;
export const MAX_ADDRESSES_TOTAL = 5_000;

export type AddressEntry = {
  addedAt: number;
  /** The exact message this address signs (addressMessage), fixed when it was added. */
  message: string;
  verifiedAt: number | null;
  signature?: Hex;
};

export type AddressList = Record<string, Record<string, AddressEntry>>;

/** The mainnets with a vault: the only chains an address list is for. */
export function addressChains(): GloamNetwork[] {
  return NETWORK_KEYS.map(getNetwork).filter((n) => !n.testnet && n.pool && n.deployBlock != null);
}

/**
 * "robinhood-mainnet", "4663", "Robinhood Chain", "Tempo", "Base", "Ethereum": the
 * mainnet meant, by its key, chain id or name, or null. "robinhood" is the
 * testnet's key, not a mainnet's name, so it is refused rather than guessed.
 */
export function chainFromCell(raw: string): GloamNetwork | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  return (
    addressChains().find(
      (n) => n.key === v || String(n.chainId) === v || networkName(n).toLowerCase() === v || n.label.toLowerCase() === v
    ) ?? null
  );
}

/** What an address signs to prove it is the partner's. Plain text, EIP-191 (personal_sign). */
export function addressMessage(p: Pick<Partner, "id" | "name">, chainId: number, address: string, date: string): string {
  const net = addressChains().find((n) => n.chainId === chainId);
  return [
    "Gloam partner receiving address",
    "",
    "I control this address and it receives payments for the Gloam partner below.",
    "",
    `Partner: ${p.name} (${p.id})`,
    `Address: ${getAddress(address)}`,
    `Chain: ${net ? networkName(net) : chainId} (${chainId})`,
    `Date: ${date}`,
  ].join("\n");
}

export type ParsedAddresses = {
  entries: { chainId: number; address: string; signature?: Hex }[];
  /** Line number (from 1) and why it was left out. */
  rejected: { line: number; text: string; reason: string }[];
};

/**
 * Reads pasted text or a CSV: one address per line, as `address`, or
 * `chain,address` (or `address,chain`), with an optional signature (0x and 130
 * hex digits, or longer for a contract wallet) anywhere on the line; commas,
 * semicolons, tabs or spaces between. A line naming no chain is for
 * `fallbackChainId`. A header line, an empty line and a # comment are skipped.
 * Duplicates count once.
 */
export function parseAddressList(text: string, fallbackChainId: number | null): ParsedAddresses {
  const entries: ParsedAddresses["entries"] = [];
  const rejected: ParsedAddresses["rejected"] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const cells = line
      .split(/[,;\t]|\s{2,}|\s(?=0x)/i)
      .map((c) => c.trim().replace(/^"|"$/g, "").trim())
      .filter(Boolean);
    const isAddr = (c: string) => /^0x[0-9a-fA-F]{40}$/.test(c);
    const isSig = (c: string) => /^0x[0-9a-fA-F]{130,}$/.test(c);
    const addrCells = cells.filter(isAddr);
    const sigCells = cells.filter(isSig);
    const others = cells.filter((c) => !isAddr(c) && !isSig(c));
    if (addrCells.length === 0) {
      // a header ("chain,address") or anything with no address in it
      if (!/^(chain|network|address|wallet)/i.test(line)) rejected.push({ line: i + 1, text: line.slice(0, 80), reason: "No 0x address on this line." });
      return;
    }
    if (addrCells.length > 1 || sigCells.length > 1) {
      rejected.push({ line: i + 1, text: line.slice(0, 80), reason: "More than one address or signature on this line." });
      return;
    }
    const raw = addrCells[0]!;
    if (!isAddress(raw, { strict: false }) || raw.toLowerCase() === zeroAddress) {
      rejected.push({ line: i + 1, text: line.slice(0, 80), reason: "Not a valid address." });
      return;
    }
    // a mixed-case address must carry a correct checksum: a typo in one is caught here
    if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase().replace(/^0X/, "0x") && getAddress(raw) !== raw) {
      rejected.push({ line: i + 1, text: line.slice(0, 80), reason: "The address's checksum is wrong. Check it for a typo." });
      return;
    }
    let chainId = fallbackChainId;
    if (others.length) {
      const named = chainFromCell(others[0]!);
      if (!named) {
        rejected.push({ line: i + 1, text: line.slice(0, 80), reason: `"${others[0]!.slice(0, 30)}" is not a mainnet Gloam runs on.` });
        return;
      }
      chainId = named.chainId;
    }
    if (chainId == null || !addressChains().some((n) => n.chainId === chainId)) {
      rejected.push({ line: i + 1, text: line.slice(0, 80), reason: "No chain for this address. Pick one, or name it on the line." });
      return;
    }
    const key = `${chainId}:${raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ chainId, address: raw.toLowerCase(), ...(sigCells[0] ? { signature: sigCells[0] as Hex } : {}) });
  });
  return { entries, rejected };
}

export async function getPartnerAddresses(partnerId: string): Promise<AddressList> {
  return jsonOf<AddressList>(await kv1(["GET", k("addrs", partnerId)])) ?? {};
}

/** getPartnerAddresses for many partners, in the same order and one round trip. */
export async function getPartnerAddressesFor(partnerIds: string[]): Promise<AddressList[]> {
  const raw = await kv(partnerIds.map((id) => ["GET", k("addrs", id)] as KvCommand));
  return partnerIds.map((_, i) => jsonOf<AddressList>(raw[i]) ?? {});
}

export function countAddresses(list: AddressList): { total: number; verified: number } {
  let total = 0;
  let verified = 0;
  for (const byAddr of Object.values(list)) {
    for (const e of Object.values(byAddr)) {
      total++;
      if (e.verifiedAt) verified++;
    }
  }
  return { total, verified };
}

/**
 * Adds addresses to a partner's list (mode "add") or replaces the list ("replace").
 * New ones wait for their signature; ones already on the list keep their state.
 * Anything dropped by a replace stops counting at once. Refuses (changing nothing)
 * over the limits.
 */
export async function setPartnerAddresses(
  partnerId: string,
  entries: { chainId: number; address: string }[],
  mode: "add" | "replace",
  now = Date.now()
): Promise<AddressList> {
  const partner = await getPartner(partnerId);
  if (!partner) throw new PartnerError("No partner with that id.", 404, "not_found");
  const prev = await getPartnerAddresses(partnerId);
  const next: AddressList = mode === "add" ? structuredClone(prev) : {};
  const date = utcDay(now);
  for (const e of entries) {
    const chain = String(e.chainId);
    const a = e.address.toLowerCase();
    const byAddr = (next[chain] ??= {});
    byAddr[a] = prev[chain]?.[a] ?? { addedAt: now, message: addressMessage(partner, e.chainId, a, date), verifiedAt: null };
  }
  for (const [chain, byAddr] of Object.entries(next)) {
    if (Object.keys(byAddr).length > MAX_ADDRESSES_PER_CHAIN) {
      throw new PartnerError(`At most ${MAX_ADDRESSES_PER_CHAIN} addresses per chain.`, 400, "too_many_addresses");
    }
    if (Object.keys(byAddr).length === 0) delete next[chain];
  }
  if (countAddresses(next).total > MAX_ADDRESSES_TOTAL) throw new PartnerError(`At most ${MAX_ADDRESSES_TOTAL} addresses in all.`, 400, "too_many_addresses");

  const cmds: KvCommand[] = [];
  // a proven address dropped from the list stops counting
  for (const [chain, byAddr] of Object.entries(prev)) {
    for (const [a, e] of Object.entries(byAddr)) if (e.verifiedAt && !next[chain]?.[a]) cmds.push(["DEL", k("addr-owner", chain, a)]);
  }
  cmds.push(Object.keys(next).length ? ["SET", k("addrs", partnerId), JSON.stringify(next)] : ["DEL", k("addrs", partnerId)]);
  await kv(cmds);
  return next;
}

/** Checks a signature: an EOA's from the signature alone, a contract wallet's on its chain (ERC-1271). */
export type SignatureCheck = (net: GloamNetwork, address: Address, message: string, signature: Hex) => Promise<boolean>;

export const checkSignatureOnChain: SignatureCheck = async (net, address, message, signature) => {
  // an EOA's signature needs no chain read; a contract wallet's does
  if (await verifyMessage({ address, message, signature }).catch(() => false)) return true;
  const { relayPublicClient } = await import("./relay/server");
  return relayPublicClient(net)
    .verifyMessage({ address, message, signature })
    .catch(() => false);
};

export type VerifyResult = { chainId: number; address: string; ok: boolean; reason?: string };

/**
 * Proves addresses on a partner's list with their signatures. A proven address is
 * the partner's from then on, unless another partner proved it first.
 */
export async function verifyPartnerAddresses(
  partnerId: string,
  signed: { chainId: number; address: string; signature?: Hex }[],
  check: SignatureCheck = checkSignatureOnChain,
  now = Date.now()
): Promise<{ results: VerifyResult[]; addresses: AddressList }> {
  const list = await getPartnerAddresses(partnerId);
  const results: VerifyResult[] = [];
  for (const s of signed) {
    const chain = String(s.chainId);
    const a = s.address.toLowerCase();
    const e = list[chain]?.[a];
    const net = addressChains().find((n) => n.chainId === s.chainId);
    if (!e || !net) {
      results.push({ chainId: s.chainId, address: a, ok: false, reason: "Not on this partner's list. Add it first." });
      continue;
    }
    if (!s.signature) {
      results.push({ chainId: s.chainId, address: a, ok: false, reason: "No signature on this line." });
      continue;
    }
    if (!(await check(net, getAddress(a), e.message, s.signature))) {
      results.push({ chainId: s.chainId, address: a, ok: false, reason: "The signature does not match this address and its message." });
      continue;
    }
    const [own] = await kv([["SET", k("addr-owner", chain, a), partnerId, "NX"]]);
    if (own !== "OK" && (await kv1(["GET", k("addr-owner", chain, a)])) !== partnerId) {
      results.push({ chainId: s.chainId, address: a, ok: false, reason: "Another partner already proved this address." });
      continue;
    }
    list[chain]![a] = { ...e, verifiedAt: e.verifiedAt ?? now, signature: s.signature };
    results.push({ chainId: s.chainId, address: a, ok: true });
  }
  await kv1(["SET", k("addrs", partnerId), JSON.stringify(list)]);
  return { results, addresses: list };
}

/** The partner a proven address belongs to, or null. */
export async function addressOwner(chainId: number, address: string): Promise<string | null> {
  const v = await kv1(["GET", k("addr-owner", chainId, address.toLowerCase())]);
  return typeof v === "string" ? v : null;
}

/** Every partner's proven addresses: chainId to (lowercase address to partner id). For the on-chain match. */
export async function addressBook(): Promise<Map<number, Map<string, string>>> {
  const partners = await listPartners();
  const book = new Map<number, Map<string, string>>();
  if (!partners.length) return book;
  const lists = await kv(partners.map((p) => ["GET", k("addrs", p.id)] as KvCommand));
  partners.forEach((p, i) => {
    const list = jsonOf<AddressList>(lists[i]) ?? {};
    for (const [chain, byAddr] of Object.entries(list)) {
      const m = book.get(Number(chain)) ?? new Map<string, string>();
      for (const [a, e] of Object.entries(byAddr)) if (e.verifiedAt && !m.has(a)) m.set(a.toLowerCase(), p.id);
      book.set(Number(chain), m);
    }
  });
  return book;
}
