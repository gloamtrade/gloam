/**
 * Cash out across balances end to end on a local fork of Base mainnet.
 *
 * Starts anvil forking Base mainnet, then, against the real Gloam vault, its
 * verifiers and the ceremony's final keys:
 *  1. three private deposits of $10, $7 and $4 (real shield proofs);
 *  2. a cash out of $20 to one address through lib/cashOutAcross: $10, $7, and
 *     $3 set aside from the $4 first (a real transfer proof, $1 of change),
 *     then three cash outs (real unshield proofs). The address gets exactly
 *     $20 less the vault's fee on each part, each note is paid out once, the
 *     $1 change stays private in the vault;
 *  3. a second cash out ($5, $3, $2 for $9) stopped after its first part, then
 *     resumed: the first part is not sent again.
 *
 * Nothing goes to a real chain: every transaction goes to the local anvil, and
 * the relay's HTTP is stood in for by an impersonated account making the same
 * call it makes. No real key is used.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/sim-cashout-across-fork.mts
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
import { buildPoseidonUnshieldWitness, buildTransferWitness, fieldToBytes32, makeBoundNotePoseidon, packGroth16Proof, type Groth16Proof } from "@gloamtrade/sdk";

localStorage.setItem("gloam.network", "base-mainnet");
const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;

const nets = await import("../src/lib/networks");
const shield = await import("../src/lib/shield");
const vault = await import("../src/lib/noteVault");
const C = await import("../src/lib/cashOutAcross");
const store = await import("../src/lib/cashOutAcrossStore");
const split = await import("../src/lib/cashOutSplit");
const treeSync = await import("../src/lib/treeSync");
const { circuitArtifactsFor } = await import("../src/lib/circuitArtifacts");
type LocalNote = import("../src/lib/shield").LocalNote;
type CashOutAcrossDeps = import("../src/lib/cashOutAcross").CashOutAcrossDeps;
type PoseidonMerklePath = import("../src/lib/merklePoseidon").PoseidonMerklePath;

const NET = nets.getNetwork("base-mainnet");
assert.ok(NET.pool, "Base mainnet has a vault");
const POOL = NET.pool as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const fmt = (raw: bigint) => `$${(Number(raw) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

const SENDER = getAddress("0x5e0de200000000000000000000000000000000a1");
const RELAY = getAddress("0x5e0de200000000000000000000000000000000b2");
const TO = getAddress("0x5e0de200000000000000000000000000000000d4");

// ------------------------------------------------------------------ anvil
const PORT = 8548;
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
for (const a of [SENDER, RELAY]) {
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, toHex(10n ** 18n)]);
}

// ------------------------------------------------------------------ proofs
const files = circuitArtifactsFor("production");
const local = (p: string) => fileURLToPath(new URL(`../public${p}`, import.meta.url));
for (const k of ["shieldWasm", "shieldZkey", "transferWasm", "transferZkey", "unshieldWasm", "unshieldZkey"] as const) {
  const got = createHash("sha256").update(readFileSync(local(files[k].path))).digest("hex");
  if (got !== files[k].sha256) throw new Error(`${files[k].path}: sha256 ${got}, the app expects ${files[k].sha256}`);
}
const prove = async (input: Record<string, string | string[]>, wasm: string, zkey: string) => {
  const { proof } = await snarkjs.groth16.fullProve(input, local(wasm), local(zkey));
  return packGroth16Proof(proof as Groth16Proof);
};

// ------------------------------------------------------------------ chain helpers
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const gasOf = new Map<Hex, bigint>();
async function send(from: Address, to: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({ account: from, address: to, abi: abi as never, functionName: functionName as never, args: args as never, chain: NET.chain });
  const r = await client.waitForTransactionReceipt({ hash });
  gasOf.set(hash, r.gasUsed);
  return hash;
}
const readVault = <T,>(functionName: string, args: readonly unknown[] = []) =>
  client.readContract({ address: POOL, abi: shield.shieldPoolAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
const usdcOf = (a: Address) => client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

async function giveUsdc(owner: Address, amount: bigint) {
  for (const base of [9n, 0n, 1n, 2n, 3n, 51n, 52n]) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, base]));
    await rpc("anvil_setStorageAt", [USDC, slot, toHex(amount, { size: 32 })]);
    if ((await usdcOf(owner)) === amount) return;
    await rpc("anvil_setStorageAt", [USDC, slot, toHex(0n, { size: 32 })]);
  }
  throw new Error("could not place the USDC balance");
}

let deposits = 0;
async function deposit(amount: bigint): Promise<LocalNote> {
  const note = await makeBoundNotePoseidon(amount, USDC);
  const proof = await prove(
    { commitment: BigInt(note.commitment).toString(), amount: amount.toString(), asset: BigInt(USDC).toString(), secret: BigInt(note.secret).toString() },
    files.shieldWasm.path,
    files.shieldZkey.path
  );
  const hash = await send(SENDER, POOL, shield.shieldPoolAbi, "shieldBound", [USDC, amount, note.commitment, proof]);
  const receipt = await client.getTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", "the deposit landed");
  const ev = parseEventLogs({ abi: shield.shieldPoolAbi, logs: receipt.logs, eventName: "Shielded" as never })[0] as unknown as { args: { leafIndex: bigint } };
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

async function pathOf(commitment: Hex): Promise<PoseidonMerklePath> {
  const t = await treeSync.syncShieldTree(client, NET);
  const i = t?.indexByCommitment.get(commitment.toLowerCase());
  assert.ok(t && i != null, "the note is in the forked vault's tree");
  return (await t.pathForLeaf(i)) as PoseidonMerklePath;
}

type Sent = { kind: "transfer" | "unshield"; nullifier: Hex; hash: Hex; amount?: bigint };
/** The engine's deps on the fork: real proofs, the relay's calls from an impersonated account. */
function deps(sent: Sent[], stopAfterFirstPaid = false): CashOutAcrossDeps {
  let stop = false;
  return {
    load: store.loadCashOutRun,
    save: store.saveCashOutRun,
    getNote: (id) => vault.getAllNotes().find((n) => n.id === id),
    findSplitPart: (noteId, amount) => vault.getAllNotes().find((n) => n.sweptFrom?.id === noteId && BigInt(n.amountWei) === amount && n.status === "open"),
    split: async (from, amount) => {
      const w = await buildTransferWitness({ secretHex: from.secret!, amountIn: BigInt(from.amountWei), amountPay: amount, asset: from.asset, path: await pathOf(from.commitment) });
      if (w.blocker) throw new Error(w.blocker);
      const proof = await prove(w.circomInput as Record<string, string | string[]>, files.transferWasm.path, files.transferZkey.path);
      const nullifier = fieldToBytes32(w.publicInputs.nullifier) as Hex;
      const made = split.splitNotes(from, w, nullifier, SENDER, Date.now());
      await shield.saveLocalNote({ ...made.part, sweepPending: true });
      if (made.change) await shield.saveLocalNote({ ...made.change, sweepPending: true });
      const hash = await send(RELAY, POOL, shield.shieldPoolAbi, "transfer", [
        proof,
        fieldToBytes32(w.publicInputs.root),
        nullifier,
        [fieldToBytes32(w.publicInputs.newCommitment0), fieldToBytes32(w.publicInputs.newCommitment1)],
      ]);
      sent.push({ kind: "transfer", nullifier, hash });
      const t = await treeSync.syncShieldTree(client, NET);
      shield.updateLocalNote(from.id, { status: "recovered", txHash: hash });
      const partAt = t?.indexByCommitment.get(made.part.commitment.toLowerCase());
      shield.updateLocalNote(made.part.id, { sweepPending: false, txHash: hash, leafIndex: partAt });
      if (made.change) shield.updateLocalNote(made.change.id, { sweepPending: false, txHash: hash, leafIndex: t?.indexByCommitment.get(made.change.commitment.toLowerCase()) });
      return { ...made.part, sweepPending: false, txHash: hash, leafIndex: partAt };
    },
    prove: async (note, to) => {
      const w = await buildPoseidonUnshieldWitness({ secretHex: note.secret!, amount: BigInt(note.amountWei), asset: note.asset, to, path: await pathOf(note.commitment) });
      assert.ok(w.checks.commitmentMatches, "the note opens its commitment");
      const proof = await prove(w.circomInput as Record<string, string | string[]>, files.unshieldWasm.path, files.unshieldZkey.path);
      return { chainId: NET.chainId, proof, root: fieldToBytes32(w.publicInputs.root) as Hex, nullifier: fieldToBytes32(w.publicInputs.nullifier) as Hex, asset: note.asset as Address, to, amount: BigInt(note.amountWei) };
    },
    submit: async (call) => {
      const hash = await send(RELAY, POOL, shield.shieldPoolAbi, "unshield", [call.proof, call.root, call.nullifier, call.asset, call.to, call.amount]);
      sent.push({ kind: "unshield", nullifier: call.nullifier, hash, amount: call.amount });
      return hash;
    },
    maybeSent: () => false,
    waitForTx: async (h) => (await client.waitForTransactionReceipt({ hash: h })).status,
    isSpent: (n) => readVault<boolean>("isSpent", [n]),
    markSpent: (id, hash) => shield.updateLocalNote(id, { status: "recovered", txHash: hash }),
    onUpdate: (r) => {
      if (stopAfterFirstPaid && r.parts[0]?.status === "paid") stop = true;
    },
    shouldStop: () => stop,
  };
}

const results: string[] = [];
const ok = (line: string) => {
  results.push(`PASS ${line}`);
  console.log(`PASS ${line}`);
};

try {
  await vault.unlockNoteVault();
  const bps = Number(await readVault<bigint | number>("withdrawFeeBps"));
  const feeOf = (a: bigint) => shield.withdrawFeeOf(a, bps);
  console.log(`vault ${POOL}, cash-out fee ${bps / 100}%`);

  // ---------------------------------------------------------------- 1. deposits
  await giveUsdc(SENDER, usd(40));
  await send(SENDER, USDC, erc20, "approve", [POOL, usd(40)]);
  console.log("1. three private deposits");
  const [ten, seven, four] = [await deposit(usd(10)), await deposit(usd(7)), await deposit(usd(4))];
  ok("1. $10, $7 and $4 deposited with real shield proofs, each its own note");

  // ---------------------------------------------------------------- 2. cash out $20 across them
  const notes = shield
    .activeSpendableNotes(shield.loadLocalNotes(SENDER, NET))
    .filter((n) => n.asset.toLowerCase() === USDC.toLowerCase() && C.cashOutAcrossEligible(n));
  const plan = C.planCashOutFrom(usd(20), notes);
  assert.ok(plan.ok, "the plan covers $20");
  assert.deepEqual(plan.parts, [usd(10), usd(7), usd(3)]);
  const amounts: Record<string, string> = {};
  for (const n of notes) amounts[n.id] = n.amountWei;
  const run = C.newCashOutRun({ chainId: NET.chainId, pool: POOL, asset: USDC, owner: SENDER, to: TO, relay: true, parts: plan.parts, noteIds: plan.noteIds, noteAmounts: amounts });
  const begun = await C.startCashOutRun(run, { loadAll: store.loadCashOutRuns, save: store.saveCashOutRun });
  assert.ok(begun.started);
  const toBefore = await usdcOf(TO);
  const vaultBefore = await readVault<bigint>("deposited", [USDC]);
  const sent1: Sent[] = [];
  console.log("2. cashing out $20 across three balances (real transfer and unshield proofs)");
  const t0 = performance.now();
  const done = await C.runCashOutAcross(run, deps(sent1));
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  assert.equal(done.status, "done", `finished (${done.parts.map((p) => `${p.status}${p.error ? ` ${p.error}` : ""}`).join(", ")})`);
  assert.deepEqual(done.parts.map((p) => p.status), ["paid", "paid", "paid"]);
  const unshields = sent1.filter((s) => s.kind === "unshield");
  const transfers = sent1.filter((s) => s.kind === "transfer");
  assert.equal(unshields.length, 3, "three cash outs");
  assert.equal(transfers.length, 1, "one set-aside step, for the last part only");
  assert.equal(new Set(unshields.map((s) => s.nullifier.toLowerCase())).size, 3, "each note paid out once");
  const expected = C.cashOutAcrossReceived(plan.parts, feeOf);
  const got = (await usdcOf(TO)) - toBefore;
  assert.equal(got, expected, `the wallet got ${fmt(got)}, expected ${fmt(expected)}`);
  assert.equal(vaultBefore - (await readVault<bigint>("deposited", [USDC])), usd(20), "$20 left the vault's accounting");
  for (const n of [ten, seven, four]) assert.equal(await readVault<boolean>("isSpent", [n.nullifier!]), true, "every planned note is spent");
  const change = shield.activeSpendableNotes(shield.loadLocalNotes(SENDER, NET)).filter((n) => n.asset.toLowerCase() === USDC.toLowerCase());
  assert.deepEqual(change.map((n) => n.amountWei), [usd(1).toString()], "$1 of change is the balance left");
  assert.equal(await readVault<boolean>("commitmentSeen", [change[0]!.commitment]), true, "and it's in the vault");
  ok(
    `2. $20 cashed out as ${done.parts.map((p) => fmt(BigInt(p.amount))).join(" + ")} in ${secs} s: the wallet got ${fmt(got)} (${bps / 100}% fee on each, ${fmt(usd(20) - got)} in all); 1 set-aside transfer (gas ${gasOf.get(transfers[0]!.hash)}) + 3 unshields (gas ${unshields.map((s) => gasOf.get(s.hash)).join(", ")}); each note paid out once, $1 change in the vault`
  );

  // ---------------------------------------------------------------- 3. stop after one, resume
  console.log("3. a second cash out, stopped after its first part, then resumed");
  for (const a of [5, 3, 2]) await deposit(usd(a));
  const notes2 = shield.activeSpendableNotes(shield.loadLocalNotes(SENDER, NET)).filter((n) => n.asset.toLowerCase() === USDC.toLowerCase() && n.amountWei !== usd(1).toString());
  const plan2 = C.planCashOutFrom(usd(9), notes2);
  assert.ok(plan2.ok);
  assert.deepEqual(plan2.parts, [usd(5), usd(3), usd(1)]);
  const amounts2: Record<string, string> = {};
  for (const n of notes2) amounts2[n.id] = n.amountWei;
  const run2 = C.newCashOutRun({ chainId: NET.chainId, pool: POOL, asset: USDC, owner: SENDER, to: TO, relay: true, parts: plan2.parts, noteIds: plan2.noteIds, noteAmounts: amounts2 });
  assert.ok((await C.startCashOutRun(run2, { loadAll: store.loadCashOutRuns, save: store.saveCashOutRun })).started);
  const before2 = await usdcOf(TO);
  const sent2: Sent[] = [];
  const paused = await C.runCashOutAcross(run2, deps(sent2, true));
  assert.equal(paused.status, "running");
  assert.equal(paused.parts[0]!.status, "paid", "the first part went");
  assert.ok(paused.parts.slice(1).every((p) => p.status === "queued"), "the rest did not");
  const resumed = await C.runCashOutAcross(run2, deps(sent2));
  assert.equal(resumed.status, "done");
  const un2 = sent2.filter((s) => s.kind === "unshield");
  assert.equal(un2.length, 3, "three cash outs in all");
  assert.equal(un2.filter((s) => s.nullifier.toLowerCase() === resumed.parts[0]!.nullifier!.toLowerCase()).length, 1, "the first part was not sent again");
  const got2 = (await usdcOf(TO)) - before2;
  assert.equal(got2, C.cashOutAcrossReceived(plan2.parts, feeOf));
  ok(`3. stopped after ${fmt(usd(5))}, resumed: ${resumed.parts.map((p) => fmt(BigInt(p.amount))).join(" + ")} = $9, 3 cash outs in all, the first not resent, the wallet got ${fmt(got2)}`);

  console.log(`\n${results.length} of 3 checks passed. Fork at Base block ${forkBlock}; every transaction went to the local anvil.`);
} catch (e) {
  console.error(results.join("\n"));
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  stopAnvil();
}
