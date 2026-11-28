/**
 * MCP: Gloam on Solana (src/solana.ts). No network: the Solana client is a fake
 * built on the real SDK module, with every chain call replaced.
 *
 *  - the tools are registered with their schemas, and their text never says
 *    the sender or the recipient is hidden on Solana
 *  - gloam_info and gloam_privacy_status list Solana with the honest line
 *  - GLOAM_AGENT_SOLANA_KEY parses from a keypair file's array or base58, and a
 *    bad one is refused without being echoed; no answer ever carries the key
 *  - spending limits: "solana-mainnet" names Solana's SOL, USDC, USDT and ZEC (a bare ZEC is Solana's, in 8 decimals);
 *    without limits a Solana spend is refused; with them a payment inside the
 *    caps is paid and logged, one over them is refused before anything is
 *    built, and a recipient off the list is refused
 *  - a relay refusal that sent nothing says so; one that may have been sent
 *    says to check the status first
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const real = await import("../../packages/sdk/src/solana.js");
const solana = await import("../src/solana.js");
const policy = await import("../src/policy.js");
const { createGloamServer } = await import("../src/server.js");

type Env = Record<string, string | undefined>;

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 9);
const mainWallet = await real.solanaKeypairWallet(SEED);
const KEYPAIR = [...SEED, ...real.base58Decode(mainWallet.address)];
const PRIVATE = "8kvtHN7Ygt53MQPSvhcKMWBVtkrV57qsxMV68oSdRWkd"; // any registered-looking address for the fake
const PAYEE = "JCgsyrL2pbesjk7zxZTfNYeUSRka6GD5Z69fs9mEbC5s";
const SIG = real.base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
const HASH = real.base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 2));

type Call = { fn: string; args: unknown };
function fakeSdk(calls: Call[], over: Partial<typeof real> = {}): typeof real {
  const account = { network: "mainnet", index: 0, mainAddress: mainWallet.address, address: PRIVATE } as unknown as import("../../packages/sdk/src/solana.js").GloamSolanaAccount;
  const sent = (fn: string) => async (_a: unknown, input: unknown) => {
    calls.push({ fn, args: input });
    return { signature: SIG, state: "landed" as const, blockhash: HASH, slot: 5n, explorer: `https://solscan.io/tx/${SIG}` };
  };
  return {
    ...real,
    openSolanaAccount: (async () => account) as typeof real.openSolanaAccount,
    solanaBalances: (async () => ({ sol: 1_500_000_000n, usdc: 2_000_000n, usdt: 0n })) as typeof real.solanaBalances,
    isSolanaAccountRegistered: (async () => true) as typeof real.isSolanaAccountRegistered,
    registerSolanaAccount: (async () => ({ signature: null, alreadyRegistered: true })) as typeof real.registerSolanaAccount,
    solanaRelayStatus: (async () => ({ on: true, funded: true, relayer: PRIVATE, network: "mainnet" as const })) as typeof real.solanaRelayStatus,
    paySolanaPrivately: sent("pay") as typeof real.paySolanaPrivately,
    cashOutSolana: sent("cashOut") as typeof real.cashOutSolana,
    addToSolanaPrivate: sent("add") as typeof real.addToSolanaPrivate,
    solanaTxStatus: (async (i: { signature: string }) => ({ state: "dropped", signature: i.signature })) as typeof real.solanaTxStatus,
    ...over,
  };
}

async function connect(env: Env, sdk: typeof real) {
  const server = new McpServer({ name: "gloam-solana-test", version: "0" });
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
  solana.registerSolanaTools(server, { env, text, errMsg: (e) => (e instanceof Error ? e.message : String(e)), sdk: async () => sdk });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const raw = (r.content as { text: string }[])[0]!.text;
    for (const secret of [JSON.stringify(KEYPAIR), real.base58Encode(Uint8Array.from(KEYPAIR))]) assert.ok(!raw.includes(secret), "no answer carries the key");
    return JSON.parse(raw);
  };
  return { client, call };
}

const dir = mkdtempSync(join(tmpdir(), "gloam-solana-test-"));
const baseEnv = (over: Env = {}): Env => ({ GLOAM_AGENT_ID: "sol", GLOAM_SPEND_LOG: join(dir, `log-${Math.random().toString(36).slice(2)}.json`), ...over });

test("the Solana tools are registered with their schemas, honest descriptions", async () => {
  const { client } = await connect(baseEnv(), fakeSdk([]));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [...solana.SOLANA_TOOLS]);
  const pay = tools.find((t) => t.name === "gloam_solana_pay")!;
  assert.deepEqual(Object.keys(pay.inputSchema.properties ?? {}).sort(), ["amount", "asset", "timeoutMs", "to"]);
  assert.deepEqual((pay.inputSchema.required ?? []).sort(), ["amount", "asset", "to"]);
  assert.deepEqual((pay.inputSchema.properties as Record<string, { enum?: string[] }>).asset!.enum, ["SOL", "USDC", "USDT", "ZEC"]);
  const cash = tools.find((t) => t.name === "gloam_solana_cash_out")!;
  assert.deepEqual((cash.inputSchema.required ?? []).sort(), ["amount", "asset"], "cash out defaults to the main wallet");
  const add = tools.find((t) => t.name === "gloam_solana_add")!;
  assert.deepEqual((add.inputSchema.required ?? []).sort(), ["amount", "asset"]);
  const status = tools.find((t) => t.name === "gloam_solana_tx_status")!;
  assert.deepEqual((status.inputSchema.required ?? []).sort(), ["signature"]);
  assert.match(pay.description!, /HIDDEN: the asset and the amount/);
  assert.match(pay.description!, /sender and recipient are not hidden/);
  assert.match(add.description!, /PUBLIC on chain: the main wallet, the asset and the amount/);
  assert.match(cash.description!, /PUBLIC on chain: the private account, the destination, the asset and the amount/);
  const all = JSON.stringify(tools) + solana.SOLANA_AGENT_PRIVACY;
  assert.ok(!/hides? (the )?(sender|recipient|who)|(sender|recipient)s? (is|are) hidden|anonymous|untraceable/i.test(all.replace(/not hidden/g, "")), "never claims sender or recipient is hidden");
  assert.ok(!/—|happy to/i.test(all), "no em dashes or banned phrases");
});

test("gloam_info and the privacy status list Solana with the honest line", async () => {
  const server = createGloamServer({ env: baseEnv() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  for (const n of solana.SOLANA_TOOLS) assert.ok(tools.some((t) => t.name === n), `${n} is on the full server`);
  const info = JSON.parse(((await client.callTool({ name: "gloam_info", arguments: {} })).content as { text: string }[])[0]!.text);
  const sol = info.networks.find((n: { key: string }) => n.key === "solana-mainnet");
  assert.ok(sol, "solana-mainnet in the network list");
  assert.match(sol.privacy, /hides the asset and the amount/);
  assert.match(sol.privacy, /two private accounts it moves between are visible/);
  assert.match(sol.privacy, /Helius's prover/);
  assert.ok(info.tools.some((t: string) => t.startsWith("gloam_solana_pay")));
  const status = JSON.parse(((await client.callTool({ name: "gloam_privacy_status", arguments: {} })).content as { text: string }[])[0]!.text);
  assert.match(status.solana, /Sender and recipient are not hidden on Solana/);
});

test("GLOAM_AGENT_SOLANA_KEY: keypair array or base58, a bad one refused without echo", () => {
  assert.equal(solana.agentSolanaKey({}), null);
  const fromArray = solana.agentSolanaKey({ GLOAM_AGENT_SOLANA_KEY: JSON.stringify(KEYPAIR) })!;
  assert.deepEqual([...fromArray], KEYPAIR);
  const fromB58 = solana.agentSolanaKey({ GLOAM_AGENT_SOLANA_KEY: real.base58Encode(Uint8Array.from(KEYPAIR)) })!;
  assert.deepEqual([...fromB58], KEYPAIR);
  for (const bad of ["[1,2,3]", "0xdeadbeef", "not-a-key-0OIl", JSON.stringify(KEYPAIR.slice(0, 32))]) {
    assert.throws(() => solana.agentSolanaKey({ GLOAM_AGENT_SOLANA_KEY: bad }), (e: Error) => /GLOAM_AGENT_SOLANA_KEY/.test(e.message) && !e.message.includes(bad));
  }
  assert.equal(solana.solanaAccountIndex({ GLOAM_SOLANA_ACCOUNT_INDEX: "3" }), 3);
  assert.throws(() => solana.solanaAccountIndex({ GLOAM_SOLANA_ACCOUNT_INDEX: "-1" }));
  assert.throws(() => solana.solanaBaseUrl({ GLOAM_SOLANA_BASE_URL: "http://evil.example" }));
  assert.equal(solana.solanaBaseUrl({ GLOAM_SOLANA_BASE_URL: "https://www.gloam.trade" }), "https://www.gloam.trade");
});

test("amounts in whole units with the asset's decimals", () => {
  const usdc = real.solanaAsset("USDC")!;
  assert.equal(solana.solanaAmount("2.5", usdc), 2_500_000n);
  assert.equal(solana.solanaAmount("0.000001", usdc), 1n);
  assert.equal(solana.solanaAmount("0.0000001", usdc), null);
  assert.equal(solana.solanaAmount("0", usdc), null);
  assert.equal(solana.solanaAmount("-1", usdc), null);
  assert.equal(solana.solanaAmount("1.5", real.solanaAsset("SOL")!), 1_500_000_000n);
});

test("spending limits name Solana's assets on solana-mainnet", () => {
  const p = policy.resolveAgent(
    "bot",
    { recipients: "any", assets: { SOL: { maxPerPayment: "1", maxPerDay: "2" }, USDC: { network: "solana-mainnet", maxPerPayment: "10", maxPerDay: "50" }, Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { maxPerPayment: "5", maxPerDay: "5" } } },
    "test"
  );
  const [sol, usdc, usdt] = p.assets;
  assert.equal(sol!.chainId, real.SOLANA_MAINNET_CHAIN_ID);
  assert.equal(sol!.address, real.SOLANA_RINGS_SOL_MINT);
  assert.equal(sol!.maxPerPayment, 1_000_000_000n, "SOL counts in 9 decimals");
  assert.equal(usdc!.address, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(usdc!.chainId, real.SOLANA_MAINNET_CHAIN_ID);
  assert.equal(usdt!.symbol, "USDT");
  const bare = policy.resolveAgent("bot", { recipients: "any", assets: ["USDC"], maxPerPayment: "1", maxPerDay: "1" }, "test");
  assert.notEqual(bare.assets[0]!.chainId, real.SOLANA_MAINNET_CHAIN_ID, "a bare USDC keeps its old meaning");
  assert.throws(() => policy.resolveAgent("bot", { recipients: "any", assets: { So11111111111111111111111111111111111111112: { maxPerPayment: "1", maxPerDay: "1" } } }, "test"), /not one Gloam lists on Solana/);
  assert.equal(policy.networkName(real.SOLANA_MAINNET_CHAIN_ID), "Solana");
  const zec = policy.resolveAgent("bot", { recipients: "any", assets: { ZEC: { maxPerPayment: "0.5", maxPerDay: "1" } } }, "test").assets[0]!;
  assert.equal(zec.chainId, real.SOLANA_MAINNET_CHAIN_ID, "a bare ZEC names Solana's (it is only there)");
  assert.equal(zec.address, "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS");
  assert.equal(zec.maxPerPayment, 50_000_000n, "ZEC counts in 8 decimals");
  const byMint = policy.resolveAgent("bot", { recipients: "any", assets: { A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS: { maxPerPayment: "1", maxPerDay: "1" } } }, "test").assets[0]!;
  assert.equal(byMint.symbol, "ZEC", "and by its mint");
  const loaded = policy.loadPolicy({ GLOAM_LIMIT_ASSETS: "USDC,USDT", GLOAM_LIMIT_NETWORK: "solana-mainnet", GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "10", GLOAM_LIMIT_RECIPIENTS: "any" }, () => "");
  assert.equal(loaded.mode, "enforced");
  if (loaded.mode === "enforced") assert.ok(loaded.policy.assets.every((a) => a.chainId === real.SOLANA_MAINNET_CHAIN_ID));
});

const keyEnv = (over: Env = {}) => baseEnv({ GLOAM_AGENT_SOLANA_KEY: JSON.stringify(KEYPAIR), ...over });

test("without a key the tools say how to add one; info still answers", async () => {
  const { call } = await connect(baseEnv(), fakeSdk([]));
  const bal = await call("gloam_solana_balance");
  assert.equal(bal.status, "error");
  assert.match(bal.error, /GLOAM_AGENT_SOLANA_KEY/);
  const info = await call("gloam_solana_info");
  assert.equal(info.agent.configured, false);
  assert.equal(info.relay.on, true);
  assert.match(info.privacy, /two private accounts/);
});

test("balance with a key", async () => {
  const { call } = await connect(keyEnv(), fakeSdk([]));
  const bal = await call("gloam_solana_balance");
  assert.equal(bal.privateAddress, PRIVATE);
  assert.equal(bal.mainWallet, mainWallet.address);
  assert.equal(bal.registered, true);
  assert.deepEqual(bal.balances.map((b: { symbol: string; balance: string }) => [b.symbol, b.balance]), [["SOL", "1.5"], ["USDC", "2"], ["USDT", "0"], ["ZEC", "0"]]);
});

test("no limits: every Solana spend is refused before anything is built", async () => {
  const calls: Call[] = [];
  const { call } = await connect(keyEnv(), fakeSdk(calls));
  for (const [tool, args] of [
    ["gloam_solana_pay", { to: PAYEE, asset: "USDC", amount: "1" }],
    ["gloam_solana_cash_out", { asset: "USDC", amount: "1" }],
    ["gloam_solana_add", { asset: "SOL", amount: "0.1" }],
  ] as const) {
    const r = await call(tool, args);
    assert.equal(r.code, "limits_unset", tool);
  }
  assert.equal(calls.length, 0);
});

test("with limits: inside the caps it pays and logs; over them, or to a stranger, it refuses", async () => {
  const calls: Call[] = [];
  const env = keyEnv({ GLOAM_LIMIT_ASSETS: "USDC", GLOAM_LIMIT_NETWORK: "solana-mainnet", GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "6", GLOAM_LIMIT_RECIPIENTS: PAYEE, GLOAM_LIMIT_TOOLS: "pay,shield" });
  const { call } = await connect(env, fakeSdk(calls));
  const paid = await call("gloam_solana_pay", { to: PAYEE, asset: "USDC", amount: "4" });
  assert.equal(paid.status, "landed");
  assert.equal(paid.signature, SIG);
  assert.equal(paid.blockhash, HASH);
  assert.match(paid.privacy, /hides the asset and the amount/);
  assert.deepEqual(calls.map((c) => c.fn), ["pay"]);
  assert.equal((calls[0]!.args as { amount: bigint }).amount, 4_000_000n);
  assert.equal((await call("gloam_solana_pay", { to: PAYEE, asset: "USDC", amount: "6" })).code, "over_per_payment");
  assert.equal((await call("gloam_solana_pay", { to: PAYEE, asset: "USDC", amount: "3" })).code, "over_daily");
  assert.equal((await call("gloam_solana_pay", { to: "11111111111111111111111111111112", asset: "USDC", amount: "1" })).code, "recipient_not_allowed");
  assert.equal((await call("gloam_solana_pay", { to: PAYEE, asset: "SOL", amount: "1" })).code, "asset_not_allowed");
  // Cash out to the agent's own main wallet is not a stranger: allowed by recipients, still capped.
  const out = await call("gloam_solana_cash_out", { asset: "USDC", amount: "1" });
  assert.equal(out.status, "landed");
  assert.equal((calls.at(-1)!.args as { to: string }).to, mainWallet.address);
  assert.equal(calls.length, 2, "nothing refused was built");
  const log = JSON.parse(readFileSync(env.GLOAM_SPEND_LOG!, "utf8")).entries as { tool: string; network: string; status: string; symbol: string }[];
  const settled = log.filter((e) => e.status === "sent");
  assert.equal(settled.length, 2);
  assert.ok(settled.every((e) => e.network === "solana-mainnet" && e.symbol === "USDC"));
});

test("relay refusals: nothing sent says so; maybe sent says check first", async () => {
  const env = keyEnv({ GLOAM_LIMITS: "off" });
  const refusedBefore = fakeSdk([], {
    paySolanaPrivately: (async () => {
      throw new real.SolanaRelayError("Gloam's relay doesn't pay for this.", 422, "not_sponsorable", false);
    }) as typeof real.paySolanaPrivately,
  });
  const r1 = await (await connect(env, refusedBefore)).call("gloam_solana_pay", { to: PAYEE, asset: "USDC", amount: "1" });
  assert.equal(r1.maybeSent, false);
  assert.match(r1.next, /Nothing was sent/);
  const lost = fakeSdk([], {
    paySolanaPrivately: (async () => {
      throw new real.SolanaRelayError("Gloam's relay didn't answer.", 0, "network", true, { blockhash: HASH });
    }) as typeof real.paySolanaPrivately,
  });
  const r2 = await (await connect(env, lost)).call("gloam_solana_pay", { to: PAYEE, asset: "USDC", amount: "1" });
  assert.equal(r2.maybeSent, true);
  assert.equal(r2.blockhash, HASH);
  assert.match(r2.next, /Check gloam_solana_tx_status/);
  const st = await (await connect(env, fakeSdk([]))).call("gloam_solana_tx_status", { signature: SIG, blockhash: HASH });
  assert.equal(st.state, "dropped");
  assert.match(st.next, /safe to send it again/);
});
