/**
 * The RPC the server uses for a chain. Server reads and relay sends all leave
 * from Vercel's shared IPs, so under load a chain's public RPC starts answering
 * 429. Set GLOAM_RPC_URL_<chainId> (server env only, never NEXT_PUBLIC_) to a
 * private endpoint and the server uses it first, with the public RPC behind it.
 * Without it, the public RPC alone, as before.
 *
 * A private RPC is used only once it answers eth_chainId with its own chain.
 * The vault has the same address on every chain, so a node for another chain
 * (a Base Sepolia URL pasted under Base mainnet's id, say) would answer every
 * vault read with that chain's state, and the answers would look real. One
 * that answers for another chain is never used: reads go to the public RPC,
 * and a send is refused before it reaches any node (WrongChainRpcError). One
 * that has not answered yet (down, slow, timed out) is passed over for a
 * while: reads and the relay's send go to the public RPC instead, so a private
 * RPC that is down never takes the server or the relay down with it. So is
 * one that passed the check and later hangs or fails (a timeout, a 5xx, a
 * rate limit): that call fails as before (a send of it is maybe_sent, never
 * sent again elsewhere), and the next ones go to the public RPC until the
 * private one is checked again.
 *
 * The public side is the chain's whole list of public RPCs, in order
 * (lib/rpcList): one that is down is passed over for a while, and a send
 * still goes to exactly one node.
 *
 * A network with a `logCanary` (BNB Chain) is read through the SDK's
 * guardPrunedLogs around all of it: its public RPCs keep about a day of logs
 * and answer an empty list for older blocks, so an empty answer about old blocks
 * is checked against the canary's logs, and a pruned one (the public RPC, or a
 * GLOAM_RPC_URL_56 that is not an archive plan) fails loudly, never as "no events".
 */
import { fallback, http, type HttpTransportConfig, type Transport } from "viem";
import { guardPrunedLogs, type LogCanary } from "@gloamtrade/sdk";
import type { GloamNetwork } from "./networks";
import { SEND_METHODS, nodeFailed, resetRpcRest, rpcListTransport } from "./rpcList";
import { readTransport } from "./readTransport";

type Net = Pick<GloamNetwork, "chainId" | "chain" | "historyRpc"> & { logCanary?: LogCanary | null };

function privateRpc(net: Net): string | null {
  return process.env[`GLOAM_RPC_URL_${net.chainId}`]?.trim() || null;
}

/** The private RPC set for this chain answers for another chain. Nothing was sent. */
export class WrongChainRpcError extends Error {
  constructor(readonly chainId: number) {
    super(`The private RPC set for chain ${chainId} answers for another chain, so it is not used.`);
    this.name = "WrongChainRpcError";
  }
}

/**
 * The private RPC set for this chain has not said which chain it serves yet
 * (down, slow, timed out), so this call goes to the public RPC. Nothing was
 * sent to it. Not a WrongChainRpcError: the relay never reads it as "off".
 */
export class UncheckedRpcError extends Error {
  constructor(readonly chainId: number) {
    super(`The private RPC set for chain ${chainId} has not said which chain it serves yet, so it is not used.`);
    this.name = "UncheckedRpcError";
  }
}

/** The longest the chain id check waits. A healthy node answers eth_chainId from memory. */
const CHECK_TIMEOUT_MS = 5_000;
/** After a check with no answer, the private RPC is passed over this long before it is asked again. */
const RECHECK_AFTER_MS = 30_000;

/** Chain id checks, per chain and URL: true or false once answered. */
const checks = new Map<string, Promise<boolean | null>>();
/** Per chain and URL: until when a private RPC that did not answer is passed over. */
const quietUntil = new Map<string, number>();

/** Test hook: forget every check, as a new instance would. */
export function resetRpcChecks(): void {
  checks.clear();
  quietUntil.clear();
  resetRpcRest();
}

/** Pass the private RPC over for RECHECK_AFTER_MS, then check its chain id again. */
function passOver(key: string): void {
  checks.delete(key);
  quietUntil.set(key, Date.now() + RECHECK_AFTER_MS);
}

/**
 * Whether `url` answers eth_chainId with `chainId`. Null when it did not
 * answer (down, timed out): it is then passed over for RECHECK_AFTER_MS, so a
 * hung node costs one short wait per instance, not one per call. Logs a
 * mismatch once and a missed check each time, never the URL (it can carry
 * its key).
 */
function answersFor(url: string, chainId: number, config: HttpTransportConfig): Promise<boolean | null> {
  const key = `${chainId} ${url}`;
  const known = checks.get(key);
  if (known) return known;
  if ((quietUntil.get(key) ?? 0) > Date.now()) return Promise.resolve(null);
  const timeout = Math.min(config.timeout ?? CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS);
  const check = http(url, { ...config, timeout, retryCount: 0 })({})
    .request({ method: "eth_chainId" })
    .then((id) => {
      const ok = Number(id) === chainId;
      if (!ok) console.error("gloam_rpc_wrong_chain", JSON.stringify({ chainId, answered: Number(id) }));
      return ok;
    })
    .catch((e: unknown) => {
      passOver(key);
      const status = (e as { status?: number })?.status ?? null;
      console.warn("gloam_rpc_unchecked", JSON.stringify({ chainId, error: e instanceof Error ? e.name : "error", status }));
      return null;
    });
  checks.set(key, check);
  return check;
}

/**
 * The private RPC, behind the chain id check. `sendInstead` (the relay's
 * transport only) takes a send while the private RPC has not answered: nothing
 * reached it, so the send still goes out once, through the public RPC.
 */
function checkedPrivate(url: string, chainId: number, config: HttpTransportConfig, sendInstead?: Transport): Transport {
  // asked once per call: a node that hangs costs one timeout, then it is passed over
  const inner = http(url, { ...config, retryCount: 0 });
  const key = `${chainId} ${url}`;
  return (params) => {
    const t = inner(params);
    return {
      ...t,
      async request(args) {
        const answered = await answersFor(url, chainId, config);
        if (answered === false) throw new WrongChainRpcError(chainId);
        if (answered === null) {
          if (sendInstead && SEND_METHODS.includes(args.method)) return sendInstead(params).request(args);
          // reads: the fallback moves on to the public RPC
          throw new UncheckedRpcError(chainId);
        }
        try {
          return await t.request(args);
        } catch (e) {
          // checked, then failed as a node: passed over like one that never answered
          if (nodeFailed(e)) {
            passOver(key);
            const status = (e as { status?: number })?.status ?? null;
            console.warn("gloam_rpc_private_failed", JSON.stringify({ chainId, method: args.method, status }));
          }
          throw e;
        }
      },
    } as typeof t;
  };
}

/**
 * `sendOnce` is for the relay's sends: a signed transaction goes to one RPC
 * only. The public backup still answers reads, but never gets a raw send the
 * private RPC may already have taken, since a second copy could only revert or
 * come back as a nonce clash that looks like nothing went out. The fallback
 * also takes `retryCount` from `config` then, instead of its own default of 3.
 */
export function serverTransport(net: Net, config: HttpTransportConfig = {}, opts: { sendOnce?: boolean } = {}): Transport {
  if (net.logCanary) {
    // one check around the whole thing (private RPC and public list), not one per side
    return guardPrunedLogs<Transport>(serverTransport({ ...net, logCanary: null }, config, opts), net.logCanary);
  }
  const urls = net.chain.rpcUrls.default.http;
  const priv = privateRpc(net);
  // The public side reads the way the browser does (lib/readTransport): the
  // chain's public RPCs in order for the head, and old logs and state from the
  // network's history RPC where it has one. A send goes to one head RPC only.
  if (!priv || priv === urls[0]) return readTransport(net, config, opts.sendOnce ? { sendTo: "one" } : {});
  // the fallback retries the pair as a whole; each side asks each of its RPCs once a pass
  const once = { ...config, retryCount: 0 };
  if (!opts.sendOnce) {
    return fallback([checkedPrivate(priv, net.chainId, config), readTransport(net, once)], { retryCount: config.retryCount });
  }
  // sendInstead only ever takes a send: one head RPC
  const own = checkedPrivate(priv, net.chainId, config, rpcListTransport(urls, once, { sendTo: "one" }));
  // The backup never gets a raw send. Its exclusion has to show on the transport
  // fallback reads (config.methods), which the history split carries over from the head list.
  const backup = readTransport(net, { ...once, methods: { exclude: SEND_METHODS } });
  return fallback([own, backup], { retryCount: config.retryCount });
}
