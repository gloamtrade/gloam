/**
 * Pay for a Gloam name with ETH: buy exactly enough $GLOAM in the wallet's own
 * balance on Robinhood Chain, through Uniswap's Universal Router and the ETH/GLOAM
 * launch pool (Orynth hook), then approve and register as usual (GloamNameCard).
 *
 * The buy is exact-in: the wallet sends `ethIn` and must get at least `gloamOut`,
 * so nothing is left in the router and the call reverts if the price moved past
 * the buffer. A little more $GLOAM than needed can land; it stays in the wallet.
 *
 * Shared by the app and scripts/fork-pay-with-eth.mts: no browser-only imports.
 */
import { concatHex, encodeAbiParameters, encodeFunctionData, toHex, zeroAddress, type Address, type Hex } from "viem";
import { RH_V4_QUOTER } from "@/lib/vaultSwap";

/** Uniswap's Universal Router on Robinhood Chain (its poolManager() is the chain's PoolManager). */
export const RH_UNIVERSAL_ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
export const RH_GLOAM: Address = "0xDcD885F5c60b3aD49F6D58718696417314e8724d";
const ORYNTH_HOOK: Address = "0x953391a2DDf7E8437FeB878FDF2C6f325Fbf00CC";

/** The ETH/GLOAM launch pool: ETH is currency0, so ETH in is zeroForOne. */
export const ETH_GLOAM_POOL = { currency0: zeroAddress, currency1: RH_GLOAM, fee: 0, tickSpacing: 200, hooks: ORYNTH_HOOK } as const;

/** Paid on top of the quote, in basis points, so a small move before the block lands still fills. */
export const ETH_SLIPPAGE_BPS = 200n;

const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

export const v4QuoterSingleAbi = [
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", ...POOL_KEY },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Universal Router command and v4 router actions (v4-periphery Actions.sol). */
const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

/** The quoter call for buying exactly `gloamOut`: what the pool asks in ETH, hook fees included. */
export function quoteCall(gloamOut: bigint) {
  return {
    address: RH_V4_QUOTER,
    abi: v4QuoterSingleAbi,
    functionName: "quoteExactOutputSingle",
    args: [{ poolKey: ETH_GLOAM_POOL, zeroForOne: true, exactAmount: gloamOut, hookData: "0x" as Hex }],
  } as const;
}

/** The ETH to send for a quote: the quote plus the slippage buffer, rounded up. */
export function ethWithBuffer(quotedEth: bigint, bps = ETH_SLIPPAGE_BPS): bigint {
  return quotedEth + (quotedEth * bps + 9_999n) / 10_000n;
}

/**
 * The Universal Router call that spends exactly `ethIn` on $GLOAM for the
 * caller, reverting unless at least `gloamOut` arrives. Send it with value `ethIn`.
 */
export function buildEthToGloamSwap(ethIn: bigint, gloamOut: bigint, deadline: bigint): { to: Address; data: Hex; value: bigint } {
  const actions = concatHex([toHex(SWAP_EXACT_IN_SINGLE, { size: 1 }), toHex(SETTLE_ALL, { size: 1 }), toHex(TAKE_ALL, { size: 1 })]);
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", ...POOL_KEY },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: ETH_GLOAM_POOL, zeroForOne: true, amountIn: ethIn, amountOutMinimum: gloamOut, hookData: "0x" }]
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [zeroAddress, ethIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [RH_GLOAM, gloamOut]);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [toHex(V4_SWAP, { size: 1 }), [v4Input], deadline],
  });
  return { to: RH_UNIVERSAL_ROUTER, data, value: ethIn };
}
