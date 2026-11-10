/**
 * Self-test: securing a claim on a weak connection (lib/secureRetry,
 * lib/claimSweep withSecureRetries, secureClaim, secureClaimsInBackground).
 *
 * User report, 10 Nov 2026: a 50 USDG claim on Robinhood Chain mainnet, on a
 * mobile network, ended "not secured yet: Robinhood Chain could not be reached
 * just now". Covers: which failures count as the connection's (and that a
 * revert, a refusal or the network-switch message do not), retries of chain
 * reads and of the proving files before anyone is told, a message that names
 * the part that failed (the chain, the files, the Gloam relay), a relay reply
 * lost on the way back looked for on the chain and never sent again, one
 * secure of a note at a time, and claims secured again with no one asking:
 * paced, never while a move may still land, never with the relay off.
 *
 * Runs the app's own code against an in-memory pool that follows
 * ShieldPoolPoseidon.transfer's rules, like selftest-claim-sweep.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-secure-retry.mts
 */
import assert from "node:assert/strict";
import "./browser-shim.mjs";
import { BaseError, HttpRequestError, LimitExceededRpcError, TimeoutError, type Address, type Hex } from "viem";
import {
  IncrementalMerkleTreePoseidon,
  fieldToHex,
  hexToField,
  noteCommitmentPoseidon,
  noteNullifierPoseidon,
  randomSecretField,
  type PoseidonMerklePath,
} from "@gloamtrade/sdk";

const { getActiveNetwork } = await import("../src/lib/networks");
const { getAllNotes, setAllNotes } = await import("../src/lib/noteVault");
const { activeSpendableNotes, saveLocalNote } = await import("../src/lib/shield");
const { RelaySubmitError, setRelayPreferred } = await import("../src/lib/relay/client");
const {
  claimNoteId,
  claimsToSecure,
  isUnsecuredClaim,
  reconcileClaims,
  secureClaim,
  secureClaimsInBackground,
  securingNow,
  withSecureRetries,
} = await import("../src/lib/claimSweep");
const {
  READ_RETRY,
  SecureStepError,
  isTransientNetError,
  retryStep,
  retryTransient,
  secureFailureOf,
  secureFailureReason,
  secureNextStep,
} = await import("../src/lib/secureRetry");
type LocalNote = import("../src/lib/shield").LocalNote;
type ClaimEnv = import("../src/lib/claimSweep").ClaimEnv;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  // every test starts from an empty store: leftover claims would be secured by the background ones
  await setAllNotes([]);
  await fn();
  passed++;
  console.log(`ok  ${name}`);
}

const net = getActiveNetwork();
const POOL = net.pool as Address;
const ASSET = "0x00000000000000000000000000000000000000ee" as Address;
const ME = "0x1111111111111111111111111111111111111111" as Address;
const lc = (h: string) => h.toLowerCase();
const BLOCK = BigInt(1);

// What a dropped connection looks like, from viem and from a plain fetch.
const rpcDown = () => new HttpRequestError({ url: "https://rpc.mainnet.chain.robinhood.com", body: { method: "eth_call" }, details: "Failed to fetch" });
/** viem wraps a read's failure: ContractFunctionExecutionError -> CallExecutionError -> HttpRequestError. */
const wrappedRpcDown = () => new BaseError("The contract function \"isSpent\" could not be called.", { cause: rpcDown() });
const fetchDown = () => new TypeError("Failed to fetch");

/** No real waiting in tests; the waits asked for are recorded. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

function mockPool() {
  const tree = new IncrementalMerkleTreePoseidon();
  const index = new Map<string, number>();
  const roots = new Set<string>();
  const spent = new Set<string>();
  const receipts = new Map<string, "success" | "reverted">();
  let n = 0;
  let relayed = 0;
  async function insert(c: Hex) {
    index.set(lc(c), await tree.insert(hexToField(c)));
    roots.add(lc(fieldToHex(tree.currentRoot)));
  }
  async function apply(args: readonly [Hex, Hex, Hex, readonly [Hex, Hex]]) {
    const [, root, nullifier, outs] = args;
    const ok = roots.has(lc(root)) && !spent.has(lc(nullifier)) && outs.every((c) => !index.has(lc(c)));
    if (ok) {
      spent.add(lc(nullifier));
      for (const c of outs) await insert(c);
    }
    return ok;
  }
  async function transfer(args: readonly [Hex, Hex, Hex, readonly [Hex, Hex]]): Promise<Hex> {
    const hash = `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
    receipts.set(hash, (await apply(args)) ? "success" : "reverted");
    return hash;
  }
  return {
    insert,
    apply,
    spent,
    index,
    get relayed() {
      return relayed;
    },
    env(over: Partial<ClaimEnv> = {}): ClaimEnv {
      const base: ClaimEnv = {
        chainId: net.chainId,
        pool: POOL,
        chain: {
          isSpent: async (nf) => spent.has(lc(nf)),
          isCommitmentSeen: async (c) => index.has(lc(c)),
          pathForCommitment: async (c) => {
            const i = index.get(lc(c));
            return i == null ? null : ((await tree.path(i)) as PoseidonMerklePath);
          },
          waitForReceipt: async (h) => ({ status: receipts.get(h) ?? "reverted" }),
        },
        prove: async () => ({ proofBytes: "0xdeadbeef" }),
        relay: (t) => transfer([t.proof, t.root, t.nullifier, t.commitments]),
        leafIndexOf: async (c) => index.get(lc(c)),
        stateAt: async (nf, c) => ({ spent: nf ? spent.has(lc(nf)) : null, seen: index.has(lc(c)), block: BLOCK }),
        landChecksMs: [5, 5, 5],
        ...over,
      };
      // every relay send counted, whatever the test puts in its place
      const send = base.relay;
      return {
        ...base,
        relay: (t) => {
          relayed++;
          return send(t);
        },
      };
    },
  };
}

async function claimed(pool: ReturnType<typeof mockPool>, amount: bigint): Promise<LocalNote> {
  const secret = await randomSecretField();
  const commitment = fieldToHex(await noteCommitmentPoseidon(secret, amount, ASSET));
  const nullifier = fieldToHex(await noteNullifierPoseidon(secret, hexToField(commitment)));
  await pool.insert(commitment);
  const note: LocalNote = {
    id: claimNoteId(),
    chainId: net.chainId,
    pool: POOL,
    asset: ASSET,
    amountWei: amount.toString(),
    commitment,
    secret: fieldToHex(secret),
    nullifier,
    bound: true,
    scheme: "poseidon",
    from: ME,
    createdAt: Date.now(),
    status: "open",
    source: "local",
    unfunded: false,
    leafIndex: pool.index.get(lc(commitment)),
  };
  await saveLocalNote(note);
  await new Promise((r) => setTimeout(r, 2)); // distinct ids
  return note;
}

const byId = (id: string) => getAllNotes().find((n) => n.id === id)!;
const freshOf = (claim: LocalNote) => getAllNotes().filter((n) => n.sweptFrom?.id === claim.id);
const secured = (claim: LocalNote) => byId(claim.id).secured === true && byId(claim.id).status === "recovered";
const counted = (claim: LocalNote) =>
  activeSpendableNotes(getAllNotes())
    .filter((n) => n.id === claim.id || n.sweptFrom?.id === claim.id)
    .reduce((s, n) => s + BigInt(n.amountWei), 0n);
const noWallet = async (): Promise<Hex> => {
  throw new Error("wallet should not be used");
};
const until = async (ok: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  return ok();
};

// ---------------------------------------------------------------- which failures

await test("a dropped connection counts as one, from viem or a plain fetch", () => {
  for (const e of [
    rpcDown(),
    wrappedRpcDown(),
    new TimeoutError({ body: {}, url: "https://rpc.mainnet.chain.robinhood.com" }),
    new LimitExceededRpcError(new Error("rate limited")),
    fetchDown(),
    new TypeError("Load failed"),
    new TypeError("NetworkError when attempting to fetch resource."),
    new TypeError("The network connection was lost."),
    Object.assign(new Error("Loading chunk 812 failed."), { name: "ChunkLoadError" }),
    new Error("Missing circuit file /circuits/final/transfer_final.zkey (503)."),
  ]) {
    assert.equal(isTransientNetError(e), true, String((e as Error).message));
  }
});

await test("a revert, a refusal or a wrong network is not the connection", () => {
  for (const e of [
    new Error("execution reverted: AlreadySpent"),
    new Error("User rejected the request."),
    // the old check matched /network/ and blamed the chain for this one
    new Error("Switch to the network this payment is on to secure it."),
    new Error("Circuit artifact hash mismatch for /circuits/transfer.wasm. Expected abc… got def…, refuse to prove."),
    new Error("Missing circuit file /circuits/final/transfer_final.zkey (404)."),
    new RelaySubmitError("Could not reach the relay. Check your connection.", "network"),
    new Error("Timed out while waiting for transaction with hash 0xab"),
  ]) {
    assert.equal(isTransientNetError(e), false, (e as Error).message);
    assert.equal(secureFailureOf(e), null, (e as Error).message);
  }
});

await test("the message names the part that failed", () => {
  const label = "Robinhood Chain";
  const chain = secureFailureReason(secureFailureOf(new SecureStepError("chain", rpcDown()))!, label);
  assert.match(chain, /^Robinhood Chain could not be reached/);
  assert.match(chain, /even after a few tries/);
  assert.doesNotMatch(chain, /relay/i);
  assert.equal(secureFailureOf(wrappedRpcDown())?.step, "chain", "an unretried viem failure is the chain's");
  assert.doesNotMatch(secureFailureReason(secureFailureOf(rpcDown())!, label), /a few tries/);
  const files = secureFailureReason(secureFailureOf(new SecureStepError("files", fetchDown()))!, label);
  assert.match(files, /files needed to secure it could not be downloaded/);
  assert.doesNotMatch(files, /Robinhood Chain/);
  assert.equal(secureFailureOf(fetchDown())?.step, "connection", "a fetch that names no part blames no part");
  // the server's own "network" code (a chain it does not serve) answered: not "could not be reached"
  assert.doesNotMatch(
    secureFailureReason({ step: "relay", code: "network", reached: true, maybeSent: true }, label),
    /could not be reached/
  );
  const relayDown = secureFailureReason({ step: "relay", code: "network", reached: false, maybeSent: true }, label);
  assert.match(relayDown, /Gloam relay could not be reached/);
  assert.doesNotMatch(relayDown, /Robinhood Chain/);
  assert.match(secureFailureReason({ step: "relay", code: "maybe_sent", reached: true, maybeSent: true }, label), /may still land/);
  assert.match(secureFailureReason({ step: "relay", code: "rate_limit", reached: true, maybeSent: false }, label), /could not take it just now/);
  assert.match(secureNextStep(true), /keeps trying/);
  assert.match(secureNextStep(false), /Tap Secure it now/);
  const all = [chain, files, relayDown, secureNextStep(true), secureNextStep(false)].join(" ");
  assert.doesNotMatch(all, /—|–|happy to/i, "plain copy: no em or en dashes");
});

// ---------------------------------------------------------------- retries

await test("a read that drops is tried again with growing waits, then answers", async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;
  const out = await retryTransient(async () => {
    if (++calls < 3) throw wrappedRpcDown();
    return 7;
  }, READ_RETRY, { sleep });
  assert.equal(out, 7);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [READ_RETRY.delays[0], READ_RETRY.delays[1]]);
});

await test("any other error is not tried again", async () => {
  let calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls++;
      throw new Error("execution reverted");
    }, READ_RETRY, { sleep: async () => {} }),
    /reverted/
  );
  assert.equal(calls, 1);
});

await test("a read that never answers gives up after its retries, as the chain's", async () => {
  let calls = 0;
  const e = await retryStep("chain", async () => {
    calls++;
    throw rpcDown();
  }, READ_RETRY, { sleep: async () => {} }).catch((x: unknown) => x);
  assert.ok(e instanceof SecureStepError);
  assert.equal((e as InstanceType<typeof SecureStepError>).step, "chain");
  assert.equal(calls, READ_RETRY.delays.length + 1);
});

await test("a read that timed out leaves no room for more (the budget)", async () => {
  let clock = 0;
  let calls = 0;
  await assert.rejects(
    retryTransient(async () => {
      calls++;
      clock += 30_000; // each try hangs for its whole timeout
      throw new TimeoutError({ body: {}, url: "https://rpc.mainnet.chain.robinhood.com" });
    }, READ_RETRY, { sleep: async (ms) => void (clock += ms), now: () => clock })
  );
  assert.equal(calls, 2, "one more try fits in 45 s, a third does not");
});

// ---------------------------------------------------------------- securing

await test("the chain drops twice mid-secure: tried again, secured, one send", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 50_000_000n);
  let drops = 2;
  const base = pool.env();
  const env = withSecureRetries(
    {
      ...base,
      chain: {
        ...base.chain,
        isSpent: async (nf) => {
          if (drops-- > 0) throw wrappedRpcDown();
          return base.chain.isSpent(nf);
        },
      },
    },
    { sleep: async () => {} }
  );
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env);
  assert.equal(r.status, "swept");
  assert.equal(pool.relayed, 1);
  assert.equal(secured(claim), true);
  assert.equal(counted(claim), 50_000_000n, "counted once");
});

await test("the chain stays unreachable: nothing proved or sent, and the error names the chain", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 50_000_000n);
  let proved = 0;
  const base = pool.env({
    prove: async () => {
      proved++;
      return { proofBytes: "0xdeadbeef" };
    },
  });
  const env = withSecureRetries(
    { ...base, chain: { ...base.chain, isSpent: async () => { throw wrappedRpcDown(); } } },
    { sleep: async () => {} }
  );
  const e = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env).catch((x: unknown) => x);
  assert.ok(e instanceof SecureStepError, String(e));
  const why = secureFailureReason(secureFailureOf(e)!, "Robinhood Chain");
  assert.match(why, /Robinhood Chain could not be reached/);
  assert.equal(proved, 0);
  assert.equal(pool.relayed, 0);
  assert.equal(freshOf(claim).length, 0, "no fresh note saved");
  assert.equal(isUnsecuredClaim(byId(claim.id)), true, "still the claim, still flagged");
  assert.equal(byId(claim.id).unfunded, false, "not mistaken for a payment that never arrived");
  assert.equal(counted(claim), 50_000_000n);
});

await test("the proving files cut off once: downloaded again, secured", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 20_000_000n);
  let cut = 1;
  const env = withSecureRetries(
    pool.env({
      prove: async () => {
        if (cut-- > 0) throw fetchDown();
        return { proofBytes: "0xdeadbeef" };
      },
    }),
    { sleep: async () => {} }
  );
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env);
  assert.equal(r.status, "swept");
  assert.equal(pool.relayed, 1);
});

await test("the proving files never come: the error names the files, not the chain", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 20_000_000n);
  const env = withSecureRetries(pool.env({ prove: async () => { throw fetchDown(); } }), { sleep: async () => {} });
  const e = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env).catch((x: unknown) => x);
  assert.ok(e instanceof SecureStepError);
  assert.equal((e as InstanceType<typeof SecureStepError>).step, "files");
  assert.doesNotMatch(secureFailureReason(secureFailureOf(e)!, "Robinhood Chain"), /Robinhood Chain/);
  assert.equal(pool.relayed, 0);
});

await test("the relay's reply is lost but the move lands: found on the chain, never sent again", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 9_000_000n);
  const env = pool.env({
    relay: async (t) => {
      // the relay took it; it lands a moment after the reply is lost
      setTimeout(() => void pool.apply([t.proof, t.root, t.nullifier, t.commitments]), 1);
      throw new RelaySubmitError("Could not reach the relay. Check your connection.", "network");
    },
  });
  const stages: string[] = [];
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet, onStage: (s) => stages.push(s) }, env);
  assert.equal(r.status, "swept");
  assert.equal(r.relayFailure, undefined, "it landed: nothing to explain");
  assert.equal(pool.relayed, 1, "sent once");
  assert.ok(stages.some((s) => /Checking whether it went through/.test(s)));
  assert.equal(secured(claim), true);
  assert.equal(counted(claim), 9_000_000n);
});

await test("the relay can't be reached and nothing lands: not resent, the message names the relay", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 9_000_000n);
  const env = pool.env({
    relay: async () => {
      throw new RelaySubmitError("Could not reach the relay. Check your connection.", "network");
    },
  });
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env);
  assert.equal(r.final, false);
  assert.deepEqual(r.relayFailure, { code: "network", reached: false, maybeSent: true });
  assert.equal(pool.relayed, 1);
  assert.match(secureFailureReason({ step: "relay", ...r.relayFailure! }, "Robinhood Chain"), /Gloam relay could not be reached/);
  const [pending] = freshOf(claim);
  assert.equal(pending?.sweepPending, true, "its fresh note is kept: the relay may still have sent it");
  assert.equal(counted(claim), 9_000_000n, "counted once, as the claim");
});

await test("the relay turns it away (busy): said so, and the chain is not searched for it", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 4_000_000n);
  const stages: string[] = [];
  const env = pool.env({
    relay: async () => {
      throw new RelaySubmitError("The relay is busy. Try again shortly or send from your wallet.", "rate_limit");
    },
  });
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet, onStage: (s) => stages.push(s) }, env);
  assert.deepEqual(r.relayFailure, { code: "rate_limit", reached: true, maybeSent: false });
  assert.ok(!stages.some((s) => /Checking whether/.test(s)));
});

await test("two secures of one note at once: the second waits, finds it secured, sends nothing", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 3_000_000n);
  const env = pool.env();
  const first = secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env);
  assert.equal(securingNow(claim.id), true);
  const second = secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "swept");
  assert.equal(b.status, "swept", "reported secured, not taken back");
  assert.equal(pool.relayed, 1);
  assert.equal(securingNow(claim.id), false);
  assert.equal(counted(claim), 3_000_000n);
});

// ---------------------------------------------------------------- with no one asking

await test("a claim left open to its payer is secured in the background", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 50_000_000n);
  assert.deepEqual(claimsToSecure(getAllNotes()).map((n) => n.id), [claim.id]);
  await secureClaimsInBackground(pool.env());
  assert.ok(await until(() => secured(claim)), "secured with no one asking");
  assert.equal(pool.relayed, 1);
  assert.equal(counted(claim), 50_000_000n);
  assert.deepEqual(claimsToSecure(getAllNotes()), []);
});

await test("after a failed try someone asked for, the background waits its turn, then goes when the connection is back", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 50_000_000n);
  let up = false;
  const base = pool.env();
  const env = withSecureRetries(
    {
      ...base,
      chain: {
        ...base.chain,
        isSpent: async (nf) => {
          if (!up) throw rpcDown();
          return base.chain.isSpent(nf);
        },
      },
    },
    { sleep: async () => {} }
  );
  await assert.rejects(secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, env));
  up = true;
  await secureClaimsInBackground(env);
  assert.equal(pool.relayed, 0, "not straight after the try that just failed");
  assert.equal(secured(claim), false);
  await secureClaimsInBackground(env, { now: true });
  assert.ok(await until(() => secured(claim)), "the connection is back: tried at once");
  assert.equal(pool.relayed, 1);
});

await test("a move whose reply was lost is never sent again by the background while it may land", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 6_000_000n);
  let held: readonly [Hex, Hex, Hex, readonly [Hex, Hex]] | null = null;
  const lost = pool.env({
    relay: async (t) => {
      held = [t.proof, t.root, t.nullifier, t.commitments];
      throw new RelaySubmitError("Could not reach the relay. Check your connection.", "network");
    },
  });
  const r = await secureClaim({ note: claim, relay: true, sendWithWallet: noWallet }, lost);
  assert.equal(r.final, false);
  assert.equal(pool.relayed, 1);
  // the background, even told the connection is back, leaves it alone: it may still land
  await secureClaimsInBackground(pool.env(), { now: true });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(pool.relayed, 1, "no second send");
  // it lands; the sync settles it
  assert.ok(held);
  assert.equal(await pool.apply(held!), true);
  assert.equal(await reconcileClaims(pool.env()), true);
  assert.equal(secured(claim), true);
  assert.equal(counted(claim), 6_000_000n);
});

await test("with the relay turned off, nothing is secured in the background (the wallet is never asked)", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 5_000_000n);
  setRelayPreferred(false);
  try {
    await secureClaimsInBackground(pool.env(), { now: true });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(pool.relayed, 0);
    assert.equal(isUnsecuredClaim(byId(claim.id)), true);
  } finally {
    setRelayPreferred(true);
  }
});

await test("a claim the vault has not shown yet is left to the funded check", async () => {
  const pool = mockPool();
  const claim = await claimed(pool, 5_000_000n);
  const { updateLocalNote } = await import("../src/lib/shield");
  await updateLocalNote(claim.id, { unfunded: true });
  assert.deepEqual(claimsToSecure(getAllNotes()), []);
  await secureClaimsInBackground(pool.env(), { now: true });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(pool.relayed, 0);
});

console.log(`\n${passed} secure-retry checks passed`);
