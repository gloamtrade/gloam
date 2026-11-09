/**
 * TIP-403 checks on the server, for /api/screen, /api/screen/policy and the relay.
 *
 * Reads go straight to the network's public RPC (eth_call only, nothing is
 * signed or sent). A stablecoin's policy and the vault's standing under it are
 * cached briefly; a wallet's standing is asked fresh each time. If the RPC
 * fails, the issuer policy check fails open: the token enforces its policy
 * on-chain anyway, so a missed early check costs a reverted transaction, never a
 * compliance gap. A cash out's receive policy fails closed: a payment it
 * refuses is held by Tempo instead of reverting (lib/tip403).
 */
import { createPublicClient, type Address } from "viem";
import { NETWORK_KEYS, getNetwork, isNetworkWritable, type GloamNetwork } from "./networks";
import {
  TIP403_RECEIVE_UNCHECKED_MESSAGE,
  checkReceivePolicy,
  checkTip403,
  isTip20Address,
  isTip403Chain,
  readAssetStatus,
  type Tip403AssetStatus,
  type Tip403Flow,
  type Tip403Reader,
  type Tip403Verdict,
} from "./tip403";
import { serverTransport } from "@/lib/serverRpc";

const STATUS_TTL_MS = 30_000;
const STATUS_MAX = 500;
const statusCache = new Map<string, { at: number; status: Tip403AssetStatus }>();
const readers = new Map<number, Tip403Reader>();
let readerOverride: ((chainId: number) => Tip403Reader | null) | null = null;

/** Swap the RPC reader (self-tests, scripts). Pass null to restore the real one. Clears the cache. */
export function setTip403ReaderFactory(factory: ((chainId: number) => Tip403Reader | null) | null) {
  readerOverride = factory;
  statusCache.clear();
}

/** The live Gloam network on a TIP-403 chain, if there is one. */
function tip403Network(chainId: unknown): GloamNetwork | null {
  if (!isTip403Chain(chainId)) return null;
  const net = NETWORK_KEYS.map(getNetwork).find((n) => n.chainId === chainId);
  return net && isNetworkWritable(net) && net.pool ? net : null;
}

function readerFor(net: GloamNetwork): Tip403Reader | null {
  if (readerOverride) return readerOverride(net.chainId);
  const hit = readers.get(net.chainId);
  if (hit) return hit;
  const client = createPublicClient({
    chain: net.chain,
    ccipRead: false,
    transport: serverTransport(net, { timeout: 8_000, retryCount: 1 }),
  });
  const reader: Tip403Reader = {
    readContract: (call) => client.readContract(call as Parameters<typeof client.readContract>[0]),
  };
  readers.set(net.chainId, reader);
  return reader;
}

/** True when a TIP-403 check applies: a live Tempo network and a TIP-20 asset. */
export function tip403Applies(chainId: unknown, asset: unknown): boolean {
  return tip403Network(chainId) !== null && isTip20Address(asset);
}

/**
 * The issuer policy for `asset` and whether it lets the Gloam vault receive and
 * send it. Null when no check applies. Throws when the RPC cannot answer.
 */
export async function tip403AssetStatus(chainId: unknown, asset: unknown): Promise<Tip403AssetStatus | null> {
  const net = tip403Network(chainId);
  if (!net || !isTip20Address(asset)) return null;
  const reader = readerFor(net);
  if (!reader) return null;
  const key = `${net.chainId}:${asset.toLowerCase()}`;
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  const status = await readAssetStatus(reader, net.chainId, asset, net.pool!);
  if (statusCache.size >= STATUS_MAX) statusCache.clear();
  statusCache.set(key, { at: Date.now(), status });
  return status;
}

/**
 * Screen public addresses against the issuer policy of `asset` for one edge of
 * the vault. Allowed when no check applies. The issuer policy passes when the
 * RPC cannot answer. On a cash out, each recipient's receive policy must accept
 * `sender` (the vault unless set: a swap's exit pays from its escrow), and when
 * it can't be read the verdict is "unchecked", which refuses.
 */
export async function screenTip403(
  addresses: readonly Address[],
  opts: { chainId?: unknown; asset?: unknown; flow?: Tip403Flow; sender?: Address }
): Promise<Tip403Verdict> {
  const net = tip403Network(opts.chainId);
  if (!net || !isTip20Address(opts.asset)) return { allowed: true };
  const reader = readerFor(net);
  if (!reader) return { allowed: true };
  try {
    const status = await tip403AssetStatus(net.chainId, opts.asset);
    const verdict = status ? await checkTip403({ reader, status, addresses, flow: opts.flow, receive: false }) : null;
    if (verdict && !verdict.allowed) return verdict;
  } catch {
    // the issuer policy fails open: the token enforces it on chain
  }
  if (opts.flow !== "cashout") return { allowed: true };
  try {
    return await checkReceivePolicy(reader, opts.asset, opts.sender ?? net.pool!, addresses);
  } catch {
    return { allowed: false, reason: "unchecked", message: TIP403_RECEIVE_UNCHECKED_MESSAGE };
  }
}
