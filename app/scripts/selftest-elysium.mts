/**
 * Self-test: Elysium mainnet in the app, behind NEXT_PUBLIC_ELYSIUM_ENABLED.
 *
 * Three runs of this file (the last two as child processes):
 *
 *  - off (as committed, no NEXT_PUBLIC_ELYSIUM_* set): Elysium does not exist.
 *    Not a network key, not in wagmi's chains, not served by the relay or the
 *    remote MCP, not in /verify's list, not in the CSP, and Glim says nothing
 *    about it. The copy still counts four mainnets.
 *  - coming (flag on, no values): still no network anywhere, but Glim and the
 *    docs word it as coming, with no partnership, and /verify lists it as next.
 *  - on (flag on, every value from NEXT_PUBLIC_ELYSIUM_*): Elysium shows up last
 *    among the mainnets with its chain, final keys, USDC alone, HYPE as the gas
 *    coin (not listed), the relay serves it with an hourly cap in HYPE, the CSP
 *    allows its RPC, Glim and the remote MCP name it. A wrong value (the
 *    testnet's id) fails loudly.
 *
 * The placeholder values reach no host (fetch fails the run if anything tries).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-elysium.mts
 */
import { ELYSIUM_MAINNET as SDK_ELYSIUM_MAINNET } from "@gloamtrade/sdk";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODE = process.env.GLOAM_SELFTEST_ELYSIUM ?? "off";
const CHAIN_ID = 99_901;
const POOL = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const USDC = "0x00000000000000000000000000000000000E1a5c";
const RPC = "https://rpc.elysium.example/v1";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_ELYSIUM_")) delete process.env[k];
// Another mainnet's id fails loudly too, now that Elysium's (99901) is known.
if (MODE === "wrongid") process.env.NEXT_PUBLIC_ELYSIUM_ENABLED = "1";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
if (MODE === "coming" || MODE === "on" || MODE === "bad") process.env.NEXT_PUBLIC_ELYSIUM_ENABLED = "1";
if (MODE === "on" || MODE === "bad") {
  Object.assign(process.env, {
    NEXT_PUBLIC_ELYSIUM_CHAIN_ID: String(MODE === "bad" ? 99801 : CHAIN_ID),
    NEXT_PUBLIC_ELYSIUM_RPC_URL: RPC,
    NEXT_PUBLIC_ELYSIUM_EXPLORER_URL: "https://explorer.elysium.example",
    NEXT_PUBLIC_ELYSIUM_USDC: USDC,
    NEXT_PUBLIC_ELYSIUM_POOL: POOL,
    NEXT_PUBLIC_ELYSIUM_DEPLOY_BLOCK: "1234",
  });
}
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-elysium: no network calls allowed (${String(url)})`);
}) as typeof fetch;

if (MODE === "wrongid") {
  process.env.NEXT_PUBLIC_ELYSIUM_CHAIN_ID = "990001";
  Object.assign(process.env, {
    NEXT_PUBLIC_ELYSIUM_RPC_URL: RPC,
    NEXT_PUBLIC_ELYSIUM_EXPLORER_URL: "https://explorer.elysium.example",
    NEXT_PUBLIC_ELYSIUM_USDC: USDC,
    NEXT_PUBLIC_ELYSIUM_POOL: POOL,
    NEXT_PUBLIC_ELYSIUM_DEPLOY_BLOCK: "1234",
  });
  await assert.rejects(import("../src/lib/elysium"), /must be 99901/);
  console.log("selftest-elysium (wrongid): ok (a chain id other than 99901 fails the build)");
  process.exit(0);
}

if (MODE === "bad") {
  await assert.rejects(import("../src/lib/elysium"), /testnet/);
  console.log("selftest-elysium (bad): ok (the testnet's chain id fails the build)");
  process.exit(0);
}

const ely = await import("../src/lib/elysium");
const nets = await import("../src/lib/networks");
const tokens = await import("../src/lib/tokens");
const mainnet = await import("../src/lib/mainnet");
const { contractDirectory } = await import("../src/lib/contractDirectory");
const { CSP_CONNECT_SOURCES } = await import("../csp.config.mjs");
const { hourlySpendWei } = await import("../src/lib/relay/spendCap");
const { relayNetworks, networkForChain } = await import("../src/lib/relay/server");
const { knowledgeBlock, elysiumFacts } = await import("../src/lib/telegramBot/knowledge");
const { agentGasLine } = await import("../src/lib/agentTopUp");
const { walkTuning } = await import("../src/lib/leafIndex");
const { callTool } = await import("../src/lib/mcpRemote/tools");

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};
const ctx = { origin: "https://www.gloam.trade", ip: "127.0.0.1" };
async function toolText(name: string, args: Record<string, unknown> = {}) {
  const r = await callTool(name, args, ctx);
  return { isError: Boolean(r.isError), text: (r.content[0] as { text: string }).text };
}

// Every run: the entry is defined, payments pool, final keys, HYPE as gas.
const e = nets.getNetwork("elysium-mainnet");
ok(e.family === "elysium" && e.label === "Elysium" && !e.testnet, "the entry is defined");
ok(e.paymentsPool && e.ceremony === "production", "mainnet pool on the final keys");
ok(e.primaryAsset.symbol === "HYPE" && e.primaryAsset.address === null && e.chain.nativeCurrency.symbol === "HYPE", "gas in HYPE");
ok(agentGasLine(e)?.includes("HYPE for gas on Elysium"), "the agent gas line names HYPE");
ok(mainnet.liveMainnetCount() >= 4, "the other mainnets still count");

if (MODE === "off" || MODE === "coming") {
  ok(ely.ELYSIUM === null && !ely.ELYSIUM_ENABLED, `${MODE}: Elysium is off`);
  ok(!nets.NETWORK_KEYS.includes("elysium-mainnet") && !nets.isNetworkKey("elysium-mainnet"), `${MODE}: not a network key`);
  ok(e.pool === null && e.deployBlock === null, `${MODE}: no pool`);
  ok(!relayNetworks().some((n) => n.family === "elysium"), `${MODE}: the relay does not serve it`);
  ok(!mainnet.liveMainnetNames().includes("Elysium"), `${MODE}: not in the live names`);
  ok(!CSP_CONNECT_SOURCES.some((s: string) => s.includes("elysium")), `${MODE}: no Elysium host in the CSP`);
  ok(tokens.shieldTokensFor(CHAIN_ID).every((t) => t.address.toLowerCase() !== USDC.toLowerCase()), `${MODE}: no Elysium USDC`);
  ok(nets.ceremonyForChain(0) === "dev", `${MODE}: the stand-in chain id 0 is no Gloam chain`);
  const all = await toolText("gloam_networks");
  ok(!all.text.includes("Elysium") && !all.text.includes("elysium"), `${MODE}: the remote MCP says nothing`);
  const dir = contractDirectory().map((d) => d.key);
  if (MODE === "off") {
    ok(elysiumFacts() === null, "off: Glim has no Elysium facts");
    ok(!/elysium/i.test(knowledgeBlock(false, true)), "off: Glim never names Elysium");
    ok(!dir.includes("elysium-mainnet"), "off: /verify does not list it");
  } else {
    const facts = elysiumFacts() ?? "";
    ok(/coming/.test(facts) && /not live yet/.test(facts), "coming: Glim words it as coming");
    ok(/no partnership/.test(facts), "coming: Glim never claims a partnership");
    ok(!/\d{1,2} November/.test(facts), "coming: Glim gives no date");
    ok(knowledgeBlock(false, true).includes(facts), "coming: the facts are in the block");
    const entry = contractDirectory().find((d) => d.key === "elysium-mainnet");
    ok(entry && !entry.live && entry.rows.length === 0, "coming: /verify lists it as next, with no rows");
  }
} else {
  ok(ely.ELYSIUM_ENABLED && ely.ELYSIUM?.chainId === CHAIN_ID, "on: Elysium is on");
  ok(nets.NETWORK_KEYS.includes("elysium-mainnet"), "on: a network key");
  const mainnets = nets.NETWORK_KEYS.filter((k) => !nets.getNetwork(k).testnet);
  ok(mainnets[mainnets.length - 1] === "elysium-mainnet", "on: listed after the other mainnets");
  ok(e.chainId === CHAIN_ID && e.chain.id === CHAIN_ID, "on: its chain id");
  ok(e.chain.rpcUrls.default.http[0] === RPC, "on: its RPC");
  ok(e.pool === POOL && e.deployBlock === 1234n, "on: its pool and block");
  ok(e.explorerTx("0xab") === "https://explorer.elysium.example/tx/0xab", "on: explorer links");
  ok(e.payMemo === null, "on: no memo board until it is filled in");
  ok(nets.isNetworkWritable(e), "on: writable");
  ok(nets.ceremonyForChain(CHAIN_ID) === "production", "on: proofs use the final keys");
  const usdc = tokens.shieldTokensFor(CHAIN_ID);
  ok(usdc.length === 2 && usdc[0]!.symbol === "USDC" && usdc[0]!.address === USDC && usdc[0]!.decimals === 6 && !usdc[0]!.opensWithLimit, "on: USDC open from launch");
  ok(usdc[1]!.symbol === "KNTQ" && usdc[1]!.decimals === 18 && usdc[1]!.opensWithLimit === true && usdc[1]!.address === "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0", "on: KNTQ listed, open only once its queued limit lands");
  ok(!tokens.supportsNativeShield(CHAIN_ID), "on: HYPE can't be added privately");
  ok(walkTuning(CHAIN_ID, e.logRange).span === 1_000_000n, "on: tree reads at the RPC's range (1,000,000 blocks at 100 ms)");
  ok(networkForChain(CHAIN_ID).key === "elysium-mainnet", "on: the relay serves it");
  ok(hourlySpendWei(CHAIN_ID, {}) === 10n ** 18n, "on: the relay's hourly cap is 1 HYPE by default");
  ok(CSP_CONNECT_SOURCES.includes("https://rpc.elysium.example"), "on: the CSP allows its RPC");
  ok(mainnet.liveMainnetNames().endsWith("and Elysium"), "on: named last in the live mainnets");
  ok(mainnet.liveMainnetCountWords() === "five mainnets", "on: five mainnets");
  const facts = elysiumFacts() ?? "";
  ok(facts.includes(`chain ID ${CHAIN_ID}`) && facts.includes("HYPE") && facts.includes("USDC only"), "on: Glim's live facts");
  ok(/no partnership/.test(facts) && !/coming/.test(facts), "on: no partnership, no longer coming");
  const entry = contractDirectory().find((d) => d.key === "elysium-mainnet");
  ok(entry?.live && entry.rows.some((r) => r.role === "vault"), "on: /verify lists its vault");
  ok(!entry!.rows.some((r) => r.role === "owner"), "on: no owner-wallet row, the guard owns it");
  const one = await toolText("gloam_networks", { network: "elysium-mainnet" });
  ok(!one.isError && one.text.includes("HYPE") && one.text.includes(String(CHAIN_ID)), "on: the remote MCP names it, gas in HYPE");
}

// "coming" (flag on, no values) only exists until the SDK carries Elysium's values.
// Once packages/sdk/src/elysium.ts is filled in, the flag alone turns Elysium on.
const SDK_FILLED = ["rpcUrl", "explorerUrl", "usdc", "pool", "deployBlock"].every(
  (k) => (SDK_ELYSIUM_MAINNET as unknown as Record<string, unknown>)[k] != null,
);
if (MODE === "off") {
  const modes = SDK_FILLED ? ["on", "bad", "wrongid"] : ["coming", "on", "bad", "wrongid"];
  if (SDK_FILLED) console.log("selftest-elysium: the SDK has Elysium's values, so there is no coming state to test");
  for (const mode of modes) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_SELFTEST_ELYSIUM: mode },
      encoding: "utf8",
    });
    if (child.status !== 0) {
      console.error(child.stdout, child.stderr);
      assert.fail(`the ${mode} run failed`);
    }
    process.stdout.write(child.stdout);
    checks++;
  }
}
console.log(`selftest-elysium (${MODE}): ok (${checks} checks)`);
