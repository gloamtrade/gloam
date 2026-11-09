/**
 * Self-test: the cash-out sweep check (lib/sweepCheck), against live Robinhood
 * Chain mainnet. Read only.
 *
 *  - a giveaway winner's wallet whose cash out was swept 7 blocks after it
 *    landed (22 Oct 2026): swept, and delegated to an unknown contract
 *  - a wallet that moved its USDG on, through a wallet relayer about 6 minutes
 *    later: delegated, not swept
 *  - a plain wallet that kept its cash out: clean
 *  - known smart-wallet delegates are not flagged
 *  - zero-value transfers (free for anyone) can't fake a sweep or hide a real one
 *  - a node that fails every read: clean, never a blocked cash out
 *  - a relayed transfer out of a delegated wallet is a sweep wherever it went,
 *    the vault included (a thief relaying deposits into a note they hold); the
 *    person's own connected Gloam wallet gets a quieter note and no hold
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-sweep-check.mts
 */
import assert from "node:assert/strict";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { SWEEP_CLEAN, checkSweep, delegateOf, sweepVerdict, type SweepReader } from "../src/lib/sweepCheck";

const RH = 4663;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// Pinned so the arrivals looked at stay the same as the chain grows.
const HEAD = BigInt(95_436_911);
const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") }) as unknown as SweepReader;

let n = 0;

const hero = await checkSweep(client, RH, "0x058dC9a70EE9fB5678eD500F7FE69AF974C884b6", USDG, { head: HEAD });
assert.equal(hero.swept?.evidenceTx, "0x5cd7dbe8357af944fd51c8a65c750961a8c1802c6918e0c22225f730bb757dd8", "swept, with the sweep as evidence");
assert.equal(hero.delegated?.delegate.toLowerCase(), "0x6d35c9c506732974219409a6e2e5fe72b082a622", "delegated to an unknown contract");
n += 2;

const relayed = await checkSweep(client, RH, "0x8f5b388c517B0E436E85A53953bDCDA9820A89EA", USDG, { head: HEAD });
assert.ok(relayed.delegated, "delegated");
assert.equal(relayed.swept, null, "left minutes later through a relayer: not a sweep");
n += 2;

const kept = await checkSweep(client, RH, "0x5B8810b2e9e452aB44271a20C960671c48c09Cff", USDG, { head: HEAD });
assert.deepEqual(kept, SWEEP_CLEAN, "a wallet that kept its cash out is clean");
n += 1;

// The delegation code itself: 0xef0100 + 20 bytes, and the known wallets pass.
assert.equal(delegateOf("0xef01006d35c9c506732974219409a6e2e5fe72b082a622"), "0x6d35c9c506732974219409a6e2e5fe72b082a622");
assert.equal(delegateOf("0x6080604052"), null, "a contract is not a delegation");
assert.equal(delegateOf(undefined), null);
const metamask: SweepReader = {
  getCode: async () => "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b" as Hex,
  getBlockNumber: async () => HEAD,
  getLogs: async () => [],
  getTransaction: async () => ({ from: "0x0000000000000000000000000000000000000001" }),
};
assert.deepEqual(await checkSweep(metamask, RH, "0x0000000000000000000000000000000000000002", USDG), SWEEP_CLEAN, "MetaMask's smart account is a known wallet");
n += 4;

// A made-up chain: only transfers that move money count. A stranger can emit a
// zero-value Transfer to or from any wallet for free, so those are ignored.
{
  type Log = { from: string; to: string; block: bigint; tx: Hex; sender: string; value: bigint };
  const VICTIM = "0x000000000000000000000000000000000000beef" as Address;
  const STRANGER = "0x000000000000000000000000000000000000dead";
  const SWEEPER = "0x00000000000000000000000000000000000bad00";
  const PAYER = "0x0000000000000000000000000000000000000077";
  const at = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex;
  const chain = (logs: Log[]): SweepReader => ({
    getCode: async () => "0x" as Hex,
    getBlockNumber: async () => HEAD,
    getLogs: async ({ args, fromBlock, toBlock }) =>
      logs
        .filter((l) => l.block >= fromBlock && l.block <= toBlock)
        .filter((l) => (args.to ? l.to === args.to.toLowerCase() : l.from === args.from!.toLowerCase()))
        .map((l) => ({ blockNumber: l.block, transactionHash: l.tx, args: { value: l.value } })),
    getTransaction: async ({ hash }) => ({ from: logs.find((l) => l.tx === hash)!.sender as Address }),
  });
  const check = (logs: Log[]) => checkSweep(chain(logs), RH, VICTIM, USDG, { head: HEAD });

  // transfer(victim, 0) then transferFrom(victim, stranger, 0): no balance or allowance needed.
  const forged: Log[] = [
    { from: STRANGER, to: VICTIM, block: HEAD - BigInt(100), tx: at(1), sender: STRANGER, value: BigInt(0) },
    { from: VICTIM, to: STRANGER, block: HEAD - BigInt(99), tx: at(2), sender: STRANGER, value: BigInt(0) },
  ];
  assert.deepEqual(await check(forged), SWEEP_CLEAN, "a forged zero-value sweep doesn't warn");

  const real: Log[] = [
    { from: PAYER, to: VICTIM, block: HEAD - BigInt(5_000), tx: at(10), sender: PAYER, value: BigInt(500_000_000) },
    { from: VICTIM, to: SWEEPER, block: HEAD - BigInt(4_993), tx: at(11), sender: SWEEPER, value: BigInt(500_000_000) },
  ];
  assert.equal((await check(real))?.swept?.evidenceTx, at(11), "a real sweep warns");
  // A zero-value move out after a real arrival is no sweep either.
  const emptyOut: Log[] = [real[0]!, { ...real[1]!, value: BigInt(0) }];
  assert.equal((await check(emptyOut)).swept, null, "a zero-value move out is not a sweep");

  // Empty arrivals after the real one, newer than it: they no longer push it out of view.
  const empties = Array.from({ length: 12 }, (_, i) => ({
    from: SWEEPER, to: VICTIM, block: HEAD - BigInt(10 * (i + 1)), tx: at(20 + i), sender: SWEEPER, value: BigInt(0),
  }));
  assert.equal((await check([...real, ...empties])).swept?.evidenceTx, at(11), "zero-value padding can't hide a sweep");
  // Real (if tiny) arrivals do count, and up to ten are looked at.
  const dust = empties.slice(0, 9).map((l) => ({ ...l, value: BigInt(1) }));
  assert.equal((await check([...real, ...dust])).swept?.evidenceTx, at(11), "nine dust arrivals still leave the sweep in view");
  n += 5;
}

// A node that fails everything: no warning, the cash out goes ahead.
const down: SweepReader = {
  getCode: async () => Promise.reject(new Error("rpc down")),
  getBlockNumber: async () => Promise.reject(new Error("rpc down")),
  getLogs: async () => Promise.reject(new Error("rpc down")),
  getTransaction: async () => Promise.reject(new Error("rpc down")),
};
assert.deepEqual(await checkSweep(down, RH, "0x058dC9a70EE9fB5678eD500F7FE69AF974C884b6", USDG), SWEEP_CLEAN, "fails open");
n += 1;

// Money that left a delegated wallet in a transaction another account sent is a sweep,
// whoever relayed it and wherever it went, the chain's Gloam vault included: Turnkey's
// paymaster relays for every Turnkey organization and its gas station takes any caller,
// so a relayed deposit proves nothing about who asked for it. A thief holding the key
// who relays each arrival into the vault (a note the thief holds) is flagged.
// The person's own connected Gloam wallet, whose sponsored deposits look the same, gets
// a quieter note and no hold (sweepVerdict), and only that wallet.
{
  const WALLET = "0x00000000000000000000000000000000000000a1" as Address;
  const TURNKEY_PAYMASTER = "0xdC77bc261D3E890FaA53c8910cD85173d9fb926d" as Address; // one of many senders seen calling the gas station
  const THIEF_BOT = "0x000000000000000000000000000000000000bad1" as Address;
  const THIEF = "0x000000000000000000000000000000000000beef" as Address;
  const STATION = "0x5aF5194B4b0909eB978e3Cf1e25333852277f07D" as Address;
  const VAULT = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194" as Address;
  const ARRIVAL = `0x${"aa".repeat(32)}` as Hex;
  const OUT = `0x${"dd".repeat(32)}` as Hex;
  const reader = (code: Hex, out: { recipient: Address; from: Address; to: Address } | null): SweepReader => ({
    getCode: async () => code,
    getBlockNumber: async () => BigInt(1_000),
    getLogs: async ({ args }) =>
      args.to
        ? [{ blockNumber: BigInt(900), transactionHash: ARRIVAL, args: { value: BigInt(50_000_000), to: WALLET } }]
        : out
          ? [{ blockNumber: BigInt(907), transactionHash: OUT, args: { value: BigInt(50_000_000), to: out.recipient } }]
          : [],
    getTransaction: async ({ hash }) => (hash === OUT ? { from: out!.from, to: out!.to } : { from: "0x00000000000000000000000000000000000000c3" as Address, to: USDG as Address }),
  });
  const turnkeyDelegate = "0xef0100955d84139e7621bc571b117d8eb5d28a4a222c6f" as Hex;
  const check = (out: { recipient: Address; from: Address; to: Address } | null) => checkSweep(reader(turnkeyDelegate, out), RH, WALLET, USDG);

  // the honest sponsored deposit: Turnkey's paymaster relays it into the vault through the gas station
  const honest = await check({ recipient: VAULT, from: TURNKEY_PAYMASTER, to: STATION });
  assert.equal(honest.swept?.evidenceTx, OUT, "on the chain alone it reads as a sweep");
  assert.equal(honest.delegated, null, "Turnkey's delegate is known");
  assert.equal(sweepVerdict(honest, { ownGloamWallet: true }), "own-wallet", "cashing out to one's own connected Gloam wallet: a note, no hold");
  assert.equal(sweepVerdict(honest, { ownGloamWallet: false }), "swept", "to anyone else's address it stays a warning");

  // a thief with the key relaying each arrival into the vault (a note the thief holds): flagged
  for (const via of [WALLET, STATION]) {
    const thief = await check({ recipient: VAULT, from: THIEF_BOT, to: via });
    assert.equal(thief.swept?.evidenceTx, OUT, `thief-relayed vault deposit via ${via === STATION ? "the gas station" : "the wallet"}: a sweep`);
    assert.equal(sweepVerdict(thief, { ownGloamWallet: false }), "swept");
  }
  // even relayed by the same paymaster Turnkey uses for everyone: flagged
  assert.equal((await check({ recipient: VAULT, from: TURNKEY_PAYMASTER, to: WALLET })).swept?.evidenceTx, OUT, "a paymaster-relayed deposit proves nothing on its own");
  // a relayed sweep to an outside address: flagged
  assert.equal((await check({ recipient: THIEF, from: THIEF_BOT, to: WALLET })).swept?.evidenceTx, OUT);
  // nothing left: clean, own wallet or not
  const quiet = await check(null);
  assert.deepEqual(quiet, SWEEP_CLEAN);
  assert.equal(sweepVerdict(quiet, { ownGloamWallet: false }), "clean");
  assert.equal(sweepVerdict(quiet, { ownGloamWallet: true }), "clean");
  assert.equal(sweepVerdict(null, { ownGloamWallet: false }), "clean", "a check that didn't answer is no warning");
  n += 13;
}

console.log(`sweep check: ${n} passed`);
