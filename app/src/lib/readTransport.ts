/**
 * The transport every read for a Gloam network goes through, in the browser
 * (wagmi, lib/rhClient, the transparency ledger) and on the server
 * (lib/serverRpc).
 *
 * The head side is the chain's public RPCs as one list (lib/rpcList): in
 * order, one that is down passed over for a while, a send to one RPC only with
 * `sendTo: "one"`, no log reads to an RPC in NO_LOG_RPCS and no sends to one in
 * NO_SEND_RPCS (a history RPC is in both: it trails the head). Where the first RPC
 * keeps only recent history (Ethereum Sepolia's publicnode, about 10,000
 * blocks), the network names a historyRpc, and logs, receipts and state older
 * than its `recentBlocks` are read there instead, through one plain `http`:
 * the vault tree rebuilt from the deploy block, a payment proof for an old
 * transfer. The rest, above all receipt waits and the reads right after a
 * transaction, stays on the head list. Every other network reads through the
 * list alone, as before.
 *
 * `opts.proxy` (browser only) adds gloam.trade's RPC proxy for the chain after
 * the head list (lib/rpcProxy): asked only when the public RPCs fail, for reads.
 *
 * A network with a `logCanary` (BNB Chain, whose public RPCs keep little
 * history and answer an empty list, or only the newer part of a range, for older
 * blocks) reads its logs through the SDK's guardPrunedLogs: a log answer about
 * old blocks is checked against the canary's logs on the RPC that gave it, and
 * when that RPC turns out to have dropped them (or fails) the read goes to
 * `opts.archive` (an RPC that keeps every log), else to the proxy, which reads
 * through the server's keyed RPC; with neither it fails loudly (PrunedLogsError)
 * instead of passing as "nothing happened". Log reads there never go on to the
 * proxy inside the list: the canary has to be answered by the RPC that answered
 * the read, so the proxy is asked through the check instead. Every other method
 * keeps the list with the proxy after it.
 *
 * The routing itself is the SDK's (splitReadTransport), so the app, the SDK
 * and the MCP split reads the same way. Both sides are this app's own viem
 * transports, never the SDK's copy, so errors keep the classes app code checks
 * (the relay's "may have been sent" test is `instanceof HttpRequestError`), and
 * the split keeps the head list's `methods`, which viem's fallback reads to
 * keep a raw send off a backup.
 */
import { guardPrunedLogs, splitReadTransport, type LogCanary } from "@gloamtrade/sdk";
import { http, type EIP1193RequestFn, type HttpTransportConfig, type Transport } from "viem";
import type { GloamNetwork } from "./networks";
import { rpcListTransport, type RpcListOptions } from "./rpcList";

export function readTransport(
  net: Pick<GloamNetwork, "chain" | "historyRpc"> & { logCanary?: LogCanary | null },
  config: HttpTransportConfig = {},
  opts: RpcListOptions & { archive?: string | null } = {}
): Transport {
  const { archive, ...listOpts } = opts;
  const build = (o: RpcListOptions): Transport => {
    const head = rpcListTransport(net.chain.rpcUrls.default.http, config, o);
    return !net.historyRpc
      ? head
      : splitReadTransport<Transport>({
          fresh: head,
          // one RPC, not the list: the head RPCs cannot serve these old blocks
          history: http(net.historyRpc.url, config),
          recentBlocks: net.historyRpc.recentBlocks,
        });
  };
  const read = build(listOpts);
  if (!net.logCanary) return read;
  const old = archive ?? listOpts.proxy ?? null;
  const logs = guardPrunedLogs<Transport>(listOpts.proxy ? build({ ...listOpts, proxy: null }) : read, net.logCanary, {
    archive: old ? http(old, config) : null,
    // the proxy used to come after the public RPCs in the list: it still answers when they fail
    archiveOnError: old !== null,
  });
  if (!listOpts.proxy) return logs;
  return (params) => {
    const l = logs(params);
    const r = read(params);
    const request = ((args, options) => (args.method === "eth_getLogs" ? l : r).request(args, options)) as EIP1193RequestFn;
    return { ...l, config: { ...l.config, request }, request } as ReturnType<Transport>;
  };
}

/**
 * How often a client looks for a new block on a chain, ms: receipt waits and
 * watched reads. Ethereum (mainnet and Sepolia) makes a block every 12 s, and an
 * Add privately waits on two receipts there (the approval, then the deposit),
 * so a new block is looked for every 2 s and a mined one is seen about 1 s
 * after it, at the median, instead of 2 s with viem's 4 s default. Chains not
 * listed keep the default (half the block time, at most 4 s).
 */
export const BLOCK_POLL_MS: Readonly<Record<number, number>> = { 1: 2_000, 11155111: 2_000 };
