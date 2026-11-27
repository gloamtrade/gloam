/**
 * MCP: Gloam on Starknet (src/starknet.ts). No network: the Starknet client is
 * a fake built on the real SDK module, with every call to Gloam's routes replaced.
 *
 *  - the tools are registered with their schemas, and their text says the
 *    first payment shows the payee's account, names the auditor key and the
 *    prover, and never claims more
 *  - gloam_info and gloam_privacy_status list Starknet as not open yet
 *  - the agent's Starknet account comes from GLOAM_AGENT_PRIVATE_KEY: the same
 *    account the SDK (and so the app) opens for that wallet; no answer carries the key
 *  - while Starknet is off every tool says "not_open" and nothing is built,
 *    reserved or logged; busy (the day's proofs used) is said plainly
 *  - spending limits: "starknet-mainnet" names Starknet's USDC (by symbol with
 *    the network, or by its address in any padding); without limits a spend is
 *    refused; with them a payment inside the caps (amount and fee) is paid and
 *    logged, one over them is refused before anything is built, a recipient
 *    off the list is refused, and a cash out to the agent's own account needs
 *    no recipient entry
 *  - a fee that changed, a balance too low and a maybe-sent refusal each say what to do
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";

const real = await import("../../packages/sdk/src/starknet.js");
const starknet = await import("../src/starknet.js");
const policy = await import("../src/policy.js");
const { createGloamServer } = await import("../src/server.js");

type Env = Record<string, string | undefined>;
type Sdk = typeof real;

// A made-up key for this test (0x33 repeated); nothing is sent with it.
const KEY = `0x${"33".repeat(32)}`;
const expected = await real.openStarknetAccount({ wallet: real.starknetViemWallet(privateKeyToAccount(KEY as `0x${string}`)) });
const RELAYER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
const PAYEE = "0x02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
const STRANGER = "0x0555555555555555555555555555555555555555555555555555555555555555";
const TX = "0x07aa";
const FEE = 250_000n; // 0.25 USDC

type Call = { fn: string; args: unknown };
const relayOn = (over: Partial<import("../../packages/sdk/src/starknet.js").StarknetRelayStatus> = {}) => ({
  reachable: true,
  on: true,
  funded: true,
  moves: "on" as const,
  relayer: RELAYER,
  network: "mainnet" as const,
  pool: real.STARKNET_MAINNET_POOL,
  fee: { [real.STARKNET_USDC.replace(/^0x0+/, "0x")]: FEE },
  maxApprove: {},
  ...over,
});

function fakeSdk(calls: Call[], over: Partial<Sdk> = {}): Sdk {
  const sent = (fn: string, firstPayment?: boolean) => async (_a: unknown, input: unknown) => {
    calls.push({ fn, args: input });
    return { txHash: TX, block: 12, fee: FEE, explorer: `https://voyager.online/tx/${TX}`, ...(firstPayment === undefined ? {} : { firstPayment }) };
  };
  return {
    ...real,
    starknetRelayStatus: (async () => relayOn()) as Sdk["starknetRelayStatus"],
    isStarknetAccountOpen: (async () => true) as Sdk["isStarknetAccountOpen"],
    starknetBalances: (async () => ({ usdc: { private: 12_500_000n, public: 3_000_000n } })) as Sdk["starknetBalances"],
    registerStarknetAccount: (async () => ({ alreadyOpen: true, deployTx: null, openTx: null })) as Sdk["registerStarknetAccount"],
    addToStarknetPrivate: sent("add") as Sdk["addToStarknetPrivate"],
    payStarknetPrivately: sent("pay", true) as Sdk["payStarknetPrivately"],
    cashOutStarknet: sent("cashOut") as Sdk["cashOutStarknet"],
    starknetTxStatus: (async (h: string) => ({ state: "accepted", txHash: h, block: 12 })) as Sdk["starknetTxStatus"],
    ...over,
  };
}

async function connect(env: Env, sdk: Sdk) {
  const server = new McpServer({ name: "gloam-starknet-test", version: "0" });
  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
  starknet.registerStarknetTools(server, { env, text, errMsg: (e) => (e instanceof Error ? e.message : String(e)), sdk: async () => sdk });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const raw = (r.content as { text: string }[])[0]!.text;
    assert.ok(!raw.toLowerCase().includes(KEY.slice(2)), "no answer carries the key");
    return JSON.parse(raw);
  };
  return { client, call };
}

const dir = mkdtempSync(join(tmpdir(), "gloam-starknet-test-"));
const baseEnv = (over: Env = {}): Env => ({ GLOAM_AGENT_ID: "sn", GLOAM_SPEND_LOG: join(dir, `log-${Math.random().toString(36).slice(2)}.json`), ...over });
const keyEnv = (over: Env = {}) => baseEnv({ GLOAM_AGENT_PRIVATE_KEY: KEY, ...over });

test("the Starknet tools are registered with their schemas and honest descriptions", async () => {
  const { client } = await connect(baseEnv(), fakeSdk([]));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), [...starknet.STARKNET_TOOLS]);
  const pay = tools.find((t) => t.name === "gloam_starknet_pay")!;
  assert.deepEqual(Object.keys(pay.inputSchema.properties ?? {}).sort(), ["amount", "maxFee", "to"]);
  assert.deepEqual((pay.inputSchema.required ?? []).sort(), ["amount", "to"]);
  const cash = tools.find((t) => t.name === "gloam_starknet_cash_out")!;
  assert.deepEqual((cash.inputSchema.required ?? []).sort(), ["amount"], "cash out defaults to the agent's own account");
  assert.match(pay.description!, /FIRST payment to someone .* SHOWS their private account/);
  assert.match(pay.description!, /Over a channel already open it shows neither side nor the amount/);
  assert.match(tools.find((t) => t.name === "gloam_starknet_add")!.description!, /PUBLIC on chain: the account and the amount/);
  assert.match(cash.description!, /PUBLIC on chain: the destination and the amount/);
  assert.match(tools.find((t) => t.name === "gloam_starknet_info")!.description!, /not open on Gloam yet/);
  assert.match(starknet.STARKNET_AGENT_PRIVACY, /auditor key/);
  assert.match(starknet.STARKNET_AGENT_PRIVACY, /Starkscan's prover/);
  const all = JSON.stringify(tools) + starknet.STARKNET_AGENT_PRIVACY;
  assert.ok(!/anonymous|untraceable|always hidden|fully private/i.test(all), "no overclaims");
  assert.ok(!/—|happy to/i.test(all), "no em dashes or banned phrases");
});

test("gloam_info and the privacy status list Starknet as not open yet", async () => {
  const server = createGloamServer({ env: baseEnv() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  for (const n of starknet.STARKNET_TOOLS) assert.ok(tools.some((t) => t.name === n), `${n} is on the full server`);
  const info = JSON.parse(((await client.callTool({ name: "gloam_info", arguments: {} })).content as { text: string }[])[0]!.text);
  const sn = info.networks.find((n: { key: string }) => n.key === "starknet-mainnet");
  assert.ok(sn, "starknet-mainnet in the network list");
  assert.match(sn.network, /Not open on Gloam yet/);
  assert.match(sn.status, /not open on Gloam yet/);
  assert.match(sn.privacy, /first payment to someone shows their private account/);
  assert.match(info.starknet, /not open on Gloam yet/);
  assert.ok(info.tools.some((t: string) => t.startsWith("gloam_starknet_pay")));
  const status = JSON.parse(((await client.callTool({ name: "gloam_privacy_status", arguments: {} })).content as { text: string }[])[0]!.text);
  assert.match(status.starknet, /not open on Gloam yet/);
  assert.match(status.starknet, /auditor key/);
});

test("the agent key opens the account the SDK (and the app) opens for that wallet", async () => {
  const { call } = await connect(keyEnv(), { ...real, starknetRelayStatus: (async () => relayOn()) as Sdk["starknetRelayStatus"] });
  const info = await call("gloam_starknet_info");
  assert.equal(info.agent.privateAccount, expected.address);
  assert.equal(info.status, "open");
  assert.equal(info.relay.feeUsdc, "0.25");
  assert.equal(starknet.starknetAccountIndex({ GLOAM_STARKNET_ACCOUNT_INDEX: "2" }), 2);
  assert.throws(() => starknet.starknetAccountIndex({ GLOAM_STARKNET_ACCOUNT_INDEX: "-1" }));
  assert.throws(() => starknet.starknetBaseUrl({ GLOAM_STARKNET_BASE_URL: "http://evil.example" }));
  assert.equal(starknet.starknetBaseUrl({ GLOAM_STARKNET_BASE_URL: "http://127.0.0.1:5152" }), "http://127.0.0.1:5152");
});

test("amounts in whole USDC", () => {
  const usdc = real.starknetAsset("USDC")!;
  assert.equal(starknet.starknetAmount("2.5", usdc), 2_500_000n);
  assert.equal(starknet.starknetAmount("0.000001", usdc), 1n);
  assert.equal(starknet.starknetAmount("0.0000001", usdc), null);
  assert.equal(starknet.starknetAmount("0", usdc), null);
});

test("Starknet off: every tool says not_open, and nothing is built or logged", async () => {
  const calls: Call[] = [];
  const env = keyEnv({ GLOAM_LIMITS: "off" });
  const sdk = fakeSdk(calls, {
    starknetRelayStatus: (async () => ({ ...relayOn(), on: false, moves: "off" as const })) as Sdk["starknetRelayStatus"],
    registerStarknetAccount: (async () => {
      throw new real.StarknetOffError("off", "Starknet is not open on Gloam yet. Nothing was sent.");
    }) as Sdk["registerStarknetAccount"],
  });
  const { call } = await connect(env, sdk);
  const info = await call("gloam_starknet_info");
  assert.equal(info.status, "not_open");
  assert.match(info.note, /not open on Gloam yet/);
  for (const [tool, args] of [
    ["gloam_starknet_add", { amount: "1" }],
    ["gloam_starknet_pay", { to: PAYEE, amount: "1" }],
    ["gloam_starknet_cash_out", { amount: "1" }],
    ["gloam_starknet_register", {}],
  ] as const) {
    const r = await call(tool, args);
    assert.equal(r.status, "not_open", tool);
    assert.match(r.error, /not open on Gloam yet/, tool);
  }
  assert.equal(calls.length, 0);
  let logged = "";
  try {
    logged = readFileSync(env.GLOAM_SPEND_LOG!, "utf8");
  } catch {
    /* no log at all */
  }
  assert.ok(!/starknet-mainnet/.test(logged), "nothing reserved or logged");
});

test("busy: the day's proofs used is said plainly", async () => {
  const sdk = fakeSdk([], {
    payStarknetPrivately: (async () => {
      throw real.asStarknetError(Object.assign(new Error("execute failed"), { cause: Object.assign(new Error("Starknet is busy. Try again later."), { name: "ProvingServiceError", code: -32603 }) }));
    }) as Sdk["payStarknetPrivately"],
  });
  const r = await (await connect(keyEnv({ GLOAM_LIMITS: "off" }), sdk)).call("gloam_starknet_pay", { to: PAYEE, amount: "1" });
  assert.equal(r.status, "busy");
  assert.equal(r.code, "quota");
  assert.match(r.next, /proofs on Starknet for today are used/);
});

test("spending limits name Starknet's USDC on starknet-mainnet", () => {
  const p = policy.resolveAgent("bot", { recipients: "any", assets: { USDC: { network: "starknet-mainnet", maxPerPayment: "10", maxPerDay: "50" } } }, "test");
  assert.equal(p.assets[0]!.chainId, real.STARKNET_MAINNET_LIST_ID);
  assert.equal(p.assets[0]!.address, real.STARKNET_USDC);
  assert.equal(p.assets[0]!.maxPerPayment, 10_000_000n, "6 decimals");
  const byAddress = policy.resolveAgent("bot", { recipients: "any", assets: { "0x33068F6539F8E6E6B131E6B2B814E6C34A5224BC66947C47DAB9DFEE93B35FB": { maxPerPayment: "1", maxPerDay: "1" } } }, "test");
  assert.equal(byAddress.assets[0]!.symbol, "USDC", "by address, any case or padding");
  assert.equal(byAddress.assets[0]!.chainId, real.STARKNET_MAINNET_LIST_ID);
  assert.throws(() => policy.resolveAgent("bot", { recipients: "any", assets: { [`0x${"7".repeat(63)}`]: { maxPerPayment: "1", maxPerDay: "1" } } }, "test"), /not one Gloam lists on Starknet/);
  const bare = policy.resolveAgent("bot", { recipients: "any", assets: ["USDC"], maxPerPayment: "1", maxPerDay: "1" }, "test");
  assert.notEqual(bare.assets[0]!.chainId, real.STARKNET_MAINNET_LIST_ID, "a bare USDC keeps its old meaning");
  assert.equal(policy.networkName(real.STARKNET_MAINNET_LIST_ID), "Starknet");
  const short = PAYEE.replace(/^0x0+/, "0x").toUpperCase().replace(/^0X/, "0x");
  const listed = policy.resolveAgent("bot", { recipients: [short], assets: { USDC: { network: "starknet-mainnet", maxPerPayment: "1", maxPerDay: "1" } } }, "test");
  assert.deepEqual(listed.recipients, [PAYEE], "a Starknet recipient is kept in one form");
  const loaded = policy.loadPolicy({ GLOAM_LIMIT_ASSETS: "USDC", GLOAM_LIMIT_NETWORK: "starknet-mainnet", GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "10", GLOAM_LIMIT_RECIPIENTS: "any" }, () => "");
  assert.equal(loaded.mode, "enforced");
});

test("no limits: every Starknet spend is refused before anything is built", async () => {
  const calls: Call[] = [];
  const { call } = await connect(keyEnv(), fakeSdk(calls));
  for (const [tool, args] of [
    ["gloam_starknet_pay", { to: PAYEE, amount: "1" }],
    ["gloam_starknet_cash_out", { amount: "1" }],
    ["gloam_starknet_add", { amount: "1" }],
  ] as const) {
    assert.equal((await call(tool, args)).code, "limits_unset", tool);
  }
  assert.equal(calls.length, 0);
});

test("with limits: inside the caps (amount and fee) it pays and logs; over them, or to a stranger, it refuses", async () => {
  const calls: Call[] = [];
  const env = keyEnv({ GLOAM_LIMIT_ASSETS: "USDC", GLOAM_LIMIT_NETWORK: "starknet-mainnet", GLOAM_LIMIT_MAX_PER_PAYMENT: "5", GLOAM_LIMIT_MAX_PER_DAY: "6", GLOAM_LIMIT_RECIPIENTS: PAYEE, GLOAM_LIMIT_TOOLS: "pay,shield" });
  const { call } = await connect(env, fakeSdk(calls));
  const paid = await call("gloam_starknet_pay", { to: PAYEE, amount: "4" });
  assert.equal(paid.status, "accepted");
  assert.equal(paid.txHash, TX);
  assert.equal(paid.feeUsdc, "0.25");
  assert.match(paid.firstPayment, /showed their private account/);
  assert.equal((calls[0]!.args as { amount: bigint }).amount, 4_000_000n);
  assert.equal((await call("gloam_starknet_pay", { to: PAYEE, amount: "4.9" })).code, "over_per_payment", "4.9 and the 0.25 fee is over 5");
  assert.equal((await call("gloam_starknet_pay", { to: PAYEE, amount: "1.6" })).code, "over_daily");
  assert.equal((await call("gloam_starknet_pay", { to: STRANGER, amount: "0.5" })).code, "recipient_not_allowed");
  assert.equal((await call("gloam_starknet_cash_out", { to: STRANGER, amount: "0.5" })).code, "recipient_not_allowed");
  const own = await call("gloam_starknet_cash_out", { amount: "0.5" });
  assert.equal(own.status, "accepted", "a cash out to the agent's own account needs no recipient entry");
  assert.equal((calls.at(-1)!.args as { to: string }).to, expected.address);
  assert.equal(calls.length, 2, "nothing refused was built");
  const log = JSON.parse(readFileSync(env.GLOAM_SPEND_LOG!, "utf8")).entries as { network: string; status: string; symbol: string; amountWei: string }[];
  const sent = log.filter((e) => e.status === "sent");
  assert.deepEqual(sent.map((e) => [e.network, e.symbol, e.amountWei]), [["starknet-mainnet", "USDC", "4250000"], ["starknet-mainnet", "USDC", "750000"]], "the fee counts with the amount");
});

test("maxFee: a fee above it stops the move; a changed fee and a low balance say what to do", async () => {
  const env = keyEnv({ GLOAM_LIMITS: "off" });
  const capped: Call[] = [];
  const r0 = await (await connect(env, fakeSdk(capped))).call("gloam_starknet_pay", { to: PAYEE, amount: "1", maxFee: "0.3" });
  assert.equal(r0.status, "accepted");
  assert.equal((capped[0]!.args as { maxFee: bigint }).maxFee, 300_000n, "maxFee goes to the SDK in base units");
  const changed = fakeSdk([], {
    cashOutStarknet: (async () => {
      throw new real.StarknetFeeChangedError("Gloam's fee on Starknet just changed.", 300_000n, FEE);
    }) as Sdk["cashOutStarknet"],
  });
  const r1 = await (await connect(env, changed)).call("gloam_starknet_cash_out", { amount: "1" });
  assert.equal(r1.code, "fee_changed");
  assert.equal(r1.feeNow, "0.3");
  assert.match(r1.next, /Call again/);
  const low = fakeSdk([], {
    payStarknetPrivately: (async () => {
      throw new real.StarknetInsufficientError("too low", 1_000_000n, 2_250_000n);
    }) as Sdk["payStarknetPrivately"],
  });
  const r2 = await (await connect(env, low)).call("gloam_starknet_pay", { to: PAYEE, amount: "2" });
  assert.deepEqual([r2.code, r2.have, r2.need], ["insufficient", "1", "2.25"]);
  const lost = fakeSdk([], {
    addToStarknetPrivate: (async () => {
      throw new real.StarknetError("unconfirmed", "Starknet hasn't confirmed it yet.", true, TX);
    }) as Sdk["addToStarknetPrivate"],
  });
  const r3 = await (await connect(env, lost)).call("gloam_starknet_add", { amount: "1" });
  assert.equal(r3.maybeSent, true);
  assert.equal(r3.txHash, TX);
  assert.match(r3.next, /Check gloam_starknet_balance/);
  const st = await (await connect(env, fakeSdk([]))).call("gloam_starknet_tx_status", { txHash: TX });
  assert.equal(st.state, "accepted");
});
