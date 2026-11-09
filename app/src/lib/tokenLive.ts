/**
 * Live facts for /token, read from chain on the server. Server only.
 *
 * Per live mainnet vault: withdrawFeeBps() and feeRecipient(). On Robinhood
 * Chain: $GLOAM decimals(), and balanceOf() for the burn address, the zero
 * address and the treasury. Every read is on its own: one that fails (an RPC
 * down or slow) comes back null and the page says it could not be read, never
 * a made-up number. The page regenerates every few minutes, so visitors never
 * wait on an RPC.
 */
import { createPublicClient, erc20Abi, type Address, type PublicClient } from "viem";
import { allNetworks, getNetwork, type GloamNetwork } from "./networks";
import { serverTransport } from "./serverRpc";
import { shieldPoolAbi } from "./shield";
import { BURN_ADDRESS, GLOAM_TOKEN, TREASURY_ADDRESS } from "./buybacks";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type VaultFee = {
  chainId: number;
  name: string;
  pool: Address;
  /** Cash-out fee in basis points, or null when the read failed. */
  feeBps: number | null;
  /** Where collectFees sends it, or null when the read failed. */
  feeRecipient: Address | null;
  explorerAddress: (addr: string) => string;
};

export type TokenLive = {
  fees: VaultFee[];
  decimals: number | null;
  /** $GLOAM held by 0x...dEaD, in base units. */
  burnedDead: bigint | null;
  /** $GLOAM held by the zero address, in base units. */
  burnedZero: bigint | null;
  /** $GLOAM held by the treasury, in base units. */
  treasury: bigint | null;
  /** When this was read, ms since epoch. */
  readAt: number;
};

function clientFor(n: GloamNetwork): PublicClient {
  return createPublicClient({
    chain: n.chain,
    ccipRead: false,
    transport: serverTransport(n, { timeout: 8_000, retryCount: 1, retryDelay: 400 }),
  }) as PublicClient;
}

const orNull = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

async function readFee(n: GloamNetwork): Promise<VaultFee | null> {
  if (!n.pool) return null;
  const c = clientFor(n);
  const [bps, recipient] = await Promise.all([
    orNull(c.readContract({ address: n.pool, abi: shieldPoolAbi, functionName: "withdrawFeeBps" })),
    orNull(c.readContract({ address: n.pool, abi: shieldPoolAbi, functionName: "feeRecipient" })),
  ]);
  return {
    chainId: n.chainId,
    name: n.label,
    pool: n.pool,
    feeBps: bps === null ? null : Number(bps),
    feeRecipient: (recipient as Address | null) ?? null,
    explorerAddress: n.explorerAddress,
  };
}

export async function readTokenLive(): Promise<TokenLive> {
  const mainnets = allNetworks().filter((n) => !n.testnet && n.pool);
  const rh = clientFor(getNetwork("robinhood-mainnet"));
  const bal = (who: Address) => orNull(rh.readContract({ address: GLOAM_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [who] }));

  const [fees, decimals, burnedDead, burnedZero, treasury] = await Promise.all([
    Promise.all(mainnets.map(readFee)),
    orNull(rh.readContract({ address: GLOAM_TOKEN, abi: erc20Abi, functionName: "decimals" })),
    bal(BURN_ADDRESS),
    bal(ZERO_ADDRESS),
    bal(TREASURY_ADDRESS),
  ]);

  return {
    fees: fees.filter((f): f is VaultFee => f !== null),
    decimals: decimals === null ? null : Number(decimals),
    burnedDead,
    burnedZero,
    treasury,
    readAt: Date.now(),
  };
}

/** The fee every vault reads, when they all read and agree; else null. */
export function commonFeeBps(fees: readonly VaultFee[]): number | null {
  if (!fees.length || fees.some((f) => f.feeBps === null)) return null;
  const first = fees[0]!.feeBps!;
  return fees.every((f) => f.feeBps === first) ? first : null;
}
