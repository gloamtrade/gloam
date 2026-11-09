/**
 * What a partner may count as its deposit (POST /api/v1/deposits): the vault's
 * Shielded logs in a transaction, less any whose `from` is a Gloam swap router.
 * A swap puts its new note in through the router, and a refund its refund note,
 * so neither is anyone's deposit, whoever reports it. Pure, for the route and its test.
 */
import { parseEventLogs, type Address, type Log } from "viem";
import { EVERY_SWAP_ROUTER } from "./vaultSwap";

export const SHIELDED_EVENT = [
  {
    type: "event",
    name: "Shielded",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "leafIndex", type: "uint256", indexed: false },
      { name: "from", type: "address", indexed: true },
    ],
  },
] as const;

const ROUTERS = new Set(EVERY_SWAP_ROUTER.map((r) => r.toLowerCase()));

/** The deposit in a receipt's logs, or null when it holds none: its asset, and the amount of that asset shielded. */
export function depositIn(logs: readonly Log[], pool: Address): { asset: Address; amount: bigint } | null {
  const shielded = parseEventLogs({ abi: SHIELDED_EVENT, logs: logs as Log[] }).filter(
    (l) => l.address.toLowerCase() === pool.toLowerCase() && !ROUTERS.has(l.args.from.toLowerCase())
  );
  if (shielded.length === 0) return null;
  const asset = shielded[0]!.args.asset;
  const amount = shielded.filter((l) => l.args.asset.toLowerCase() === asset.toLowerCase()).reduce((s, l) => s + l.args.amount, 0n);
  return { asset, amount };
}
