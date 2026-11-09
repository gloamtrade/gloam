/**
 * A proof made before a fee rise, sent after it, on a local fork of Base
 * Sepolia. Nothing here reaches a real network: the owner is impersonated and
 * the three days of the timelock pass inside the fork.
 *
 * A proof binds the amount and the recipient, not the fee, and unshield reads
 * withdrawFeeBps when it runs. So the old proof must still land, the recipient
 * must get the new rate, and the outcome must report what the pool kept.
 *
 *   BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com pnpm --filter @gloamtrade/game-plugin-gloam test:fork
 *
 * Skipped without BASE_SEPOLIA_RPC_URL or without anvil.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SEPOLIA_USDC } from "@gloamtrade/sdk";
import { createWalletClient, encodeFunctionData, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { GloamAgent, shutdownProver, walletCallSender, type CallSender } from "../src/index.ts";
import { ERC20, findAnvil, startFork, type Fork } from "./fork/harness.mts";

const UPSTREAM = process.env.BASE_SEPOLIA_RPC_URL?.trim();
const SKIP = !UPSTREAM ? "set BASE_SEPOLIA_RPC_URL to run the fork test" : !findAnvil() ? "anvil not found" : false;
const USDC_HOLDER = (process.env.GLOAM_FORK_USDC_HOLDER?.trim() || "0xfaec9cdc3ef75713b48f46057b98ba04885e3391") as Address;
const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "circuits");
const usdc = (v: string) => parseUnits(v, 6);
const log = (m: string) => console.log(`  [fork] ${m}`);

const VAULT = parseAbi([
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function withdrawFeeBps() view returns (uint16)",
  "function setWithdrawFee(uint16 bps, address recipient)",
  "function queueChange(bytes call)",
  "function executeChange(bytes call)",
]);
const THREE_DAYS = 3 * 24 * 60 * 60;

let fork: Fork;

before(async () => {
  if (!SKIP) fork = await startFork({ upstream: UPSTREAM!, chainId: 84532, log });
});

after(async () => {
  await shutdownProver();
  await fork?.stop();
});

/** The fee change as the owner makes it: queued, three days on, executed. */
async function raiseFee(pool: Address, bps: number) {
  const read = <T,>(functionName: "owner" | "feeRecipient" | "withdrawFeeBps") =>
    fork.client.readContract({ address: pool, abi: VAULT, functionName }) as Promise<T>;
  const owner = await read<Address>("owner");
  const change = encodeFunctionData({ abi: VAULT, functionName: "setWithdrawFee", args: [bps, await read<Address>("feeRecipient")] });
  await fork.sendAs(owner, pool, encodeFunctionData({ abi: VAULT, functionName: "queueChange", args: [change] }));
  await fork.rpc("evm_increaseTime", [THREE_DAYS + 1]);
  await fork.rpc("anvil_mine", ["0x1"]);
  await fork.sendAs(owner, pool, encodeFunctionData({ abi: VAULT, functionName: "executeChange", args: [change] }));
}

test("a cash out proven at 0.25% still lands after the rise, and pays the new fee", { skip: SKIP, timeout: 20 * 60_000 }, async () => {
  const me = await fork.newKey();
  const carol = (await fork.newKey(0n)).address;
  await fork.sendFromHolder(BASE_SEPOLIA_USDC, USDC_HOLDER, me.address, usdc("10"));

  // The proof is made inside cashOut, before this runs: the rise lands between the two.
  const wallet = createWalletClient({ account: privateKeyToAccount(me.key as Hex), chain: baseSepolia, transport: http(fork.url) });
  const direct = walletCallSender(wallet, fork.client);
  let riseFirst: (() => Promise<void>) | null = null;
  const sender: CallSender = {
    address: direct.address,
    async sendCalls(calls) {
      const rise = riseFirst;
      riseFirst = null;
      if (rise) await rise();
      return direct.sendCalls(calls);
    },
  };

  const dir = mkdtempSync(join(tmpdir(), "gloam-fork-feerise-"));
  const agent = new GloamAgent({
    network: "base",
    rpc: fork.url,
    submit: "wallet",
    agentId: "feerise",
    dataDir: dir,
    env: { GLOAM_AGENT_PRIVATE_KEY: me.key, GLOAM_NOTE_STORE: join(dir, "notes.json") },
    artifacts: { dir: CIRCUITS, url: "http://127.0.0.1:1/never" },
    limits: { recipients: "any", assets: { USDC: { maxPerPayment: "20", maxPerDay: "60" } } },
    publicClient: fork.client,
    sender,
  });
  const pool = agent.network.pool;

  const added = await agent.add({ amount: "5" });
  assert.equal(added.status, "done", JSON.stringify(added));
  const feeNow = () => fork.client.readContract({ address: pool, abi: VAULT, functionName: "withdrawFeeBps" });
  assert.equal(await feeNow(), 25, "Base Sepolia starts at 0.25%");

  riseFirst = () => raiseFee(pool, 50);
  const out = await agent.cashOut({ amount: "5", to: carol });
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.equal(riseFirst, null, "the rise landed after the proof and before the send");
  assert.equal(await feeNow(), 50);

  const got = await fork.client.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20, functionName: "balanceOf", args: [carol] });
  assert.equal(got, 4_975_000n, "the old proof paid 5 USDC less 0.5%, not 4.9875");
  assert.equal(out.fee, "0.025 USDC", "the outcome reports what the pool kept");
  assert.equal(out.received, "4.975 USDC");
  log(`a 5 USDC cash out proven at 0.25% landed at 0.5%: carol got ${out.received}, the pool kept ${out.fee} (${out.hash})`);
});
