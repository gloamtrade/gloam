/**
 * $GLOAM buybacks, one entry per round, shown on /token#buybacks.
 *
 * Every number here is read from Robinhood Chain logs: the $GLOAM Transfer
 * events of the buy transactions (into the treasury) and of the burn
 * transaction (treasury to 0x...dEaD). Amounts are exact token amounts as
 * decimal strings (18 decimals), so nothing is rounded until it is shown.
 *
 * A round can also burn $GLOAM the treasury already held from Gloam's fees
 * (cash-out fees taken in $GLOAM by the vault, and private swap leftovers).
 * That is `fromFees`: bought + fromFees = burned + toTreasury.
 *
 * Add a round only once its transactions are final on chain, and check the
 * sums before committing. Never add a planned round.
 */

/** The burn address. Nothing can move tokens out of it. */
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

/** Gloam's treasury: the cash-out fee recipient on every mainnet vault, and the wallet that runs buybacks. */
export const TREASURY_ADDRESS = "0xB3900ac9350903218e4c7597bAb0f008F01B30B8" as const;

/** $GLOAM on Robinhood Chain mainnet (4663). */
export const GLOAM_TOKEN = "0xDcD885F5c60b3aD49F6D58718696417314e8724d" as const;

export type BuybackEntry = {
  /** UTC day of the burn, YYYY-MM-DD. */
  date: string;
  chainId: 4663;
  /** The burn transaction (treasury to the burn address). */
  txHash: `0x${string}`;
  /** The market buys that delivered $GLOAM to the treasury for this round. */
  buyTxs: `0x${string}`[];
  /** $GLOAM bought from the market in buyTxs. */
  gloamBought: string;
  /** $GLOAM the treasury already held from Gloam's fees, burned in the same round. */
  fromFees: string;
  /** $GLOAM sent to the burn address in txHash. */
  burned: string;
  /** $GLOAM kept by the treasury from this round. */
  toTreasury: string;
  note: string;
};

const ALL_BURNED = "This round was 100% burned, topped up by the founder. From the next round, half is burned and half goes to the treasury.";

export const BUYBACKS: BuybackEntry[] = [
  {
    date: "2026-10-31",
    chainId: 4663,
    txHash: "0x4ed0e963486d72b4444236428a74732db37d6977145834a8ccf924c26af1dd6b",
    buyTxs: [
      "0xaad00d08120a2beea08bdc6a95f652d0fb2c4281622bfd7c177e57a516148e42",
      "0x2074dde28528f5f7866d1a56423788cfc18c4095af5f24e67125fdfd1dfba5d7",
    ],
    gloamBought: "182.291706688010298849",
    fromFees: "0.72290939923898762",
    burned: "183.014616087249286469",
    toTreasury: "0",
    note: ALL_BURNED,
  },
  {
    date: "2026-11-06",
    chainId: 4663,
    txHash: "0x59831426fa7d82fa4e46ddf4fee3125404e844f400f9a94fcd7c24a128622d5c",
    buyTxs: ["0x41cd6152ce684438d60632120c7bbb292e61101954ea397ddd70eb4cea999b3c"],
    gloamBought: "417.411671514803301463",
    fromFees: "0.614170418595236556",
    burned: "418.025841933398538019",
    toTreasury: "0",
    note: ALL_BURNED,
  },
];

/** A decimal token amount as base units (18 decimals). */
export function toUnits(amount: string, decimals = 18): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Total $GLOAM burned by Gloam buybacks, in base units. */
export function buybackBurnedUnits(entries: readonly BuybackEntry[] = BUYBACKS): bigint {
  return entries.reduce((s, e) => s + toUnits(e.burned), 0n);
}
