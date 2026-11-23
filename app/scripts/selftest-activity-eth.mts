/**
 * Self-test: on Base, where the vault lists native ETH, adding ETH privately
 * and cashing it out show in Activity like a token's. Activity on a payments
 * vault was read from ERC-20 Transfer logs only, and a native-coin deposit or
 * cash-out leaves none, so "Added 100 USDC" showed and "Added 0.1 ETH" never
 * did. Now the vault's own Shielded and Unshielded events for the wallet are
 * read too, a cash-out net of the vault's fee (what the wallet received).
 *
 * The chain is a stand-in that answers getLogs by event and filter; nothing
 * reaches a network.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-activity-eth.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { parseEther, parseUnits, type Address, type Hex } from "viem";

globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-activity-eth: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const { getNetwork } = await import("../src/lib/networks");
const { readWalletActivity } = await import("../src/lib/walletActivity");

const BASE = getNetwork("base");
const POOL = BASE.pool! as Address;
const ME = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8" as Address;
const SOMEONE = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const ETH = "0x0000000000000000000000000000000000000000" as Address;
const lc = (a: string) => a.toLowerCase();
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const NULLIFIER = `0x${"ab".repeat(32)}` as Hex;
const START = BASE.deployBlock!;

type FakeLog = { event: string; address: Address; blockNumber: bigint; transactionHash: Hex; logIndex: number; args: Record<string, unknown> };
const LOGS: FakeLog[] = [
  // a USDC deposit (Transfer to the vault), as before
  { event: "Transfer", address: USDC, blockNumber: START + 10n, transactionHash: tx(1), logIndex: 0, args: { from: ME, to: POOL, value: parseUnits("100", 6) } },
  // 0.1 ETH added privately by this wallet, and one by someone else
  { event: "Shielded", address: POOL, blockNumber: START + 20n, transactionHash: tx(2), logIndex: 1, args: { commitment: tx(9), asset: ETH, amount: parseEther("0.1"), leafIndex: 3n, from: ME } },
  { event: "Shielded", address: POOL, blockNumber: START + 21n, transactionHash: tx(3), logIndex: 1, args: { commitment: tx(8), asset: ETH, amount: parseEther("0.2"), leafIndex: 4n, from: SOMEONE } },
  // 0.05 ETH cashed out to this wallet, the vault keeping its 0.25%
  { event: "Unshielded", address: POOL, blockNumber: START + 60_000n, transactionHash: tx(4), logIndex: 2, args: { nullifier: NULLIFIER, asset: ETH, to: ME, amount: parseEther("0.05") } },
  { event: "WithdrawFee", address: POOL, blockNumber: START + 60_000n, transactionHash: tx(4), logIndex: 3, args: { nullifier: NULLIFIER, asset: ETH, fee: parseEther("0.000125") } },
];

let calls = 0;
const client = {
  getBlockNumber: async () => START + 70_000n,
  getLogs: async (q: { address: Address | Address[]; event?: { name: string }; events?: { name: string }[]; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) => {
    calls++;
    const addrs = (Array.isArray(q.address) ? q.address : [q.address]).map(lc);
    const names = q.events ? q.events.map((e) => e.name) : [q.event!.name];
    return LOGS.map((l) => ({ ...l, eventName: l.event })).filter(
      (l) =>
        names.includes(l.event) &&
        addrs.includes(lc(l.address)) &&
        l.blockNumber >= q.fromBlock &&
        l.blockNumber <= q.toBlock &&
        Object.entries(q.args ?? {}).every(([k, v]) => lc(String(l.args[k])) === lc(String(v)))
    );
  },
} as never;

const { txs } = await readWalletActivity("base", ME, client);
const rows = txs.map((t) => [t.token?.symbol, t.valueWei, lc(t.from) === lc(ME) ? "out" : "in", lc(t.from) === lc(POOL) || lc(t.to) === lc(POOL)]);

assert.deepEqual(
  rows,
  [
    ["ETH", parseEther("0.049875").toString(), "in", true], // cashed out, net of the fee
    ["ETH", parseEther("0.1").toString(), "out", true], // added privately
    ["USDC", parseUnits("100", 6).toString(), "out", true],
  ],
  "Activity lists the ETH cash-out and deposit next to the USDC one, newest first"
);
assert.ok(!txs.some((t) => t.valueWei === parseEther("0.2").toString()), "another wallet's deposit is not this wallet's activity");
assert.ok(txs.every((t) => t.token?.decimals === (t.token?.symbol === "ETH" ? 18 : 6)));
assert.ok(calls > 0);

// Robinhood Chain mainnet lists ETH too, so its activity reads the same; Tempo has no native coin.
const { supportsNativeShield } = await import("../src/lib/tokens");
assert.equal(supportsNativeShield(4663), true);
assert.equal(supportsNativeShield(4217), false);

console.log("selftest-activity-eth: 4 checks passed");
