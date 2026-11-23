/**
 * Pay across notes end to end, on a local fork of Base mainnet (#402, lib/payAcross).
 *
 * Starts anvil forking Base mainnet, then, against the real Gloam vault, its
 * real verifiers and the real payment-memo board (forked, so nothing reaches
 * Base itself and no real money moves):
 *  1. a throwaway sender gets 21 USDC by storage write and makes three private
 *     deposits ($10, $7, $4) with real shield proofs on the ceremony's final keys
 *  2. it pays $20 to a Gloam address through the app's own planner and payroll
 *     engine (purpose "pay"): real transfer proofs, each part sent to the forked
 *     vault and its code posted to the forked memo board, the way the relay does
 *     (an impersonated account stands in for the relay's HTTP)
 *  3. the person paid finds every part with lib/autoReceive, reading the forked
 *     board, and secures one with lib/claimSweep (a real transfer proof)
 *  4. a second payment is stopped after its first part and resumed: no part goes
 *     out twice
 *  5. a third payment goes in ONE transaction (lib/relay/batch): every part and its
 *     message through Multicall3's aggregate3, as the relay sends it, all or nothing;
 *     its gas is set against steps 2 and 4, which went part by part
 * Checked: the parts add up, the change, every spent nullifier, the vault's
 * USDC accounting unchanged by private transfers, one submit per part.
 *
 * Nothing is broadcast to a real chain: every transaction goes to the local
 * anvil. No real key is used: accounts are impersonated on the fork.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/sim-pay-across-fork.mts
 * SIM_RPC sets the Base mainnet RPC to fork (default publicnode), ANVIL the anvil binary.
 */
import { localStorage } from "./browser-shim.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as snarkjs from "snarkjs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { makeBoundNotePoseidon, packGroth16Proof, type Groth16Proof } from "@gloamtrade/sdk";

// the app reads the network it is on from storage, before any of its modules load
localStorage.setItem("gloam.network", "base-mainnet");
const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;

const nets = await import("../src/lib/networks");
const shield = await import("../src/lib/shield");
const vault = await import("../src/lib/noteVault");
const payroll = await import("../src/lib/payroll");
const across = await import("../src/lib/payAcross");
const receive = await import("../src/lib/receiveTag");
const auto = await import("../src/lib/autoReceive");
const sweep = await import("../src/lib/claimSweep");
const treeSync = await import("../src/lib/treeSync");
const memo = await import("../src/lib/payMemo");
const relayBatch = await import("../src/lib/relay/batch");
const { circuitArtifactsFor } = await import("../src/lib/circuitArtifacts");
type LocalNote = import("../src/lib/shield").LocalNote;
type PayrollBatch = import("../src/lib/payroll").PayrollBatch;
type PayrollEngineDeps = import("../src/lib/payroll").PayrollEngineDeps;
type ClaimEnv = import("../src/lib/claimSweep").ClaimEnv;

const NET = nets.getNetwork("base-mainnet");
assert.equal(nets.getActiveNetwork().key, "base-mainnet", "the app is on Base");
const POOL = NET.pool as Address;
const BOARD = NET.payMemo!.address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const fmt = (raw: bigint) => `$${(Number(raw) / 1e6).toFixed(2)}`;

const SENDER = getAddress("0x5e0de200000000000000000000000000000000a1");
const RELAY = getAddress("0x5e0de200000000000000000000000000000000b2");
const RECIPIENT = getAddress("0x5e0de200000000000000000000000000000000c3");

// ------------------------------------------------------------------ anvil
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const anvilBin = process.env.ANVIL ?? `${homedir()}/.foundry/bin/anvil`;
const forkUrl = process.env.SIM_RPC ?? "https://base-rpc.publicnode.com";
const anvil = spawn(anvilBin, ["--fork-url", forkUrl, "--port", String(PORT), "--chain-id", "8453", "--silent"], { stdio: "ignore" });
const stopAnvil = () => {
  try {
    anvil.kill("SIGTERM");
  } catch {
    /* gone */
  }
};
process.on("exit", stopAnvil);

const client = createPublicClient({ chain: NET.chain, transport: http(RPC, { timeout: 120_000, retryCount: 2 }) }) as PublicClient;
const wallet = createWalletClient({ chain: NET.chain, transport: http(RPC, { timeout: 120_000 }) });
const rpc = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never });

for (let i = 0; ; i++) {
  try {
    if ((await client.getChainId()) === 8453) break;
  } catch {
    /* not up yet */
  }
  if (i > 120) throw new Error("anvil did not start");
  await new Promise((r) => setTimeout(r, 500));
}
const forkBlock = await client.getBlockNumber();
console.log(`anvil forking Base mainnet at block ${forkBlock} (${forkUrl})`);

for (const a of [SENDER, RELAY, RECIPIENT]) {
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, toHex(10n ** 18n)]);
}

// ------------------------------------------------------------------ proofs
const files = circuitArtifactsFor("production");
const local = (p: string) => fileURLToPath(new URL(`../public${p}`, import.meta.url));
for (const k of ["shieldWasm", "shieldZkey", "transferWasm", "transferZkey"] as const) {
  const got = createHash("sha256").update(readFileSync(local(files[k].path))).digest("hex");
  if (got !== files[k].sha256) throw new Error(`${files[k].path}: sha256 ${got}, the app expects ${files[k].sha256}`);
}
async function proveTransfer(input: Record<string, string | string[]>) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, local(files.transferWasm.path), local(files.transferZkey.path));
  return { proofBytes: packGroth16Proof(proof as Groth16Proof), publicSignals: publicSignals as string[] };
}

// ------------------------------------------------------------------ chain helpers
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const gasOf = new Map<Hex, bigint>();
async function send(from: Address, to: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({ account: from, address: to, abi: abi as never, functionName: functionName as never, args: args as never, chain: NET.chain });
  const r = await client.waitForTransactionReceipt({ hash });
  gasOf.set(hash, r.gasUsed);
  if (r.status !== "success" && functionName !== "transfer") throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}
const readVault = <T,>(functionName: string, args: readonly unknown[] = []) =>
  client.readContract({ address: POOL, abi: shield.shieldPoolAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

/** Writes `amount` USDC into `owner`'s balance on the fork: the balance mapping's slot, found by reading it back. */
async function giveUsdc(owner: Address, amount: bigint) {
  for (const base of [9n, 0n, 1n, 2n, 3n, 51n, 52n]) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, base]));
    await rpc("anvil_setStorageAt", [USDC, slot, toHex(amount, { size: 32 })]);
    if ((await client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [owner] })) === amount) return;
    await rpc("anvil_setStorageAt", [USDC, slot, toHex(0n, { size: 32 })]);
  }
  throw new Error("could not place the USDC balance");
}

let deposits = 0;
/** A private deposit, the way the app makes one: a bound note, a shield proof, shieldBound. */
async function deposit(amount: bigint): Promise<LocalNote> {
  const note = await makeBoundNotePoseidon(amount, USDC);
  const { proof } = await snarkjs.groth16.fullProve(
    { commitment: BigInt(note.commitment).toString(), amount: amount.toString(), asset: BigInt(USDC).toString(), secret: BigInt(note.secret).toString() },
    local(files.shieldWasm.path),
    local(files.shieldZkey.path)
  );
  const hash = await send(SENDER, POOL, shield.shieldPoolAbi, "shieldBound", [USDC, amount, note.commitment, packGroth16Proof(proof as Groth16Proof)]);
  const receipt = await client.getTransactionReceipt({ hash });
  const ev = parseEventLogs({ abi: shield.shieldPoolAbi, logs: receipt.logs, eventName: "Shielded" as never })[0] as unknown as { args: { leafIndex: bigint } } | undefined;
  assert.ok(ev, "the vault logged the deposit");
  const saved: LocalNote = {
    id: `fork-dep-${++deposits}`,
    chainId: NET.chainId,
    pool: POOL,
    asset: USDC,
    amountWei: amount.toString(),
    commitment: note.commitment as Hex,
    secret: note.secret as Hex,
    nullifier: note.nullifier as Hex,
    bound: true,
    scheme: "poseidon",
    from: SENDER,
    createdAt: Date.now(),
    status: "open",
    source: "local",
    leafIndex: Number(ev.args.leafIndex),
  };
  await shield.saveLocalNote(saved);
  console.log(`  deposit ${fmt(amount)}: leaf ${saved.leafIndex}, gas ${gasOf.get(hash)}`);
  return saved;
}

/** The relay's part, with an impersonated account in place of its HTTP: the same two calls it makes. */
type Submitted = { nullifier: Hex; hash: Hex };
function engineDeps(submitted: Submitted[], stopAfterFirstPaid = false): PayrollEngineDeps & { stopped: () => boolean } {
  let stop = false;
  return {
    client,
    submitTransfer: async (a) => {
      const hash = await send(RELAY, POOL, shield.shieldPoolAbi, "transfer", [a.proof, a.root, a.nullifier, a.commitments]);
      submitted.push({ nullifier: a.nullifier, hash });
      return hash;
    },
    submitMemo: async (m) => send(RELAY, BOARD, memo.payMemoAbi, "postMemo", [m.paymentCommitment, m.memo]),
    waitForTx: async (hash) => (await client.waitForTransactionReceipt({ hash })).status,
    onUpdate: (b) => {
      if (stopAfterFirstPaid && b.rows[0]?.status === "paid") stop = true;
    },
    shouldStop: () => stop,
    prove: proveTransfer,
    stopped: () => stop,
  };
}

async function storedRun(id: string): Promise<PayrollBatch> {
  const b = (await payroll.loadBatches(NET.chainId, POOL)).find((x) => x.id === id);
  assert.ok(b, "the run is stored");
  return b;
}

const results: string[] = [];
const ok = (line: string) => {
  results.push(`PASS ${line}`);
  console.log(`PASS ${line}`);
};

try {
  await vault.unlockNoteVault();
  const tag = (await receive.getOrCreateReceiveIdentity()).tag;
  const verifier = await readVault<Address>("verifier");
  console.log(`vault ${POOL}, transfer verifier ${verifier}, memo board ${BOARD}`);

  // ---------------------------------------------------------------- 1. three deposits
  await giveUsdc(SENDER, usd(40));
  await send(SENDER, USDC, erc20, "approve", [POOL, usd(40)]);
  console.log("1. three private deposits");
  for (const a of [10, 7, 4]) await deposit(usd(a));
  ok("1. $10, $7 and $4 deposited with real shield proofs, each its own note in the forked vault");

  // ---------------------------------------------------------------- 2. pay $20 across them
  const vaultUsdcBefore = await readVault<bigint>("deposited", [USDC]);
  const notes = shield.activeSpendableNotes(shield.loadLocalNotes(SENDER, NET)).filter((n) => n.asset.toLowerCase() === USDC.toLowerCase());
  const plan = across.planPayFrom(usd(20), notes);
  assert.ok(plan.ok, "the plan covers $20");
  assert.deepEqual(plan.parts, [usd(10), usd(7), usd(3)], "$10, $7, then $3 out of the $4");
  const run = across.newPayRun({ chainId: NET.chainId, pool: POOL, asset: USDC, payer: SENDER, tag, label: "@forktest", parts: plan.parts, noteIds: plan.noteIds, note: "Fork test" });
  await payroll.saveBatch(run);
  const submitted1: Submitted[] = [];
  console.log("2. paying $20 in parts (real transfer proofs, a few seconds each)");
  const t0 = performance.now();
  const done = await payroll.runPayroll(run, engineDeps(submitted1));
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  assert.equal(done.status, "done", `the run finished (rows: ${done.rows.map((r) => `${r.status}${r.error ? ` ${r.error}` : ""}`).join(", ")})`);
  assert.deepEqual(across.payRunProgress(done), { parts: 3, sent: 3, failed: 0, done: true, unconfirmed: false });
  assert.equal(submitted1.length, 3, "three transfers submitted, one per part");
  assert.equal(new Set(submitted1.map((s) => s.nullifier.toLowerCase())).size, 3, "each spends a different note");
  assert.deepEqual(done.rows.map((r) => r.spendNoteId), plan.noteIds, "each part spent the note it was planned on");
  for (const r of done.rows) {
    assert.equal(await readVault<boolean>("isSpent", [r.spendNullifier!]), true, "its note is spent in the vault");
    assert.equal(await readVault<boolean>("commitmentSeen", [r.paymentCommitment!]), true, "its payment is in the vault");
    assert.equal(r.memoPosted, true, "its code is on the memo board");
  }
  const vaultUsdcAfter = await readVault<bigint>("deposited", [USDC]);
  assert.equal(vaultUsdcAfter, vaultUsdcBefore, "private transfers leave the vault's USDC accounting unchanged");
  const change = shield.activeSpendableNotes(shield.loadLocalNotes(SENDER, NET)).filter((n) => n.asset.toLowerCase() === USDC.toLowerCase());
  assert.deepEqual(change.map((n) => n.amountWei), [usd(1).toString()], "$1 of change is the sender's whole balance now");
  const transferGas = submitted1.map((s) => gasOf.get(s.hash)!);
  const memoGas = [...gasOf.entries()].filter(([h]) => !submitted1.some((s) => s.hash === h)).slice(-3).map(([, g]) => g);
  ok(`2. $20 paid as ${done.rows.map((r) => fmt(BigInt(r.amount))).join(" + ")} in ${secs} s: 3 transfers (gas ${transferGas.join(", ")}) + 3 memos (gas ${memoGas.join(", ")}), each note spent once, change ${fmt(BigInt(change[0]!.amountWei))}, vault USDC unchanged at ${fmt(vaultUsdcAfter)}`);

  // ---------------------------------------------------------------- 3. the person paid
  console.log("3. the person paid reads the forked board");
  const landed = await auto.receiveWaitingPayments(NET, RECIPIENT, { client, force: true });
  assert.equal(landed.length, 3, `all three parts found (found ${landed.length})`);
  const got = landed.reduce((s, p) => s + BigInt(p.amountWei), 0n);
  assert.equal(got, usd(20), "they add up to exactly $20");
  assert.equal(landed.filter((p) => p.note === "Fork test").length, 1, "the private note comes once");
  const claims = shield.loadLocalNotes(RECIPIENT, NET).filter((n) => sweep.isUnsecuredClaim(n));
  assert.equal(claims.length, 3, "each saved as a claimed payment to secure");
  ok(`3a. autoReceive found ${landed.map((p) => p.label).join(" + ")} = ${fmt(got)} on the forked board, the note once`);

  const env: ClaimEnv = {
    chainId: NET.chainId,
    pool: POOL,
    chain: {
      isSpent: (n) => readVault<boolean>("isSpent", [n]),
      isCommitmentSeen: (c) => readVault<boolean>("commitmentSeen", [c]),
      pathForCommitment: async (c) => {
        const t = await treeSync.syncShieldTree(client, NET);
        const i = t?.indexByCommitment.get(c.toLowerCase());
        return i == null ? null : ((await t!.pathForLeaf(i)) as never);
      },
      waitForReceipt: async (hash) => ({ status: (await client.waitForTransactionReceipt({ hash })).status }),
    },
    prove: proveTransfer,
    relay: async (t) => send(RELAY, POOL, shield.shieldPoolAbi, "transfer", [t.proof, t.root, t.nullifier, t.commitments]),
    leafIndexOf: async (c) => (await treeSync.syncShieldTree(client, NET))?.indexByCommitment.get(c.toLowerCase()),
    txOutcome: async (hash) => {
      const r = await client.getTransactionReceipt({ hash }).catch(() => null);
      return r ? (r.status === "success" ? "success" : "reverted") : null;
    },
  };
  const toSecure = claims.find((n) => n.amountWei === usd(7).toString())!;
  const secured = await sweep.secureClaim(
    { note: toSecure, relay: true, sendWithWallet: () => Promise.reject(new Error("relay only")) },
    env
  );
  assert.equal(await readVault<boolean>("isSpent", [toSecure.nullifier!]), true, "the payer can no longer take it back");
  const fresh = shield.loadLocalNotes(RECIPIENT, NET).find((n) => n.sweptFrom?.id === toSecure.id);
  assert.ok(fresh, "the fresh note is saved");
  assert.equal(await readVault<boolean>("commitmentSeen", [fresh.commitment]), true, "the fresh note is in the vault");
  ok(`3b. secured the $7 part (${JSON.stringify((secured as { status?: string }).status ?? secured)}): its note spent, the fresh note only they know is in the vault`);

  // ---------------------------------------------------------------- 4. stop after one part, resume
  console.log("4. a second payment, stopped after its first part, then resumed");
  for (const a of [5, 3, 2]) await deposit(usd(a));
  const notes2 = shield.activeSpendableNotes(shield.loadLocalNotes(SENDER, NET)).filter((n) => n.asset.toLowerCase() === USDC.toLowerCase());
  const plan2 = across.planPayFrom(usd(9), notes2);
  assert.ok(plan2.ok);
  assert.deepEqual(plan2.parts, [usd(5), usd(3), usd(1)]);
  const run2 = across.newPayRun({ chainId: NET.chainId, pool: POOL, asset: USDC, payer: SENDER, tag, label: "@forktest", parts: plan2.parts, noteIds: plan2.noteIds });
  await payroll.saveBatch(run2);
  const submitted2: Submitted[] = [];
  const first = engineDeps(submitted2, true);
  const afterStop = await payroll.runPayroll(run2, first).catch((e) => (e instanceof payroll.PayrollStop ? null : Promise.reject(e)));
  const paused = afterStop ?? (await storedRun(run2.id));
  assert.equal(paused.rows[0]!.status, "paid", "the first part went out");
  assert.ok(paused.rows.slice(1).every((r) => r.status !== "paid" && !r.spendNullifier), "the rest did not");
  assert.equal(submitted2.length, 1, "one transfer before the stop");
  const resumed = await payroll.runPayroll(await storedRun(run2.id), engineDeps(submitted2));
  assert.equal(resumed.status, "done");
  assert.equal(submitted2.length, 3, "two more transfers on resume, three in all");
  assert.equal(new Set(submitted2.map((s) => s.nullifier.toLowerCase())).size, 3, "no part submitted twice");
  assert.equal(submitted2.filter((s) => s.nullifier.toLowerCase() === resumed.rows[0]!.spendNullifier!.toLowerCase()).length, 1, "the first part was not sent again");
  const landed2 = await auto.receiveWaitingPayments(NET, RECIPIENT, { client, force: true });
  assert.equal(landed2.reduce((s, p) => s + BigInt(p.amountWei), 0n), usd(9), "the person paid gets exactly $9 more");
  ok(`4. stopped after ${fmt(usd(5))}, resumed: ${resumed.rows.map((r) => fmt(BigInt(r.amount))).join(" + ")} = $9, 3 transfers in all, the first not resent, the person paid found ${landed2.length} more parts`);

  // ---------------------------------------------------------------- 5. one transaction
  console.log("5. a third payment, every part and its message in one transaction through Multicall3");
  const mcCode = await client.getCode({ address: relayBatch.MULTICALL3 });
  assert.equal(keccak256(mcCode!), relayBatch.MULTICALL3_CODEHASH, "Multicall3 on Base is the canonical one");
  await giveUsdc(SENDER, usd(40));
  await send(SENDER, USDC, erc20, "approve", [POOL, usd(40)]);
  for (const a of [6, 5, 4]) await deposit(usd(a));
  const notes3 = shield.activeSpendableNotes(shield.loadLocalNotes(SENDER, NET)).filter((n) => n.asset.toLowerCase() === USDC.toLowerCase());
  const plan3 = across.planPayFrom(usd(14), notes3);
  assert.ok(plan3.ok);
  assert.deepEqual(plan3.parts, [usd(6), usd(5), usd(3)]);
  const run3 = across.newPayRun({ chainId: NET.chainId, pool: POOL, asset: USDC, payer: SENDER, tag, label: "@forktest", parts: plan3.parts, noteIds: plan3.noteIds, note: "One go" });
  await payroll.saveBatch(run3);
  const singles3: Submitted[] = [];
  const batches3: Hex[] = [];
  const vaultUsdc3 = await readVault<bigint>("deposited", [USDC]);
  const t3 = performance.now();
  const done3 = await payroll.runPayroll(run3, {
    ...engineDeps(singles3),
    // the relay's batch, with an impersonated account in place of its HTTP: the same aggregate3 call it makes
    submitTransferBatch: async (parts) => {
      const hash = await send(RELAY, relayBatch.MULTICALL3, relayBatch.multicall3Abi, "aggregate3", [relayBatch.batchCalls(POOL, BOARD, parts)]);
      batches3.push(hash);
      return hash;
    },
    batchRefused: () => false,
  });
  const secs3 = ((performance.now() - t3) / 1000).toFixed(0);
  assert.equal(done3.status, "done", `the run finished (rows: ${done3.rows.map((r) => `${r.status}${r.error ? ` ${r.error}` : ""}`).join(", ")})`);
  assert.equal(batches3.length, 1, "one transaction");
  assert.equal(singles3.length, 0, "no part went on its own");
  const r3 = await client.getTransactionReceipt({ hash: batches3[0]! });
  assert.equal(r3.status, "success");
  const memoLogs = r3.logs.filter((l) => l.address.toLowerCase() === BOARD.toLowerCase());
  assert.equal(memoLogs.length, 3, "three payment messages in the same transaction");
  for (const r of done3.rows) {
    assert.equal(r.txHash, batches3[0], "every part settled from the one transaction");
    assert.equal(await readVault<boolean>("isSpent", [r.spendNullifier!]), true);
    assert.equal(await readVault<boolean>("commitmentSeen", [r.paymentCommitment!]), true);
    assert.equal(r.memoPosted, true);
  }
  assert.equal(await readVault<bigint>("deposited", [USDC]), vaultUsdc3, "the vault's USDC accounting unchanged");
  const landed3 = await auto.receiveWaitingPayments(NET, RECIPIENT, { client, force: true });
  assert.equal(landed3.reduce((s, p) => s + BigInt(p.amountWei), 0n), usd(14), "the person paid gets exactly $14");
  const batchGas = gasOf.get(batches3[0]!)!;
  const partGas2 = transferGas.reduce((a, b) => a + b, 0n) + memoGas.reduce((a, b) => a + b, 0n);
  ok(`5. $14 as ${done3.rows.map((r) => fmt(BigInt(r.amount))).join(" + ")} in ONE transaction in ${secs3} s: gas ${batchGas} for 3 transfers + 3 messages, against ${partGas2} for step 2's 6 separate transactions (${(Number(batchGas) / Number(partGas2) * 100).toFixed(1)}%); the person paid found ${landed3.length} parts`);

  console.log(`\n${results.length} of 6 checks passed. Fork at Base block ${forkBlock}; every transaction went to the local anvil.`);
  stopAnvil();
  process.exit(0);
} catch (e) {
  console.error("FAIL", e);
  console.log(results.join("\n"));
  stopAnvil();
  process.exit(1);
}
