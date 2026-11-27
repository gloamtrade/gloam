/**
 * Bringing money in to Starknet from Gloam's networks that Circle's CCTP
 * doesn't serve: Robinhood Chain, Tempo, BNB Chain (CCTP is USYC only there)
 * and Elysium. Shared by the browser and the server; checked by
 * scripts/selftest-starknet-cctp-relay.mts.
 *
 * The shortest honest route is one hop to a CCTP chain and the burn there, in
 * one order the person signs once: Relay (the bridge Gloam already uses) takes
 * their stablecoin on the source chain and delivers exactly `amount` USDC on
 * Base to its router, which runs two calls Gloam fixed in the order:
 * USDC.approve(TokenMessengerV2, amount) and TokenMessengerV2.depositForBurn(
 * amount, 25, the Gloam Starknet account, USDC, 0, maxFee, fast). From there it
 * is the CCTP bring-in of lib/starknetPrivacy/cctp: Circle signs the burn in
 * Relay's Base transaction, Gloam's relay brings it to the account and the add
 * follows. If Relay can't run the calls it sends the USDC to the person's own
 * wallet on Base instead.
 *
 * Who pays what: the wallet pays the source chain's gas and Relay's fee (in
 * what it pays, read from the quote); Relay pays Base's gas; Circle's fast fee
 * from Base and Gloam's two fees are as for any bring-in.
 *
 * What is public: the payment on the source chain and Relay's fill on Base
 * (with the burn, naming the Starknet account), then the mint and the add on
 * Starknet. Layerswap also reaches Starknet and could land on the account,
 * where the plain Add privately would take it, but it is a second bridge to
 * integrate (its own API, quotes and status), and Gloam already uses Relay on
 * all four of these chains.
 */
import { encodeFunctionData, parseAbi } from "viem";
import { BNB } from "../bnb";
import { ELYSIUM } from "../elysium";
import { CCTP_STARKNET_DOMAIN, EVM_TOKEN_MESSENGER_V2, ZERO_BYTES32, burnFinality, burnMaxFee, cctpSourceByDomain, starknetToBytes32, type CctpSource } from "./cctp";

export type RelaySourceToken = { symbol: string; address: string; decimals: number };
export type RelaySource = { chainId: number; name: string; tokens: RelaySourceToken[] };

/** The CCTP chain Relay delivers to before the burn: Base (fast transfer, about 8 seconds to Circle's signature). */
export const RELAY_HOP: CctpSource = cctpSourceByDomain(6)!;

/**
 * The sources, in the order lists show them, with the stablecoins Gloam's
 * bridge lists there (lib/bridge BRIDGE_CHAINS). Relay quoted all four into
 * Base with these two calls on 2026-11-27 (20 USDC out for 20.03 USDG, 20.04
 * USDC.e, 20.06 USDC on Elysium, 20.08 USDT on BNB Chain; about a second).
 */
export const RELAY_SOURCES: readonly RelaySource[] = [
  { chainId: 4663, name: "Robinhood Chain", tokens: [{ symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6 }] },
  { chainId: 4217, name: "Tempo", tokens: [{ symbol: "USDC.e", address: "0x20c000000000000000000000b9537d11c60e8b50", decimals: 6 }] },
  ...(BNB
    ? [
        {
          chainId: 56,
          name: "BNB Chain",
          tokens: [
            { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
            { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
          ],
        },
      ]
    : []),
  ...(ELYSIUM ? [{ chainId: ELYSIUM.chainId, name: "Elysium", tokens: [{ symbol: "USDC", address: ELYSIUM.usdc.toLowerCase(), decimals: ELYSIUM.usdcDecimals }] }] : []),
];

export function relaySource(chainId: number): RelaySource | null {
  return RELAY_SOURCES.find((s) => s.chainId === chainId) ?? null;
}

const HOP_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);

/** The two calls Relay's router runs on Base: approve the messenger, then burn `amount` to the Starknet account. */
export function relayHopCalls(input: { account: string; amount: bigint; bps: number }): { to: `0x${string}`; data: `0x${string}` }[] {
  if (input.amount <= 0n) throw new Error("Invalid amount.");
  const usdc = `0x${RELAY_HOP.usdc.slice(-40)}` as `0x${string}`;
  const messenger = EVM_TOKEN_MESSENGER_V2.toLowerCase() as `0x${string}`;
  return [
    { to: usdc, data: encodeFunctionData({ abi: HOP_ABI, functionName: "approve", args: [messenger, input.amount] }) },
    {
      to: messenger,
      data: encodeFunctionData({
        abi: HOP_ABI,
        functionName: "depositForBurn",
        args: [
          input.amount,
          CCTP_STARKNET_DOMAIN,
          starknetToBytes32(input.account) as `0x${string}`,
          usdc,
          ZERO_BYTES32 as `0x${string}`,
          burnMaxFee(input.amount, input.bps, RELAY_HOP.fast),
          burnFinality(RELAY_HOP),
        ],
      }),
    },
  ];
}

/** What the route hands the page: the order's transactions on the source chain and what it costs. */
export type RelayBringInQuote = {
  requestId: string;
  /** In order: an approve when the token needs one, then the deposit. */
  txs: { to: string; data: string; value: string; chainId: number }[];
  /** What the wallet pays, in the source token (a decimal string, all its places). */
  pay: string;
  symbol: string;
  /** USDC that arrives on Base and is burned to Starknet, base units. */
  amount: string;
  /** Relay's fee, in dollars, as Relay priced it. */
  relayUsd: number;
  /** Relay's estimate of its part, seconds. */
  seconds: number;
};
