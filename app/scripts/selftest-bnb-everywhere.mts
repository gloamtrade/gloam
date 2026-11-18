/**
 * Self-test: BNB Chain everywhere Gloam lists its chains, and nowhere while it is off.
 *
 * Three runs of this file (the last two as child processes):
 *
 *  - unset (no NEXT_PUBLIC_BNB_* at all, as a preview build or a missing
 *    variable leaves it) and "0": BNB Chain is off. No network, chain list,
 *    count, logo, contract list, CSP entry, token list, price, Glim fact or
 *    remote MCP text names it as a Gloam network, and the copy counts the
 *    mainnets as before. The flag's words are checked: only "1", "true", "on"
 *    and "yes" turn it on.
 *  - on (flag "1", its pool, deploy block and live-since date from
 *    NEXT_PUBLIC_BNB_*): BNB Chain is the last mainnet in every list and count,
 *    with its own mark, gas in BNB, USDT and USDC in 18 decimals, BDX in 9 with
 *    its cap, /verify naming its guard, the Safe and its own deployer, Glim and
 *    the remote MCP naming it (public RPC only), and no private swaps there.
 *
 * Every run also reads the source: a file under src/ that writes "BNB Chain"
 * outside a comment must be gated (it imports lib/bnb, names NETWORK_KEYS or a
 * BNB_* value, or keys off family "bnb"), or be one of the files below that are
 * read only for a network that exists, or that name BNB Chain as a bridge
 * origin or a vote option, which has nothing to do with its vault. A new
 * ungated line of BNB Chain copy fails here.
 *
 * And /verify's planned addresses for BNB Chain (lib/contractDirectory
 * BORN_GUARDED) must match contracts/deployments/bnb-mainnet.json, the plan
 * before the deploy and the read-back after it.
 *
 * Placeholder values reach no host (fetch fails the run if anything tries).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-bnb-everywhere.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MODE = process.env.GLOAM_SELFTEST_BNB_EVERYWHERE ?? "unset";
const CHAIN_ID = 56;
const POOL = "0x89d3042390204f57b8b4F8949D3c2203E4002164";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const BDX = "0x6ad12E761b438beA3EA09F6C6266556Bb24C2181";
const SAFE = "0x8E74b2b85b40f36771f92392b42BBaeacDC75507";
const ZERO = "0x0000000000000000000000000000000000000000";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_BNB_")) delete process.env[k];
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
if (MODE === "zero") process.env.NEXT_PUBLIC_BNB_ENABLED = "0";
if (MODE === "on") {
  Object.assign(process.env, {
    NEXT_PUBLIC_BNB_ENABLED: "1",
    NEXT_PUBLIC_BNB_POOL: POOL,
    NEXT_PUBLIC_BNB_DEPLOY_BLOCK: "134300000",
    NEXT_PUBLIC_BNB_LIVE_SINCE: "21 November 2026",
  });
}
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-bnb-everywhere: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const APP = fileURLToPath(new URL("..", import.meta.url));

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};

// ---------------------------------------------------------------- the source: BNB Chain copy is gated

/** Files that may write "BNB Chain" with no gate of their own, and why that is fine. */
const ALLOWED: Record<string, string> = {
  "src/lib/networks.ts": "the network entries; listed only through NETWORK_KEYS (hasPool)",
  "src/lib/bnb.ts": "the switch itself",
  "src/components/app/NetworkSelector.tsx": "assetLine, called for listed networks only",
  "src/lib/docsCardArt.tsx": "pill map by MAINNET_CHAINS name",
  // BNB Chain as a place money is bridged FROM, long before its vault: not about the vault
  "src/lib/bridge.ts": "bridge origins (BRIDGE_CHAINS)",
  "src/lib/vote/config.ts": "a past holder vote's options",
  "src/lib/vote/optionArt.tsx": "a past holder vote's options",
  "src/app/docs/compare/page.tsx": "another project's audit names BNB Chain",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** The text with comments taken out, roughly: enough to tell copy from notes. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const GATE = /from "(?:@\/lib\/|\.\.?\/)bnb"|NETWORK_KEYS|family === "bnb"|\bBNB_[A-Z_]+\b|bnbFacts/;
const ungated: string[] = [];
for (const file of walk(join(APP, "src"))) {
  const rel = file.slice(APP.length).replace(/^\/+/, "");
  const body = code(readFileSync(file, "utf8"));
  if (!/BNB Chain/.test(body)) continue;
  if (ALLOWED[rel]) continue;
  if (!GATE.test(body)) ungated.push(rel);
}
ok(ungated.length === 0, `BNB Chain copy with no gate: ${ungated.join(", ")}`);

// /verify's planned addresses match the deployments record, before and after the deploy.
const { BORN_GUARDED } = await import("../src/lib/contractDirectory");
const record = JSON.parse(readFileSync(join(APP, "../contracts/deployments/bnb-mainnet.json"), "utf8"));
const planned = BORN_GUARDED.bnb!;
const same = (a: string | undefined, b: string | undefined) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
if (record.contracts?.ShieldPoolPayments) {
  ok(same(planned.deployer, record.deployer), "BORN_GUARDED.bnb.deployer = the deploy's");
  ok(same(planned.poseidon, record.contracts.PoseidonT3), "BORN_GUARDED.bnb.poseidon = the deploy's PoseidonT3");
  ok(same(planned.guard, record.contracts.VaultOwnerGuard), "BORN_GUARDED.bnb.guard = the deploy's VaultOwnerGuard");
  ok(same(planned.controller, record.guard?.controller) || same(planned.controller, record.guard?.pendingController), "BORN_GUARDED.bnb.controller = the guard's controller");
} else {
  ok(same(planned.deployer, record.plan.deployer), "BORN_GUARDED.bnb.deployer = the plan's");
  ok(same(planned.poseidon, record.plan.PoseidonT3), "BORN_GUARDED.bnb.poseidon = the plan's PoseidonT3");
  ok(same(planned.guard, record.plan.VaultOwnerGuard), "BORN_GUARDED.bnb.guard = the plan's VaultOwnerGuard");
  ok(same(planned.controller, record.plan.guardController) && same(planned.controller, SAFE), "BORN_GUARDED.bnb.controller = the Safe");
}

// ---------------------------------------------------------------- the lists

const bnb = await import("../src/lib/bnb");
const nets = await import("../src/lib/networks");
const mainnet = await import("../src/lib/mainnet");
const tokens = await import("../src/lib/tokens");
const { chainLogoSrc } = await import("../src/lib/chainLogo");
const { contractDirectory, vaultChecks } = await import("../src/lib/contractDirectory");
const { CSP_CONNECT_SOURCES, bnbConnectSources } = await import("../csp.config.mjs");
const { knowledgeBlock, bnbFacts } = await import("../src/lib/telegramBot/knowledge");
const { chainFix } = await import("../src/lib/telegramBot/rules");
const { TOOLS, callTool } = await import("../src/lib/mcpRemote/tools");
const { vaultSwapRouter, swapMainnets } = await import("../src/lib/vaultSwap");
const { relayNetworks, networkForChain } = await import("../src/lib/relay/server");
const { MARKED_BY_CHAIN, hasCoingeckoMarks } = await import("../src/lib/markedTokens");
const { presetsFor, BNB_PRESETS } = await import("../src/lib/cashOutPrivacy");
const { claimNativeSymbol } = await import("../src/lib/claimHelp");
const { usdOf } = await import("../src/lib/onchainMetrics");
const { amountOf } = await import("../src/components/verify/ProofVerdict");

const ctx = { origin: "https://www.gloam.trade", ip: "127.0.0.1" };
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await callTool(name, args, ctx);
  return { isError: Boolean(r.isError), text: (r.content[0] as { text: string }).text };
};
const toolText = JSON.stringify(TOOLS);
const mainnetKeys = () => nets.NETWORK_KEYS.filter((k) => !nets.getNetwork(k).testnet);
const PUBLIC_RPC_HOSTS = ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"];

// Every run: no private swaps on BNB Chain, and the flag's words.
ok(vaultSwapRouter(CHAIN_ID) === null, "no swap router on BNB Chain");
ok(!swapMainnets().includes("BNB Chain"), "the swap chains leave BNB Chain out");
for (const raw of ["1", "true", "TRUE", "on", "yes", " 1 "]) {
  ok(bnb.bnbFlagFrom(raw), `${JSON.stringify(raw)} turns it on`);
  ok(bnbConnectSources({ NEXT_PUBLIC_BNB_ENABLED: raw, NEXT_PUBLIC_BNB_POOL: "0x89d3042390204f57b8b4F8949D3c2203E4002164" } as unknown as NodeJS.ProcessEnv).length === 2, `${JSON.stringify(raw)} with a pool: the CSP allows its two public RPCs`);
  ok(bnbConnectSources({ NEXT_PUBLIC_BNB_ENABLED: raw } as unknown as NodeJS.ProcessEnv).length === 0, `${JSON.stringify(raw)} with no pool: nothing to allow yet`);
}
for (const raw of [undefined, "", "0", "false", "off", "no", "enabled", "2"]) {
  ok(!bnb.bnbFlagFrom(raw), `${JSON.stringify(raw)} leaves it off`);
  ok(bnbConnectSources({ NEXT_PUBLIC_BNB_ENABLED: raw, NEXT_PUBLIC_BNB_POOL: "0x89d3042390204f57b8b4F8949D3c2203E4002164" } as unknown as NodeJS.ProcessEnv).length === 0, `${JSON.stringify(raw)}: no BNB Chain RPC in the CSP`);
}
// A proof's amount reads in its own chain's decimals, whatever network the browser has open.
ok(amountOf("1250000000", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 8453) === "1,250", "a Base USDC proof reads in 6 decimals");

if (MODE !== "on") {
  ok(bnb.BNB === null && !bnb.BNB_ENABLED && !bnb.BNB_FLAG, `${MODE}: BNB Chain is off`);
  ok(!nets.NETWORK_KEYS.some((k) => nets.getNetwork(k).family === "bnb") && !nets.isNetworkKey("bnb-mainnet"), `${MODE}: no BNB Chain network key`);
  ok(!nets.SHOWN_NETWORK_KEYS.includes("bnb-mainnet"), `${MODE}: not shown`);
  ok(!mainnet.MAINNET_CHAINS.some((c) => c.name === "BNB Chain"), `${MODE}: not in MAINNET_CHAINS`);
  ok(!/BNB/.test(mainnet.liveMainnetNames()) && !/BNB/.test(mainnet.liveMainnetsSinceText()), `${MODE}: not in the live mainnet names`);
  ok(!/six/.test(mainnet.liveMainnetCountWords()), `${MODE}: the count is as before`);
  ok(!contractDirectory(true).some((d) => d.key === "bnb-mainnet" || /BNB/.test(d.name)), `${MODE}: /verify does not list it`);
  ok(!CSP_CONNECT_SOURCES.some((s: string) => PUBLIC_RPC_HOSTS.includes(s)), `${MODE}: no BNB Chain vault RPC in the CSP`);
  ok(tokens.shieldTokensFor(CHAIN_ID).every((t) => t.address.toLowerCase() !== USDT.toLowerCase()), `${MODE}: no BNB Chain USDT to add`);
  ok(tokens.BNB_MAINNET_TOKENS.length === 0, `${MODE}: no BNB Chain token list`);
  ok(!MARKED_BY_CHAIN.some((m) => m.chainId === CHAIN_ID) && !hasCoingeckoMarks(CHAIN_ID), `${MODE}: no BNB Chain price list`);
  ok(bnbFacts() === null, `${MODE}: Glim has no BNB Chain facts`);
  const glim = knowledgeBlock();
  ok(!/BNB CHAIN|chain ID 56|BNB Chain mainnet/.test(glim), `${MODE}: Glim never names a BNB Chain vault`);
  ok(!/bnb-mainnet|BNB Chain mainnet/.test(toolText), `${MODE}: no remote MCP tool names BNB Chain`);
  ok(!/bnb-mainnet|BNB Chain/.test((await tool("gloam_networks")).text), `${MODE}: the remote MCP's networks say nothing`);
  ok((await tool("gloam_networks", { network: "bnb-mainnet" })).isError, `${MODE}: the remote MCP refuses the key`);
  ok(!relayNetworks().some((n) => n.family === "bnb"), `${MODE}: the relay does not serve it`);
  ok(!chainFix("Ada", { wallet: 1, want: CHAIN_ID }).includes("BNB Chain"), `${MODE}: Glim's wrong-network help never names BNB Chain`);
} else {
  ok(bnb.BNB?.chainId === CHAIN_ID && bnb.BNB.pool === POOL, "on: BNB Chain is on with its pool");
  const mk = mainnetKeys();
  ok(mk[mk.length - 1] === "bnb-mainnet", "on: the last mainnet");
  const shown = nets.shownNetworks().filter((n) => !n.testnet);
  ok(shown[shown.length - 1]?.key === "bnb-mainnet", "on: shown last among the mainnets (SHOWN_NETWORK_KEYS)");
  ok(mainnet.MAINNET_CHAINS[mainnet.MAINNET_CHAINS.length - 1]?.name === "BNB Chain", "on: last in MAINNET_CHAINS");
  ok(mainnet.liveMainnetNames().endsWith("and BNB Chain"), "on: last in the live mainnet names");
  ok(mainnet.liveMainnetsSinceText().endsWith("BNB Chain since 21 November 2026"), "on: in the since-when line");
  ok(chainLogoSrc(CHAIN_ID) === "/brand/chains/56.png" && chainLogoSrc(CHAIN_ID, true) === "/brand/chains/56-dark.png", "on: BNB Chain's own mark");
  const n = nets.getNetwork("bnb-mainnet");
  ok(n.primaryAsset.symbol === "BNB" && n.chain.nativeCurrency.symbol === "BNB", "on: gas in BNB");
  ok(n.ceremony === "production" && n.paymentsPool && n.logCanary, "on: final keys, payments pool, pruned-logs check");
  // the relay serves it once the server has its own RPC there (lib/serverRpc hasServerRpc)
  process.env.GLOAM_RPC_URL_56 = "https://archive.example/bsc";
  ok(networkForChain(CHAIN_ID).key === "bnb-mainnet", "on: the relay serves it with GLOAM_RPC_URL_56 set");
  delete process.env.GLOAM_RPC_URL_56;
  // Its tokens, each in its own decimals.
  const list = tokens.shieldTokensFor(CHAIN_ID);
  ok(list.map((t) => `${t.symbol}:${t.decimals}`).join() === "USDT:18,USDC:18,BDX:9", "on: USDT and USDC with 18 decimals, BDX with 9");
  ok(list[0]!.address === USDT && list[1]!.address === USDC && list[2]!.address === BDX, "on: the canonical addresses");
  ok(tokens.nativeTokenFor(CHAIN_ID).symbol === "BNB" && tokens.supportsNativeShield(CHAIN_ID), "on: BNB is the native coin, and the vault lists it");
  ok(hasCoingeckoMarks(CHAIN_ID) && MARKED_BY_CHAIN.some((m) => m.chainId === CHAIN_ID && m.tokens.some((t) => t.symbol === "BDX")), "on: BDX is priced");
  ok(presetsFor(CHAIN_ID, ZERO).values === BNB_PRESETS, "on: BNB amounts round to BNB presets, not ETH's");
  ok(claimNativeSymbol(ZERO, CHAIN_ID) === "BNB", "on: a claim link in the native coin says BNB");
  // BNB is priced at BNB's price, never ETH's.
  const prices = { at: 0, ethUsd: 3000, hypeUsd: 30, bnbUsd: 900, marks: new Map<string, number>(), stocks: "live" as const };
  ok(usdOf(n, "native", 2, { symbol: "BNB", decimals: 18, stable: false }, prices) === 1800, "on: 2 BNB at BNB's price");
  ok(usdOf(n, "native", 2, { symbol: "BNB", decimals: 18, stable: false }, { ...prices, bnbUsd: null }) === null, "on: unpriced, never at ETH's");
  // A proof on BNB Chain reads its USDT in 18 decimals.
  ok(amountOf("1500000000000000000", USDT, CHAIN_ID) === "1.5", "on: a BNB Chain USDT proof reads in 18 decimals");
  // /verify: the guard, the Safe and its own deployer, and checks that pass for a vault as planned.
  const entry = contractDirectory().find((d) => d.key === "bnb-mainnet");
  ok(entry?.live && entry.kind === "mainnet", "on: /verify lists it");
  const rows = entry!.rows;
  ok(rows.some((r) => r.name === "Owner guard" && same(r.address, BORN_GUARDED.bnb!.guard)), "on: the guard row");
  ok(rows.some((r) => r.name === "Guard controller" && same(r.address, SAFE)), "on: the Safe runs the guard");
  ok(!rows.some((r) => same(r.address, "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8")), "on: no owner-wallet row");
  ok(rows.some((r) => r.role === "deployer" && same(r.address, "0xec9993765e249e8e9DC677B7BCB61F78b31c6b60")), "on: its own deployer");
  const read = {
    owner: BORN_GUARDED.bnb!.guard,
    pendingOwner: ZERO,
    setupMode: false,
    changeDelay: 3n * 24n * 60n * 60n,
    verifier: "0x29053A713E3a7D37053374446869a6f55858FcEf",
    shieldVerifier: "0xAEB8cb99B3BB43eB230F9fEB7293fB5E39080016",
    poseidon: BORN_GUARDED.bnb!.poseidon,
    feeRecipient: "0xB3900ac9350903218e4c7597bAb0f008F01B30B8",
    withdrawFeeBps: 50,
    cashOutVerifier: null,
    sendVerifier: null,
  } as Parameters<typeof vaultChecks>[1];
  const vc = vaultChecks(n, read);
  ok(vc.every((c) => c.ok), `on: a vault as planned passes every check (${vc.filter((c) => !c.ok).map((c) => c.label).join(", ")})`);
  ok(PUBLIC_RPC_HOSTS.every((h) => CSP_CONNECT_SOURCES.includes(h)), "on: the CSP allows its public RPCs");
  // Glim: live facts, the public RPC, no partnership.
  const facts = bnbFacts() ?? "";
  ok(facts.includes("chain ID 56") && facts.includes("18 decimals") && facts.includes("100,000") && facts.includes("21 November 2026"), "on: Glim's live facts");
  ok(facts.includes("https://bsc-rpc.publicnode.com") && !/\/v\d+\/|apikey|api_key/i.test(facts), "on: Glim names the public RPC only");
  ok(!/partner(ed|ship) with|official partner|\bfirst\b|\bthe only\b/i.test(facts.replace(/no partnership with BNB Chain, Binance or Beldex/, "")), "on: Glim claims no partnership, no first or only");
  ok(knowledgeBlock().includes(facts), "on: the facts are in Glim's block");
  ok(chainFix("Ada", { wallet: 1, want: CHAIN_ID }).includes('"Switch to BNB Chain"') && chainFix("Ada", { wallet: 1, want: CHAIN_ID }).includes("currency BNB"), "on: Glim's wrong-network help names BNB Chain");
  // The remote MCP.
  ok(/bnb-mainnet/.test(toolText), "on: the remote MCP's tool text names it");
  const one = await tool("gloam_networks", { network: "bnb-mainnet" });
  ok(!one.isError && one.text.includes("BNB (BNB Chain's gas coin)") && /\b56\b/.test(one.text) && one.text.includes("about a day of logs"), "on: the remote MCP names it, gas in BNB, and warns about its logs");
  const mpp = await tool("gloam_mpp_how_to", { network: "bnb-mainnet", role: "both" });
  ok(!mpp.isError && mpp.text.includes("BNB_MAINNET.usdt.address") && mpp.text.includes("50_000_000_000_000_000n"), "on: the MPP snippet uses BNB Chain's USDT in 18 decimals");
  ok(!/RH_MAINNET_USDG/.test(mpp.text), "on: never Robinhood Chain's USDG for BNB Chain");
  // A cap counts base units: pinned to USDT on this chain, or 5 * 10^16 would also allow 0.05 BNB or 50,000,000 BDX.
  const payOnly = await tool("gloam_mpp_how_to", { network: "bnb-mainnet", role: "pay" });
  const payCode = String((JSON.parse(payOnly.text) as { pay?: { code?: string } }).pay?.code ?? "");
  ok(
    payCode.includes("maxAmountWei: 50_000_000_000_000_000n, currencies: [BNB_MAINNET.usdt.address], chainIds: [net.chainId]") &&
      payCode.includes('relayIntent, BNB_MAINNET } from "@gloamtrade/sdk"'),
    "on: the payer's cap is pinned to BNB Chain's USDT and chain, and the pay snippet imports BNB_MAINNET"
  );
}

if (MODE === "unset") {
  for (const mode of ["zero", "on"]) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_SELFTEST_BNB_EVERYWHERE: mode },
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
console.log(`selftest-bnb-everywhere (${MODE}): ok (${checks} checks)`);
