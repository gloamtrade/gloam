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
 * Steps 1 to 3 send part by part, the relay's HTTP stood in for by an impersonated
 * account making the same call it makes. Steps 4 to 6 go through the real relay:
 * the app's relay client, /api/relay and lib/relay/server, every check included,
 * signing with anvil's first test key:
 *  4. $20 over $10, $7 and $4 again, through the relay, every cash out in ONE
 *     transaction through Multicall3 (lib/relay/batch): one set-aside transfer and
 *     one batch, 2 relay transactions against step 2's 4; tx count, gas and time
 *     set against step 2;
 *  5. a batch whose answer is lost on the way back (it went out): the run holds,
 *     and resume settles every part from the chain (the vault's log), nothing sent
 *     again;
 *  6. a relay that doesn't know the batch (an older one): the parts go one by one
 *     through the relay, in the same run, not an error.
 *
 * Nothing goes to a real chain: every transaction goes to the local anvil. fetch
 * is guarded: /api/relay goes to the route in this process, the anvil's URL to the
 * anvil, and anything else is refused and counted (the run fails if any was tried).
 * The only key is anvil's first test key, on the fork alone.
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
  parseAbiItem,
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
const PORT = Number(process.env.SIM_PORT ?? 8548);
const RPC = `http://127.0.0.1:${PORT}`;
// The relay (steps 4 to 6) reads and sends through the anvil alone, as its private RPC,
// with anvil's first test key. No Redis and no Chainalysis key: locks in memory, the
// sanctions list from the snapshot.
process.env.GLOAM_RPC_URL_8453 = RPC;
process.env.GLOAM_RELAYER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
delete process.env.GLOAM_RELAYER_PRIVATE_KEYS;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.CHAINALYSIS_API_KEY;
const anvilBin = process.env.ANVIL ?? `${homedir()}/.foundry/bin/anvil`;
const forkUrl = process.env.SIM_RPC ?? "https://base-rpc.publicnode.com";
// SIM_BLOCK_TIME (seconds) mines on a clock, as Base does every 2 s; unset, every transaction mines at once
const blockTime = process.env.SIM_BLOCK_TIME ? ["--block-time", process.env.SIM_BLOCK_TIME] : [];
const anvil = spawn(anvilBin, ["--fork-url", forkUrl, "--port", String(PORT), "--chain-id", "8453", "--silent", ...blockTime], { stdio: "ignore" });
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
console.log(`anvil forking Base mainnet at block ${forkBlock} (${forkUrl})${blockTime.length ? `, a block every ${process.env.SIM_BLOCK_TIME} s` : ""}`);

// ------------------------------------------------------------------ the relay, in this process
const relayClient = await import("../src/lib/relay/client");
const relayBatch = await import("../src/lib/relay/batch");
const { POST: relayPost } = await import("../src/app/api/relay/route");
const { cashOutTogetherRefused, splitMaybeSent } = await import("../src/lib/cashOutSplit");
const realFetch = globalThis.fetch;
/** Calls the guard refused: the URL and the JSON-RPC methods in it. */
const refusedUrls: { url: string; methods: string[] }[] = [];
const SENDS = /^eth_send(Raw)?Transaction$/;
/** How the next unshieldBatch answer comes back: as sent, lost after it went out, or as an older relay answers. */
let batchAnswer: "as-sent" | "lost" | "old-relay" = "as-sent";
/** The hash of the batch whose answer was lost. */
let lostHash: Hex | null = null;
const relayCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "/api/relay") {
    const body = JSON.parse(String(init?.body)) as { action?: string };
    relayCalls.push(String(body.action));
    if (body.action === "unshieldBatch" && batchAnswer === "old-relay") {
      batchAnswer = "as-sent";
      // what a relay without the action answers (the route's default case)
      return new Response(JSON.stringify({ ok: false, error: "Unknown action.", code: "bad_request" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const res = await relayPost(new Request("http://localhost/api/relay", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" }, body: init?.body as string }));
    if (body.action === "unshieldBatch" && batchAnswer === "lost") {
      batchAnswer = "as-sent";
      // it went out; the answer never got back
      const said = (await res.json()) as { ok?: boolean; hash?: Hex; code?: string; error?: string };
      if (!said.ok) throw new Error(`the relay refused the batch whose answer was to be lost: ${said.code} ${said.error}`);
      lostHash = said.hash ?? null;
      throw new TypeError("fetch failed");
    }
    return res;
  }
  if (url.startsWith(RPC)) return realFetch(input, init);
  let methods: string[] = [];
  try {
    const parsed = JSON.parse(String(init?.body ?? "null")) as { method?: string } | { method?: string }[] | null;
    methods = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map((x) => String(x.method));
  } catch {
    /* not JSON-RPC */
  }
  refusedUrls.push({ url, methods });
  if (process.env.SIM_DEBUG) console.warn("refused", url, init?.body ? String(init.body).slice(0, 120) : "", new Error().stack?.split("\n").slice(2, 9).join("\n"));
  throw new TypeError(`sim-cashout-across-fork: no call to ${url}`);
}) as typeof fetch;
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

type Sent = { kind: "transfer" | "unshield" | "batch"; nullifier: Hex; hash: Hex; amount?: bigint };
const UNSHIELDED = parseAbiItem("event Unshielded(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount)");
/**
 * The engine's deps on the fork: real proofs. `via` "impersonated": the relay's calls from an
 * impersonated account, part by part. "relay": the app's relay client through /api/relay and
 * lib/relay/server, with every part in one transaction where the relay takes it, as
 * components/app/CashOutAcross sets it up.
 */
function deps(sent: Sent[], stopAfterFirstPaid = false, via: "impersonated" | "relay" = "impersonated", feeBps = 0): CashOutAcrossDeps {
  let stop = false;
  const viaRelay = via === "relay";
  const landed = async (hash: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash });
    gasOf.set(hash, r.gasUsed);
    return r;
  };
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
      const args = [
        proof,
        fieldToBytes32(w.publicInputs.root),
        nullifier,
        [fieldToBytes32(w.publicInputs.newCommitment0), fieldToBytes32(w.publicInputs.newCommitment1)],
      ] as const;
      let hash: Hex;
      if (viaRelay) {
        hash = await relayClient.relayTransfer({ chainId: NET.chainId, proof: args[0], root: args[1], nullifier: args[2], commitments: args[3] });
        assert.equal((await landed(hash)).status, "success", "the set-aside landed");
      } else {
        hash = await send(RELAY, POOL, shield.shieldPoolAbi, "transfer", args);
      }
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
      const hash = viaRelay
        ? await relayClient.relayUnshield(call)
        : await send(RELAY, POOL, shield.shieldPoolAbi, "unshield", [call.proof, call.root, call.nullifier, call.asset, call.to, call.amount]);
      sent.push({ kind: "unshield", nullifier: call.nullifier, hash, amount: call.amount });
      return hash;
    },
    ...(viaRelay
      ? {
          submitTogether: async (calls: Awaited<ReturnType<CashOutAcrossDeps["prove"]>>[]) => {
            const hash = await relayClient.relayUnshieldBatch({ chainId: NET.chainId, pool: POOL, feeBps, parts: calls });
            for (const c of calls) sent.push({ kind: "batch", nullifier: c.nullifier, hash, amount: c.amount });
            return hash;
          },
          togetherRefused: cashOutTogetherRefused,
        }
      : {}),
    maybeSent: (e) => (viaRelay ? splitMaybeSent(e, true) : false),
    waitForTx: async (h) => (await landed(h)).status,
    isSpent: (n) => readVault<boolean>("isSpent", [n]),
    blockNumber: () => client.getBlockNumber(),
    payoutOf: async (nullifier, from) => {
      const logs = await client.getLogs({ address: POOL, event: UNSHIELDED, args: { nullifier }, fromBlock: from, toBlock: "latest" });
      const hit = logs[0]?.args;
      return hit?.to && hit.amount != null ? { to: hit.to, amount: hit.amount } : null;
    },
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
  // the vault's tree read once before the clock starts, so step 2 and step 4 are timed alike
  // (a cold read of every leaf took most of the first run's 55 s)
  const tw = performance.now();
  await treeSync.syncShieldTree(client, NET);
  console.log(`  the vault's tree read in ${((performance.now() - tw) / 1000).toFixed(0)} s`);
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
  const step2Gas = gasOf.get(transfers[0]!.hash)! + unshields.reduce((sum, u) => sum + gasOf.get(u.hash)!, 0n);
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

  // ---------------------------------------------------------------- 4. through the relay, in one transaction
  console.log("4. $20 over $10, $7 and $4 again, through the relay: every cash out in one transaction");
  const mcCode = await client.getCode({ address: relayBatch.MULTICALL3 });
  assert.equal(keccak256(mcCode!), relayBatch.MULTICALL3_CODEHASH, "Multicall3 on Base is the canonical one");
  await giveUsdc(SENDER, usd(60));
  await send(SENDER, USDC, erc20, "approve", [POOL, usd(60)]);
  const fresh4 = [await deposit(usd(10)), await deposit(usd(7)), await deposit(usd(4))];
  const newRun = (parts: bigint[], noteIds: string[], from: LocalNote[]) =>
    C.newCashOutRun({
      chainId: NET.chainId,
      pool: POOL,
      asset: USDC,
      owner: SENDER,
      to: TO,
      relay: true,
      feeBps: bps,
      parts,
      noteIds,
      noteAmounts: Object.fromEntries(from.map((n) => [n.id, n.amountWei])),
    });
  const plan4 = C.planCashOutFrom(usd(20), fresh4);
  assert.ok(plan4.ok);
  assert.deepEqual(plan4.parts, [usd(10), usd(7), usd(3)], "the same parts as step 2");
  const run4 = newRun(plan4.parts, plan4.noteIds, fresh4);
  assert.ok((await C.startCashOutRun(run4, { loadAll: store.loadCashOutRuns, save: store.saveCashOutRun })).started);
  const before4 = await usdcOf(TO);
  const vault4 = await readVault<bigint>("deposited", [USDC]);
  const sent4: Sent[] = [];
  relayCalls.length = 0;
  const t4 = performance.now();
  const done4 = await C.runCashOutAcross(run4, deps(sent4, false, "relay", bps));
  const secs4 = ((performance.now() - t4) / 1000).toFixed(0);
  assert.equal(done4.status, "done", `finished (${done4.parts.map((p) => `${p.status}${p.error ? ` ${p.error}` : ""}`).join(", ")})`);
  assert.deepEqual(done4.parts.map((p) => p.status), ["paid", "paid", "paid"]);
  assert.deepEqual(relayCalls, ["transfer", "unshieldBatch"], "the set-aside, then one batch: nothing part by part");
  const hashes4 = [...new Set(sent4.map((x) => x.hash))];
  assert.equal(hashes4.length, 2, "two relay transactions in all");
  const batchHash = sent4.find((x) => x.kind === "batch")!.hash;
  assert.ok(done4.parts.every((p) => p.txHash === batchHash && p.sentBlock), "every part settled from the one transaction, its block on record");
  const batchTx = await client.getTransaction({ hash: batchHash });
  assert.equal(getAddress(batchTx.to!), relayBatch.MULTICALL3, "sent to Multicall3");
  assert.equal(batchTx.value, 0n);
  const batchReceipt = await client.getTransactionReceipt({ hash: batchHash });
  assert.equal(batchReceipt.status, "success");
  const outs = parseEventLogs({ abi: [UNSHIELDED], logs: batchReceipt.logs.filter((l) => l.address.toLowerCase() === POOL.toLowerCase()) });
  assert.equal(outs.length, 3, "three cash outs from the vault in it");
  assert.ok(outs.every((o) => getAddress(o.args.to) === TO), "all to the same wallet");
  const expected4 = C.cashOutAcrossReceived(plan4.parts, feeOf);
  const got4 = (await usdcOf(TO)) - before4;
  assert.equal(got4, expected4, `the wallet got ${fmt(got4)}, as shown before confirming (${fmt(expected4)})`);
  assert.equal(got4, expected, "the same as step 2, part by part: no fee or amount changed");
  assert.equal(vault4 - (await readVault<bigint>("deposited", [USDC])), usd(20));
  for (const n of fresh4) assert.equal(await readVault<boolean>("isSpent", [n.nullifier!]), true);
  const transfer4 = sent4.find((x) => x.kind === "transfer")!.hash;
  const step4Gas = gasOf.get(transfer4)! + gasOf.get(batchHash)!;
  const unshieldGas2 = unshields.reduce((sum, u) => sum + gasOf.get(u.hash)!, 0n);
  ok(
    `4. $20 as ${done4.parts.map((p) => fmt(BigInt(p.amount))).join(" + ")} through the relay in ${secs4} s (step 2: ${secs} s): 2 transactions (step 2: 4), 1 set-aside (gas ${gasOf.get(transfer4)}) + 1 batch of 3 cash outs (gas ${gasOf.get(batchHash)}, step 2's 3 unshields: ${unshieldGas2}); in all ${step4Gas} gas against ${step2Gas} (${((Number(step4Gas) / Number(step2Gas)) * 100).toFixed(1)}%); the wallet got ${fmt(got4)}, the same as part by part`
  );

  // ---------------------------------------------------------------- 5. the batch's answer lost on the way back
  console.log("5. a batch that went out with its answer lost: held, then settled from the chain");
  const fresh5 = [await deposit(usd(6)), await deposit(usd(5))];
  const plan5 = C.planCashOutFrom(usd(11), fresh5);
  assert.ok(plan5.ok);
  const run5 = newRun(plan5.parts, plan5.noteIds, fresh5);
  assert.ok((await C.startCashOutRun(run5, { loadAll: store.loadCashOutRuns, save: store.saveCashOutRun })).started);
  const before5 = await usdcOf(TO);
  const sent5: Sent[] = [];
  relayCalls.length = 0;
  batchAnswer = "lost";
  const held5 = await C.runCashOutAcross(run5, deps(sent5, false, "relay", bps));
  assert.ok(lostHash, "the relay sent it");
  // it lands in its own time; the run doesn't know its hash
  assert.equal((await client.waitForTransactionReceipt({ hash: lostHash! })).status, "success");
  assert.equal(held5.status, "running", "held: it may have gone out");
  assert.deepEqual(held5.parts.map((p) => p.status), ["sent", "sent"]);
  assert.ok(held5.parts.every((p) => p.error === C.CASHOUT_MAYBE_SENT && !p.txHash && p.nullifier && p.sentBlock));
  for (const n of fresh5) assert.equal(await readVault<boolean>("isSpent", [n.nullifier!]), true, "it did go out");
  const done5 = await C.runCashOutAcross(run5, deps(sent5, false, "relay", bps));
  assert.equal(done5.status, "done");
  assert.deepEqual(done5.parts.map((p) => p.status), ["paid", "paid"], "settled from the vault's log: this cash out paid both");
  assert.deepEqual(relayCalls, ["unshieldBatch"], "nothing sent again");
  const got5 = (await usdcOf(TO)) - before5;
  assert.equal(got5, C.cashOutAcrossReceived(plan5.parts, feeOf), "paid once");
  ok(`5. ${fmt(usd(11))} as ${plan5.parts.map(fmt).join(" + ")} in one batch whose answer was lost: held, then both parts settled from the chain on resume, nothing resent, the wallet got ${fmt(got5)} once`);

  // ---------------------------------------------------------------- 6. a relay without the batch
  console.log("6. a relay that doesn't know the batch: the parts go one by one");
  const fresh6 = [await deposit(usd(3)), await deposit(usd(2))];
  const plan6 = C.planCashOutFrom(usd(5), fresh6);
  assert.ok(plan6.ok);
  const run6 = newRun(plan6.parts, plan6.noteIds, fresh6);
  assert.ok((await C.startCashOutRun(run6, { loadAll: store.loadCashOutRuns, save: store.saveCashOutRun })).started);
  const before6 = await usdcOf(TO);
  const sent6: Sent[] = [];
  relayCalls.length = 0;
  batchAnswer = "old-relay";
  const done6 = await C.runCashOutAcross(run6, deps(sent6, false, "relay", bps));
  assert.equal(done6.status, "done", "not an error");
  assert.deepEqual(done6.parts.map((p) => p.status), ["paid", "paid"]);
  assert.deepEqual(relayCalls, ["unshieldBatch", "unshield", "unshield"], "refused, then one by one through the relay");
  assert.notEqual(done6.parts[0]!.txHash, done6.parts[1]!.txHash);
  const got6 = (await usdcOf(TO)) - before6;
  assert.equal(got6, C.cashOutAcrossReceived(plan6.parts, feeOf));
  ok(`6. ${fmt(usd(5))} with a relay that doesn't know the batch: refused, then ${plan6.parts.map(fmt).join(" + ")} one by one through the relay in the same run, the wallet got ${fmt(got6)}`);

  // Reads the app and the relay would make elsewhere (the tree's public leaf list, a receipt
  // read falling back to a public RPC while proofs held the event loop) were refused here.
  // A send never was: every one went to the anvil.
  assert.deepEqual(refusedUrls.filter((r) => r.methods.some((m) => SENDS.test(m))), [], "no transaction was ever sent anywhere but the anvil");
  const reads = refusedUrls.flatMap((r) => r.methods.length ? r.methods : [r.url]);
  console.log(`\n${results.length} of 6 checks passed. Fork at Base block ${forkBlock}; every transaction went to the local anvil. ${refusedUrls.length} reads for other hosts were refused by the guard (${[...new Set(reads)].join(", ")}).`);
} catch (e) {
  console.error(results.join("\n"));
  if (refusedUrls.length) console.error("refused calls:", JSON.stringify(refusedUrls));
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  stopAnvil();
  // the relay's receipt watches run on after their replies: nothing more to wait for
  setTimeout(() => process.exit(), 200);
}
