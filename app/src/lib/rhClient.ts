/**
 * Dedicated public client for the active Gloam network's pool reads.
 * Does NOT depend on the wallet connection or wagmi chain selection, so the
 * browser can always read the vault even when the wallet is on another network.
 * Resolves the active network (Robinhood today, Tempo once selectable) and
 * caches one client per chain.
 */

import { guardPrunedLogs } from "@gloamtrade/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { BNB_BROWSER_ARCHIVE_RPC, isBnbChainId } from "./bnb";
import { getActiveNetwork, type GloamNetwork } from "./networks";
import { readTransport } from "./readTransport";
import { rpcProxyUrl } from "./rpcProxy";

const cache = new Map<number, PublicClient>();

/**
 * Where a network's old logs come from when its public RPCs dropped them: only
 * a network with a logCanary (BNB Chain, whose public RPCs keep about a day of
 * logs) has one. NEXT_PUBLIC_BNB_ARCHIVE_RPC_URL when set, and gloam.trade's
 * proxy in the browser (null on the server, which reads its own RPC instead).
 * Without these the pruned-logs check had nowhere to send an old read and threw,
 * so every walk from a deploy block more than a day back failed: in a fresh
 * browser no payment to a Gloam address on BNB Chain ever landed.
 */
export function archiveOptionsFor(net: { chainId: number; logCanary?: unknown }): { proxy: string | null; archive: string | null } {
  if (!net.logCanary) return { proxy: null, archive: null };
  return { proxy: rpcProxyUrl(net.chainId), archive: isBnbChainId(net.chainId) ? BNB_BROWSER_ARCHIVE_RPC : null };
}

/**
 * The read client for one network. Work that spans several reads (a sync, a
 * claim, a payroll run) takes its network once and reads through this, so a
 * network switch halfway through can't send the rest of its reads to another
 * chain: several vaults share one address, and a read there answers for the
 * wrong chain without failing.
 */
export function publicClientFor(net: Pick<GloamNetwork, "chainId" | "chain" | "historyRpc" | "logCanary">): PublicClient {
  const existing = cache.get(net.chainId);
  if (existing) return existing;
  const client = createPublicClient({
    chain: net.chain,
    // the chain's public RPCs in order, one that is down passed over for a while
    // (lib/rpcList); old logs and state from the network's history RPC (lib/readTransport);
    // on BNB Chain, logs older than its public RPCs keep from the archive or the proxy
    transport: readTransport(
      net,
      {
        timeout: 25_000,
        retryCount: 2,
      },
      archiveOptionsFor(net)
    ),
    // reads made together (spent checks, balances) go out as one Multicall3 call
    batch: { multicall: true },
  });
  cache.set(net.chainId, client);
  return client;
}

const archiveCache = new Map<number, PublicClient>();

/**
 * A client that reads logs from the network's archive alone (the archive RPC,
 * else gloam.trade's proxy), for blocks its public RPCs no longer keep. Null
 * for a network without a logCanary, and on the server. Its answers still go
 * through the pruned-logs check, against its own canary, so an archive that
 * dropped logs fails loudly too.
 *
 * Why: through publicClientFor, every old range is asked of publicnode first,
 * then the canary, then the proxy, and the proxy takes 10,000 (at times 5,000)
 * blocks a read, so each split asks publicnode again. A fresh browser's walk
 * of BNB Chain's payment board from its deploy block (850,000 blocks on 23 Nov)
 * took 860 s that way; asked of the proxy directly it is about a third of the reads.
 */
export function archiveLogClientFor(net: Pick<GloamNetwork, "chainId" | "chain" | "logCanary">): PublicClient | null {
  if (!net.logCanary) return null;
  const existing = archiveCache.get(net.chainId);
  if (existing) return existing;
  const { proxy, archive } = archiveOptionsFor(net);
  const url = archive ?? proxy;
  if (!url) return null;
  const client = createPublicClient({
    chain: net.chain,
    transport: guardPrunedLogs(http(url, { timeout: 25_000, retryCount: 2 }), net.logCanary),
  });
  archiveCache.set(net.chainId, client);
  return client;
}

export function getRhPublicClient(): PublicClient {
  return publicClientFor(getActiveNetwork());
}
