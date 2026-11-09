/**
 * Self-test: $GLOAM holder votes (lib/vote, /api/vote).
 *
 *  - The config: every vote is valid, a published vote has its snapshot, the
 *    standing exclusions name the team and Gloam's own contracts
 *  - The Transfer-log replay behind every snapshot
 *  - Votes signed with throwaway test keys against a test vote and snapshot:
 *    weights from the snapshot, excluded and empty wallets refused, a changed
 *    vote replaces the old one (last signature wins), an older signature never
 *    lands over a newer one, a double send is harmless, tampered and
 *    mis-addressed signatures fail, the window and the clock are enforced,
 *    smart wallets go through the contract check only when ecrecover fails
 *  - A recount from the published list matches the live totals, and catches a
 *    tampered weight, a bad signature and a stale duplicate
 *  - The real routes: drafts stay hidden without GLOAM_VOTE_PREVIEW, unknown
 *    votes are 404, bad input is refused, the vote endpoint is rate limited
 *  - Weight at close: a wallet that bought after the snapshot can vote, an
 *    empty one and an excluded one can't, a balance that can't be read
 *    refuses the vote; live totals use what each voter holds now; the final
 *    count uses the balances at the closing block (Transfer replay, checked
 *    with balanceOf), so GLOAM moved after a vote never counts twice; the
 *    count is the same however it is worked out, and stored once; the
 *    ballots published before the change still verify
 *  - The holder check: an eligible holder, a wallet with nothing at the
 *    snapshot and a team wallet each come back as they should; a connected
 *    wallet is recorded once (first seen kept, last seen moved on), its
 *    balances worked out on the server whatever the browser sends, its signed
 *    votes noted, and the endpoint is rate limited
 *
 * Uses the in-process store (GLOAM_PARTNERS_STORE=memory). Nothing is sent to
 * any chain.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-vote.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.GLOAM_PARTNERS_STORE = "memory";
process.env.GLOAM_VOTE_NO_ENS = "1";
process.env.GLOAM_VOTE_NO_CHAIN = "1";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.GLOAM_VOTE_PREVIEW;
const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const { VOTES } = await import("../src/lib/vote/config");
const core = await import("../src/lib/vote/core");
const { EXCLUDED, excludedFor } = await import("../src/lib/vote/excluded");
const { SNAPSHOTS } = await import("../src/lib/vote/snapshots");
const registry = await import("../src/lib/vote/registry");
const { submitBallot, VoteError } = await import("../src/lib/vote/submit");
const { listBallots, clearBallotCache, BallotBusyError } = await import("../src/lib/vote/store");
const chainReads = await import("../src/lib/vote/chainReads");
const final = await import("../src/lib/vote/final");
const { ballotsCsv } = await import("../src/lib/vote/results");
const { kv, resetMemoryKv } = await import("../src/lib/partnersKv");
const directory = await import("../src/lib/contractDirectory");
const { VAULT_SWAP_ROUTERS, VAULT_SWAP_V2_ROUTER, VAULT_SWAP_V3_ADDRESS, swapV3Live } = await import("../src/lib/vaultSwap");

type VoteConfig = (typeof VOTES)[number];
type Ballot = import("../src/lib/vote/core").Ballot;
type VoteSnapshot = import("../src/lib/vote/core").VoteSnapshot;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  resetMemoryKv();
  clearBallotCache();
  chainReads.setVoteChain(null);
  final.clearFinalCache();
  (globalThis as { __gloamMcpRate?: Map<string, unknown> }).__gloamMcpRate?.clear();
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

async function rejects(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof VoteError, `expected VoteError ${code}, got ${String(e)}`);
    assert.equal((e as InstanceType<typeof VoteError>).code, code);
    return;
  }
  assert.fail(`expected VoteError ${code}, but it went through`);
}

// ---------------------------------------------------------------- fixtures

const ONE = 10n ** 18n;
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const carol = privateKeyToAccount(generatePrivateKey()); // holds nothing
const team = privateKeyToAccount(generatePrivateKey()); // holds a lot, excluded by the test vote
const smart = getAddress("0x5fbc62072701b34e9a2c272ba0f9275bdf5dde46"); // stands in for a smart wallet

const START = Date.parse("2030-01-01T00:00:00Z");
const END = Date.parse("2030-01-08T00:00:00Z");
const NOW = START + 3 * 86_400_000;
const nowSec = Math.floor(NOW / 1000);

const testVote: VoteConfig = {
  id: "selftest-vote",
  published: true,
  question: "Test question?",
  description: "Test.",
  options: ["Red", "Green", "Blue"],
  snapshotBlock: 100_000_000,
  start: new Date(START).toISOString().replace(".000Z", "Z"),
  end: new Date(END).toISOString().replace(".000Z", "Z"),
  exclude: [{ address: team.address, reason: "Test team wallet" }],
};

const snapshot: VoteSnapshot = {
  voteId: testVote.id,
  chainId: 4663,
  token: core.GLOAM_TOKEN_ADDRESS,
  block: testVote.snapshotBlock,
  blockHash: `0x${"ab".repeat(32)}`,
  blockTime: nowSec - 86_400,
  takenAt: new Date(NOW).toISOString(),
  balances: {
    [alice.address.toLowerCase()]: (100n * ONE).toString(),
    [bob.address.toLowerCase()]: (50n * ONE).toString(),
    [team.address.toLowerCase()]: (1000n * ONE).toString(),
    [smart.toLowerCase()]: (7n * ONE).toString(),
    [directory.GLOAM_TREASURY.toLowerCase()]: (9n * ONE).toString(),
  },
  checked: { balanceOf: 5, mismatches: 0 },
};
const excluded = excludedFor(testVote.exclude);

async function sign(account: typeof alice, option: number, timestamp = nowSec, v: VoteConfig = testVote, voter = account.address) {
  const message = core.voteMessage(v, option, voter, timestamp);
  const signature = await account.signTypedData(core.voteTypedData(message));
  return { voter, option, timestamp, signature };
}

const ctx = (extra: Partial<Parameters<typeof submitBallot>[1]> = {}) => ({ vote: testVote, snapshot, excluded, now: NOW, ...extra });

// ---------------------------------------------------------------- config

await test("every configured vote is valid, and a published one has its snapshot", () => {
  assert.ok(VOTES.length >= 1);
  const ids = new Set<string>();
  for (const v of VOTES) {
    assert.deepEqual(core.configProblems(v), [], `${v.id}: ${core.configProblems(v).join("; ")}`);
    assert.ok(!ids.has(v.id), `duplicate id ${v.id}`);
    ids.add(v.id);
    if (v.published) assert.ok(registry.snapshotFor(v), `${v.id} is published without a matching snapshot`);
  }
  for (const [id, s] of Object.entries(SNAPSHOTS)) {
    assert.equal(s.voteId, id);
    assert.equal(s.chainId, 4663);
    assert.equal(s.token.toLowerCase(), core.GLOAM_TOKEN_ADDRESS.toLowerCase());
    if (s.checked) assert.equal(s.checked.mismatches, 0);
  }
});

await test("the first three votes are published with one window and one snapshot block", () => {
  const first = ["private-swaps-next", "next-chain", "first-integration"].map((id) => VOTES.find((v) => v.id === id));
  for (const v of first) {
    assert.ok(v, "configured");
    assert.equal(v.published, true);
    assert.ok(registry.snapshotFor(v), `${v.id} has its snapshot`);
    assert.equal(registry.snapshotFor(v)!.checked?.mismatches, 0, "balanceOf check passed");
    for (const text of [v.question, v.description, ...v.options]) {
      assert.doesNotMatch(text, /\u2014|\u2013/, "no dashes");
      assert.doesNotMatch(text, /price|moon|pump|airdrop/i, "no price talk");
    }
    assert.match(v.description, /advisory/);
  }
  assert.equal(new Set(first.map((v) => `${v!.snapshotBlock} ${v!.start} ${v!.end}`)).size, 1);
  assert.equal(first[0]!.end, "2026-11-01T23:00:00Z");
  assert.equal(core.whenPhrase(first[0]!.end), "Sunday 1 Nov at 11pm UTC");
  for (const v of first) {
    assert.equal(v!.details?.length, v!.options.length, `${v!.id}: one detail per option`);
    for (const d of v!.details ?? []) assert.doesNotMatch(d, /\u2014|\u2013|price|moon|pump/i);
  }
});

await test("config problems are caught", () => {
  const bad = (patch: Partial<VoteConfig>) => core.configProblems({ ...testVote, ...patch }).length > 0;
  assert.ok(bad({ id: "Bad Id" }));
  assert.ok(bad({ options: ["Only one"] }));
  assert.ok(bad({ options: ["a", "b", "c", "d", "e", "f"] }));
  assert.ok(bad({ options: ["Same", "same"] }));
  assert.ok(bad({ start: testVote.end, end: testVote.start }));
  assert.ok(bad({ start: "2030-01-01T00:00:00+01:00" }));
  assert.ok(bad({ snapshotBlock: 0 })); // published with no snapshot
  assert.ok(bad({ snapshotBlock: 5 }));
  assert.ok(!bad({ published: false, snapshotBlock: 0 }));
  assert.ok(bad({ details: ["only one"] }));
  assert.ok(bad({ details: ["a", "", "c"] }));
  assert.ok(!bad({ details: ["a", "b", "c"] }));
  assert.ok(bad({ id: "me" }), "reserved for /api/vote/me");
});

await test("the standing exclusions name the team wallets, the vault, the swap routers and the pools", () => {
  const ex = excludedFor();
  const has = (a: string) => ex.has(a.toLowerCase());
  for (const e of EXCLUDED) assert.ok(isAddress(e.address), e.address);
  assert.ok(has("0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8"), "owner");
  assert.ok(has(directory.GLOAM_TREASURY), "treasury");
  assert.ok(has(directory.GLOAM_DEPLOYER), "deployer");
  for (const r of directory.GLOAM_RELAYERS) assert.ok(has(r), "relayer");
  assert.ok(has("0x39e28cde55cab798874746ac52cb4b5cc99a0194"), "vault");
  // Robinhood Chain's routers: GLOAM lives there, and the next one is listed once it is live
  for (const r of [VAULT_SWAP_ROUTERS[4663], ...Object.values(VAULT_SWAP_V2_ROUTER)]) if (r) assert.ok(has(r), `router ${r}`);
  assert.equal(has(VAULT_SWAP_V3_ADDRESS[4663]!), swapV3Live(4663), "the next router, only once it is live");
  assert.ok(has("0x8366a39cc670b4001a1121b8f6a443a643e40951"), "v4 PoolManager");
  assert.ok(has("0x0000000000000000000000000000000000000000"), "zero");
  // a vote's own extras add to the list, never replace it
  assert.ok(excluded.has(team.address.toLowerCase()) && excluded.has(directory.GLOAM_TREASURY.toLowerCase()));
});

// ---------------------------------------------------------------- snapshot replay

await test("replaying Transfer logs gives each holder's balance at a block", () => {
  const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  const zero = "0x0000000000000000000000000000000000000000";
  const log = (block: number, from: string, to: string, amount: bigint) => ({
    blockNumber: `0x${block.toString(16)}`,
    topics: [core.TRANSFER_TOPIC, word(from), word(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  });
  const logs = [
    log(10, zero, alice.address, 500n),
    log(11, alice.address, bob.address, 200n),
    log(12, bob.address, carol.address, 200n),
    log(13, alice.address, zero, 50n),
  ];
  const at11 = core.replayTransfers(logs, 11);
  assert.equal(at11.get(alice.address.toLowerCase()), 300n);
  assert.equal(at11.get(bob.address.toLowerCase()), 200n);
  assert.equal(at11.has(zero), false);
  const at13 = core.replayTransfers(logs, 13);
  assert.equal(at13.get(alice.address.toLowerCase()), 250n);
  assert.equal(at13.has(bob.address.toLowerCase()), false, "an emptied holder drops out");
  assert.equal(at13.get(carol.address.toLowerCase()), 200n);
  assert.equal([...at13.values()].reduce((s, b) => s + b, 0n), 450n, "minted less burned");
});

// ---------------------------------------------------------------- voting

await test("a vote counts with the wallet's snapshot balance", async () => {
  const { ballot, changed } = await submitBallot(await sign(alice, 0), ctx());
  assert.equal(changed, false);
  assert.equal(ballot.weight, (100n * ONE).toString());
  assert.equal(ballot.choice, "Red");
  await submitBallot(await sign(bob, 1), ctx());
  const t = core.tally(testVote, await listBallots(testVote.id));
  assert.equal(t.wallets, 2);
  assert.equal(t.weight, 150n * ONE);
  assert.equal(t.options[0]!.weight, 100n * ONE);
  assert.equal(t.options[1]!.weight, 50n * ONE);
  assert.equal(t.options[2]!.wallets, 0);
});

await test("last signature wins: a changed vote replaces the old one", async () => {
  await submitBallot(await sign(alice, 0, nowSec - 60), ctx());
  await submitBallot(await sign(bob, 1, nowSec - 60), ctx());
  const r = await submitBallot(await sign(alice, 2, nowSec - 10), ctx());
  assert.equal(r.changed, true);
  const ballots = await listBallots(testVote.id);
  assert.equal(ballots.length, 2, "one ballot per wallet");
  const t = core.tally(testVote, ballots);
  assert.equal(t.options[0]!.weight, 0n);
  assert.equal(t.options[1]!.weight, 50n * ONE);
  assert.equal(t.options[2]!.weight, 100n * ONE);
  assert.equal(t.wallets, 2);
});

await test("an older signature never lands over a newer one, and a double send is harmless", async () => {
  const older = await sign(alice, 0, nowSec - 120);
  const newer = await sign(alice, 1, nowSec - 30);
  await submitBallot(newer, ctx());
  await rejects(submitBallot(older, ctx()), "newer");
  const again = await submitBallot(newer, ctx());
  assert.equal(again.changed, false);
  const [b] = await listBallots(testVote.id);
  assert.equal(b!.option, 1);
  // the same timestamp with another choice is not newer either
  await rejects(submitBallot(await sign(alice, 2, nowSec - 30), ctx()), "newer");
});

await test("two saves for one wallet never cross", async () => {
  await kv([["SET", `gloam:vote:v1:${testVote.id}:lock:${alice.address.toLowerCase()}`, "1", "NX", "EX", 10]]);
  await assert.rejects(submitBallot(await sign(alice, 0), ctx()), (e) => e instanceof BallotBusyError);
  // two at once: whichever lands, an older signature never ends up over a newer one
  resetMemoryKv();
  const a = await sign(alice, 0, nowSec - 50);
  const b = await sign(alice, 2, nowSec - 40);
  const [ra, rb] = await Promise.allSettled([submitBallot(a, ctx()), submitBallot(b, ctx())]);
  assert.ok(ra.status === "fulfilled" || rb.status === "fulfilled");
  const [stored] = await listBallots(testVote.id);
  if (rb.status === "fulfilled") assert.equal(stored!.option, 2);
  // and the older one can't land afterwards
  if (rb.status === "fulfilled") await rejects(submitBallot(a, ctx()), "newer");
});

await test("excluded and empty wallets have no vote", async () => {
  await rejects(submitBallot(await sign(team, 0), ctx()), "excluded");
  await rejects(submitBallot(await sign(carol, 0), ctx()), "no_balance");
  assert.equal((await listBallots(testVote.id)).length, 0);
});

await test("tampered and mis-addressed signatures fail", async () => {
  // bob signs, but says alice voted
  const forged = await sign(bob, 0, nowSec, testVote, alice.address);
  await rejects(submitBallot(forged, ctx()), "bad_signature");
  // alice signs Red, the request says Blue
  const s = await sign(alice, 0);
  await rejects(submitBallot({ ...s, option: 2 }, ctx()), "bad_signature");
  // a signature for another vote
  const other = { ...testVote, id: "another-vote" };
  await rejects(submitBallot(await sign(alice, 0, nowSec, other), ctx()), "bad_signature");
  // a signature over a different label for the same option
  const relabeled = { ...testVote, options: ["Crimson", "Green", "Blue"] };
  await rejects(submitBallot(await sign(alice, 0, nowSec, relabeled), ctx()), "bad_signature");
  // a different timestamp than the one signed
  await rejects(submitBallot({ ...s, timestamp: s.timestamp - 1 }, ctx()), "bad_signature");
  assert.equal((await listBallots(testVote.id)).length, 0);
});

await test("the voting window and the signing time are enforced", async () => {
  await rejects(submitBallot(await sign(alice, 0, Math.floor(START / 1000) - 10), ctx({ now: START - 5_000 })), "not_open");
  await rejects(submitBallot(await sign(alice, 0, Math.floor(END / 1000)), ctx({ now: END })), "closed");
  await rejects(submitBallot(await sign(alice, 0, nowSec - core.SIGNED_MAX_AGE_SEC - 5), ctx()), "stale");
  await rejects(submitBallot(await sign(alice, 0, nowSec + core.SIGNED_MAX_AHEAD_SEC + 5), ctx()), "stale");
  // the last second of the window still counts
  await submitBallot(await sign(alice, 0, Math.floor(END / 1000) - 1), ctx({ now: END - 1_000 }));
  // a fast clock signing past the close is refused, so it can't replace a vote that counts with one that doesn't
  await rejects(submitBallot(await sign(alice, 1, Math.floor(END / 1000)), ctx({ now: END - 1_000 })), "stale");
  await rejects(submitBallot(await sign(alice, 1, Math.floor(END / 1000) + 30), ctx({ now: END - 1_000 })), "stale");
  // a signature from before the open is refused when it is sent, since the count would leave it out
  const early = await sign(bob, 1, Math.floor(START / 1000) - 90);
  await rejects(submitBallot(early, ctx({ now: START + 5_000 })), "stale");
  await rejects(submitBallot(await sign(bob, 1, Math.floor(START / 1000) - 1), ctx({ now: START + 1_000 })), "stale");
  try {
    await submitBallot(early, ctx({ now: START + 5_000 }));
  } catch (e) {
    assert.match((e as Error).message, /before this vote opened/);
  }
  assert.ok(!(await listBallots(testVote.id)).some((b) => b.voter.toLowerCase() === bob.address.toLowerCase()), "nothing kept");
  // the first second of the window counts
  await submitBallot(await sign(bob, 1, Math.floor(START / 1000)), ctx({ now: START + 1_000 }));
});

await test("bad input is refused before any check", async () => {
  const s = await sign(alice, 0);
  await rejects(submitBallot({ ...s, voter: "0x1234" }, ctx()), "bad_voter");
  await rejects(submitBallot({ ...s, option: 3 }, ctx()), "bad_option");
  await rejects(submitBallot({ ...s, option: -1 }, ctx()), "bad_option");
  await rejects(submitBallot({ ...s, option: "0" }, ctx()), "bad_option");
  await rejects(submitBallot({ ...s, timestamp: 1.5 }, ctx()), "bad_timestamp");
  await rejects(submitBallot({ ...s, signature: "0x1234" }, ctx()), "bad_signature");
  await rejects(submitBallot({ ...s, signature: `0x${"z".repeat(130)}` }, ctx()), "bad_signature");
  await rejects(submitBallot({ ...s, signature: `0x${"ab".repeat(4000)}` }, ctx()), "bad_signature");
  await rejects(submitBallot(null, ctx()), "bad_voter");
});

await test("smart wallets go through the contract check, and only when ecrecover fails", async () => {
  let asked = 0;
  const contractCheck = async (m: { voter: string }, sig: Hex) => {
    asked++;
    return m.voter === smart && sig === `0x${"11".repeat(65)}`;
  };
  await submitBallot(await sign(alice, 1), ctx({ contractCheck }));
  assert.equal(asked, 0, "an EOA never needs the RPC");
  const sw = { voter: smart, option: 1, timestamp: nowSec, signature: `0x${"11".repeat(65)}` as Hex };
  const r = await submitBallot(sw, ctx({ contractCheck }));
  assert.equal(r.ballot.weight, (7n * ONE).toString());
  assert.equal(asked, 1);
  await rejects(submitBallot({ ...sw, signature: `0x${"22".repeat(65)}` as Hex, timestamp: nowSec + 1 }, ctx({ contractCheck })), "bad_signature");
  // without a contract check, a smart wallet signature fails closed
  await rejects(submitBallot({ ...sw, timestamp: nowSec + 2 }, ctx()), "bad_signature");
});

// ---------------------------------------------------------------- recount

await test("a recount from the published list matches the live totals", async () => {
  await submitBallot(await sign(alice, 0, nowSec - 100), ctx());
  await submitBallot(await sign(bob, 2, nowSec - 90), ctx());
  await submitBallot(await sign(alice, 1, nowSec - 80), ctx());
  const published: Ballot[] = JSON.parse(JSON.stringify(await listBallots(testVote.id)));
  const live = core.tally(testVote, published);
  const r = await core.recount(testVote, snapshot, excluded, published);
  assert.deepEqual(r.problems, []);
  assert.equal(r.tally.weight, live.weight);
  assert.deepEqual(r.tally.options.map((o) => o.weight), live.options.map((o) => o.weight));
  assert.deepEqual(r.tally.options.map((o) => o.wallets), [0, 1, 1]);
  // the CSV carries every signature
  const csv = ballotsCsv(published);
  for (const b of published) assert.ok(csv.includes(b.signature) && csv.includes(b.voter));
});

await test("a recount catches tampering and keeps each wallet's latest vote", async () => {
  await submitBallot(await sign(alice, 1, nowSec - 80), ctx());
  await submitBallot(await sign(bob, 2, nowSec - 70), ctx());
  const published: Ballot[] = JSON.parse(JSON.stringify(await listBallots(testVote.id)));
  const oldAlice = await sign(alice, 0, nowSec - 500);
  const tampered: Ballot[] = [
    // alice's weight inflated: the snapshot's weight is used, and the gap reported
    { ...published.find((b) => b.voter === alice.address)!, weight: (999n * ONE).toString() },
    // bob's signature broken: dropped
    { ...published.find((b) => b.voter === bob.address)!, signature: `0x${"00".repeat(65)}` as Hex },
    // an older alice ballot slipped in: ignored, the latest counts
    { ...oldAlice, choice: "Red", weight: (100n * ONE).toString(), receivedAt: NOW } as Ballot,
    // the team wallet, signed for real: excluded
    { ...(await sign(team, 0)), choice: "Red", weight: (1000n * ONE).toString(), receivedAt: NOW } as Ballot,
  ];
  const r = await core.recount(testVote, snapshot, excluded, tampered);
  assert.equal(r.tally.weight, 100n * ONE);
  assert.equal(r.tally.options[1]!.weight, 100n * ONE);
  assert.equal(r.counted.length, 1);
  const why = (a: string) => r.problems.filter((p) => p.voter === a).map((p) => p.problem).join("; ");
  assert.match(why(alice.address), /listed weight/);
  assert.match(why(bob.address), /signature/);
  assert.match(why(team.address), /excluded/);
  // a snapshot for another block is flagged
  const wrong = await core.recount(testVote, { ...snapshot, block: 1 }, excluded, published);
  assert.ok(wrong.problems.some((p) => /snapshot is block/.test(p.problem)));
});

// ---------------------------------------------------------------- registry and routes

await test("drafts stay hidden unless preview is on, and a snapshot must match its vote", () => {
  const draft = { ...testVote, published: false };
  assert.equal(registry.findVote(draft.id, [draft]), null);
  assert.equal(registry.findVote(testVote.id, [testVote])?.id, testVote.id);
  assert.equal(registry.findVote("nope", [testVote]), null);
  process.env.GLOAM_VOTE_PREVIEW = "1";
  try {
    assert.equal(registry.findVote(draft.id, [draft])?.id, draft.id);
    assert.equal(registry.acceptingVotes(draft, snapshot, NOW), true);
  } finally {
    delete process.env.GLOAM_VOTE_PREVIEW;
  }
  assert.equal(registry.acceptingVotes(draft, snapshot, NOW), false);
  assert.equal(registry.acceptingVotes(testVote, null, NOW), false);
  assert.equal(registry.acceptingVotes(testVote, snapshot, END), false);
  assert.equal(registry.snapshotFor(testVote, { [testVote.id]: snapshot })?.block, snapshot.block);
  assert.equal(registry.snapshotFor(testVote, { [testVote.id]: { ...snapshot, block: 5 } }), null);
  assert.equal(registry.snapshotFor(testVote, { [testVote.id]: { ...snapshot, voteId: "x" } }), null);
  assert.equal(registry.snapshotFor(testVote, { [testVote.id]: { ...snapshot, checked: { balanceOf: 5, mismatches: 1 } } }), null);
  assert.equal(registry.snapshotFor(testVote, {}), null);
});

const route = await import("../src/app/api/vote/[id]/route");
const ballotsRoute = await import("../src/app/api/vote/[id]/ballots/route");
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, init?: RequestInit, query = "") =>
  new Request(`http://localhost/api/vote/${id}${query}`, { ...init, headers: { "x-forwarded-for": "203.0.113.7", "content-type": "application/json", ...(init?.headers ?? {}) } });

await test("routes: unknown votes are 404", async () => {
  for (const id of ["does-not-exist"]) {
    assert.equal((await route.GET(req(id), params(id))).status, 404);
    assert.equal((await route.POST(req(id, { method: "POST", body: "{}" }), params(id))).status, 404);
    assert.equal((await ballotsRoute.GET(req(`${id}/ballots`), params(id))).status, 404);
  }
});

await test("routes: in preview a draft shows, and takes no votes until its snapshot and window are in", async () => {
  const draft = VOTES.find((v) => !v.published);
  if (!draft) return;
  process.env.GLOAM_VOTE_PREVIEW = "1";
  try {
    const res = await route.GET(req(draft.id), params(draft.id));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { draft: boolean; options: string[]; accepting: boolean; snapshotReady: boolean } };
    assert.equal(body.data.draft, true);
    assert.deepEqual(body.data.options, draft.options);
    if (!registry.snapshotFor(draft) || !core.inWindow(draft)) {
      assert.equal(body.data.accepting, false);
      const post = await route.POST(req(draft.id, { method: "POST", body: JSON.stringify(await sign(alice, 0, nowSec, draft)) }), params(draft.id));
      assert.equal(post.status, 409);
    }
    assert.equal((await route.GET(req(draft.id, undefined, "?address=0x12"), params(draft.id))).status, 400);
    const csv = await ballotsRoute.GET(req(`${draft.id}/ballots`, undefined, "?format=csv"), params(draft.id));
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  } finally {
    delete process.env.GLOAM_VOTE_PREVIEW;
  }
});

await test("routes: the vote endpoint is rate limited per IP", async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await route.POST(req("does-not-exist", { method: "POST", body: "{}" }), params("does-not-exist"))).status;
  assert.equal(last, 429);
});

// ---------------------------------------------------------------- Glim

await test("Glim says nothing about votes until one is published, then gives the link and the rules", async () => {
  const { voteFacts } = await import("../src/lib/vote/glim");
  assert.equal(voteFacts([{ ...testVote, published: false }]), null);
  const text = voteFacts([testVote], NOW)!;
  assert.match(text, /gloam\.trade\/vote\/selftest-vote/);
  assert.match(text, /open until 8 Jan 2030, 00:00 UTC/);
  assert.match(text, /never tell anyone how to vote/);
  assert.match(text, /can't be counted in an open vote/);
  assert.doesNotMatch(text, /\u2014/, "no em dashes");
  assert.match(voteFacts([testVote], END)!, /closed/);
  if (!VOTES.some((v) => v.published)) assert.equal(voteFacts(), null, "nothing published, nothing said");
  else for (const v of VOTES.filter((x) => x.published)) assert.ok(voteFacts()!.includes(`gloam.trade/vote/${v.id}`));
});

await test("routes: every published vote answers with its own snapshot and options", async () => {
  for (const v of VOTES.filter((x) => x.published)) {
    const res = await route.GET(req(v.id), params(v.id));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { id: string; options: string[]; snapshotReady: boolean; snapshotBlock: number; eligible: { wallets: number } } };
    assert.equal(body.data.id, v.id);
    assert.deepEqual(body.data.options, v.options);
    assert.equal(body.data.snapshotReady, true);
    assert.equal(body.data.snapshotBlock, v.snapshotBlock);
    const d = body.data as typeof body.data & { weighting: string; basis: string };
    if (d.weighting === "snapshot") assert.ok(body.data.eligible.wallets > 100);
    else assert.ok(["live", "counting", "final"].includes(d.basis), d.basis);
  }
});

// ---------------------------------------------------------------- three votes at once

await test("three votes at once: separate tallies, separate last-vote-wins, no signature crosses over", async () => {
  const three = ["swaps", "chain", "apps"].map((id, i) => ({ ...testVote, id: `three-${id}`, options: [`${id} A`, `${id} B`, `${id} C`, `${id} D`].slice(0, 3 + (i % 2)) }));
  const c = (v: VoteConfig) => ctx({ vote: v, snapshot: { ...snapshot, voteId: v.id } });
  const [a, b, d] = three as [VoteConfig, VoteConfig, VoteConfig];
  // alice votes in all three; bob only in two; alice changes her mind in one
  await submitBallot(await sign(alice, 0, nowSec - 100, a), c(a));
  await submitBallot(await sign(alice, 1, nowSec - 100, b), c(b));
  await submitBallot(await sign(alice, 2, nowSec - 100, d), c(d));
  await submitBallot(await sign(bob, 1, nowSec - 90, a), c(a));
  await submitBallot(await sign(bob, 3, nowSec - 90, b), c(b));
  const changed = await submitBallot(await sign(alice, 2, nowSec - 50, b), c(b));
  assert.equal(changed.changed, true);
  // a signature for one vote never counts in another
  await rejects(submitBallot(await sign(bob, 0, nowSec - 40, a), c(d)), "bad_signature");
  // an older alice ballot in vote a is refused there, though she signed later in vote b
  await rejects(submitBallot(await sign(alice, 2, nowSec - 120, a), c(a)), "newer");

  const ta = core.tally(a, await listBallots(a.id));
  const tb = core.tally(b, await listBallots(b.id));
  const td = core.tally(d, await listBallots(d.id));
  assert.deepEqual(ta.options.map((o) => o.weight), [100n * ONE, 50n * ONE, 0n]);
  assert.deepEqual(tb.options.map((o) => o.weight), [0n, 0n, 100n * ONE, 50n * ONE]);
  assert.deepEqual(td.options.map((o) => o.weight), [0n, 0n, 100n * ONE]);
  assert.deepEqual([ta.wallets, tb.wallets, td.wallets], [2, 2, 1]);
  // each recounts clean on its own
  for (const v of three) {
    const r = await core.recount(v, snapshot, excluded, await listBallots(v.id));
    assert.deepEqual(r.problems, []);
  }
  // alice's standing differs per vote
  const { voterStanding } = await import("../src/lib/vote/results");
  assert.equal((await voterStanding(a, snapshot, excluded, alice.address)).ballot?.option, 0);
  assert.equal((await voterStanding(b, snapshot, excluded, alice.address)).ballot?.option, 2);
  assert.equal((await voterStanding(d, snapshot, excluded, bob.address)).ballot, null);
});

await test("routes: /api/vote lists every published vote, /api/vote/me gives one wallet's standing in each", async () => {
  const listRoute = await import("../src/app/api/vote/route");
  const meRoute = await import("../src/app/api/vote/me/route");
  const list = await listRoute.GET(new Request("http://localhost/api/vote", { headers: { "x-forwarded-for": "203.0.113.9" } }));
  assert.equal(list.status, 200);
  const lj = (await list.json()) as { data: { votes: { id: string; details: string[] }[] } };
  assert.deepEqual(lj.data.votes.map((v) => v.id).sort(), VOTES.filter((v) => v.published).map((v) => v.id).sort());
  for (const v of lj.data.votes) assert.equal(v.details.length, VOTES.find((x) => x.id === v.id)!.options.length);

  const meReq = (q: string) => new Request(`http://localhost/api/vote/me${q}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal((await meRoute.GET(meReq("?address=nope"))).status, 400);
  assert.equal((await meRoute.GET(meReq(""))).status, 400);
  // the largest eligible holder in the snapshot: weight, share, nothing cast yet
  const pub = VOTES.find((v) => v.published)!;
  const snap = registry.snapshotFor(pub)!;
  const ex = registry.excludedForVote(pub);
  const [top] = Object.entries(snap.balances).filter(([a]) => !ex.has(a));
  const closeWeighted = core.weightingOf(pub) === "close";
  // a close-weighted vote reads the wallet's GLOAM now: with no chain it says so instead of guessing
  if (closeWeighted) {
    assert.equal((await meRoute.GET(meReq(`?address=${top![0]}`))).status, 503);
    // the wallet now holds a little less than at the snapshot: that is its weight
    chainReads.setVoteChain(fakeChain({ [top![0]]: BigInt(top![1]) - 1n }));
    top![1] = (BigInt(top![1]) - 1n).toString();
  }
  const res = await meRoute.GET(meReq(`?address=${top![0]}`));
  assert.equal(res.status, 200);
  const mj = (await res.json()) as { data: { name: string | null; votes: Record<string, { weight: string; eligibleWallets: number; ballot: unknown; excluded: string | null }> } };
  assert.equal(mj.data.name, null);
  for (const v of VOTES.filter((x) => x.published)) {
    const st = mj.data.votes[v.id]!;
    assert.equal(st.weight, top![1]);
    assert.equal(st.excluded, null);
    assert.equal(st.ballot, null);
    if (!closeWeighted) assert.equal(st.eligibleWallets, core.eligibleTotal(snap, ex).wallets);
  }
  // a team wallet comes back excluded with weight 0
  const team = (await (await meRoute.GET(meReq("?address=0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8"))).json()) as typeof mj;
  for (const st of Object.values(team.data.votes)) {
    assert.equal(st.weight, "0");
    assert.match(st.excluded ?? "", /Team/);
  }
});

// ---------------------------------------------------------------- holder check and connected holders

const holders = await import("../src/lib/vote/holders");
const seenRoute = await import("../src/app/api/vote/seen/route");
const seenReq = (body: unknown, ip = "203.0.113.20") =>
  new Request("http://localhost/api/vote/seen", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "x-forwarded-for": ip } });
const pubVotes = VOTES.filter((v) => v.published);
const pubSnap = registry.snapshotFor(pubVotes[0]!)!;
const pubEx = registry.excludedForVote(pubVotes[0]!);
const [topHolder, topWei] = Object.entries(pubSnap.balances).find(([a]) => !pubEx.has(a))!;
const TEAM_WALLET = "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8";

await test("holder check: eligible, nothing at the snapshot, and a team wallet", async () => {
  const closeWeighted = pubVotes.some((v) => core.weightingOf(v) === "close");
  const yes = await holders.holderFacts(getAddress(topHolder), undefined, BigInt(topWei));
  assert.equal(yes.snapshot, topWei);
  assert.equal(yes.eligible, true);
  assert.equal(yes.excluded, null);
  assert.deepEqual(yes.signed, []);
  // weight at close: what the wallet holds now decides, whatever it held at the snapshot
  if (closeWeighted) assert.equal((await holders.holderFacts(getAddress(topHolder), undefined, 0n)).eligible, false, "sold since the snapshot");

  const zero = await holders.holderFacts(carol.address, undefined, 0n);
  assert.equal(zero.snapshot, "0");
  assert.equal(zero.eligible, false);
  assert.equal(zero.excluded, null);
  if (closeWeighted) {
    const bought = await holders.holderFacts(carol.address, undefined, 5n * ONE);
    assert.equal(bought.snapshot, "0");
    assert.equal(bought.eligible, true, "bought after the snapshot");
  }

  const teamFacts = await holders.holderFacts(getAddress(TEAM_WALLET), undefined, 1000n * ONE);
  assert.equal(teamFacts.eligible, false);
  assert.match(teamFacts.excluded ?? "", /Team/);
});

await test("connected holders: one record per wallet, first seen kept, last seen moved on", async () => {
  const facts = await holders.holderFacts(getAddress(topHolder));
  const first = await holders.recordHolder(facts, 5n * ONE, 1_000);
  assert.ok(first);
  assert.equal(first.visits, 1);
  // the same wallet again later, typed in lower case, with a failed chain read
  const again = await holders.recordHolder({ ...facts, address: topHolder.toLowerCase() }, null, 9_000);
  assert.equal(again!.firstSeen, 1_000);
  assert.equal(again!.lastSeen, 9_000);
  assert.equal(again!.visits, 2);
  assert.equal(again!.current, (5n * ONE).toString(), "a failed read keeps the last balance");
  assert.equal(again!.currentAt, 1_000);
  const list = await holders.listHolders();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.address, getAddress(topHolder));
  // a newer read replaces it
  const third = await holders.recordHolder(facts, 7n * ONE, 12_000);
  assert.equal(third!.current, (7n * ONE).toString());
  assert.equal(third!.currentAt, 12_000);
});

await test("connected holders: the signed votes are noted, and stay noted", async () => {
  const v = pubVotes[0]!;
  const { saveBallot } = await import("../src/lib/vote/store");
  await saveBallot(v.id, { voter: getAddress(topHolder), option: 0, choice: v.options[0]!, weight: topWei, timestamp: nowSec, signature: `0x${"cd".repeat(65)}`, receivedAt: NOW });
  const rec = await holders.recordHolder(await holders.holderFacts(getAddress(topHolder), undefined, BigInt(topWei)), null, 2_000);
  assert.deepEqual(rec!.signed, [v.id]);
  const csv = holders.holdersCsv([{ ...rec!, voted: rec!.signed }]);
  assert.ok(csv.startsWith('"wallet","first_seen_utc"'));
  assert.ok(csv.includes(getAddress(topHolder)) && csv.includes(topWei) && csv.includes('"yes"'));
});

await test("holder records: only a wallet with $GLOAM, a signed vote or a team listing is stored new", () => {
  const none = { address: carol.address, snapshot: "0", eligible: false, excluded: null, signed: [] as string[] };
  assert.equal(holders.worthRecording(none, null), false);
  assert.equal(holders.worthRecording(none, 0n), false);
  assert.equal(holders.worthRecording(none, 1n), true, "holds some now");
  assert.equal(holders.worthRecording({ ...none, snapshot: "1" }, null), true, "held at a snapshot");
  assert.equal(holders.worthRecording({ ...none, signed: ["v"] }, null), true, "signed a vote");
  assert.equal(holders.worthRecording({ ...none, excluded: "Team" }, null), true, "a listed team address");
});

await test("the seen route: balances from the server only, bad input refused, rate limited", async () => {
  // whatever balance the browser claims is ignored
  const res = await seenRoute.POST(seenReq({ address: carol.address, snapshot: (999n * ONE).toString(), current: (999n * ONE).toString(), eligible: true }));
  assert.equal(res.status, 200);
  const j = (await res.json()) as { data: { current: string | null; recorded: boolean } };
  assert.equal(j.data.current, null, "no chain read in the self-test");
  // nothing at the snapshot, nothing read now, no vote signed: answered, not stored
  assert.equal(j.data.recorded, false, "a wallet with no $GLOAM is not stored");
  assert.equal(await holders.getHolder(carol.address), null);
  // a flood of made-up addresses stores nothing
  const stored = (await holders.listHolders()).length;
  for (let i = 0; i < 10; i++) {
    const r = await seenRoute.POST(seenReq({ address: privateKeyToAccount(generatePrivateKey()).address }, `198.51.100.${i + 1}`));
    assert.equal(((await r.json()) as { data: { recorded: boolean } }).data.recorded, false);
  }
  assert.equal((await holders.listHolders()).length, stored, "nothing new stored");
  // a team wallet is recorded as excluded
  await seenRoute.POST(seenReq({ address: TEAM_WALLET }));
  const t = await holders.getHolder(TEAM_WALLET);
  assert.equal(t!.eligible, false);
  assert.match(t!.excluded ?? "", /Team/);
  // a holder at the snapshot is recorded, whatever the browser claims; twice is still one record
  const before = (await holders.getHolder(topHolder))?.visits ?? 0;
  const h = await seenRoute.POST(seenReq({ address: topHolder, snapshot: "1" }));
  assert.equal(((await h.json()) as { data: { recorded: boolean } }).data.recorded, true);
  const rec = await holders.getHolder(topHolder);
  assert.equal(rec!.snapshot, topWei);
  assert.equal(rec!.visits, before + 1);
  await seenRoute.POST(seenReq({ address: topHolder }));
  assert.equal((await holders.getHolder(topHolder))!.visits, before + 2);
  assert.equal((await holders.listHolders()).length, stored + 1 + (before === 0 ? 1 : 0), "the team wallet and the holder, once each");

  for (const bad of [{}, { address: "nope" }, { address: 42 }, "not json"]) assert.equal((await seenRoute.POST(seenReq(bad))).status, 400);
  assert.equal((await seenRoute.POST(seenReq({ address: `0x${"1".repeat(40)}`, pad: "x".repeat(600) }))).status, 413);
  assert.equal("GET" in seenRoute, false, "the records are never served from a public route");
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await seenRoute.POST(seenReq({ address: alice.address }, "203.0.113.21"))).status;
  assert.equal(last, 429);
});

// ---------------------------------------------------------------- weight at close

const dave = privateKeyToAccount(generatePrivateKey()); // bought after the snapshot

/** A stand-in chain: balances now from `now`, and blocks one second apart with the Transfer logs given. */
function fakeChain(now: Record<string, bigint>, opts: { logs?: import("../src/lib/vote/core").TransferLog[]; b0?: number; t0?: number; head?: number; atBlock?: "replay" | "gone" | "wrong"; calls?: { balances: number } } = {}) {
  const b0 = opts.b0 ?? 100_000_000;
  const t0 = opts.t0 ?? Math.floor(START / 1000) - 1_000;
  const head = opts.head ?? b0 + 10_000_000;
  const logs = opts.logs ?? [];
  const blk = (n: number) => ({ number: n, hash: `0x${n.toString(16).padStart(64, "0")}`, time: t0 + (n - b0) });
  const chain: import("../src/lib/vote/chainReads").VoteChain = {
    async balances(addresses, block) {
      if (opts.calls) opts.calls.balances++;
      const out = new Map<string, bigint>();
      if (block === undefined) {
        for (const a of addresses) out.set(a.toLowerCase(), now[a.toLowerCase()] ?? now[a] ?? 0n);
        return out;
      }
      if (opts.atBlock === "gone") throw new Error("missing trie node");
      const at = core.replayTransfers(logs, block);
      for (const a of addresses) out.set(a.toLowerCase(), (at.get(a.toLowerCase()) ?? 0n) + (opts.atBlock === "wrong" ? 1n : 0n));
      return out;
    },
    totalSupply: async () => Object.values(now).reduce((s, b) => s + b, 0n),
    head: async () => blk(head),
    block: async (n) => blk(n),
    transferLogs: async (from, to) => logs.filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to),
  };
  return chain;
}

const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const tlog = (block: number, from: string, to: string, amount: bigint) => ({
  blockNumber: `0x${block.toString(16)}`,
  topics: [core.TRANSFER_TOPIC, word(from), word(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
});

const closeVote: VoteConfig = { ...testVote, id: "selftest-close", weighting: "close" };
const B0 = 100_000_000;
const T0 = Math.floor(START / 1000) - 1_000;
/** The block whose time is the vote's end: the closing block. */
const CLOSE_BLOCK = B0 + (Math.floor(END / 1000) - T0);
const nowCtx = (now: Record<string, bigint | null>, extra: Partial<Parameters<typeof submitBallot>[1]> = {}) =>
  ctx({ vote: closeVote, snapshot: null, balanceNow: async (a: string) => (a.toLowerCase() in now ? now[a.toLowerCase()]! : 0n), ...extra });
const lower = (a: string) => a.toLowerCase();

await test("weight at close: the config field is optional, and only snapshot or close", () => {
  assert.equal(core.weightingOf(testVote), "snapshot", "a vote without the field weighs the snapshot, as before");
  assert.equal(core.weightingOf(closeVote), "close");
  assert.deepEqual(core.configProblems(closeVote), []);
  assert.deepEqual(core.configProblems({ ...closeVote, snapshotBlock: 0 }), [], "a close-weighted vote needs no snapshot");
  assert.ok(core.configProblems({ ...closeVote, weighting: "later" as never }).length > 0);
  for (const v of VOTES.filter((x) => x.published)) assert.equal(core.weightingOf(v), "close", `${v.id} weighs at close`);
  // and it takes votes without a snapshot
  assert.equal(registry.acceptingVotes(closeVote, null, NOW), true);
  assert.equal(registry.acceptingVotes(testVote, null, NOW), false);
});

await test("weight at close: a wallet that bought after the snapshot can vote, with what it holds now", async () => {
  assert.equal(snapshot.balances[lower(dave.address)], undefined, "dave isn't in the snapshot");
  const { ballot } = await submitBallot(await sign(dave, 1, nowSec, closeVote), nowCtx({ [lower(dave.address)]: 30n * ONE }));
  assert.equal(ballot.weight, (30n * ONE).toString());
  // the same wallet in the snapshot-weighted vote still can't
  await rejects(submitBallot(await sign(dave, 1), ctx()), "no_balance");
  // a snapshot holder votes with what it holds now, not what it held then
  const r = await submitBallot(await sign(alice, 0, nowSec, closeVote), nowCtx({ [lower(alice.address)]: 7n * ONE }));
  assert.equal(r.ballot.weight, (7n * ONE).toString());
});

await test("weight at close: a post-snapshot buyer's plain-text signature (the wallet fallback) is accepted", async () => {
  const v = closeVote;
  const message = core.voteMessage(v, 2, dave.address, nowSec);
  const signature = await dave.signMessage({ message: core.voteText(message) });
  const held = { [lower(dave.address)]: 12n * ONE };
  const { ballot } = await submitBallot({ voter: dave.address, option: 2, timestamp: nowSec, signature }, nowCtx(held));
  assert.equal(ballot.weight, (12n * ONE).toString());
  assert.equal(ballot.choice, "Blue");
  // and a typed-data signature with a chainId the wallet added
  const typed = await dave.signTypedData({ ...core.voteTypedData(core.voteMessage(v, 1, dave.address, nowSec + 1)), domain: { ...core.VOTE_DOMAIN, chainId: 4663 } });
  const r = await submitBallot({ voter: dave.address, option: 1, timestamp: nowSec + 1, signature: typed }, nowCtx(held));
  assert.equal(r.changed, true);
  // a plain-text signature over another choice, or from someone else, still fails
  await rejects(submitBallot({ voter: dave.address, option: 0, timestamp: nowSec + 2, signature: await dave.signMessage({ message: core.voteText(core.voteMessage(v, 1, dave.address, nowSec + 2)) }) }, nowCtx(held)), "bad_signature");
  await rejects(submitBallot({ voter: dave.address, option: 0, timestamp: nowSec + 2, signature: await bob.signMessage({ message: core.voteText(core.voteMessage(v, 0, dave.address, nowSec + 2)) }) }, nowCtx(held)), "bad_signature");
  // with nothing in the wallet, the fallback form is refused like any other
  const carolText = await carol.signMessage({ message: core.voteText(core.voteMessage(v, 0, carol.address, nowSec)) });
  await rejects(submitBallot({ voter: carol.address, option: 0, timestamp: nowSec, signature: carolText }, nowCtx({})), "no_balance");
  // and the final count accepts the plain-text ballot from the store
  const f = await final.computeFinal(v, await listBallots(v.id), excluded, null, {
    chain: fakeChain({}, { logs: [tlog(B0 + 10, ZERO, dave.address, 12n * ONE)] }),
  });
  assert.deepEqual(f.problems, []);
  assert.equal(f.totals.options[1]!.weight, (12n * ONE).toString());
});

await test("weight at close: an empty wallet is refused, and an unread balance never lets a vote through", async () => {
  try {
    await submitBallot(await sign(alice, 0, nowSec, closeVote), nowCtx({ [lower(alice.address)]: 0n }));
    assert.fail("went through");
  } catch (e) {
    assert.equal((e as InstanceType<typeof VoteError>).code, "no_balance");
    assert.equal((e as Error).message, "You need $GLOAM in this wallet to vote.");
  }
  await rejects(submitBallot(await sign(alice, 0, nowSec, closeVote), nowCtx({ [lower(alice.address)]: null })), "balance_unavailable");
  // with chain reads off, the default read can't answer: refused, not waved through
  await rejects(submitBallot(await sign(alice, 0, nowSec, closeVote), ctx({ vote: closeVote, snapshot: null })), "balance_unavailable");
  assert.equal((await listBallots(closeVote.id)).length, 0);
});

await test("weight at close: excluded wallets are still refused, whatever they hold", async () => {
  let asked = 0;
  const read = async () => {
    asked++;
    return 1000n * ONE;
  };
  await rejects(submitBallot(await sign(team, 0, nowSec, closeVote), ctx({ vote: closeVote, snapshot: null, balanceNow: read })), "excluded");
  assert.equal(asked, 0, "excluded before any read");
  // and a recount at close drops them even if a ballot slipped in
  const slipped = { ...(await sign(team, 0, nowSec, closeVote)), choice: "Red", weight: "1", receivedAt: NOW } as Ballot;
  const r = await core.recount(closeVote, { balances: { [lower(team.address)]: (1000n * ONE).toString() }, block: CLOSE_BLOCK }, excluded, [slipped], undefined, { closeBlock: CLOSE_BLOCK });
  assert.equal(r.tally.weight, 0n);
  assert.match(r.problems[0]!.problem, /excluded/);
});

await test("weight at close: the routes take a vote with no snapshot, and refuse after the close", async () => {
  // the snapshot-weighted path is unchanged; a close-weighted vote needs none (route check)
  assert.equal(registry.acceptingVotes(closeVote, null, END), false);
  await rejects(submitBallot(await sign(dave, 0, Math.floor(END / 1000), closeVote), nowCtx({ [lower(dave.address)]: ONE }, { now: END })), "closed");
});

await test("weight at close: live totals weigh each ballot by what its wallet holds now", async () => {
  const { voteSummary } = await import("../src/lib/vote/results");
  const held: Record<string, bigint> = { [lower(alice.address)]: 100n * ONE, [lower(dave.address)]: 30n * ONE, [lower(bob.address)]: 50n * ONE };
  await submitBallot(await sign(alice, 0, nowSec - 30, closeVote), nowCtx(held));
  await submitBallot(await sign(dave, 1, nowSec - 20, closeVote), nowCtx(held));
  await submitBallot(await sign(bob, 1, nowSec - 10, closeVote), nowCtx(held));
  // since voting: bob sold everything, alice sent 40 to dave
  const calls = { balances: 0 };
  chainReads.setVoteChain(fakeChain({ [lower(alice.address)]: 60n * ONE, [lower(dave.address)]: 70n * ONE, [lower(bob.address)]: 0n }, { calls }));
  const s = await voteSummary(closeVote, null, excluded, NOW);
  assert.equal(s.basis, "live");
  assert.equal(s.weighting, "close");
  assert.equal(s.snapshotReady, true);
  assert.equal(s.closeBlock, null);
  assert.deepEqual(s.totals.options.map((o) => o.weight), [(60n * ONE).toString(), (70n * ONE).toString(), "0"]);
  assert.equal(s.totals.weight, (130n * ONE).toString(), "the 40 alice sent counts once, with dave");
  assert.equal(s.totals.wallets, 2, "a wallet holding nothing now carries no weight");
  assert.equal(s.eligible?.wallets, null, "live: only the total is known");
  // the reads are cached: a second summary inside a minute asks the chain nothing new
  const before = calls.balances;
  await voteSummary(closeVote, null, excluded, NOW + 1_000);
  assert.equal(calls.balances, before);
  // a chain that doesn't answer: the weights the ballots were signed with stand in
  chainReads.setVoteChain(null);
  const off = await voteSummary(closeVote, null, excluded, NOW);
  assert.equal(off.totals.weight, (180n * ONE).toString());
});

/** Alice and dave hold GLOAM; after voting alice sends dave everything, then after the close dave sends it all back. */
function moves(closeBlock: number) {
  return [
    tlog(B0 - 5_000, ZERO, alice.address, 100n * ONE),
    tlog(B0 - 4_000, ZERO, bob.address, 50n * ONE),
    tlog(B0 - 3_000, ZERO, team.address, 1000n * ONE),
    tlog(B0 + 200_000, ZERO, dave.address, 30n * ONE), // dave buys after the snapshot
    tlog(B0 + 300_000, alice.address, dave.address, 100n * ONE), // after alice voted
    tlog(closeBlock, bob.address, carol.address, 10n * ONE), // in the closing block itself: counts
    tlog(closeBlock + 1, dave.address, alice.address, 130n * ONE), // after the close: doesn't
  ];
}

async function castCloseBallots() {
  const held: Record<string, bigint> = { [lower(alice.address)]: 100n * ONE, [lower(dave.address)]: 30n * ONE, [lower(bob.address)]: 50n * ONE };
  await submitBallot(await sign(alice, 0, nowSec - 30, closeVote), nowCtx(held));
  await submitBallot(await sign(dave, 1, nowSec - 20, closeVote), nowCtx(held));
  await submitBallot(await sign(bob, 2, nowSec - 10, closeVote), nowCtx(held));
}

await test("weight at close: GLOAM moved after a vote is counted once, with the wallet that holds it at the close", async () => {
  await castCloseBallots();
  const chain = fakeChain({}, { logs: moves(CLOSE_BLOCK) });
  const f = await final.computeFinal(closeVote, await listBallots(closeVote.id), excluded, null, { chain, now: END + 600_000 });
  assert.equal(f.closeBlock, CLOSE_BLOCK);
  assert.equal(f.closeBlockTime, Math.floor(END / 1000), "the first block at or after the end");
  const expected: Record<string, string> = { [lower(alice.address)]: "0", [lower(bob.address)]: (40n * ONE).toString(), [lower(dave.address)]: (130n * ONE).toString() };
  assert.deepEqual(f.balances, expected, "alice sent hers on, bob sent 10 away in the closing block, dave's send back came after");
  // alice voted, then moved everything to dave: her 100 counts once, in dave's vote
  assert.deepEqual(f.totals.options.map((o) => o.weight), ["0", (130n * ONE).toString(), (40n * ONE).toString()]);
  assert.equal(f.totals.weight, (170n * ONE).toString(), "never more than was held at the close");
  assert.equal(f.totals.wallets, 2);
  assert.ok(f.problems.some((p) => p.voter === alice.address && /held no GLOAM at the closing block/.test(p.problem)));
  assert.deepEqual(f.checked, { balanceOf: 3, mismatches: 0 });
  // every voter's weight is at most its own balance at the close, and the total at most what voters held
  const sumAtClose = Object.values(f.balances).reduce((s, b) => s + BigInt(b), 0n);
  assert.ok(BigInt(f.totals.weight) <= sumAtClose);
  // eligible: everyone at the close less the excluded team wallet
  assert.equal(f.eligible.weight, (100n * ONE + 30n * ONE + 50n * ONE).toString());
  // the same count from the published ballots, recounted by anyone with the balances at the close
  const r = await core.recount(closeVote, { balances: f.balances, block: f.closeBlock }, excluded, await listBallots(closeVote.id), undefined, { closeBlock: f.closeBlock });
  assert.equal(r.tally.weight.toString(), f.totals.weight);
});

await test("weight at close: the final count is the same however it is worked out", async () => {
  await castCloseBallots();
  const chain = fakeChain({}, { logs: moves(CLOSE_BLOCK) });
  const ballots = await listBallots(closeVote.id);
  const strip = (f: import("../src/lib/vote/core").FinalWeights) => ({ ...f, computedAt: "", replayFrom: 0, logs: 0 });
  const a = await final.computeFinal(closeVote, ballots, excluded, null, { chain, now: 1 });
  const b = await final.computeFinal(closeVote, [...ballots].reverse(), excluded, null, { chain, now: 2 });
  assert.deepEqual(strip(a), strip(b), "ballot order doesn't matter");
  // from a checked snapshot before the close: the same balances with fewer logs
  const at = core.replayTransfers(moves(CLOSE_BLOCK), B0);
  const base: VoteSnapshot = { ...snapshot, voteId: closeVote.id, block: B0, blockTime: T0, balances: Object.fromEntries([...at].map(([k, v]) => [k, v.toString()])) };
  const c = await final.computeFinal(closeVote, ballots, excluded, base, { chain, now: 3 });
  assert.equal(c.replayFrom, B0);
  assert.ok(c.logs < a.logs);
  assert.deepEqual(strip(c), strip(a), "replaying from the snapshot gives the same count as from launch");
  // the state at the block gone from the RPC: the replay alone, still the same count
  const gone = await final.computeFinal(closeVote, ballots, excluded, null, { chain: fakeChain({}, { logs: moves(CLOSE_BLOCK), atBlock: "gone" }) });
  assert.equal(gone.checked, null);
  assert.deepEqual(gone.totals, a.totals);
  // balanceOf disagreeing with the replay: refused, never stored
  await assert.rejects(final.computeFinal(closeVote, ballots, excluded, null, { chain: fakeChain({}, { logs: moves(CLOSE_BLOCK), atBlock: "wrong" }) }), /differ/);
  // a chain that hasn't reached the close yet: refused
  await assert.rejects(final.computeFinal(closeVote, ballots, excluded, null, { chain: fakeChain({}, { logs: moves(CLOSE_BLOCK), head: CLOSE_BLOCK - 10 }) }), /before the close/);
});

await test("weight at close: stored once, on the first results request after the close, and never replaced", async () => {
  const { voteSummary, ballotsExport } = await import("../src/lib/vote/results");
  await castCloseBallots();
  chainReads.setVoteChain(fakeChain({ [lower(alice.address)]: 1n }, { logs: moves(CLOSE_BLOCK) }));
  // closed, inside the grace: still live
  const early = await voteSummary(closeVote, null, excluded, END + 30_000, { finalize: true });
  assert.equal(early.status, "closed");
  assert.equal(early.basis, "counting");
  assert.equal(await final.storedFinal(closeVote.id), null);
  // a page load (no finalize) never works it out
  const page = await voteSummary(closeVote, null, excluded, END + final.FINAL_GRACE_MS + 1, {});
  assert.equal(page.basis, "counting");
  assert.equal(await final.storedFinal(closeVote.id), null);
  // another instance holds the lock: this one waits its turn
  await kv([["SET", `gloam:vote:v1:${closeVote.id}:final:lock`, "1", "NX", "EX", 90]]);
  assert.equal(await final.ensureFinal(closeVote, excluded, null, { now: END + final.FINAL_GRACE_MS + 1 }), null);
  await kv([["DEL", `gloam:vote:v1:${closeVote.id}:final:lock`]]);
  // the first API request after the grace works it out and stores it
  const after = END + final.FINAL_GRACE_MS + 1;
  const s = await voteSummary(closeVote, null, excluded, after, { finalize: true });
  assert.equal(s.basis, "final");
  assert.equal(s.closeBlock, CLOSE_BLOCK);
  assert.deepEqual(s.totals.options.map((o) => o.weight), ["0", (130n * ONE).toString(), (40n * ONE).toString()]);
  assert.equal(s.eligible?.wallets, 3);
  const stored = await final.storedFinal(closeVote.id);
  assert.ok(stored);
  // asking again changes nothing, even if the chain now says something else
  chainReads.setVoteChain(fakeChain({}, { logs: [] }));
  final.clearFinalCache();
  const again = await final.ensureFinal(closeVote, excluded, null, { now: after + 60_000 });
  assert.deepEqual(again, stored);
  const s2 = await voteSummary(closeVote, null, excluded, after + 60_000, { finalize: true });
  assert.deepEqual(s2.totals, s.totals);
  // the standing and the export use the final weights
  const { voterStanding } = await import("../src/lib/vote/results");
  const st = await voterStanding(closeVote, null, excluded, dave.address, { now: after });
  assert.equal(st.basis, "close");
  assert.equal(st.weight, (130n * ONE).toString());
  const doc = await ballotsExport(closeVote, null, excluded, { now: after });
  assert.equal(doc.final?.closeBlock, CLOSE_BLOCK);
  assert.equal(doc.ballots.find((b) => b.voter === alice.address)?.weight, "0");
  assert.equal(doc.ballots.find((b) => b.voter === dave.address)?.weight, (130n * ONE).toString());
  // a snapshot-weighted vote never has a final count
  assert.equal(await final.ensureFinal(testVote, excluded, snapshot, { now: after }), null);
});

await test("a closed vote's outcome reaches Glim, and an open one's doesn't", async () => {
  const { voteFacts } = await import("../src/lib/vote/glim");
  const v = { ...VOTES[0]!, outcome: "Stablecoin swaps are next." };
  assert.match(voteFacts([v], Date.parse(v.end) + 1000) ?? "", /Result: Stablecoin swaps are next\./);
  assert.doesNotMatch(voteFacts([v], Date.parse(v.start) + 1000) ?? "", /Result:/);
});

await test("weight at close: feedback and Glim follow what a wallet holds now", async () => {
  const { feedbackWeight } = await import("../src/lib/vote/feedback");
  const { voteFacts } = await import("../src/lib/vote/glim");
  chainReads.setVoteChain(fakeChain({ [lower(dave.address)]: 30n * ONE, [lower(team.address)]: 1000n * ONE }));
  assert.equal(await feedbackWeight(dave.address, [closeVote], NOW), 30n * ONE, "bought after the snapshot");
  assert.equal(await feedbackWeight(carol.address, [closeVote], NOW), 0n);
  assert.equal(await feedbackWeight(team.address, [closeVote], NOW), 0n, "excluded");
  assert.equal(await feedbackWeight(dave.address, [closeVote], END), 0n, "closed");
  const text = voteFacts([closeVote], NOW)!;
  assert.match(text, /when the vote closes/);
  assert.doesNotMatch(text, /snapshot block|\u2014/);
  assert.match(voteFacts([testVote], NOW)!, /snapshot block/, "a snapshot-weighted vote still says so");
});

await test("weight at close: the ballots cast before the change still verify, unchanged", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/vote-ballots-2026-10-29.json", import.meta.url), "utf8")) as { ballots: Record<string, Ballot[]> };
  let n = 0;
  for (const [id, ballots] of Object.entries(fixture.ballots)) {
    const v = VOTES.find((x) => x.id === id)!;
    assert.equal(core.weightingOf(v), "close");
    for (const b of ballots) {
      // the message is the one they signed: weighting isn't part of it
      const message = core.voteMessage(v, b.option, b.voter, b.timestamp);
      assert.deepEqual(message, core.voteMessage({ ...v, weighting: undefined }, b.option, b.voter, b.timestamp));
      assert.equal(message.snapshotBlock, BigInt(v.snapshotBlock));
      assert.ok(await core.signatureValid(message, b.signature), `${id} ${b.voter}`);
      n++;
    }
    // and they count at close, with whatever their wallets held then
    const balances = Object.fromEntries(ballots.map((b) => [lower(b.voter), b.weight]));
    const r = await core.recount(v, { balances, block: 123 }, registry.excludedForVote(v), ballots, undefined, { closeBlock: 123 });
    assert.deepEqual(r.problems, []);
    assert.equal(r.counted.length, ballots.length);
  }
  assert.ok(n >= 4, `${n} ballots checked`);
});

// ---------------------------------------------------------------- display

await test("amounts and shares read plainly", () => {
  assert.equal(core.formatGloam(0n), "0");
  assert.equal(core.formatGloam(1n), "<0.01");
  assert.equal(core.formatGloam(1234n * ONE + ONE / 2n), "1,234.5");
  assert.equal(core.formatGloam((ONE * 5n) / 100n), "0.05");
  assert.equal(core.formatGloam((54_550n * ONE).toString()), "54,550");
  assert.equal(core.percentOf(1n, 3n), 33.3);
  assert.equal(core.percentOf(0n, 0n), 0);
  assert.equal(core.sharePercent(1240n * ONE, 447_743n * ONE), "0.27%");
  assert.equal(core.sharePercent(1n, 447_743n * ONE), "<0.01%");
  assert.equal(core.sharePercent(0n, 5n), "0%");
  assert.equal(core.sharePercent(5n, 0n), "0%");
  assert.equal(core.sharePercent(1n, 4n), "25%");
  assert.equal(core.whenPhrase("2026-11-02T00:00:00Z"), "Sunday 1 Nov at midnight UTC");
  assert.equal(core.whenPhrase("2026-10-29T16:15:00Z"), "Thursday 29 Oct at 4:15pm UTC");
  assert.equal(core.whenPhrase("2026-11-01T23:00:00Z"), "Sunday 1 Nov at 11pm UTC");
  assert.equal(core.whenPhrase("2026-11-01T12:00:00Z"), "Sunday 1 Nov at noon UTC");
  assert.equal(core.whenPhrase("2026-11-01T09:30:00Z"), "Sunday 1 Nov at 9:30am UTC");
  assert.equal(core.timeLeft(30_000), "less than a minute");
  assert.equal(core.timeLeft(60_000), "1 minute");
  assert.equal(core.timeLeft(12 * 60_000), "12 minutes");
  assert.equal(core.timeLeft(3_600_000), "1 hour");
  assert.equal(core.timeLeft(5 * 3_600_000 + 12 * 60_000), "5 hours, 12 minutes");
  assert.equal(core.timeLeft(2 * 86_400_000 + 7 * 3_600_000 + 59_000), "2 days, 7 hours");
  assert.equal(core.timeLeft(86_400_000), "1 day");
});

await test("the final count checks smart wallets, and stops rather than drop one when the node gives no answer", async () => {
  const signature = `0x${"11".repeat(65)}` as Hex;
  const ballot = { voter: smart, option: 1, choice: closeVote.options[1]!, weight: "0", timestamp: nowSec, signature, receivedAt: Date.now() };
  const at = { balances: { [lower(smart)]: (7n * ONE).toString() }, block: 1 };
  const counted = await core.recount(closeVote, at, excluded, [ballot], async () => true, { closeBlock: 1 });
  assert.deepEqual(counted.counted.map((b) => b.weight), [(7n * ONE).toString()]);
  const bad = await core.recount(closeVote, at, excluded, [ballot], async () => false, { closeBlock: 1 });
  assert.deepEqual(bad.problems.map((p) => p.problem), ["signature does not match"], "a clear no is still a no");
  await assert.rejects(
    core.recount(closeVote, at, excluded, [ballot], async () => {
      throw new core.ContractCheckDown(smart);
    }, { closeBlock: 1 }),
    core.ContractCheckDown,
  );
  // ballots come in with a retry, so there the same failure is only a no
  await rejects(
    submitBallot({ voter: smart, option: 1, timestamp: nowSec, signature }, ctx({ contractCheck: async () => { throw new Error("rpc"); } })),
    "bad_signature",
  );
  // the site's count, and the script's, both make this check
  const { readFileSync } = await import("node:fs");
  const results = readFileSync(new URL("../src/lib/vote/results.ts", import.meta.url), "utf8");
  assert.ok(/ensureFinal\(v, excluded, snapshot, \{[^}]*contractCheck: smartWalletFinalCheck/.test(results));
  const script = readFileSync(new URL("./vote-final.mts", import.meta.url), "utf8");
  assert.equal((script.match(/contractCheck: smartWalletFinalCheck/g) ?? []).length, 2);
});

console.log(`\n${passed} passed`);
