/**
 * Self-test: a payment to your Gloam address lands in your private balance on
 * its own (lib/autoReceive), with nothing tapped.
 *
 * HeisRae's report, 23 Nov 2026: a payroll to two Gloam addresses on Ethereum
 * said paid, but both accounts showed zero. The payments were in the vault and
 * their codes on the memo board; the app only looked for them when Receive was
 * opened on that network, and then waited for a Claim tap.
 *
 * Here, against a fake chain:
 *  - a payment encrypted to this account's address is saved to the balance as
 *    a claimed payment (so the relay secures it next), and the page is told
 *  - one for another address, one whose code doesn't match the commitment it
 *    names, one not in the vault and one already spent are all left alone
 *  - a second pass is paced, never saves the same payment twice, and reads on
 *    from where the last one stopped
 *  - signed out, nothing is read or saved
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-auto-receive.mts
 */
import assert from "node:assert/strict";
import { localStorage } from "./browser-shim.mjs";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex, type Log } from "viem";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const win = globalThis.window as unknown as Record<string, unknown>;
win.setTimeout = setTimeout;
win.clearTimeout = clearTimeout;
globalThis.fetch = (async (url: string | URL) => {
  throw new Error(`selftest-auto-receive: no network calls allowed (${String(url)})`);
}) as typeof fetch;

localStorage.setItem("gloam.network", "ethereum-mainnet");

const slot = await import("../src/lib/accountSlot");
const scope = await import("../src/lib/accountScope");
// on in every browser (document exists there); the shim has none, so it is turned on here
slot.enforceAccountScope(true);
// a sign-out reloads the page in a browser; here the next "page" just carries on
scope.setPageReload(() => {});
const vault = await import("../src/lib/noteVault");
const receive = await import("../src/lib/receiveTag");
const pkg = await import("../src/lib/notePackage");
const poseidon = await import("../src/lib/poseidon");
const notePos = await import("../src/lib/notePoseidon");
const memo = await import("../src/lib/payMemo");
const nets = await import("../src/lib/networks");
const auto = await import("../src/lib/autoReceive");
const sweep = await import("../src/lib/claimSweep");
const shield = await import("../src/lib/shield");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const ME = getAddress("0x1111111111111111111111111111111111111111");
const POOL = getAddress("0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194");
const BOARD = getAddress("0x8699D015087dE6D25d55d5ceB63b34b9d773f135");
const ETH = "0x0000000000000000000000000000000000000000" as Address;
const NET = {
  ...nets.getNetwork("ethereum-mainnet"),
  pool: POOL,
  deployBlock: 100n,
  payMemo: { address: BOARD, deployBlock: 100n, emitsPoster: false },
};

const memoEvent = memo.payMemoAbi.find((x) => x.type === "event")!;
const memoEventNoPoster = {
  type: "event",
  name: "PaymentMemo",
  inputs: [
    { name: "paymentCommitment", type: "bytes32", indexed: true },
    { name: "memo", type: "bytes", indexed: false },
  ],
} as const;
void memoEvent;

/** A chain: logs on the board, which commitments the vault holds and which are spent. */
const chain = { head: 1000n, logs: [] as (Log & { blockNumber: bigint })[], inVault: new Set<string>(), spent: new Set<string>(), reads: [] as [bigint, bigint][] };
const client = {
  getBlockNumber: async () => chain.head,
  getLogs: async (a: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
    if (a.address.toLowerCase() !== BOARD.toLowerCase()) return [];
    chain.reads.push([a.fromBlock, a.toBlock]);
    return chain.logs.filter((l) => l.blockNumber >= a.fromBlock && l.blockNumber <= a.toBlock);
  },
  readContract: async (a: { functionName: string; args: [Hex] }) => {
    if (a.functionName === "commitmentSeen") return chain.inVault.has(a.args[0].toLowerCase());
    if (a.functionName === "isSpent") return chain.spent.has(a.args[0].toLowerCase());
    throw new Error(`unexpected read ${a.functionName}`);
  },
} as never;

let logIndex = 0;
/** Posts a code on the board for `commitment` at `block`, like a payer does after the transfer. */
function post(commitment: Hex, ticket: string, block: bigint) {
  const topics = encodeEventTopics({ abi: [memoEventNoPoster], eventName: "PaymentMemo", args: { paymentCommitment: commitment } });
  const data = encodeAbiParameters([{ type: "bytes" }], [memo.ticketToMemoBytes(ticket)]);
  chain.logs.push({
    address: BOARD,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: block,
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${(logIndex + 1).toString(16).padStart(64, "0")}`,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
  } as never);
}

/** A payment of `wei` ETH: its note's secret and commitment, as a payer makes them. */
async function payment(wei: bigint, note?: string) {
  const secret = poseidon.fieldToHex(BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString("hex")}`)) as Hex;
  const commitment = poseidon.fieldToHex(await notePos.noteCommitmentPoseidon(poseidon.hexToField(secret), wei, ETH)) as Hex;
  const nullifier = poseidon.fieldToHex(await notePos.noteNullifierPoseidon(poseidon.hexToField(secret), poseidon.hexToField(commitment))) as Hex;
  const plain = pkg.encodeNotePackage(pkg.buildNotePackage({ pool: POOL, asset: ETH, amountWei: wei.toString(), secret, commitment, chainId: 1, ...(note ? { note } : {}) }));
  return { secret, commitment: commitment.toLowerCase() as Hex, nullifier: nullifier.toLowerCase() as Hex, plain };
}

async function otherTag(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return `gloamr1.${Buffer.from(spki).toString("base64url")}`;
}

const mine = () => vault.getAllNotes().filter((n) => n.pool.toLowerCase() === POOL.toLowerCase());
const events: unknown[] = [];
(globalThis.window as unknown as EventTarget).addEventListener(auto.PAYMENTS_RECEIVED_EVENT, (e) => events.push((e as CustomEvent).detail));

await scope.signInAs(ME);
await vault.unlockNoteVault();
const myTag = (await receive.getOrCreateReceiveIdentity()).tag;

await test("a payment to my Gloam address lands in my balance with nothing tapped", async () => {
  const p = await payment(3_000_000_000_000_000n, "1st week tip");
  chain.inVault.add(p.commitment);
  post(p.commitment, await receive.encryptTicketForTag(p.plain, myTag), 500n);

  const landed = await auto.receiveWaitingPayments(NET as never, ME, { client, force: true });
  assert.equal(landed.length, 1);
  assert.equal(landed[0]!.label, "0.003 ETH");
  assert.equal(landed[0]!.note, "1st week tip");
  assert.equal(landed[0]!.networkKey, "ethereum-mainnet");
  const saved = mine();
  assert.equal(saved.length, 1, "saved to the balance");
  const n = saved[0]!;
  assert.equal(n.commitment.toLowerCase(), p.commitment);
  assert.equal(n.nullifier?.toLowerCase(), p.nullifier);
  assert.equal(n.amountWei, "3000000000000000");
  assert.equal(n.status, "open");
  assert.ok(sweep.isClaimedNote(n), "as a claimed payment");
  assert.ok(sweep.isUnsecuredClaim(n), "which the relay secures next (secureClaimsInBackground)");
  assert.equal(n.unfunded, false, "the vault said it holds it, so it counts at once");
  assert.equal(sweep.claimsToSecure([n]).length, 1, "and the background secure picks it up");
  assert.equal(n.id, auto.receivedNoteId(p.commitment), "its id comes from the payment, the same in every tab");
  assert.equal(events.length, 1, "the page is told");
  assert.equal(localStorage.getItem([...Array(localStorage.length).keys()].map((i) => localStorage.key(i)!).find((k) => k.startsWith("gloam.receive.cursor.v1"))!), "1000", "read up to the head");
});

await test("payments that aren't mine, aren't real or aren't there are left alone", async () => {
  const before = mine().length;
  // for someone else's address
  const other = await payment(5n);
  chain.inVault.add(other.commitment);
  post(other.commitment, await receive.encryptTicketForTag(other.plain, await otherTag()), 1100n);
  // a real code posted under a commitment it doesn't open
  const real = await payment(7n);
  chain.inVault.add(real.commitment);
  const wrong = `0x${"12".repeat(32)}` as Hex;
  chain.inVault.add(wrong);
  post(wrong, await receive.encryptTicketForTag(real.plain, myTag), 1101n);
  // not in the vault
  const ghost = await payment(9n);
  post(ghost.commitment, await receive.encryptTicketForTag(ghost.plain, myTag), 1102n);
  // already spent (taken back, or claimed on another device)
  const gone = await payment(11n);
  chain.inVault.add(gone.commitment);
  chain.spent.add(gone.nullifier);
  post(gone.commitment, await receive.encryptTicketForTag(gone.plain, myTag), 1103n);
  // not even a code
  post(`0x${"34".repeat(32)}`, "gloam2t.garbage", 1104n);

  chain.head = 1200n;
  const landed = await auto.receiveWaitingPayments(NET as never, ME, { client, force: true });
  assert.deepEqual(landed, []);
  assert.equal(mine().length, before, "nothing saved");
});

await test("paced, never twice, and read on from where it stopped", async () => {
  const before = mine().length;
  const reads = chain.reads.length;
  assert.deepEqual(await auto.receiveWaitingPayments(NET as never, ME, { client }), [], "a second pass inside a minute does nothing");
  assert.equal(chain.reads.length, reads, "and reads nothing");

  const p = await payment(4_000_000_000_000_000n);
  chain.inVault.add(p.commitment);
  post(p.commitment, await receive.encryptTicketForTag(p.plain, myTag), 1250n);
  chain.head = 1300n;
  const landed = await auto.receiveWaitingPayments(NET as never, ME, { client, force: true });
  assert.equal(landed.length, 1, "the new one lands");
  assert.equal(mine().length, before + 1, "and only it: the first is not saved again");
  const last = chain.reads[chain.reads.length - 1]!;
  assert.ok(last[0] >= 1200n - 64n && last[0] < 1200n, `read from the last head, a little back for reorgs (from ${last[0]})`);

  // the whole board again, as after cleared storage: still nothing twice
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)!;
    if (k.startsWith("gloam.receive.cursor.v1")) localStorage.removeItem(k);
  }
  assert.deepEqual(await auto.receiveWaitingPayments(NET as never, ME, { client, force: true }), []);
  assert.equal(mine().length, before + 1);
});

await test("the label names the coin of the network it landed on", async () => {
  // shown: Ethereum. A payment of native coin on BNB Chain is BNB, not ETH
  assert.equal(auto.receivedLabel({ chainId: 56, primaryAsset: { symbol: "BNB", address: null, decimals: 18 } } as never, "500000000000000000", ETH), "0.5 BNB");
  assert.equal(auto.receivedLabel({ chainId: 1, primaryAsset: { symbol: "ETH", address: null, decimals: 18 } } as never, "3000000000000000", ETH), "0.003 ETH");
});

await test("another tab saving the same payment mid-pass leaves one note", async () => {
  const p = await payment(6_000_000_000_000_000n);
  chain.inVault.add(p.commitment);
  post(p.commitment, await receive.encryptTicketForTag(p.plain, myTag), 1310n);
  const c = client as unknown as { readContract: (a: { functionName: string; args: [Hex] }) => Promise<unknown> };
  const real = c.readContract;
  let saved = false;
  c.readContract = async (a) => {
    if (!saved && a.functionName === "isSpent" && a.args[0].toLowerCase() === p.nullifier) {
      saved = true;
      // the other tab, on older code, saved it under an id of its own
      await shield.saveLocalNote({
        id: `imp-${Date.now()}-other`,
        chainId: 1,
        pool: POOL,
        asset: ETH,
        amountWei: "6000000000000000",
        commitment: p.commitment,
        secret: p.secret,
        nullifier: p.nullifier,
        bound: true,
        scheme: "poseidon",
        from: ME,
        createdAt: Date.now(),
        status: "open",
        source: "local",
      } as never);
    }
    return real(a);
  };
  chain.head = 1320n;
  try {
    await auto.receiveWaitingPayments(NET as never, ME, { client, force: true });
  } finally {
    c.readContract = real;
  }
  assert.equal(mine().filter((n) => n.commitment.toLowerCase() === p.commitment).length, 1, "one note for one payment");
});

await test("keys restored on a new device: payments sent before the restore still land", async () => {
  const backup = await receive.exportReceiveKeys();
  // a payment to this address while the new device didn't hold its key
  const p = await payment(2_000_000_000_000_000n, "salary");
  chain.inVault.add(p.commitment);
  // older than the few blocks every pass reads again, so only a fresh read from the start finds it
  post(p.commitment, await receive.encryptTicketForTag(p.plain, myTag), 1260n);
  // the new device: no receive keys yet
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)!);
  for (const key of keys) if (key.startsWith("gloam.receive.identity")) localStorage.removeItem(key);
  chain.head = 1340n;
  assert.deepEqual(await auto.receiveWaitingPayments(NET as never, ME, { client, force: true }), [], "without the key nothing opens, and the read moves on");
  // the backup is restored, and the chain moves on
  await receive.importReceiveKeys(backup);
  chain.head = 2000n;
  const landed = await auto.receiveWaitingPayments(NET as never, ME, { client, force: true });
  assert.equal(landed.length, 1, "the restore reads the board again: the payment lands");
  assert.equal(landed[0]!.note, "salary");
  assert.ok(mine().some((n) => n.commitment.toLowerCase() === p.commitment));
});

await test("signed out, nothing is read or saved", async () => {
  await vault.notesSettled();
  await slot.unbindSlot();
  await scope.signInAs(null);
  const reads = chain.reads.length;
  const p = await payment(13n);
  chain.inVault.add(p.commitment);
  post(p.commitment, await receive.encryptTicketForTag(p.plain, myTag), 2050n);
  chain.head = 2100n;
  assert.deepEqual(await auto.receiveWaitingPayments(NET as never, ME, { client, force: true }), []);
  assert.equal(chain.reads.length, reads, "the board isn't even read");
});

console.log(`\n${passed} auto-receive checks passed`);
