/**
 * Every Gloam name claimed so far, read from the GloamNames registry's events on
 * Robinhood Chain mainnet (contracts/src/GloamNames.sol). Names and the wallets that
 * hold them are public on chain; this only puts them in one list.
 *
 * Used by /api/admin/names (the admin Names tab) and scripts/names-draw.mts.
 */
import { getAddress, parseAbiItem, sha256, stringToBytes, type Hex } from "viem";
import { GLOAM_NAMES_ADDRESS, isBlockedName } from "@/lib/gloamNames";
import { getLogsSafe } from "@/lib/logRange";
import type { publicClientFor } from "@/lib/rhClient";

type Client = ReturnType<typeof publicClientFor>;

/** The block the registry was deployed in (contracts/deployments/mainnet.json). */
export const GLOAM_NAMES_DEPLOY_BLOCK = 119798738n;

const EVENTS = [
  parseAbiItem(
    "event NameRegistered(bytes32 indexed node, string name, address indexed holder, bytes32 keyX, bytes32 keyY, uint64 expires, uint256 paid)"
  ),
  parseAbiItem("event NameRenewed(bytes32 indexed node, uint64 expires, uint256 paid)"),
  parseAbiItem("event NameTransferred(bytes32 indexed node, address indexed from, address indexed to)"),
] as const;

export type ClaimedName = {
  name: string;
  node: Hex;
  /** The wallet that holds it now. */
  holder: `0x${string}`;
  /** Unix seconds of the registration that holds it now. */
  claimedAt: number;
  claimedBlock: number;
  claimTx: Hex;
  logIndex: number;
  /** Unix seconds; the name still pays its holder for 30 days after. */
  expires: number;
  /** $GLOAM paid for this registration and its renewals. */
  paidGloam: number;
  renewals: number;
  /** A name the app never pays (lib/gloamNames isBlockedName), written to the registry directly. */
  blocked: boolean;
};

export type NamesSnapshot = {
  names: ClaimedName[];
  /** Registrations ever, counting a name claimed again after it lapsed. */
  registrations: number;
  /** $GLOAM sent to the treasury by every registration and renewal. */
  collectedGloam: number;
  latestBlock: number;
};

const gloam = (wei: bigint) => Number(wei / 10n ** 12n) / 1e6;

/** Read every registration, renewal and transfer up to `toBlock` (default: the latest block). */
export async function readClaimedNames(client: Client, toBlock?: bigint): Promise<NamesSnapshot> {
  const registry = GLOAM_NAMES_ADDRESS;
  if (!registry) return { names: [], registrations: 0, collectedGloam: 0, latestBlock: 0 };
  const latest = toBlock ?? (await client.getBlockNumber());
  const logs = await getLogsSafe(
    (from, to) => client.getLogs({ address: registry, events: EVENTS, fromBlock: from, toBlock: to }),
    GLOAM_NAMES_DEPLOY_BLOCK,
    latest
  );
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n))
  );

  const byNode = new Map<Hex, ClaimedName>();
  let registrations = 0;
  let collected = 0;
  for (const log of logs) {
    const node = log.args.node as Hex;
    if (log.eventName === "NameRegistered") {
      const a = log.args as { name: string; holder: `0x${string}`; expires: bigint; paid: bigint };
      registrations++;
      collected += gloam(a.paid);
      // a new registration replaces a lapsed one whole
      byNode.set(node, {
        name: a.name,
        node,
        holder: getAddress(a.holder),
        claimedAt: 0,
        claimedBlock: Number(log.blockNumber),
        claimTx: log.transactionHash as Hex,
        logIndex: log.logIndex ?? 0,
        expires: Number(a.expires),
        paidGloam: gloam(a.paid),
        renewals: 0,
        blocked: isBlockedName(a.name),
      });
    } else if (log.eventName === "NameRenewed") {
      const a = log.args as { expires: bigint; paid: bigint };
      collected += gloam(a.paid);
      const n = byNode.get(node);
      if (n) {
        n.expires = Number(a.expires);
        n.paidGloam += gloam(a.paid);
        n.renewals++;
      }
    } else if (log.eventName === "NameTransferred") {
      const n = byNode.get(node);
      if (n) n.holder = getAddress((log.args as { to: `0x${string}` }).to);
    }
  }

  // when each name was claimed: one block read per block, eight at a time
  const names = [...byNode.values()];
  const blocks = [...new Set(names.map((n) => n.claimedBlock))];
  const times = new Map<number, number>();
  for (let i = 0; i < blocks.length; i += 8) {
    await Promise.all(
      blocks.slice(i, i + 8).map(async (b) => times.set(b, Number((await client.getBlock({ blockNumber: BigInt(b) })).timestamp)))
    );
  }
  for (const n of names) n.claimedAt = times.get(n.claimedBlock) ?? 0;
  names.sort((a, b) => a.claimedBlock - b.claimedBlock || a.logIndex - b.logIndex);
  return { names, registrations, collectedGloam: Math.round(collected * 1e6) / 1e6, latestBlock: Number(latest) };
}

/**
 * Pick `count` entries with a public random value (a drand beacon): pick k is
 * sha256("<randomness>:<k>") mod the entries still left, in claim order. Anyone
 * with the same list and the same beacon gets the same picks.
 */
export function pickWinners<T>(randomness: string, entries: T[], count: number): T[] {
  const left = entries.slice();
  const won: T[] = [];
  for (let k = 0; k < count && left.length > 0; k++) {
    const h = BigInt(sha256(stringToBytes(`${randomness.toLowerCase()}:${k}`)));
    won.push(left.splice(Number(h % BigInt(left.length)), 1)[0]);
  }
  return won;
}
