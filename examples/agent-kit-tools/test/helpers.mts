/** Fakes shared by the tests: an engine that records what it was asked, and a stand-in chain. */
import { BASE_SEPOLIA_USDC, getGloamNetwork, type GloamPaymentRequirements } from "@gloamtrade/sdk";
import type { Address, Hex } from "viem";
import type { GloamEngine } from "../src/index.ts";

export const USDC = BASE_SEPOLIA_USDC as Address;
export const NET = getGloamNetwork("base")!;
export const POOL = NET.pool;
export const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export type Call = { fn: string; args: unknown };

/** An engine on Base Sepolia that holds one 100 USDC note and records every call. */
export function fakeEngine(over: Partial<GloamEngine> & { largest?: bigint; feeBps?: number; wallet?: Address | null; holds?: bigint } = {}) {
  const calls: Call[] = [];
  const state = { feeBps: over.feeBps ?? 50 };
  const rec = (fn: string) => async (args: unknown) => {
    calls.push({ fn, args });
    return { status: "done", action: fn, hash: hashOf(calls.length) };
  };
  const engine: GloamEngine = {
    network: { key: NET.key, label: NET.label, testnet: NET.testnet, chainId: NET.chainId, pool: NET.pool, assets: NET.assets, nativeShield: NET.nativeShield },
    submitMode: "relay",
    walletAddress: over.wallet === undefined ? ("0x00000000000000000000000000000000000000a1" as Address) : over.wallet,
    balance: rec("balance"),
    checkIncoming: async () => {
      calls.push({ fn: "checkIncoming", args: null });
      return { status: "done", received: [] };
    },
    add: rec("add"),
    pay: rec("pay"),
    payX402: async (args: { requirements: GloamPaymentRequirements }) => {
      calls.push({ fn: "payX402", args });
      return { status: "done", action: "pay_x402", hash: hashOf(77), paymentHeader: "gloamx402pay1:e30" };
    },
    payX402Cashout: async (args: unknown) => {
      calls.push({ fn: "payX402Cashout", args });
      return { status: "done", action: "pay_x402_cashout", hash: hashOf(78) };
    },
    payByClaimLink: rec("payByClaimLink"),
    cashOut: rec("cashOut"),
    proveFunds: rec("proveFunds"),
    verifyProof: rec("verifyProof"),
    largestPayment: () => over.largest ?? 100_000_000n,
    cashOutFeeBps: async () => state.feeBps,
    walletHolds: async () => over.holds ?? 1_000_000_000n,
    depositProblem: async () => null,
    ...over,
  } as GloamEngine;
  return { engine, calls, state };
}
