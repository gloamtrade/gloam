/**
 * Self-test: notes are matched on chain AND vault, never the vault alone
 * (Duke's report, 25 Oct 2026).
 *
 * With the network set to Base (testnet), the Portfolio showed "Private
 * balance 249.239539 USDG": his Robinhood Chain mainnet notes (35, 214.229539
 * and 0.01 USDG). The Robinhood Chain and Tempo mainnet vaults and the Base
 * Sepolia vault sit at one address, so a switch from Robinhood Chain mainnet to
 * Base Sepolia changed neither the wallet nor the vault address, and the notes
 * hook (which re-read on those two only) kept showing, and offering, the notes
 * it had read for 4663. The tree hook never re-synced on a switch either, so a
 * stale note came with a stale tree: a valid Robinhood Chain proof made while
 * the page showed Base Sepolia.
 *
 * Here: notes of 4663 (and of Base mainnet and Ethereum, which will share the
 * address) sit in the store while 84532 is active. None is shown, counted or
 * spendable; every spend path refuses them before proving; a tree of another
 * chain is never handed out or built through another chain's client; and lib
 * code follows the network the page shows even when storage refuses the write.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-note-scope.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { formatUnits, type Address, type Hex, type PublicClient } from "viem";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-note-scope: no network calls allowed (${String(url)})`);
}) as typeof fetch;

type LocalNote = import("../src/lib/shield").LocalNote;

// The page was on Robinhood Chain mainnet, as Duke's was before the switch.
window.localStorage.setItem("gloam.network", "robinhood-mainnet");

const nets = await import("../src/lib/networks");
const shield = await import("../src/lib/shield");
const vault = await import("../src/lib/noteVault");
const { shownTree, syncShieldTree, treeIsFor } = await import("../src/lib/treeSync");
const { proveCashOut } = await import("../src/lib/cashOutProof");
const { splitForCashOut } = await import("../src/lib/cashOutSplit");
const { runVaultSwap } = await import("../src/lib/vaultSwapRun");
const { fundingNotes, newBatch, runNetworkProblem, runPayroll } = await import("../src/lib/payroll");
const { visibleNotes, notesOnNetwork, noteNetworkProblem, ghostEthNotes, activeSpendableNotes, sumByAsset } = shield;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const RH = nets.getNetwork("robinhood-mainnet");
const BASE = nets.getNetwork("base");
const ME = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8" as Address;
const USDG = "0xe8b7cdec0a2b6a1d34e3b0c0e4b0e2c7d7a2bb11" as Address; // any token Base does not list
const ETH = "0x0000000000000000000000000000000000000000" as Address;
const hex = (fill: string) => `0x${fill.repeat(64).slice(0, 64)}` as Hex;

let k = 0;
function note(chainId: number, asset: Address, amountWei: string, extra: Partial<LocalNote> = {}): LocalNote {
  k++;
  return {
    id: `${chainId}-${k}`,
    chainId,
    pool: RH.pool as Address,
    asset,
    amountWei,
    commitment: hex(`${k}c`),
    secret: hex(`${k}a`),
    nullifier: hex(`${k}b`),
    bound: true,
    scheme: "poseidon",
    leafIndex: k,
    txHash: hex(`${k}d`),
    from: ME,
    createdAt: Date.now() + k,
    status: "open",
    source: "local",
    ...extra,
  };
}

// Duke's three Robinhood Chain mainnet notes, a Base Sepolia ETH note, and notes of
// the chains that will share the vault address (Base mainnet, Ethereum mainnet).
const rhNotes = [note(4663, USDG, "35000000"), note(4663, USDG, "214229539"), note(4663, USDG, "10000")];
const baseNote = note(84532, ETH, "10000000000000000");
const futureNotes = [note(8453, ETH, "10000000000000000"), note(1, ETH, "10000000000000000")];

await vault.unlockNoteVault();
await vault.setAllNotes([...rhNotes, baseNote, ...futureNotes]);

await test("the vault address alone can't tell these chains apart", () => {
  assert.equal(RH.pool!.toLowerCase(), BASE.pool!.toLowerCase());
  for (const n of [...rhNotes, ...futureNotes]) assert.equal(n.pool.toLowerCase(), BASE.pool!.toLowerCase());
});

// What the notes hook held when Duke switched: read for 4663, kept across the switch.
const heldFromBefore = shield.loadLocalNotes(ME);
assert.equal(heldFromBefore.length, 3, "on Robinhood Chain mainnet the hook reads its three notes");

nets.setShownNetworkKey("base");

await test("the state the hook kept across the switch is Duke's 249.239539 USDG, all of it on 4663", () => {
  // Before the fix the hook showed this state as it was: same wallet, same vault address.
  const total = activeSpendableNotes(heldFromBefore).reduce((s, n) => s + BigInt(n.amountWei), 0n);
  assert.equal(formatUnits(total, 6), "249.239539");
  assert.ok(heldFromBefore.every((n) => n.chainId === 4663 && n.pool.toLowerCase() === BASE.pool!.toLowerCase()));
});

await test("notes of 4663 in the store while 84532 is active: none shown, none counted, none spendable", () => {
  // the hook's state still holds the 4663 notes (the bug); what it shows must not
  const shown = visibleNotes(heldFromBefore, [], BASE, true, ME);
  assert.deepEqual(shown.local, []);
  assert.deepEqual(activeSpendableNotes(shown.local), []);
  assert.equal(sumByAsset(shown.local).size, 0, "no balance row, so no USDG headline");
  // and a fresh read on Base Sepolia holds only its own note
  assert.deepEqual(shield.loadLocalNotes(ME).map((n) => n.id), [baseNote.id]);
  assert.deepEqual(visibleNotes(shield.loadLocalNotes(ME), [], BASE, true, ME).local.map((n) => n.id), [baseNote.id]);
  // chain history rows of another chain are dropped the same way
  assert.deepEqual(visibleNotes([], heldFromBefore, BASE, true, ME).chain, []);
});

await test("nothing is shown before the page knows its network (first render)", () => {
  assert.deepEqual(visibleNotes(shield.loadLocalNotes(ME), heldFromBefore, BASE, false, ME), { local: [], chain: [] });
});

await test("Base mainnet and Ethereum notes at the same address never show on Base Sepolia, nor its notes on them", () => {
  const all = [...rhNotes, baseNote, ...futureNotes];
  assert.deepEqual(notesOnNetwork(all, BASE).map((n) => n.id), [baseNote.id]);
  assert.deepEqual(notesOnNetwork(all, { chainId: 8453, pool: BASE.pool }).map((n) => n.id), [futureNotes[0]!.id]);
  assert.deepEqual(notesOnNetwork(all, { chainId: 1, pool: BASE.pool }).map((n) => n.id), [futureNotes[1]!.id]);
});

await test("a note of another chain can't be spent or proved: the guard and every spend path refuse it", async () => {
  for (const n of [...rhNotes, ...futureNotes]) {
    assert.equal(noteNetworkProblem(n, BASE), shield.NOTE_OTHER_NETWORK_MESSAGE);
  }
  assert.equal(noteNetworkProblem(baseNote, BASE), null);
  const path = { pathElements: [], pathIndices: [], root: 0n } as never;
  // the cash-out proof (also what cash out later and a private cash out prove)
  await assert.rejects(proveCashOut(rhNotes[1]!, ME, path, BASE.chainId), /another network/);
  // asked for the note's own chain while the app reads Base Sepolia: refused too
  await assert.rejects(proveCashOut(rhNotes[1]!, ME, path, RH.chainId), /another network/);
  // setting part of a balance aside (the first step of a partial cash out or swap)
  await assert.rejects(
    splitForCashOut({
      note: rhNotes[1]!,
      amount: 1_000_000n,
      path,
      owner: ME,
      relayOn: true,
      sendWithWallet: () => Promise.reject(new Error("must not send")),
      onStatus: () => {},
    }),
    /another network/
  );
  // a private swap
  await assert.rejects(
    runVaultSwap({
      network: BASE,
      router: ME,
      note: rhNotes[1]!,
      amount: 1_000_000n,
      assetOut: ETH,
      plan: {} as never,
      feeBps: 25,
      owner: ME,
      pathFor: () => Promise.reject(new Error("must not read a path")),
      onStatus: () => {},
    }),
    /another network/
  );
  // payroll pays from its own run's chain only, whatever the active network
  assert.deepEqual(fundingNotes(ME, USDG, null, { chainId: BASE.chainId, pool: BASE.pool }), []);
  nets.setShownNetworkKey("robinhood-mainnet");
  assert.deepEqual(fundingNotes(ME, ETH, null, { chainId: BASE.chainId, pool: BASE.pool }).map((n) => n.id), [baseNote.id]);
  nets.setShownNetworkKey("base");
});

await test("a page on one chain while lib code reads another: spending waits for the switch", () => {
  nets.setShownNetworkKey("robinhood-mainnet");
  assert.equal(noteNetworkProblem(baseNote, BASE), shield.NETWORK_SWITCHING_MESSAGE);
  nets.setShownNetworkKey("base");
  assert.equal(noteNetworkProblem(baseNote, BASE), null);
});

await test("lib code follows the network shown even when storage refuses the write", () => {
  const setItem = window.localStorage.setItem.bind(window.localStorage);
  window.localStorage.setItem("gloam.network", "robinhood-mainnet");
  window.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  try {
    nets.setShownNetworkKey("base");
    assert.equal(nets.getActiveNetwork().key, "base");
    assert.deepEqual(shield.loadLocalNotes(ME).map((n) => n.id), [baseNote.id]);
  } finally {
    window.localStorage.setItem = setItem;
  }
});

await test("a tree of another chain is never handed out, and never built through another chain's client", async () => {
  const rhTree = { chainId: RH.chainId, pool: RH.pool! };
  assert.equal(treeIsFor(rhTree, BASE), false);
  assert.equal(shownTree(rhTree, BASE), null, "the tree hook gives no tree, so no path, for another chain");
  assert.equal(shownTree({ chainId: BASE.chainId, pool: BASE.pool! }, BASE)?.chainId, BASE.chainId);
  assert.equal(shownTree({}, BASE), null, "an untagged tree is not used either");
  // a client for 4663 asked for Base Sepolia's tree: refused before any read
  let reads = 0;
  const rhClient = new Proxy({ chain: { id: RH.chainId } } as unknown as PublicClient, {
    get(t, p) {
      if (p === "chain") return (t as unknown as { chain: unknown }).chain;
      if (p === "then") return undefined;
      reads++;
      throw new Error(`read ${String(p)}`);
    },
  });
  await assert.rejects(syncShieldTree(rhClient, BASE), /chain 4663 asked for chain 84532/);
  assert.equal(reads, 0);
});

await test("the empty-ETH cleanup only retires nullifier-less notes of its own network", () => {
  const legacy = note(84532, ETH, "1", { nullifier: undefined });
  const all = [...rhNotes, baseNote, legacy, ...futureNotes];
  // Base Sepolia's own ETH note has a nullifier: isSpent settles it, an empty read never does
  assert.deepEqual(ghostEthNotes(all, BASE).map((n) => n.id), [legacy.id]);
  // a read of Robinhood Chain mainnet (no ETH there) can't touch Base Sepolia's notes
  assert.deepEqual(ghostEthNotes(all, RH), []);
});

await test("a payroll run of another chain is refused before anything is read, resume included", async () => {
  nets.setShownNetworkKey("base");
  const rhRun = newBatch({ title: "October", chainId: RH.chainId, pool: RH.pool as Address, asset: USDG, employer: ME, relay: true, rows: [] });
  const baseRun = newBatch({ title: "October", chainId: BASE.chainId, pool: BASE.pool as Address, asset: ETH, employer: ME, relay: true, rows: [] });
  const baseClient = { chain: { id: BASE.chainId } };
  assert.match(runNetworkProblem(rhRun, baseClient) ?? "", /another network/);
  assert.equal(runNetworkProblem(baseRun, { chain: { id: RH.chainId } }), shield.NETWORK_SWITCHING_MESSAGE, "a client for another chain");
  assert.equal(runNetworkProblem(baseRun, baseClient), null);
  // A Robinhood Chain run resumed while Base Sepolia is shown: refused before its first read.
  let reads = 0;
  const client = new Proxy(baseClient as unknown as PublicClient, {
    get(t, p) {
      if (p === "chain") return (t as unknown as { chain: unknown }).chain;
      if (p === "then") return undefined;
      reads++;
      throw new Error(`read ${String(p)}`);
    },
  });
  const deps = {
    client,
    submitTransfer: () => Promise.reject(new Error("must not send")),
    submitMemo: null,
    waitForTx: () => Promise.reject(new Error("must not wait")),
    onUpdate: () => {},
    shouldStop: () => false,
  } as never;
  await assert.rejects(runPayroll(rhRun, deps), /another network/);
  assert.equal(reads, 0, "nothing was read on Base Sepolia for the Robinhood Chain run");
});

await test("one repair pass reopens ETH notes the old cleanup marked spent, only where the vault still holds them", async () => {
  const { reopenGhostEthNotes } = await import("../src/lib/claimSweep");
  const { noteNullifierPoseidon } = await import("../src/lib/notePoseidon");
  const { fieldToHex, hexToField } = await import("../src/lib/poseidon");
  nets.setShownNetworkKey("base");
  const secret = (i: number) => fieldToHex(BigInt(1000 + i)) as Hex;
  const mk = (id: string, i: number, extra: Partial<LocalNote> = {}) =>
    note(84532, ETH, "10000000000000000", { id, secret: secret(i), commitment: fieldToHex(BigInt(5000 + i)) as Hex, nullifier: undefined, status: "recovered", ...extra });
  const ghost = mk("ghost", 1); // unspent, in the vault: the bug's victim
  const spent = mk("spent", 2); // really spent
  const unseen = mk("unseen", 3); // never landed
  const payeeRow = mk("pay-for-someone", 4); // a payment made for someone else: not this browser's money
  const usdc = mk("usdc", 5, { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address }); // only ETH was hit
  const rh = { ...mk("rh", 6), chainId: 4663 }; // another chain
  await vault.setAllNotes([...rhNotes, baseNote, ...futureNotes, ghost, spent, unseen, payeeRow, usdc, rh]);
  const nf = async (n: LocalNote) => fieldToHex(await noteNullifierPoseidon(hexToField(n.secret), hexToField(n.commitment))).toLowerCase();
  const spentSet = new Set([await nf(spent)]);
  const seenSet = new Set([ghost, spent, payeeRow, usdc, rh].map((n) => n.commitment.toLowerCase()));
  let reads = 0;
  const env = {
    chainId: BASE.chainId,
    pool: BASE.pool as Address,
    chain: {
      isSpent: async (x: Hex) => (reads++, spentSet.has(x.toLowerCase())),
      isCommitmentSeen: async (c: Hex) => (reads++, seenSet.has(c.toLowerCase())),
    },
  } as never;
  assert.equal(await reopenGhostEthNotes(env), true);
  const status = (id: string) => vault.getAllNotes().find((n) => n.id === id)?.status;
  assert.equal(status("ghost"), "open", "the wrongly retired ETH note is back in the balance");
  for (const id of ["spent", "unseen", "pay-for-someone", "usdc", "rh"]) assert.equal(status(id), "recovered", id);
  // once per vault: a later sync reads nothing and changes nothing, even if a note is retired again
  const before = reads;
  await vault.setAllNotes(vault.getAllNotes().map((n) => (n.id === "ghost" ? { ...n, status: "recovered" as const } : n)));
  assert.equal(await reopenGhostEthNotes(env), false);
  assert.equal(reads, before);
  // a vault with no ETH at all (Tempo mainnet) never runs it
  assert.equal(await reopenGhostEthNotes({ ...(env as object), chainId: 4217 } as never), false);
});

console.log(`selftest-note-scope: ${passed} checks passed`);
