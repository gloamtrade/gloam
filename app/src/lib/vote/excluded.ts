/**
 * Addresses whose $GLOAM never counts in a holder vote: the team's wallets,
 * Gloam's own contracts, and the pools and launch contracts that hold GLOAM
 * for everyone who trades it. The vote page lists every one with its reason.
 *
 * Found from the token's holders on Robinhood Chain (Transfer logs replayed
 * from the launch, 29 October 2026). A vote can add more in its own `exclude`.
 * A pool or launch contract can't sign a vote anyway; listing it keeps the
 * eligible total honest.
 */
import { getAddress, zeroAddress } from "viem";
import { VAULT_SWAP_V3_ADDRESS, swapV3Live } from "@/lib/vaultSwap";

export type Excluded = { address: `0x${string}`; reason: string };

export const EXCLUDED: Excluded[] = [
  // the team
  { address: "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8", reason: "Team: Gloam's owner wallet, which also created the token" },
  { address: "0xB3900ac9350903218e4c7597bAb0f008F01B30B8", reason: "Team: the Gloam treasury" },
  { address: "0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411", reason: "Team: deploys Gloam's contracts" },
  { address: "0xb1E994586E62994648a0b866BF33F2EDd942512e", reason: "Team: the Gloam relay" },
  // Gloam's contracts
  { address: "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", reason: "The Gloam vault. GLOAM held privately counts once private voting arrives" },
  { address: "0x34AB06208586A737Bf1607fa996Bc9162271c52d", reason: "Gloam private swaps router (first version)" },
  // the vote page lists all of these, so the next router joins once it is live (GLOAM is on Robinhood Chain alone)
  ...(swapV3Live(4663) ? [{ address: VAULT_SWAP_V3_ADDRESS[4663]!, reason: "Gloam private swaps router (third version)" }] : []),
  { address: "0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", reason: "Gloam private swaps router" },
  // pools and launch contracts
  { address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", reason: "Uniswap v4 pools, the Orynth launch pool among them" },
  { address: "0xE6d97c102cF738eC0d7FF42b010E00ca779Cb874", reason: "A GOO and GLOAM liquidity pool" },
  { address: "0x953391a2DDf7E8437FeB878FDF2C6f325Fbf00CC", reason: "Orynth launch hook and creator fee vault" },
  { address: "0xaf483a76F3732fC9726189CA1EB48f54c234E4Df", reason: "Orynth launcher, which minted GLOAM into the pool" },
  // burned
  { address: zeroAddress, reason: "Burned" },
  { address: "0x000000000000000000000000000000000000dEaD", reason: "Burned" },
];

/** The standing list plus a vote's own extras, keyed by lowercase address. */
export function excludedFor(extra: { address: string; reason: string }[] = []): Map<string, Excluded> {
  const map = new Map<string, Excluded>();
  for (const e of [...EXCLUDED, ...extra]) {
    const address = getAddress(e.address);
    map.set(address.toLowerCase(), { address, reason: e.reason });
  }
  return map;
}
