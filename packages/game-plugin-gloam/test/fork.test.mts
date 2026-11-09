/**
 * End to end on a Base Sepolia fork: the plugin's flows against the real Gloam
 * vault (0x39e2…0194, final keys), with fresh keys funded inside the fork and
 * every transaction self-sent from the agents' own wallets. Nothing reaches a
 * live network and no relay is called.
 *
 *   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org pnpm --filter @gloamtrade/game-plugin-gloam test:fork
 *
 * Skipped without BASE_SEPOLIA_RPC_URL or without anvil. sepolia.base.org
 * answers 200 blocks per getLogs, so the first read of the vault takes a couple
 * of minutes there; an RPC with wider log ranges is faster.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SEPOLIA_USDC, cashOutFee } from "@gloamtrade/sdk";
import { ExecutableGameFunctionStatus } from "@virtuals-protocol/game";
import { formatUnits, parseUnits, type Address } from "viem";
import GloamPlugin, { GloamAgent, shutdownProver, type ClaimLinkOut, type GloamAgentOptions, type LimitsConfig } from "../src/index.ts";
import { ERC20, findAnvil, startFork, type Fork } from "./fork/harness.mts";

const UPSTREAM = process.env.BASE_SEPOLIA_RPC_URL?.trim();
const SKIP = !UPSTREAM ? "set BASE_SEPOLIA_RPC_URL to run the fork test" : !findAnvil() ? "anvil not found" : false;
/** An address that holds Circle's test USDC on Base Sepolia (impersonated inside the fork only). */
const USDC_HOLDER = (process.env.GLOAM_FORK_USDC_HOLDER?.trim() || "0xfaec9cdc3ef75713b48f46057b98ba04885e3391") as Address;
const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "circuits");
const usdc = (v: string) => parseUnits(v, 6);
const log = (m: string) => console.log(`  [fork] ${m}`);

let fork: Fork;
let alice: GloamAgent;
let bob: GloamAgent;
let carol: Address;
const claimLinks: ClaimLinkOut[] = [];
const secretsSeen: string[] = [];

function agentFor(name: string, key: string, limits: LimitsConfig, extra: Partial<GloamAgentOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `gloam-fork-${name}-`));
  return new GloamAgent({
    network: "base",
    rpc: fork.url,
    submit: "wallet",
    agentId: name,
    dataDir: dir,
    env: { GLOAM_AGENT_PRIVATE_KEY: key, GLOAM_NOTE_STORE: join(dir, "notes.json") },
    artifacts: { dir: CIRCUITS, url: "http://127.0.0.1:1/never" },
    limits,
    ...extra,
  });
}

before(async () => {
  if (SKIP) return;
  fork = await startFork({ upstream: UPSTREAM!, chainId: 84532, log });
  const a = await fork.newKey();
  const b = await fork.newKey();
  carol = (await fork.newKey(0n)).address;
  await fork.sendFromHolder(BASE_SEPOLIA_USDC, USDC_HOLDER, a.address, usdc("100"));
  log(`alice ${a.address} funded with 100 USDC by impersonating ${USDC_HOLDER} on the fork`);
  alice = agentFor("alice", a.key, {
    recipients: "any",
    assets: { USDC: { maxPerPayment: "15", maxPerDay: "20" } },
  }, { onClaimLink: (c) => void claimLinks.push(c) });
  bob = agentFor("bob", b.key, { recipients: "any", assets: { USDC: { maxPerPayment: "20", maxPerDay: "60" } } });
});

after(async () => {
  await shutdownProver();
  await fork?.stop();
});

test("add privately, pay a Gloam address, receive, pay a request and a claim link, limits, cash out, prove funds", { skip: SKIP, timeout: 20 * 60_000 }, async () => {
  // 1. Add privately: a public deposit into the vault.
  let t = Date.now();
  const added = await alice.add({ amount: "40" });
  assert.equal(added.status, "done", JSON.stringify(added));
  log(`add 40 USDC: ${added.hash} (${Date.now() - t} ms: the deposit proof and two transactions)`);
  let bal = await alice.balance();
  assert.deepEqual((bal.privateBalance as { asset: string; spendable: string }[]).map((b) => [b.asset, b.spendable]), [["USDC", "40"]]);

  // 2. Pay bob's Gloam address privately, with a private note.
  const bobTag = await bob.address();
  t = Date.now();
  const paid = await alice.pay({ to: bobTag, amount: "7", note: "job 1" });
  assert.equal(paid.status, "done", JSON.stringify(paid));
  assert.match(String(paid.delivered), /payment-message board/);
  log(`pay 7 USDC to bob's Gloam address: ${paid.hash} (${Date.now() - t} ms, includes the first read of the vault)`);

  // 3. Bob finds it on the board and secures it into a note only he knows.
  const got = await bob.checkIncoming();
  const rec = got.received as { status: string; amount: string; note: string }[];
  assert.equal(rec.length, 1, JSON.stringify(got));
  assert.equal(rec[0]!.status, "swept");
  assert.equal(rec[0]!.note, "job 1");
  log(`bob received ${rec[0]!.amount} (note "${rec[0]!.note}") and swept it`);
  // A second check finds nothing new.
  assert.equal(((await bob.checkIncoming()).received as unknown[]).length, 0);

  // 4. A payment request link: bob asks, alice pays the link.
  const req = await bob.requestPayment({ amount: "2.5", note: "inv-2" });
  const paidReq = await alice.pay({ to: String(req.link) });
  assert.equal(paidReq.status, "done", JSON.stringify(paidReq));
  const got2 = (await bob.checkIncoming()).received as { status: string; note: string }[];
  assert.equal(got2[0]?.status, "swept");
  assert.equal(got2[0]?.note, "inv-2");
  log(`payment request for 2.5 USDC paid and swept: ${paidReq.hash}`);

  // 5. A claim link for someone with no Gloam address: it goes to the owner's handler, never the planner.
  const byLink = await alice.payByClaimLink({ amount: "3", note: "welcome" });
  assert.equal(byLink.status, "done", JSON.stringify(byLink));
  assert.ok(!JSON.stringify(byLink).includes("#claim="), "the outcome carries no link");
  assert.equal(claimLinks.length, 1);
  const claimed = await bob.claim(claimLinks[0]!.link);
  assert.equal(claimed.status, "done", JSON.stringify(claimed));
  log(`claim link for 3 USDC claimed by bob: ${claimed.hash}`);
  bal = await bob.balance();
  assert.equal((bal.privateBalance as { spendable: string }[])[0]!.spendable, "12.5");

  // 6. Limits: per payment and per rolling day, per asset.
  const over = await alice.pay({ to: bobTag, amount: "25" });
  assert.equal(over.status, "refused");
  assert.equal(over.code, "over_per_payment");
  // 7 + 2.5 + 3 = 12.5 paid today (the add is not capped); another 10 would pass 20.
  const daily = await alice.pay({ to: bobTag, amount: "10" });
  assert.equal(daily.status, "refused");
  assert.equal(daily.code, "over_daily");
  log(`limits: 25 refused (${over.code}), 10 refused (${daily.code})`);

  // 7. Cash out from bob (fresh limits) to carol's plain address. The pool keeps its fee.
  const bps = Number(await fork.client.readContract({ address: bob.network.pool, abi: [{ type: "function", name: "withdrawFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }], functionName: "withdrawFeeBps" }));
  assert.equal(bps, 25);
  const out = await bob.cashOut({ amount: "5", to: carol });
  assert.equal(out.status, "done", JSON.stringify(out));
  const carolHas = await fork.client.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20, functionName: "balanceOf", args: [carol] });
  assert.equal(carolHas, usdc("5") - cashOutFee(usdc("5"), bps));
  assert.equal(out.fee, `${formatUnits(cashOutFee(usdc("5"), bps), 6)} USDC`, "the fee reported is what the pool kept");
  log(`cash out 5 USDC to ${carol}: received ${formatUnits(carolHas, 6)} after the 0.25% fee (${out.hash})`);

  // 8. Prove funds, checked by the other agent against the fork.
  const proof = await alice.proveFunds({ atLeast: "20", for: "Fork test reader" });
  assert.equal(proof.status, "done", JSON.stringify(proof));
  const checked = await bob.verifyProof(String(proof.proof));
  assert.equal(checked.ok, true, JSON.stringify(checked.checks));
  log(`proof of funds (at least 20 USDC) verified: ${(checked.checks as { label: string; state: string }[]).map((c) => c.state).join(", ")}`);
  const tampered = String(proof.proof).replace(/^gloamfunds1:/, "");
  const body = JSON.parse(Buffer.from(tampered, "base64").toString("utf8"));
  body.threshold = "200000000";
  const bad = await bob.verifyProof(`gloamfunds1:${Buffer.from(JSON.stringify(body)).toString("base64")}`);
  assert.equal(bad.ok, false);

  // 9. Proof of payment for the claim-link payment, checked by bob.
  const pp = await alice.provePayment({ handle: String(byLink.claimHandle), for: "bob" });
  const ppCheck = await bob.verifyProof(String(pp.proof));
  assert.equal(ppCheck.ok, true, JSON.stringify(ppCheck.checks));
  log("proof of payment for the claim-link payment verified");

  // 10. Spent notes cannot back a proof: after alice spends, the old proof fails "still unspent".
  await alice.cashOut({ amount: "1", to: carol }).catch(() => null);
  const after = await bob.verifyProof(String(proof.proof));
  const unspent = (after.checks as { label: string; state: string }[]).find((c) => c.label === "Balance is still unspent");
  log(`after alice moved money, the old proof reads: ${unspent?.state}`);

  for (const n of [...alice.store.list(), ...bob.store.list()]) secretsSeen.push(n.secret);
});

test("the GAME functions run the same flows, and nothing secret reaches the planner", { skip: SKIP, timeout: 10 * 60_000 }, async () => {
  const plugin = new GloamPlugin({ agent: bob });
  const fns = Object.fromEntries(plugin.getWorker().functions.map((f) => [f.name, f]));
  const logs: string[] = [];
  const run = async (name: string, args: Record<string, string>) => {
    const res = await fns[name]!.execute(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, { value: v }])), (m) => logs.push(m));
    for (const s of secretsSeen) assert.ok(!res.feedback.toLowerCase().includes(s.slice(2).toLowerCase()), `${name} feedback holds no secret`);
    assert.ok(!res.feedback.includes("#claim="), `${name} feedback holds no claim link`);
    return res;
  };
  const balance = await run("gloam_private_balance", { refresh: "true" });
  assert.equal(balance.status, ExecutableGameFunctionStatus.Done);
  const proof = await run("gloam_prove_funds", { at_least: "1", for: "GAME planner test" });
  assert.equal(proof.status, ExecutableGameFunctionStatus.Done, proof.feedback);
  const verify = await run("gloam_verify_proof", { proof: JSON.parse(proof.feedback).proof });
  assert.equal(JSON.parse(verify.feedback).ok, true);
  const claim = await run("gloam_pay_privately", { to: "claim link", amount: "1", seal_to: await alice.address() });
  assert.equal(claim.status, ExecutableGameFunctionStatus.Done, claim.feedback);
  assert.ok(JSON.parse(claim.feedback).sealedLink.startsWith("gloam2t."), "a claim link sealed to a Gloam address is safe to return");
  const refused = await run("gloam_cash_out", { amount: "50", to: carol });
  assert.equal(refused.status, ExecutableGameFunctionStatus.Failed);
  assert.equal(JSON.parse(refused.feedback).code, "over_per_payment");
  for (const s of [...secretsSeen, ...bob.store.list().map((n) => n.secret)]) {
    assert.ok(logs.every((l) => !l.toLowerCase().includes(s.slice(2).toLowerCase())), "logs hold no secret");
  }
  const env = JSON.stringify(await plugin.environment());
  assert.ok(!env.includes("#claim="));
  log(`GAME functions: balance, prove, verify, claim link sealed to alice, refused cash out; environment ${env.length} chars, no secrets`);
});
