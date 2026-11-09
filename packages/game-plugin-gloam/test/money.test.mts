/**
 * Money and secret safety without a chain: a fake chain and wallet, the real
 * shield prover where a deposit needs one.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { BASE_SEPOLIA_USDC, encodeNotePackage, generateReceiveKey, makeBoundNotePoseidon } from "@gloamtrade/sdk";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type Log, type PublicClient } from "viem";
import { feeKept } from "../src/agent.ts";
import GloamPlugin, { GloamAgent, claimLinkFor, redact, registerSecret, registerUrlSecret, shutdownProver, walletCallSender, type CallSender } from "../src/index.ts";

const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "public", "circuits");
const POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as Address;
const LIMITS = { recipients: "any" as const, assets: { USDC: { maxPerPayment: "25", maxPerDay: "100" } } };
const BAD_TAG = "gloamr1." + Buffer.from("3059301306072a8648ce3d020106082a8648ce3d03010703420004" + "01".repeat(64), "hex").toString("base64url");
const WITHDRAW_FEE_ABI = parseAbi(["event WithdrawFee(bytes32 indexed nullifier, address indexed asset, uint256 fee)"]);
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A chain that answers the reads a deposit and a refresh make. */
function fakeChain(opts: { chainId?: number; receipt?: (hash: Hex) => Promise<{ status: "success" | "reverted" }> } = {}) {
  const seen = new Set<string>();
  const spent = new Set<string>();
  const client = {
    chain: { id: opts.chainId ?? 84532 },
    getChainId: async () => opts.chainId ?? 84532,
    getBlockNumber: async () => 1_000n,
    getBalance: async () => 10n ** 18n,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === "balanceOf") return 1_000_000_000n;
      if (functionName === "allowance") return 10n ** 30n;
      if (functionName === "commitmentSeen") return seen.has(String(args![0]).toLowerCase());
      if (functionName === "isSpent") return spent.has(String(args![0]).toLowerCase());
      throw new Error(`fake chain: no ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => (opts.receipt ? opts.receipt(hash) : { status: "success" as const }),
    getTransactionReceipt: async () => {
      throw new Error("fake chain: receipt not found");
    },
    getLogs: async () => {
      throw new Error("fake chain: no logs");
    },
  };
  return { client: client as unknown as PublicClient, seen, spent };
}

function agentOn(client: PublicClient, sender?: CallSender, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gloam-money-unit-"));
  return new GloamAgent({
    network: "base",
    rpc: "http://127.0.0.1:1",
    submit: "wallet",
    agentId: "unit",
    dataDir: dir,
    env: { GLOAM_AGENT_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`, GLOAM_NOTE_STORE: join(dir, "notes.json") },
    artifacts: { dir: CIRCUITS, url: "http://127.0.0.1:1/never" },
    limits: LIMITS,
    publicClient: client,
    ...(sender ? { sender } : {}),
    ...extra,
  });
}

after(() => shutdownProver());

const view = (a: GloamAgent) => a.notes().map((n) => `${n.origin}:${n.amount}:${n.status}`);

test("walletCallSender hands back the hash once the last call is broadcast, not after its receipt", async () => {
  let n = 0;
  const waited: Hex[] = [];
  const wallet = { account: { address: "0x00000000000000000000000000000000000000a1" }, chain: { id: 84532 }, sendTransaction: async () => hashOf(++n) };
  const client = {
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      waited.push(hash);
      if (hash === hashOf(2)) throw new Error("HTTP request failed. Status: 429");
      return { status: "success" };
    },
  };
  const sender = walletCallSender(wallet as never, client as never);
  const hash = await sender.sendCalls([{ to: POOL, data: "0x01" }, { to: POOL, data: "0x02" }]);
  assert.equal(hash, hashOf(2), "the deposit's hash comes back although its receipt wait would fail");
  assert.deepEqual(waited, [hashOf(1)], "only the earlier call (an approve) is waited for");
});

test("walletCallSender says nothing was sent when an earlier call reverts", async () => {
  let n = 0;
  const wallet = { account: { address: "0x00000000000000000000000000000000000000a1" }, chain: { id: 84532 }, sendTransaction: async () => hashOf(++n) };
  const client = { waitForTransactionReceipt: async () => ({ status: "reverted" }) };
  const sender = walletCallSender(wallet as never, client as never);
  await assert.rejects(sender.sendCalls([{ to: POOL, data: "0x01" }, { to: POOL, data: "0x02" }]), (e: Error & { notSent?: boolean }) => e.notSent === true);
  assert.equal(n, 1, "the deposit itself was never sent");
});

test("a deposit whose wallet throws after sending keeps its note, and refresh makes it spendable", { timeout: 120_000 }, async () => {
  const chain = fakeChain();
  const sent: unknown[] = [];
  const sender: CallSender = {
    address: "0x00000000000000000000000000000000000000a1",
    async sendCalls(calls) {
      sent.push(calls);
      throw new Error("The ACP wallet did not answer in time.");
    },
  };
  const agent = agentOn(chain.client, sender);
  const out = await agent.add({ amount: "10" });
  assert.equal(sent.length, 1);
  assert.notEqual(out.status, "done");
  assert.match(String(out.check), /refresh/i, JSON.stringify(out));
  assert.deepEqual(view(agent), ["shield:10:pending"], "the note is kept: the deposit may have landed");
  // The deposit landed.
  const n = agent.store.list()[0]!;
  chain.seen.add(n.commitment.toLowerCase());
  await agent.refresh();
  assert.deepEqual(view(agent), ["shield:10:unspent"]);
});

test("a deposit the wallet never sent forgets its note", { timeout: 120_000 }, async () => {
  const chain = fakeChain();
  const sender: CallSender = {
    address: "0x00000000000000000000000000000000000000a1",
    async sendCalls() {
      throw Object.assign(new Error("The approve reverted."), { notSent: true });
    },
  };
  const agent = agentOn(chain.client, sender);
  const out = await agent.add({ amount: "10" });
  assert.equal(out.status, "error");
  assert.deepEqual(view(agent), []);
});

test("a Gloam address whose key is not a P-256 point is refused before the limits or any note", async () => {
  const agent = agentOn(fakeChain().client);
  await assert.rejects(agent.pay({ to: BAD_TAG, amount: "4" }), /Gloam address/);
  await assert.rejects(agent.payByClaimLink({ amount: "4", sealTo: BAD_TAG }), /Gloam address/);
  assert.equal((agent.limitsReport() as { assets: { usedLast24h: string }[] }).assets[0]!.usedLast24h, "0");
});

test("a cash out reports the fee the pool kept, whatever the rate that day", () => {
  const pool = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194" as Address;
  const nullifier = hashOf(7);
  const log = (fee: bigint, at: Address = pool, spent: Hex = nullifier) =>
    ({
      address: at,
      data: encodeAbiParameters([{ type: "uint256" }], [fee]),
      topics: encodeEventTopics({ abi: WITHDRAW_FEE_ABI, eventName: "WithdrawFee", args: { nullifier: spent, asset: BASE_SEPOLIA_USDC as Address } }),
      blockNumber: 1n,
      blockHash: hashOf(1),
      logIndex: 0,
      transactionHash: hashOf(2),
      transactionIndex: 0,
      removed: false,
    }) as unknown as Log;
  assert.equal(feeKept([log(25_000n)], pool, nullifier), 25_000n, "5 USDC at 0.5%");
  assert.equal(feeKept([log(12_500n)], pool, nullifier), 12_500n, "5 USDC at 0.25%, as Base Sepolia charges");
  assert.equal(feeKept([], pool, nullifier), 0n, "no event: a pool with no fee kept nothing");
  assert.equal(feeKept([log(9n, BASE_SEPOLIA_USDC as Address)], pool, nullifier), 0n, "another contract's log is not the pool's");
  assert.equal(feeKept([log(9n, pool, hashOf(8))], pool, nullifier), 0n, "another cash out in the same transaction is not this one");
});

test("a decimal comma is refused, never read as a bigger number", async () => {
  const agent = agentOn(fakeChain().client);
  const tag = (await generateReceiveKey()).tag;
  for (const amount of ["2,5", "1,000", "1,000.50"]) {
    await assert.rejects(agent.pay({ to: tag, amount }), /comma/, amount);
    await assert.rejects(agent.requestPayment({ amount }), /comma/, amount);
  }
  // Plain numbers still work (the request link names 2.5).
  const req = await agent.requestPayment({ amount: "2.5" });
  assert.match(String(req.link), /amount=2\.5/);
});

test("an RPC URL with an API key never reaches the planner or the logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloam-money-rpc-"));
  const plugin = new GloamPlugin({
    network: "base",
    rpc: "http://127.0.0.1:9/v2/ALCHEMY_SECRET_KEY_abc123",
    env: { GLOAM_AGENT_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`, GLOAM_NOTE_STORE: join(dir, "n.json") },
    dataDir: dir,
    limits: LIMITS,
  });
  const logs: string[] = [];
  const res = await plugin.addPrivatelyFunction.execute({ amount: { value: "1" } } as never, (m) => logs.push(m));
  const all = [res.feedback, ...logs].join("\n");
  assert.ok(!/ALCHEMY_SECRET_KEY/.test(all), all);
  assert.ok(!/Request body|Version: viem|Details:/.test(res.feedback), "only the short message reaches the planner");
  assert.ok(res.feedback.length < 400, res.feedback);
});

test("the redactor catches claim links and secrets however they are wrapped", async () => {
  const secret = ("0x00" + "1a".repeat(30) + "0b") as Hex; // a leading zero byte
  registerSecret(secret);
  const code = encodeNotePackage({ pool: POOL, chainId: 84532, asset: BASE_SEPOLIA_USDC, amountWei: "1000000", secret, commitment: ("0x" + "22".repeat(32)) as Hex });
  const link = claimLinkFor(code, "base");
  const body = code.slice("gloam1.".length);
  const cases: Record<string, string> = {
    raw_link: link,
    url_encoded_link: encodeURIComponent(link),
    url_encoded_twice: encodeURIComponent(encodeURIComponent(link)),
    code,
    code_base64: Buffer.from(code).toString("base64"),
    code_base64url: Buffer.from(code).toString("base64url"),
    link_base64: Buffer.from(`pay: ${link}`).toString("base64"),
    code_body_only: body,
    json_escaped: JSON.stringify({ text: `send ${link}` }),
    secret_decimal: BigInt(secret).toString(),
    secret_no_leading_zero: "0x" + BigInt(secret).toString(16),
    secret_upper: secret.toUpperCase().replace("0X", "0x"),
  };
  for (const [k, v] of Object.entries(cases)) {
    const out = redact(`x ${v} y`);
    assert.ok(!out.includes(v), `${k} leaks: ${out}`);
    assert.ok(!out.includes(body.slice(0, 24)), `${k} leaks the code: ${out}`);
  }
  // Public things pass untouched: hashes, Gloam addresses, sealed codes, proofs, amounts.
  const tag = (await generateReceiveKey()).tag;
  const proof = "gloampay1:" + Buffer.from(JSON.stringify({ v: 1, kind: "payment", chainId: 84532, commitment: "0x" + "33".repeat(32), txHash: hashOf(7) })).toString("base64");
  const keep = [hashOf(99), tag, "gloam2t." + "A".repeat(200), proof, "12.5 USDC", "https://sepolia.basescan.org/tx/" + hashOf(5)];
  for (const k of keep) assert.equal(redact(k), k, `kept: ${k.slice(0, 40)}`);
});

test("the sweep reader names its chain, so a claim through an RPC on another chain is refused before anything is sent", { timeout: 60_000 }, async () => {
  const chain = fakeChain({ chainId: 4663 });
  const sent: unknown[] = [];
  const sender: CallSender = { address: "0x00000000000000000000000000000000000000a1", sendCalls: async (c) => (sent.push(c), hashOf(1)) };
  const agent = agentOn(chain.client, sender);
  const note = await makeBoundNotePoseidon(1_000_000n, BASE_SEPOLIA_USDC);
  const code = encodeNotePackage({ pool: POOL, chainId: 84532, asset: BASE_SEPOLIA_USDC, amountWei: "1000000", secret: note.secret, commitment: note.commitment });
  const out = await agent.claim(claimLinkFor(code, "base"));
  assert.equal(out.status, "error");
  assert.match(String(out.message), /chain 4663/);
  assert.equal(sent.length, 0);
});

test("a cash out to an address that cannot pay it on is refused before anything is split or sent", { timeout: 120_000 }, async () => {
  const chain = fakeChain();
  const sent: unknown[] = [];
  const sender: CallSender = {
    address: "0x00000000000000000000000000000000000000a1",
    async sendCalls(calls) {
      sent.push(calls);
      throw new Error("The ACP wallet did not answer in time.");
    },
  };
  const agent = agentOn(chain.client, sender);
  await agent.add({ amount: "10" });
  chain.seen.add(agent.store.list()[0]!.commitment.toLowerCase());
  await agent.refresh();
  assert.deepEqual(view(agent), ["shield:10:unspent"]);
  const deposited = sent.length;
  const refused: [string, RegExp][] = [
    [POOL, /vault itself/],
    ["0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194", /vault itself/],
    ["0x01B3172d9900Cb26d57E986429b9b23854c74598", /message board/],
    [BASE_SEPOLIA_USDC, /token contract/],
    ["0x0000000000000000000000000000000000000000", /zero address/],
  ];
  // 4 of a 10 note would need a split first: that split is what must not run.
  for (const [to, why] of refused) await assert.rejects(agent.cashOut({ amount: "4", to }), why);
  assert.equal(sent.length, deposited, "no split and no cash out went out");
  assert.deepEqual(view(agent), ["shield:10:unspent"], "the note was not touched");
});

test("on Robinhood Chain a cash out to a swap router or a token a swap lands in is refused, and neither means anything on Base", async () => {
  const onRh = agentOn(fakeChain({ chainId: 4663 }).client, undefined, {
    network: "robinhood-mainnet",
    limits: { recipients: "any" as const, assets: { USDG: { maxPerPayment: "25", maxPerDay: "100" } } },
  });
  for (const r of ["0xfCa1887e77f738ef9C5751974b3f3873d029F2DC", "0x34AB06208586A737Bf1607fa996Bc9162271c52d"]) {
    await assert.rejects(onRh.cashOut({ amount: "4", to: r }), /swap router/);
  }
  await assert.rejects(onRh.cashOut({ amount: "4", to: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }), /token contract/);
  // Base Sepolia has no router and no WETH on the list: past the guard, this agent simply has no note.
  const onBase = agentOn(fakeChain().client);
  const out = await onBase.cashOut({ amount: "4", to: "0x34AB06208586A737Bf1607fa996Bc9162271c52d" });
  assert.equal(out.status, "error");
  assert.doesNotMatch(String(out.message), /swap router|token contract/);
});

test("balances stay out of what the planner reads unless the owner shares them", async () => {
  const chain = fakeChain();
  const dir = mkdtempSync(join(tmpdir(), "gloam-money-env-"));
  const opts = {
    network: "base",
    rpc: "http://127.0.0.1:1",
    publicClient: chain.client,
    dataDir: dir,
    env: { GLOAM_AGENT_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`, GLOAM_NOTE_STORE: join(dir, "n.json") },
    limits: LIMITS,
  };
  const quiet = await new GloamPlugin(opts).environment();
  assert.ok(!("gloam_private_balance" in quiet), JSON.stringify(quiet));
  const shared = await new GloamPlugin({ ...opts, env: { ...opts.env, GLOAM_NOTE_STORE: join(dir, "m.json") }, shareBalances: true }).environment();
  assert.ok("gloam_private_balance" in shared);
});

test("a note pending for over an hour with nothing on chain is kept but stops counting as confirming or in flight", { timeout: 120_000 }, async () => {
  const chain = fakeChain();
  const sender: CallSender = {
    address: "0x00000000000000000000000000000000000000a1",
    async sendCalls() {
      throw new Error("The ACP wallet did not answer in time.");
    },
  };
  const agent = agentOn(chain.client, sender);
  assert.equal((await agent.add({ amount: "10" })).status, "unconfirmed");
  const n = agent.store.list()[0]!;
  const confirming = async () => ((await agent.balance()).privateBalance as { confirming: string }[])[0]?.confirming ?? "0";
  assert.equal(await confirming(), "10");
  agent.store.update(n.handle, { createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
  await agent.refresh();
  assert.deepEqual(agent.notes().map((x) => [x.status, "stale" in x]), [["pending", true]], "kept, marked stale");
  assert.equal(await confirming(), "0");
  // If it lands after all, it settles.
  chain.seen.add(n.commitment.toLowerCase());
  await agent.refresh();
  assert.deepEqual(view(agent), ["shield:10:unspent"]);
});

test("GAME hears an unconfirmed send as done with an instruction not to send it again, never as a failure to retry", async () => {
  const unsure = {
    network: { key: "base", testnet: true, assets: [{ symbol: "USDC" }] },
    address: async () => "gloamr1.x",
    limitsReport: () => ({ enforced: true }),
    cashOut: async () => ({ status: "unconfirmed", message: "The cash out was sent, but its answer was lost.", next: "Do not send it again. Call gloam_private_balance with refresh." }),
  } as unknown as GloamAgent;
  const plugin = new GloamPlugin({ agent: unsure });
  const res = await plugin.cashOutFunction.execute({ amount: { value: "5" }, to: { value: "0x00000000000000000000000000000000000000c1" } } as never, () => undefined);
  assert.equal(res.status, "done");
  assert.match(res.feedback, /Do not send it again/);
});

test("the redactor also catches a secret as raw bytes, as a byte array or in spaced hex, a claim code in hex, and a note package's JSON with a secret nobody registered", async () => {
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const fe = () => ("0x" + (BigInt("0x" + randomBytes(32).toString("hex")) % FIELD).toString(16).padStart(64, "0")) as Hex;
  const secret = fe();
  registerSecret(secret);
  const raw = Buffer.from(secret.slice(2), "hex");
  const code = encodeNotePackage({ pool: POOL, chainId: 84532, asset: BASE_SEPOLIA_USDC, amountWei: "1000000", secret, commitment: fe() });
  const unregistered = fe();
  const pack = JSON.stringify({ v: 1, t: "gloam-private-note", s: "poseidon", p: POOL, a: BASE_SEPOLIA_USDC, w: "1000000", k: unregistered, c: fe() });
  const cases: Record<string, [string, string]> = {
    "raw bytes, base64": [raw.toString("base64"), raw.toString("base64")],
    "raw bytes, base64url": [raw.toString("base64url"), raw.toString("base64url")],
    "byte array": [JSON.stringify([...raw]), JSON.stringify([...raw])],
    "byte array with spaces": [`[${[...raw].join(", ")}]`, [...raw].join(", ")],
    "hex split by spaces": [secret.slice(2).replace(/(.{8})/g, "$1 ").trim(), secret.slice(2, 10)],
    "claim code in hex": [Buffer.from(code).toString("hex"), Buffer.from(code).toString("hex")],
    "note package JSON, unregistered secret": [pack, unregistered.slice(2)],
    "the same, escaped inside JSON": [JSON.stringify({ text: pack }), unregistered.slice(2)],
  };
  for (const [what, [v, mustGo]] of Object.entries(cases)) {
    const out = redact(`x ${v} y`);
    assert.ok(!out.includes(mustGo), `${what} leaks: ${out.slice(0, 160)}`);
  }
  // A public RPC named in a message still reads; a key in an RPC URL does not.
  registerUrlSecret("https://sepolia.base.org");
  assert.equal(redact("fetch failed: https://sepolia.base.org is rate limited"), "fetch failed: https://sepolia.base.org is rate limited");
  registerUrlSecret("https://base-sepolia.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrSt12");
  assert.equal(redact("URL: https://base-sepolia.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrSt12"), "URL: https://base-sepolia.g.alchemy.com/v2/[redacted]");
  // Public things still pass, and many known secrets keep it quick.
  for (let i = 0; i < 3000; i++) registerSecret(fe());
  const proof = "gloamfunds1:" + Buffer.from(JSON.stringify({ v: 1, kind: "funds", nullifiers: [fe(), fe()], publicSignals: Array.from({ length: 12 }, () => BigInt(fe()).toString()) })).toString("base64");
  const big = JSON.stringify({ status: "done", proof, deliverable: "gloam2t." + randomBytes(12000).toString("base64url"), tx: `0x${randomBytes(32).toString("hex")}` });
  const t = performance.now();
  assert.equal(redact(big), big);
  assert.ok(performance.now() - t < 2000, `redact took ${performance.now() - t} ms`);
});
