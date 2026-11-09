/**
 * The on-chain match: cash outs that paid one of a partner's own proven
 * receiving addresses (lib/partnerAddresses), counted to that partner with
 * source "chain". Admin-started, server side, read-only on chain. Server only.
 *
 * On every mainnet with a vault it reads the vault's Unshielded logs from the
 * vault's deploy block (lib/networks, the same blocks as contracts/deployments)
 * up to the chain's head, one address and one topic per query (Robinhood Chain's
 * RPC allows no more over a wide range), in spans each chain's RPC accepts; a
 * span the node calls too wide is halved (lib/logRange). For each cash out:
 *  - it paid a partner's proven address: the receipt is read and checked like a
 *    link's (lib/partnerVerify: one plain cash out) and the cash out is counted to
 *    that partner with the vault fee from its WithdrawFee log and the block's time.
 *    One a link counted to another partner is moved to the address's partner: an
 *    address match overrides a link. One counted with an API key stays.
 *  - it was bound to a partner's link (by the relay that sent it, or by the
 *    payer's wallet registration) and nobody counted it yet: it is counted to that
 *    link's partner (lib/partnerAttribution settleLinkTx).
 * A transaction counts once (the claim in lib/partners).
 *
 * What it can't find, said plainly in the dashboards:
 *  - private payments: inside the vault the payee and the amount are hidden, so
 *    there is nothing to match a partner's address against;
 *  - private swaps: a swap's note goes out to a one-time escrow and its output comes
 *    back into the vault as a new note, so no swap on the live routers pays a public
 *    address. Only the next router's exit (VaultSwapExit) could, and it is not
 *    deployed: nothing to read yet.
 *
 * Nothing about who sent the money is read into storage: not the transaction's
 * sender, not the relay, not the paying wallet.
 *
 * A pass stops starting new spans when its time budget runs out; each chain's
 * cursor (backfill:cursor:<chainId>) keeps where it got to, and the next pass picks
 * up there. A span where a receipt could not be read is not passed: the cursor
 * stays before it. A dry run reads the same and writes nothing.
 */
import { createHash } from "crypto";
import type { Address, Hex } from "viem";
import { getLogsSafe } from "./logRange";
import { k, kv, kv1, type KvCommand } from "./partnersKv";
import { assetInfo, attributedTo, countedRecord, getPartner, recordActivity, reverseActivity, type Partner } from "./partners";
import { addressChains } from "./partnerAddresses";
import { VAULT_EVENTS } from "./partnerVerify";
import { linkNullifierHash } from "./partnerCode";
import { classify, settleLinkTx, type AttributionReceipt } from "./partnerAttribution";
import { relayPublicClient } from "./relay/server";
import type { GloamNetwork, NetworkKey } from "./networks";

/** First span per query; a range error halves it. Robinhood Chain takes wide spans for one address and one topic. */
export const BACKFILL_SPAN: Record<number, bigint> = { 4663: 5_000_000n };

export function spanFor(net: GloamNetwork): bigint {
  return BACKFILL_SPAN[net.chainId] ?? net.logRange;
}

export type UnshieldLog = { txHash: Hex; blockNumber: bigint; nullifier: Hex; asset: Address; to: Address; amount: bigint };

export type BackfillDeps = {
  head: (net: GloamNetwork) => Promise<bigint>;
  /** The vault's Unshielded logs in [from, to]: one address, one topic. */
  unshielded: (net: GloamNetwork, from: bigint, to: bigint) => Promise<UnshieldLog[]>;
  receipt: (net: GloamNetwork, hash: Hex) => Promise<AttributionReceipt | null>;
  blockTime: (net: GloamNetwork, block: bigint) => Promise<number>;
  partner: (id: string) => Promise<Partner | null>;
  record: typeof recordActivity;
  attributed: typeof attributedTo;
  counted: typeof countedRecord;
  reverse: typeof reverseActivity;
  /** Which of these cash outs were bound to a partner's link: the relay's binding of the transaction, or a wallet registration of the spend. */
  registered: (chainId: number, logs: { txHash: Hex; nullifier: Hex }[]) => Promise<boolean[]>;
  /** Counts a registered transaction to its link (lib/partnerAttribution settleLinkTx). */
  settle: (net: GloamNetwork, hash: Hex) => Promise<void>;
  readCursor: (chainId: number) => Promise<bigint | null>;
  writeCursor: (chainId: number, block: bigint) => Promise<void>;
  now: () => number;
};

const UNSHIELDED = VAULT_EVENTS[2];

export const backfillDeps: BackfillDeps = {
  head: (net) => relayPublicClient(net).getBlockNumber({ cacheTime: 0 }),
  unshielded: async (net, from, to) => {
    const c = relayPublicClient(net);
    const read = (x: bigint, y: bigint) => getLogsSafe((a, b) => c.getLogs({ address: net.pool!, event: UNSHIELDED, fromBlock: a, toBlock: b }), x, y);
    let logs: Awaited<ReturnType<typeof read>>;
    try {
      logs = await read(from, to);
    } catch (e) {
      // Some nodes refuse a span with a generic error ("Invalid parameters") rather than a range error: halve it once.
      if (to - from < 1_000n) throw e;
      const mid = from + (to - from) / 2n;
      logs = [...(await read(from, mid)), ...(await read(mid + 1n, to))];
    }
    return logs.map((l) => ({
      txHash: l.transactionHash!,
      blockNumber: l.blockNumber!,
      nullifier: l.args.nullifier!,
      asset: l.args.asset!,
      to: l.args.to!,
      amount: l.args.amount!,
    }));
  },
  receipt: async (net, hash) => {
    const r = await relayPublicClient(net)
      .getTransactionReceipt({ hash })
      .catch(() => null);
    return r ? { status: r.status, blockNumber: r.blockNumber, logs: r.logs } : null;
  },
  blockTime: async (net, block) => Number((await relayPublicClient(net).getBlock({ blockNumber: block })).timestamp),
  partner: getPartner,
  record: recordActivity,
  attributed: attributedTo,
  counted: countedRecord,
  reverse: reverseActivity,
  registered: async (chainId, logs) => {
    if (!logs.length) return [];
    const res = await kv(
      logs.flatMap((l) => [
        ["EXISTS", k("relaytx", chainId, l.txHash.toLowerCase())],
        ["EXISTS", k("reg", chainId, linkNullifierHash(l.nullifier).toLowerCase())],
        // a payment of this note the relay bound just before sending (kept an hour if its after-send step never ran)
        ["EXISTS", k("relayspendnf", chainId, linkNullifierHash(l.nullifier).toLowerCase())],
      ] as KvCommand[])
    );
    return logs.map((_, i) => [0, 1, 2].some((j) => Number(res[3 * i + j]) > 0));
  },
  settle: async (net, hash) => {
    await settleLinkTx({ chainId: net.chainId, txHash: hash });
  },
  readCursor: async (chainId) => {
    const v = await kv1(["GET", k("backfill", "cursor", chainId)]);
    return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null;
  },
  writeCursor: async (chainId, block) => {
    await kv1(["SET", k("backfill", "cursor", chainId), block.toString()]);
  },
  now: () => Date.now(),
};

export type BackfillResultKind =
  | "recorded"
  | "would_record"
  | "moved"
  | "would_move"
  | "settled"
  | "would_settle"
  | "already_counted"
  | "refused";

export type BackfillMatch = {
  partnerId: string;
  /** "chain": it paid this partner's proven address; "link": registered from this partner's link. */
  via: "chain" | "link";
  /** The partner's own proven address it paid (via "chain"); never the sender. */
  address?: string;
  network: NetworkKey;
  chainId: number;
  txHash: Hex;
  kind: "cash_out";
  asset: Address;
  symbol: string | null;
  /** Smallest units. */
  amount: string;
  /** The vault's fee, smallest units. */
  vaultFee: string;
  /** Block time, ms (0 when not read). */
  ts: number;
  result: BackfillResultKind;
  /** The partner a link had counted it to, for a move. */
  from?: string;
  /** Why a matched log was not counted. */
  reason?: string;
};

export type ChainScan = {
  network: NetworkKey;
  chainId: number;
  from: string;
  to: string;
  /** The last block read; `to` when `done`. */
  scannedTo: string;
  done: boolean;
  queries: number;
  logs: number;
  matches: number;
  ms: number;
  error?: string;
};

/** Per proven address: what the pass found paying it. */
export type AddressSummary = { partnerId: string; chainId: number; address: string; matches: number; counted: number; byToken: Record<string, string> };

export type BackfillResult = {
  dryRun: boolean;
  from: "deploy" | "cursor";
  ms: number;
  addresses: number;
  /** Fingerprint of the proven addresses this pass used (a real pass needs a dry run of the same). */
  book: string;
  chains: ChainScan[];
  matches: BackfillMatch[];
  byAddress: AddressSummary[];
  /** Why swaps are not matched, in a sentence. */
  swaps: string;
  /** Why private payments are not matched, in a sentence. */
  privatePayments: string;
};

export const SWAPS_NOT_MATCHED =
  "Swaps are not matched: a swap's note goes to a one-time escrow and its output comes back into the vault as a private note, so no swap on the live routers pays a public address.";
export const PRIVATE_PAYMENTS_NOT_MATCHED =
  "Past private payments can't be matched: inside the vault the payee and the amount are hidden. Only cash outs that paid a partner's public address can be.";

/** A stable fingerprint of an address book, so a real pass can be tied to the dry run that showed it. */
export function bookFingerprint(book: Map<number, Map<string, string>>): string {
  const lines = [...book.entries()].flatMap(([chain, m]) => [...m.entries()].map(([a, p]) => `${chain}:${a}:${p}`)).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

/** A receipt that could not be read: the span is not passed, so the next pass reads it again. */
class ReceiptUnread extends Error {}

/**
 * One pass over every mainnet (or `chains`). `book`: chainId to (lowercase
 * address to partner id), proven addresses only. Stops starting new spans after `budgetMs`.
 */
export async function runBackfill(
  opts: { dryRun: boolean; from: "deploy" | "cursor"; book: Map<number, Map<string, string>>; budgetMs: number; chains?: number[] },
  deps: BackfillDeps = backfillDeps
): Promise<BackfillResult> {
  const started = deps.now();
  const deadline = started + opts.budgetMs;
  const nets = addressChains().filter((n) => !opts.chains || opts.chains.includes(n.chainId));
  const matches: BackfillMatch[] = [];
  const addresses = [...opts.book.values()].reduce((s, m) => s + m.size, 0);

  const chains = await Promise.all(
    nets.map(async (net): Promise<ChainScan> => {
      const t0 = deps.now();
      const scan: ChainScan = { network: net.key, chainId: net.chainId, from: "", to: "", scannedTo: "", done: false, queries: 0, logs: 0, matches: 0, ms: 0 };
      try {
        const deploy = net.deployBlock!;
        const cursor = opts.from === "cursor" ? await deps.readCursor(net.chainId) : null;
        const from = cursor != null && cursor >= deploy ? cursor + 1n : deploy;
        const head = await deps.head(net);
        scan.from = from.toString();
        scan.to = head.toString();
        scan.scannedTo = (from - 1n).toString();
        const mine = opts.book.get(net.chainId) ?? new Map<string, string>();
        const span = spanFor(net);
        for (let a = from; a <= head; a += span) {
          if (deps.now() > deadline) break;
          const b = a + span - 1n > head ? head : a + span - 1n;
          const logs = await deps.unshielded(net, a, b);
          scan.queries++;
          scan.logs += logs.length;
          const others = logs.filter((l) => !mine.has(l.to.toLowerCase()));
          const reg = await deps.registered(net.chainId, others.map((l) => ({ txHash: l.txHash, nullifier: l.nullifier })));
          const linked = new Set(others.filter((_, i) => reg[i]).map((l) => l.txHash.toLowerCase()));
          for (const log of logs) {
            const partnerId = mine.get(log.to.toLowerCase());
            if (partnerId) {
              scan.matches++;
              matches.push(await matchAddress(net, log, partnerId, opts.dryRun, deps));
            } else if (linked.has(log.txHash.toLowerCase())) {
              matches.push(await settleRegistered(net, log, opts.dryRun, deps));
            }
          }
          // every receipt of this span was read: it is passed
          scan.scannedTo = b.toString();
          if (!opts.dryRun) await deps.writeCursor(net.chainId, b);
        }
        scan.done = BigInt(scan.scannedTo) >= head;
      } catch (e) {
        scan.error =
          e instanceof ReceiptUnread
            ? "A receipt could not be read. The cursor stays before it; run again to carry on."
            : e instanceof Error
              ? e.message.split("\n")[0]!.slice(0, 200)
              : "read failed";
      }
      scan.ms = deps.now() - t0;
      return scan;
    })
  );
  matches.sort((x, y) => y.ts - x.ts);

  const byAddress = new Map<string, AddressSummary & { raw: Record<string, { amount: bigint; decimals: number }> }>();
  for (const m of matches) {
    if (m.via !== "chain" || !m.address) continue;
    const key = `${m.chainId}:${m.address}`;
    const s = byAddress.get(key) ?? { partnerId: m.partnerId, chainId: m.chainId, address: m.address, matches: 0, counted: 0, byToken: {}, raw: {} };
    s.matches++;
    if (["recorded", "would_record", "moved", "would_move"].includes(m.result)) {
      s.counted++;
      const net = nets.find((n) => n.chainId === m.chainId)!;
      const sym = m.symbol ?? m.asset;
      const prev = s.raw[sym] ?? { amount: 0n, decimals: assetInfo(net, m.asset)?.decimals ?? 18 };
      s.raw[sym] = { ...prev, amount: prev.amount + BigInt(m.amount) };
    }
    byAddress.set(key, s);
  }
  const summaries: AddressSummary[] = [...byAddress.values()].map(({ raw, ...s }) => ({
    ...s,
    byToken: Object.fromEntries(Object.entries(raw).map(([sym, r]) => [sym, wholeTokens(r.amount, r.decimals)])),
  }));

  return {
    dryRun: opts.dryRun,
    from: opts.from,
    ms: deps.now() - started,
    addresses,
    book: bookFingerprint(opts.book),
    chains,
    matches,
    byAddress: summaries,
    swaps: SWAPS_NOT_MATCHED,
    privatePayments: PRIVATE_PAYMENTS_NOT_MATCHED,
  };
}

function wholeTokens(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

function baseOf(net: GloamNetwork, log: UnshieldLog, partnerId: string, via: "chain" | "link"): BackfillMatch {
  return {
    partnerId,
    via,
    ...(via === "chain" ? { address: log.to.toLowerCase() } : {}),
    network: net.key,
    chainId: net.chainId,
    txHash: log.txHash.toLowerCase() as Hex,
    kind: "cash_out",
    asset: log.asset,
    symbol: assetInfo(net, log.asset)?.symbol ?? null,
    amount: log.amount.toString(),
    vaultFee: "0",
    ts: 0,
    result: "refused",
  };
}

async function matchAddress(net: GloamNetwork, log: UnshieldLog, partnerId: string, dryRun: boolean, deps: BackfillDeps): Promise<BackfillMatch> {
  const base = baseOf(net, log, partnerId, "chain");
  const counted = await deps.counted(net.chainId, base.txHash);
  // counted to this partner already, or with a key (the key's partner sent it): left as it is
  if (counted && (counted.partnerId === partnerId || counted.record.source !== "link")) return { ...base, result: "already_counted" };
  if (!counted && (await deps.attributed(net.chainId, base.txHash))) return { ...base, result: "already_counted", reason: "Claimed as a refund or an exit." };
  const receipt = await deps.receipt(net, base.txHash);
  if (!receipt) throw new ReceiptUnread();
  if (receipt.status !== "success") return { ...base, reason: "The transaction failed." };
  const facts = classify(net, receipt.logs);
  // the receipt must be the one cash out the log came from, nothing packed beside it
  if (!facts.ok || facts.kind !== "cash_out" || facts.asset.toLowerCase() !== log.asset.toLowerCase() || facts.amount !== log.amount) {
    return { ...base, reason: "Not a plain cash out." };
  }
  const ts = (await deps.blockTime(net, receipt.blockNumber)) * 1000;
  const found = { ...base, vaultFee: facts.vaultFee.toString(), ts, ...(counted ? { from: counted.partnerId } : {}) };
  if (dryRun) return { ...found, result: counted ? "would_move" : "would_record" };
  const partner = await deps.partner(partnerId);
  if (!partner) return { ...found, reason: "The partner account is gone." };
  // an address match overrides a link: take it back from the link's partner first
  if (counted) await deps.reverse(net.chainId, base.txHash);
  const r = await deps.record({
    partner,
    keyId: null,
    source: "chain",
    network: net,
    kind: "cash_out",
    txHash: base.txHash,
    edge: { asset: log.asset, amount: log.amount },
    vaultFee: facts.vaultFee,
    now: ts,
  });
  return { ...found, result: r.recorded ? (counted ? "moved" : "recorded") : "already_counted" };
}

async function settleRegistered(net: GloamNetwork, log: UnshieldLog, dryRun: boolean, deps: BackfillDeps): Promise<BackfillMatch> {
  const base = baseOf(net, log, "", "link");
  if (await deps.attributed(net.chainId, base.txHash)) return { ...base, result: "already_counted" };
  if (dryRun) return { ...base, result: "would_settle" };
  try {
    await deps.settle(net, base.txHash);
    const c = await deps.counted(net.chainId, base.txHash);
    return { ...base, partnerId: c?.partnerId ?? "", ts: c?.record.ts ?? 0, vaultFee: c?.record.vaultFee ?? "0", result: "settled" };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "tx_not_found" || code === "rpc") throw new ReceiptUnread();
    return { ...base, result: code === "already_attributed" ? "already_counted" : "refused", reason: e instanceof Error ? e.message : undefined };
  }
}
