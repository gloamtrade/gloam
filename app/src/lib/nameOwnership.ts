/**
 * Whether a signed-in account already has a Gloam name, for the "Get your
 * @name" offer (lib/nameOffer). The registry has no reverse lookup, but its
 * logs name the holder: NameRegistered(node, name, holder indexed, ...) and
 * NameTransferred(node, from, to indexed). So the names this wallet ever
 * registered or was given are read from the logs, and each one is checked
 * against the registry now.
 *
 * Owned uses the same rule as the name card on Receive (GloamNameCard): the
 * wallet holds the name, or the name pays one of this account's Gloam
 * addresses. A read that fails says nothing, so the answer is then "unknown"
 * and the offer stays hidden.
 */
import { parseAbiItem, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { walkLogs, walkTuning } from "./leafIndex";
import { GLOAM_NAMES_ADDRESS, GLOAM_NAMES_CHAIN_ID, type NameRecord } from "./gloamNames";

/** A little before the registry's first log on Robinhood Chain (block 119,798,738, 21 Nov 2026). */
export const NAMES_FROM_BLOCK = 119_798_000n;

export const NAME_REGISTERED_EVENT = parseAbiItem(
  "event NameRegistered(bytes32 indexed node, string name, address indexed holder, bytes32 keyX, bytes32 keyY, uint64 expires, uint256 paid)"
);
export const NAME_TRANSFERRED_EVENT = parseAbiItem("event NameTransferred(bytes32 indexed node, address indexed from, address indexed to)");

type LogReader = (filter: { event: typeof NAME_REGISTERED_EVENT | typeof NAME_TRANSFERRED_EVENT; args: Record<string, unknown> }) => Promise<
  { args: Record<string, unknown> }[]
>;

/** Every name `holder` registered or was given, read from the registry's logs. Throws when the logs can't be read. */
export async function namesHeldInLogs(holder: Address, read: LogReader): Promise<string[]> {
  const names = new Set<string>();
  const registered = await read({ event: NAME_REGISTERED_EVENT, args: { holder } });
  for (const l of registered) if (typeof l.args.name === "string") names.add(l.args.name);
  // a name given to this wallet: its node, then the name it was registered as
  const given = await read({ event: NAME_TRANSFERRED_EVENT, args: { to: holder } });
  for (const l of given) {
    const node = l.args.node as Hex | undefined;
    if (!node) continue;
    const reg = await read({ event: NAME_REGISTERED_EVENT, args: { node } });
    for (const r of reg) if (typeof r.args.name === "string") names.add(r.args.name);
  }
  return [...names];
}

/** The registry's logs on Robinhood Chain, read through `client`. */
export function registryLogReader(client: PublicClient, logRange: bigint): LogReader {
  return async ({ event, args }) => {
    if (!GLOAM_NAMES_ADDRESS) return [];
    const head = await client.getBlockNumber();
    const raw = await walkLogs(client, GLOAM_NAMES_ADDRESS, NAMES_FROM_BLOCK, head, walkTuning(GLOAM_NAMES_CHAIN_ID, logRange), { event, args });
    return parseEventLogs({ abi: [event], logs: raw, strict: false }) as unknown as { args: Record<string, unknown> }[];
  };
}

/**
 * True when the account owns a name, false when it surely doesn't, null when
 * a read failed and it can't be told. `remembered` are the names this browser
 * saved for the account; `myTags` its Gloam addresses, current and earlier.
 */
export async function accountOwnsName(s: {
  address: Address;
  myTags: readonly string[];
  remembered: readonly string[];
  namesFromLogs: () => Promise<string[]>;
  lookup: (name: string) => Promise<NameRecord | null | "failed">;
}): Promise<boolean | null> {
  const me = s.address.toLowerCase();
  const tags = new Set(s.myTags);
  let unknown = false;
  const check = async (names: readonly string[], seen: Set<string>) => {
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const record = await s.lookup(n);
      if (record === "failed") {
        unknown = true;
        continue;
      }
      if (!record) continue;
      // a name past its grace period has no holder (lookup gives null); in its grace it still pays the holder
      if (record.holder.toLowerCase() === me || tags.has(record.tag)) return true;
    }
    return false;
  };
  const seen = new Set<string>();
  if (await check(s.remembered, seen)) return true;
  let fromLogs: string[];
  try {
    fromLogs = await s.namesFromLogs();
  } catch {
    return null;
  }
  if (await check(fromLogs, seen)) return true;
  return unknown ? null : false;
}
