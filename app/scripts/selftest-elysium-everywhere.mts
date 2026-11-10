/**
 * Self-test: Elysium everywhere Gloam lists its chains, and nowhere while it is off.
 *
 * Two runs of this file (the second as a child process):
 *
 *  - off (NEXT_PUBLIC_ELYSIUM_ENABLED=0; unset, Elysium mainnet is on with the
 *    SDK's values, which selftest-elysium checks): no network, chain list,
 *    count, logo, contract list, CSP entry, token list, Glim fact or remote MCP
 *    text names Elysium, and copy still counts four mainnets.
 *  - on (both switches on, every value from NEXT_PUBLIC_ELYSIUM_*, a keyed RPC):
 *    Elysium mainnet is the fifth mainnet in every list and count, its testnet
 *    is the last testnet, both use Elysium's own logo, gas is HYPE, the relay
 *    serves both with Orbit gas room, the RPC key never shows in Glim or the
 *    remote MCP, and the bridge and private swaps leave Elysium out.
 *
 * Both runs also read the source: every file under src/ that writes "Elysium"
 * outside a comment must be gated (it names ELYSIUM*, isElysium* or
 * NETWORK_KEYS), or be one of the maps below that are only read for a network
 * that exists. A new ungated line of Elysium copy fails here.
 *
 * Placeholder values reach no host (fetch fails the run if anything tries).
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-elysium-everywhere.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MODE = process.env.GLOAM_SELFTEST_ELYSIUM_EVERYWHERE ?? "off";
const CHAIN_ID = 99_901;
const TESTNET_ID = 99_801;
const POOL = "0x39E28Cde55CAB798874746ac52cb4B5Cc99a0194";
const TESTNET_POOL = "0x00000000000000000000000000000000000E1A5e";
const USDC = "0x00000000000000000000000000000000000E1a5c";
const KEY = "selftestKey0123456789abcdef";
const RPC = `https://elysium-mainnet.g.alchemy.com/v2/${KEY}`;

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_ELYSIUM_")) delete process.env[k];
// Elysium mainnet is on unless the flag says off
if (MODE === "off") process.env.NEXT_PUBLIC_ELYSIUM_ENABLED = "0";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
if (MODE === "on") {
  Object.assign(process.env, {
    NEXT_PUBLIC_ELYSIUM_ENABLED: "1",
    NEXT_PUBLIC_ELYSIUM_CHAIN_ID: String(CHAIN_ID),
    NEXT_PUBLIC_ELYSIUM_RPC_URL: RPC,
    NEXT_PUBLIC_ELYSIUM_EXPLORER_URL: "https://explorer.elysium.example",
    NEXT_PUBLIC_ELYSIUM_USDC: USDC,
    NEXT_PUBLIC_ELYSIUM_POOL: POOL,
    NEXT_PUBLIC_ELYSIUM_DEPLOY_BLOCK: "1234",
    NEXT_PUBLIC_ELYSIUM_TESTNET_ENABLED: "1",
    NEXT_PUBLIC_ELYSIUM_TESTNET_POOL: TESTNET_POOL,
    NEXT_PUBLIC_ELYSIUM_TESTNET_DEPLOY_BLOCK: "25000000",
  });
}
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`selftest-elysium-everywhere: no network calls allowed (${String(url)})`);
}) as typeof fetch;

const APP = fileURLToPath(new URL("..", import.meta.url));

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};

// ---------------------------------------------------------------- the source: Elysium copy is gated

/**
 * Files that may name Elysium with no gate of their own: each is a map or a
 * definition that is only read for a network that exists (NETWORK_KEYS), so
 * nothing in it reaches a page while Elysium is off.
 */
const KEYED_BY_NETWORK: Record<string, string> = {
  "src/lib/networks.ts": "the network entries; listed only through NETWORK_KEYS (hasPool)",
  "src/components/app/NetworkSelector.tsx": "assetLine, called for listed networks only",
  "src/components/app/TokenLogo.tsx": "logo map by id",
  "src/components/transparency/NetworkPicker.tsx": "logo map by family, for listed networks",
  "src/components/verify/ContractsSection.tsx": "logo map by family, for directory entries",
  "src/lib/docsCardArt.tsx": "pill map by MAINNET_CHAINS name",
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

const GATE = /\bELYSIUM\w*\b|\bisElysium\w*\(|NETWORK_KEYS|elysiumFacts|ELYSIUM_LOGO/;
const ungated: string[] = [];
for (const file of walk(join(APP, "src"))) {
  const rel = file.slice(APP.length).replace(/^\/+/, "");
  if (rel === "src/lib/elysium.ts" || rel === "src/lib/chainLogo.ts") continue;
  const body = code(readFileSync(file, "utf8"));
  if (!/Elysium/.test(body)) continue;
  if (KEYED_BY_NETWORK[rel]) continue;
  if (!GATE.test(body)) ungated.push(rel);
}
ok(ungated.length === 0, `Elysium copy with no gate: ${ungated.join(", ")}`);
// The stand-in mark is gone; every reference points at the real one.
const svgRefs = walk(join(APP, "src")).filter((f) => readFileSync(f, "utf8").includes("elysium.svg"));
ok(svgRefs.length === 0, `still pointing at the stand-in elysium.svg: ${svgRefs.join(", ")}`);
const png = readFileSync(join(APP, "public/brand/chains/elysium.png"));
ok(png.subarray(1, 4).toString() === "PNG" && png.readUInt32BE(16) === png.readUInt32BE(20), "Elysium's mark is a square PNG");

// ---------------------------------------------------------------- the lists

const ely = await import("../src/lib/elysium");
const nets = await import("../src/lib/networks");
const mainnet = await import("../src/lib/mainnet");
const tokens = await import("../src/lib/tokens");
const { chainLogoSrc, ELYSIUM_LOGO } = await import("../src/lib/chainLogo");
const { contractDirectory } = await import("../src/lib/contractDirectory");
const { CSP_CONNECT_SOURCES } = await import("../csp.config.mjs");
const { knowledgeBlock } = await import("../src/lib/telegramBot/knowledge");
const { TOOLS, callTool } = await import("../src/lib/mcpRemote/tools");
const { BRIDGE_DESTINATIONS } = await import("../src/lib/bridge");
const { vaultSwapRouter, swapMainnets } = await import("../src/lib/vaultSwap");
const { networkForChain, relayNetworks, sendGasMost } = await import("../src/lib/relay/server");
const { hourlySpendWei } = await import("../src/lib/relay/spendCap");
const { PUBLIC_MEMPOOL_CHAINS } = await import("../src/lib/partnerCode");

const ctx = { origin: "https://www.gloam.trade", ip: "127.0.0.1" };
const networksText = async (network?: string) => {
  const r = await callTool("gloam_networks", network ? { network } : {}, ctx);
  return { isError: Boolean(r.isError), text: (r.content[0] as { text: string }).text };
};
const toolText = JSON.stringify(TOOLS);
const mainnetKeys = () => nets.NETWORK_KEYS.filter((k) => !nets.getNetwork(k).testnet);
const testnetKeys = () => nets.NETWORK_KEYS.filter((k) => nets.getNetwork(k).testnet);

// The bridge brings USDC into Elysium only with the flag on; no swap router there yet in either run.
ok(("elysium" in BRIDGE_DESTINATIONS) === ely.ELYSIUM_ENABLED, "a bridge destination on Elysium exactly when it is on");
ok(vaultSwapRouter(CHAIN_ID) === null && vaultSwapRouter(TESTNET_ID) === null, "no swap router on Elysium");
ok(!swapMainnets().includes("Elysium"), "the swap chains leave Elysium out");
// Both runs: link attribution there counts relay-sent payments only, until its sequencer is checked.
ok(PUBLIC_MEMPOOL_CHAINS.includes(CHAIN_ID) && PUBLIC_MEMPOOL_CHAINS.includes(TESTNET_ID), "Elysium counts relay-sent link payments only");

if (MODE === "off") {
  ok(ely.ELYSIUM === null && ely.ELYSIUM_TESTNET === null && !ely.ELYSIUM_FLAG && !ely.ELYSIUM_TESTNET_FLAG, "off: Elysium is off");
  ok(!nets.NETWORK_KEYS.some((k) => nets.getNetwork(k).family === "elysium"), "off: no Elysium network key");
  ok(!mainnet.MAINNET_CHAINS.some((c) => c.name === "Elysium"), "off: not in MAINNET_CHAINS");
  ok(!/Elysium/.test(mainnet.liveMainnetNames()), "off: not in the live mainnet names");
  ok(mainnet.liveMainnetCountWords() === "four mainnets", "off: four mainnets");
  ok(!/Elysium/.test(mainnet.liveMainnetsSinceText()), "off: not in the since-when line");
  ok(mainnet.liveMainnetsSinceText() === "Robinhood Chain and Tempo since 21 October 2026, Base and Ethereum since 26 October 2026", "off: the since-when line as shipped");
  ok(chainLogoSrc(CHAIN_ID) === `/brand/chains/${CHAIN_ID}.png` && chainLogoSrc(TESTNET_ID) !== ELYSIUM_LOGO, "off: no Elysium logo by chain id");
  ok(!contractDirectory().some((d) => /elysium/i.test(`${d.key} ${d.name}`)), "off: /verify does not list it");
  ok(!CSP_CONNECT_SOURCES.some((s: string) => /elysium|kinetiq/.test(s)), "off: no Elysium host in the CSP");
  ok(tokens.shieldTokensFor(CHAIN_ID).every((t) => t.address.toLowerCase() !== USDC.toLowerCase()), "off: no Elysium USDC");
  ok(!tokens.shieldTokensFor(TESTNET_ID).some((t) => t.address.toLowerCase() === "0x7d29d8047b905000459c0e80c34a26ceedcb47b2"), "off: no Elysium test USDC");
  ok(!/elysium/i.test(knowledgeBlock()), "off: Glim never names Elysium");
  ok(!/elysium/i.test(toolText), "off: no remote MCP tool names Elysium");
  ok(!/elysium/i.test((await networksText()).text), "off: the remote MCP's networks say nothing");
  ok((await networksText("elysium-mainnet")).isError && (await networksText("elysium")).isError, "off: the remote MCP refuses both keys");
  ok(!relayNetworks().some((n) => n.family === "elysium"), "off: the relay does not serve it");
} else {
  // Mainnet: fifth, last, in every list and count.
  ok(ely.ELYSIUM?.chainId === CHAIN_ID && ely.ELYSIUM_TESTNET?.chainId === TESTNET_ID, "on: both networks on");
  const mk = mainnetKeys();
  ok(mk.length === 5 && mk[4] === "elysium-mainnet", "on: the fifth mainnet, listed last");
  const tk = testnetKeys();
  ok(tk[tk.length - 1] === "elysium", "on: its testnet listed last");
  ok(mainnet.MAINNET_CHAINS[mainnet.MAINNET_CHAINS.length - 1]?.name === "Elysium", "on: last in MAINNET_CHAINS");
  ok(mainnet.liveMainnetNames() === "Robinhood Chain, Tempo, Base, Ethereum and Elysium", "on: in the live mainnet names");
  ok(mainnet.liveMainnetCountWords() === "five mainnets", "on: five mainnets");
  ok(mainnet.liveMainnetsSinceText().endsWith("Elysium since 9 November 2026"), "on: in the since-when line");
  // Its own mark on both networks, gas in HYPE.
  ok(chainLogoSrc(CHAIN_ID) === ELYSIUM_LOGO && chainLogoSrc(TESTNET_ID, true) === ELYSIUM_LOGO, "on: Elysium's mark for both");
  for (const key of ["elysium-mainnet", "elysium"] as const) {
    const n = nets.getNetwork(key);
    ok(n.primaryAsset.symbol === "HYPE" && n.chain.nativeCurrency.symbol === "HYPE", `on: ${key} gas in HYPE`);
    ok(n.ceremony === "production" && n.paymentsPool, `on: ${key} on the final keys`);
    ok(!tokens.supportsNativeShield(n.chainId), `on: ${key} does not list HYPE`);
    ok(networkForChain(n.chainId).key === key, `on: the relay serves ${key}`);
    ok(sendGasMost(n.chainId, "unshield") === 4_800_000n, `on: ${key} gets Orbit gas room, like Robinhood Chain`);
  }
  ok(nets.getNetwork("elysium").logRange === 1_000_000n, "on: 100 ms blocks, 1,000,000-block log reads");
  ok(tokens.shieldTokensFor(CHAIN_ID).map((t) => t.symbol).join() === "USDC,KNTQ", "on: USDC and KNTQ on Elysium mainnet");
  ok(tokens.shieldTokensFor(TESTNET_ID)[0]?.address === "0x7D29d8047B905000459c0E80c34a26CeedcB47b2", "on: test USDC on Elysium testnet");
  ok(hourlySpendWei(CHAIN_ID, {}) === 10n ** 18n, "on: the relay's hourly cap is 1 HYPE");
  const dir = contractDirectory();
  ok(dir.some((d) => d.key === "elysium-mainnet" && d.live) && dir.some((d) => d.key === "elysium" && d.live), "on: /verify lists both");
  ok(CSP_CONNECT_SOURCES.includes("https://elysium-mainnet.g.alchemy.com"), "on: the CSP allows the keyed RPC's origin");
  ok(CSP_CONNECT_SOURCES.includes("https://testnet-rpc.elysium.kinetiq.xyz"), "on: the CSP allows the testnet RPC");
  // The key never shows.
  ok(ely.ELYSIUM_RPC_DISPLAY === "https://elysium-mainnet.g.alchemy.com/v2/{API_KEY}", "on: the RPC is shown redacted");
  const glim = knowledgeBlock();
  ok(/Elysium mainnet \(chain ID 99901\)/.test(glim) && /Elysium testnet \(chain ID 99801\)/.test(glim), "on: Glim knows both");
  ok(!glim.includes(KEY), "on: Glim never shows the RPC key");
  ok(!/partner(ed|ship)? with Kinetiq|official partner/i.test(glim.replace(/no partnership with Kinetiq or Hyperliquid/g, "")), "on: Glim claims no partnership");
  const all = await networksText();
  ok(/elysium-mainnet/.test(all.text) && /"elysium"|elysium\b/.test(all.text), "on: the remote MCP lists both");
  ok(!all.text.includes(KEY), "on: the remote MCP never shows the RPC key");
  const one = await networksText("elysium");
  ok(!one.isError && one.text.includes("HYPE") && one.text.includes(String(TESTNET_ID)), "on: the remote MCP names its testnet, gas in HYPE");
  ok(/Elysium/.test(toolText), "on: the remote MCP's tool text names Elysium");
  // Claim links on both networks round-trip. Id 45 is Elysium mainnet's USDC once the SDK
  // file carries every value (launch day, 9 Nov 2026), and reserved before that; id 46
  // stays reserved. The env's placeholder pool differs, so these links write the place out.
  const { encodeShortClaim, decodeShortClaim, randomNoteSeed, SHORT_LINK_WHERE, ELYSIUM_MAINNET: SDK_ELY } = await import("@gloamtrade/sdk");
  const sdkFilled = [SDK_ELY.rpcUrl, SDK_ELY.explorerUrl, SDK_ELY.usdc, SDK_ELY.pool, SDK_ELY.deployBlock].every((v) => v != null);
  ok(SHORT_LINK_WHERE.length >= 46 && SHORT_LINK_WHERE[44]!.chainId === (sdkFilled ? CHAIN_ID : 0) && SHORT_LINK_WHERE[45]!.chainId === 0, sdkFilled ? "on: id 45 is Elysium's USDC, 46 stays reserved" : "on: ids 45 and 46 stay reserved without the SDK file's values");
  for (const [chainId, pool, asset] of [
    [CHAIN_ID, POOL, USDC],
    [TESTNET_ID, TESTNET_POOL, "0x7D29d8047B905000459c0E80c34a26CeedcB47b2"],
  ] as const) {
    const s = randomNoteSeed();
    const body = encodeShortClaim({ pool, asset, amountWei: "2500000", secret: `0x${s.secret.toString(16).padStart(64, "0")}`, chainId, seed: s.seed });
    ok(body !== null, `on: a ${chainId} claim link is made`);
    const back = await decodeShortClaim(body!);
    ok(back.chainId === chainId && back.asset.toLowerCase() === asset.toLowerCase() && back.amountWei === "2500000", `on: a ${chainId} claim link reads back`);
  }
}

if (MODE === "off") {
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
    env: { ...process.env, GLOAM_SELFTEST_ELYSIUM_EVERYWHERE: "on" },
    encoding: "utf8",
  });
  if (child.status !== 0) {
    console.error(child.stdout, child.stderr);
    assert.fail("the on run failed");
  }
  process.stdout.write(child.stdout);
  checks++;
}
console.log(`selftest-elysium-everywhere (${MODE}): ok (${checks} checks)`);
