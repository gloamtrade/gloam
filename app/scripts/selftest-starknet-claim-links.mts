/**
 * Self-test: claim links on Starknet (lib/starknetPrivacy/claimLink, claim,
 * sentLinks, and the link rows of lib/starknetPrivacy/payroll).
 *
 *  - the link: its body round-trips, a cut, mistyped or other-version link is
 *    refused, the fragment is letters, digits and "=" only, and no EVM or
 *    Solana reader takes it (or it theirs);
 *  - the one-time account: the same secret always gives the same account,
 *    and another secret another;
 *  - claiming: nothing in it (claimed, taken back, not paid yet), less than the
 *    fee, a claim, a claim whose answer was lost after it landed (said, never
 *    moved twice), a failure with the money still there;
 *  - payroll rows with no account: paid by link when links are on, refused
 *    otherwise; the estimate adds a proof per link and Gloam's fee twice; the
 *    engine keeps a link before anything is sent for it, opens it before the
 *    proof, reuses the same link on resume, pauses when it can't keep one,
 *    and marks links paid; the results file carries a paid link's URL;
 *  - the sent links store: sealed, a link not used is never dropped.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-claim-links.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "devnet";

const L = await import("../src/lib/starknetPrivacy/claimLink");
const C = await import("../src/lib/starknetPrivacy/claim");
const P = await import("../src/lib/starknetPrivacy/payroll");
const S = await import("../src/lib/starknetPrivacy/payrollStore");
const SL = await import("../src/lib/starknetPrivacy/sentLinks");
const { keysFromSeed } = await import("../src/lib/starknetPrivacy/account");
const { codeFromHash, shortCodeFromHash } = await import("../src/lib/claimLink");
type PayrollRun = import("../src/lib/starknetPrivacy/payroll").PayrollRun;

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  checks++;
};

const USDC = { symbol: "USDC", decimals: 6 };
const ONE = 1_000_000n;
const OWNER = "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656";
const secret = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) % 256);

// ------------------------------------------------------------------ the link

{
  const claim = { network: "mainnet" as const, token: 0, amount: 250n * ONE, secret };
  const body = L.claimBody(claim);
  ok(/^[1-9A-HJ-NP-Za-km-z]{38,44}$/.test(body), `the body is base58, about 42 letters and digits (${body.length})`);
  eq(L.readClaimBody(body), claim, "it reads back");
  const url = L.claimLinkUrl(claim, "https://www.gloam.trade");
  eq(url, `https://www.gloam.trade/c#sn=${body}`, "the link is /c#sn=<body>");
  ok(/^#[A-Za-z0-9=]+$/.test(new URL(url).hash), "its fragment is letters, digits and = only");
  eq(L.claimFromHash(`#sn=${body}`), claim, "read from the fragment");
  eq(L.claimFromHash(`Here you go: ${url} enjoy`), claim, "read from a pasted message");
  ok(L.isStarknetClaimHash(`#sn=${body}`) && !L.isStarknetClaimHash(`#sol=${body}`) && !L.isStarknetClaimHash("#claim=gloam1=abc"), "only a #sn= fragment is a Starknet claim");
  eq(L.appClaimPathFor(body), `/app/vault?tab=move&mode=receive#sn=${body}`, "the app opens it on Receive, with no ?net= (an EVM network's)");

  // never another chain's
  eq(codeFromHash(`#sn=${body}`), null, "EVM's claim reader takes none of it");
  eq(shortCodeFromHash(`#sn=${body}`), null, "nor EVM's short-link reader");
  ok(!/^#sol=/.test(`#sn=${body}`), "nor Solana's (#sol=)");

  const cut = body.slice(0, -3);
  eq(L.readClaimBody(cut), null, "a cut link is refused");
  const swapped = body.slice(0, 10) + (body[10] === "a" ? "b" : "a") + body.slice(11);
  eq(L.readClaimBody(swapped), null, "a mistyped link is refused (its check)");
  eq(L.readClaimBody("0OIl"), null, "letters base58 doesn't use are refused");
  const raw = L.unbase58(body)!;
  raw[0] = 2;
  eq(L.readClaimBody(L.base58(raw)), null, "another version is refused");
  for (const network of ["mainnet", "sepolia", "devnet"] as const) eq(L.readClaimBody(L.claimBody({ ...claim, network }))?.network, network, `the network rides in it: ${network}`);
  eq(L.readClaimBody(L.claimBody({ ...claim, amount: 0n }))?.amount, 0n, "an amount of zero reads (shown as is)");
  assert.throws(() => L.claimBody({ ...claim, amount: 1n << 64n }));
  assert.throws(() => L.claimBody({ ...claim, secret: new Uint8Array(15) }));
  checks += 2;
  eq(L.unbase58(L.base58(Uint8Array.of(0, 0, 7))), Uint8Array.of(0, 0, 7), "leading zero bytes survive base58");
  eq(L.bytesOf(L.hexOf(secret)), secret, "hex round trip");
  ok(L.newClaimSecret().length === 16 && L.hexOf(L.newClaimSecret()) !== L.hexOf(L.newClaimSecret()), "new secrets are 16 random bytes");
}

// ------------------------------------------------------------------ the one-time account

{
  const a1 = await keysFromSeed(await L.claimSeed(secret), 0);
  const a2 = await keysFromSeed(await L.claimSeed(Uint8Array.from(secret)), 0);
  const other = Uint8Array.from(secret);
  other[0] ^= 1;
  const b = await keysFromSeed(await L.claimSeed(other), 0);
  eq(a1.address, a2.address, "the same secret opens the same account");
  ok(a1.address !== b.address, "another secret, another account");
  ok(a1.viewingKey !== a1.accountKey, "its viewing key is not its account key");
  eq((await L.claimSeed(secret)).length, 32, "the seed is 32 bytes");
}

// ------------------------------------------------------------------ claiming

{
  const run = async (h: { open: boolean; balance: bigint }, fee: bigint, move: (amount: bigint) => Promise<string>, after?: { open: boolean; balance: bigint }) => {
    let reads = 0;
    const moved: bigint[] = [];
    try {
      const r = await C.claimAll({
        read: async () => (reads++ === 0 ? h : (after ?? h)),
        fee: async () => fee,
        move: async (a) => {
          moved.push(a);
          return move(a);
        },
      });
      return { r, moved, err: null as string | null };
    } catch (e) {
      return { r: null, moved, err: (e as Error).message };
    }
  };
  const F = ONE / 4n;
  const notOpen = await run({ open: false, balance: 0n }, F, async () => "0x1");
  eq([notOpen.r, notOpen.moved], [{ state: "empty", open: false }, []], "not open yet: nothing moved");
  eq(C.claimMessage(notOpen.r!), C.LINK_NOT_READY, "said: nothing has arrived yet");
  const used = await run({ open: true, balance: 0n }, F, async () => "0x1");
  eq([used.r, C.claimMessage(used.r!)], [{ state: "empty", open: true }, C.LINK_EMPTY], "empty: claimed or taken back, said");
  const small = await run({ open: true, balance: F }, F, async () => "0x1");
  eq([small.r?.state, small.moved], ["too_small", []], "no more than the fee: nothing moved");
  const good = await run({ open: true, balance: 10n * ONE + F }, F, async () => "0xabc");
  eq([good.r, good.moved], [{ state: "claimed", amount: 10n * ONE, txHash: "0xabc" }, [10n * ONE]], "a claim moves all but the fee: they get what was sent");
  const free = await run({ open: true, balance: 3n * ONE }, 0n, async () => "0xdef");
  eq(free.moved, [3n * ONE], "no fee asked: all of it");
  const lost = await run({ open: true, balance: 2n * ONE }, F, async () => {
    throw new Error("Failed to fetch");
  }, { open: true, balance: 0n });
  eq([lost.err, lost.moved.length], [C.LINK_GONE_AFTER, 1], "a failed move with the link empty after: said, never moved again");
  const failed = await run({ open: true, balance: 2n * ONE }, F, async () => {
    throw new Error("Starknet is busy. Try again later.");
  });
  eq(failed.err, "Starknet is busy. Try again later.", "a failure with the money still there says why");
  eq([C.linkStanding({ open: true, balance: 1n }, true), C.linkStanding({ open: true, balance: 0n }, true), C.linkStanding({ open: true, balance: 0n }, false)], ["waiting", "used", "not_paid"], "a sent link's standing");
}

// ------------------------------------------------------------------ payroll rows paid by link

const addr = (i: number) => `0x${(0x5000n + BigInt(i) * 0x1000003n).toString(16)}${"ab".repeat(20)}`;
{
  const list = `name,address,amount\nAda,${addr(1)},10\nBo,,5\nCy,,7`;
  const off = P.parseStarknetPayrollCsv(list, USDC);
  eq(off.rows.map((r) => r.error), [null, "Add their private account on Starknet.", "Add their private account on Starknet."], "no links: a row with no account is refused");
  const on = P.parseStarknetPayrollCsv(list, USDC, { links: true });
  eq(on.rows.map((r) => [r.error, Boolean(r.link)]), [[null, false], [null, true], [null, true]], "links on: a row with no account is paid by link");
  eq(P.addressesToCheck(on.rows, new Map()), [P.starknetAddressText(addr(1))], "a link row isn't looked up");
  const checked = P.checkRecipients(on.rows, new Map([[P.starknetAddressText(addr(1))!, "ready" as const]]), OWNER);
  ok(checked[1]!.link && !checked[1]!.error, "a link row passes the account check");
  const s = P.summarize(checked, 100n * ONE, ONE / 4n);
  eq([s.ready, s.proofs, s.links, s.fees], [3, 3, 2, (5n * ONE) / 4n], "one payment proof and two link opens; Gloam's fee once for the proof and twice per link");
  eq(P.estimateProofs([{ address: "", link: true }, ...Array.from({ length: 8 }, () => ({ address: "", link: true }))]), 2, "links cost a first payment's room: 8 to a proof");
}

type Kept = { id: string; address: string; open: boolean; paid: boolean };
function linkHarness(opts: { saveFailsAt?: number; openFails?: boolean } = {}) {
  const kept: Kept[] = [];
  const saved: PayrollRun[] = [];
  const ledger = new Map<string, bigint>();
  const fees: bigint[] = [];
  let saves = 0;
  let n = 0;
  const deps: import("../src/lib/starknetPrivacy/payroll").PayrollDeps = {
    async save(run) {
      saves++;
      if (opts.saveFailsAt !== undefined && saves === opts.saveFailsAt) throw new Error("QuotaExceededError");
      saved.push(JSON.parse(JSON.stringify(run)) as PayrollRun);
    },
    async newLink() {
      const k = { id: `l${kept.length}`, address: `0x1${kept.length}`, open: false, paid: false };
      kept.push(k);
      return { id: k.id, address: k.address };
    },
    async openLink(id) {
      const k = kept.find((x) => x.id === id)!;
      // Kept and saved in the run before its account opens.
      assert.ok(saved.at(-1)!.rows.some((r) => r.link?.id === id), "the link is saved in the run before its account opens");
      checks++;
      if (opts.openFails) throw new Error("Starknet is busy. Try again later.");
      k.open = true;
    },
    async onPaid(rows) {
      for (const r of rows) if (r.link?.id) kept.find((x) => x.id === r.link!.id)!.paid = true;
    },
    async prove(payments) {
      for (const p of payments) if (p.link) ok(kept.find((k) => k.address === p.address)?.open, "a link is open before the proof that pays it");
      const links = BigInt(payments.filter((p) => p.link).length);
      return { count: payments.length, spends: [`0xa${n}`], change: [`0xc${n}`], provedAt: 1, fee: (ONE / 4n) * (1n + 2n * links), payload: payments };
    },
    async send(p) {
      for (const x of p.payload as { address: string; amount: bigint }[]) ledger.set(x.address, (ledger.get(x.address) ?? 0n) + x.amount);
      fees.push(p.fee);
      return `0x7${n++}`;
    },
    async confirm() {},
    async resolve() {
      return { state: "pending" };
    },
    message: (e) => (e instanceof Error ? e.message : String(e)),
    sleep: async () => {},
    now: () => 1,
    stopRequested: () => false,
  };
  return { deps, kept, saved, ledger, fees };
}

{
  const rows = P.checkRecipients(P.parseStarknetPayrollCsv(`name,address,amount\nAda,${addr(1)},10\nBo,,5\nCy,,7`, USDC, { links: true }).rows, new Map([[P.starknetAddressText(addr(1))!, "ready" as const]]), OWNER);
  const mk = () => P.newRun({ id: "r1", network: "devnet", owner: OWNER, token: "0x1", rows, now: 1 });
  ok(mk().rows[1]!.link && mk().rows[1]!.address === "", "a link row starts with no account");

  const h = linkHarness();
  const out = await P.runPayroll(mk(), h.deps);
  eq(out.state, "done", "a run with links finishes");
  eq(h.kept.map((k) => [k.open, k.paid]), [[true, true], [true, true]], "two links kept, opened and marked paid");
  eq([h.ledger.get("0x10"), h.ledger.get("0x11")], [5n * ONE, 7n * ONE], "each link's account is paid (the claim fee is added by the session)");
  eq([out.proofs, BigInt(out.feesPaid)], [1, (5n * ONE) / 4n], "one proof for all three, Gloam's fee for it and twice per link");
  ok(out.rows.slice(1).every((r) => r.link?.id && r.link.open && r.address.startsWith("0x1")), "link rows keep their link and its account");
  const csv = P.resultsCsv(out, USDC, (id) => `https://www.gloam.trade/c#sn=${id}`).split("\n");
  ok(csv[0]!.includes("claim link") && csv[2]!.includes("https://www.gloam.trade/c#sn=l0") && !csv[1]!.includes("#sn="), "the results file carries each paid link, and only links");

  // The tab closes after a link is kept, before its account opens: resume opens that link, never a second one.
  const h2 = linkHarness({ openFails: true });
  const paused = await P.runPayroll(mk(), h2.deps);
  eq([paused.state, paused.error], ["paused", "Starknet is busy. Try again later."], "a link that can't open pauses the run, with why");
  eq(h2.kept.length, 1, "one link kept");
  ok(paused.rows[1]!.link?.id === "l0" && !paused.rows[1]!.link.open, "the run holds that link, not open");
  // Resumed in a new tab, with the links this browser kept.
  const resumed = linkHarness();
  resumed.kept.push(...h2.kept);
  resumed.saved.push(JSON.parse(JSON.stringify(paused)) as PayrollRun);
  const again = await P.runPayroll(JSON.parse(JSON.stringify(paused)) as PayrollRun, resumed.deps);
  eq(again.state, "done", "resumed to the end");
  eq(resumed.kept.map((k) => k.id), ["l0", "l1"], "the kept link was opened, not made again");

  // A link that can't be saved in the run: nothing opened, nothing sent.
  const h4 = linkHarness({ saveFailsAt: 2 });
  const failed = await P.runPayroll(mk(), h4.deps);
  eq([failed.state, failed.error], ["paused", P.SAVE_FAILED], "can't save the run with its link: paused");
  ok(h4.kept.every((k) => !k.open) && h4.ledger.size === 0, "nothing opened or paid");

  // Links off (no link step): a run with a link row pauses before anything.
  const h5 = linkHarness();
  const noLinks = { ...h5.deps, newLink: undefined, openLink: undefined };
  const off = await P.runPayroll(mk(), noLinks);
  eq([off.state, off.error, h5.ledger.size], ["paused", P.LINKS_OFF, 0], "no link step: paused before anything is sent");

  ok(P.isRun(JSON.parse(JSON.stringify(out))), "a run with links reads back");
  ok(!P.isRun({ ...out, rows: [{ ...out.rows[1]!, link: { id: 5 } }] }), "a bad link id doesn't");
}

// ------------------------------------------------------------------ a schedule with a link row

{
  const SC = await import("../src/lib/starknetPrivacy/payrollSchedule");
  const rows = P.parseStarknetPayrollCsv(`name,address,amount\nAda,${addr(1)},10\nBo,,5`, USDC, { links: true }).rows;
  const s = SC.newSchedule({ id: "s", name: "T", network: "devnet", owner: OWNER, token: "0x1", cadence: { kind: "weekly", weekday: 5 }, startsOn: "2026-11-27", people: SC.peopleFromRows(rows), now: 1 });
  ok(SC.isSchedule(JSON.parse(JSON.stringify(s))), "a schedule with a person paid by link reads back");
  eq(P.parseStarknetPayrollCsv(SC.scheduleListText(s, USDC), USDC, { links: true }).rows.map((r) => Boolean(r.link)), [false, true], "and loads back as a link row (a new link each payday)");
}

// ------------------------------------------------------------------ sent links

{
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const key = SL.sentLinksKey("devnet", OWNER);
  const store = SL.sentLinksStore({ key, cipher: await S.runCipher(77n, OWNER, SL.SENT_LINKS_DOMAIN), storage });
  const link = (i: number, state: "new" | "open" | "paid" | "used"): import("../src/lib/starknetPrivacy/sentLinks").StarknetSentLink => ({
    v: 1,
    id: `l${i}`,
    network: "devnet",
    owner: OWNER,
    secret: L.hexOf(secret),
    address: `0x${(1000 + i).toString(16)}`,
    amount: "5000000",
    claimFee: "250000",
    name: `Person ${i}`,
    createdAt: i,
    state,
  });
  await store.save(link(0, "paid"));
  for (let i = 1; i <= 55; i++) await store.save(link(i, "used"));
  const all = await store.load();
  ok(all.some((l) => l.id === "l0"), "a link still waiting is never dropped");
  eq(all.length, 51, "fifty used links kept besides");
  ok(!mem.get(key)!.includes(L.hexOf(secret)), "the secret is sealed");
  await store.save(link(60, "paid"));
  await store.update("l60", (l) => ({ ...l, state: "used", takenBack: true }));
  const l0 = (await store.load()).find((l) => l.id === "l60")!;
  eq([l0.state, l0.takenBack], ["used", true], "a link marked taken back");
  eq(SL.sentLinkUrl(l0, "https://www.gloam.trade"), L.claimLinkUrl({ network: "devnet", token: 0, amount: 5_000_000n, secret }, "https://www.gloam.trade"), "its URL is the link");
  await store.update("l0", (l) => ({ ...l, state: "used" }));
  ok(!(await store.load()).some((l) => l.id === "l0"), "once used, the oldest makes room");
  ok(!SL.isSentLink({ ...l0, secret: "nothex" }) && !SL.isSentLink({ ...l0, state: "lost" }), "a bad record doesn't read");
  const runsKey = await S.runCipher(77n, OWNER);
  await assert.rejects(runsKey.open(mem.get(key)!));
  checks++;
}

console.log(`selftest-starknet-claim-links: ${checks} checks passed`);
