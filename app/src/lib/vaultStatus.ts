/**
 * Vault reads that do not depend on the user's wallet network.
 */

import type { Address } from "viem";
import { getActiveNetwork } from "./networks";
import { getRhPublicClient } from "./rhClient";
import { shieldPoolAbi } from "./shield";
import { readDemo } from "./demoFlag";
import { demoPoolInventory } from "./demo/chain";

export async function readPoolDeposited(asset: Address): Promise<bigint | null> {
  // Recording demo: the vault always holds enough to cover the pretend wallet.
  if (readDemo()) return demoPoolInventory(asset);
  const pool = getActiveNetwork().pool;
  if (!pool) return null;
  try {
    const client = getRhPublicClient();
    return (await client.readContract({
      address: pool,
      abi: shieldPoolAbi,
      functionName: "deposited",
      args: [asset],
    })) as bigint;
  } catch {
    return null;
  }
}
