/**
 * Self-test: Gloam on Starknet on the public site, behind
 * NEXT_PUBLIC_STARKNET_ENABLED, and nowhere while it is off.
 *
 * Two runs of this file (the second as a child process):
 *
 *  - off (the flag unset, as production builds it until Starknet opens):
 *    llms.txt, the docs nav, search and sitemap, the hosted MCP's info and
 *    networks and Glim's knowledge say nothing about Gloam on Starknet, and
 *    /docs/starknet answers 404.
 *  - on (flag "1", mainnet): each of them names Starknet with the SDK's plain
 *    words (over an open channel both sides and the amount hidden, the first
 *    payment showing the payee's account, the auditor key, the prover); the
 *    hosted MCP lists it apart, not for a single network; Glim is told never
 *    to say a first payment hides the payee; the docs page renders.
 *
 * Every run reads the source of the files that carry this copy: no line that
 * names Starknet says it hides who was paid without the open-channel
 * condition, none calls it anonymous, untraceable or live, none has an em
 * dash or "happy to"; and every file under src/ that links /docs/starknet or
 * uses the docs' Starknet copy is gated by STARKNET_ENABLED.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-site.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const stubs: Record<string, string> = { "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)) };
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

const MODE = process.env.GLOAM_SELFTEST_STARKNET_SITE ?? "off";
for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_")) delete process.env[k];
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.GLOAM_PARTNERS_STORE = "memory";
if (MODE === "on") process.env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
globalThis.fetch = (async (input: unknown) => {
  throw new TypeError(`no network in selftest-starknet-site (${String(input)})`);
}) as typeof fetch;

const SITE = "https://www.gloam.trade";
const APP = fileURLToPath(new URL("..", import.meta.url));
let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};

const sdk = await import("@gloamtrade/sdk");
const config = await import("../src/lib/starknetPrivacy/config");
const { GET: llms } = await import("../src/app/llms.txt/route");
const { callTool, TOOLS } = await import("../src/lib/mcpRemote/tools");
const { knowledgeBlock, starknetFacts } = await import("../src/lib/telegramBot/knowledge");
const { DOCS_NAV, DOCS_TABS } = await import("../src/components/docs/DocsNav");
const sitemap = (await import("../src/app/sitemap")).default;

const ON = MODE === "on";
ok(config.STARKNET_ENABLED === ON, `${MODE}: the flag reads ${ON ? "on" : "off"}`);

// ---------------------------------------------------------------- llms.txt
const text = await (await llms()).text();
ok(/Starknet/.test(text) === ON, `${MODE}: llms.txt ${ON ? "names" : "never names"} Starknet`);
ok(text.includes(sdk.STARKNET_PRIVACY_NOTE) === ON, `${MODE}: llms.txt ${ON ? "carries" : "leaves out"} the Starknet line`);
ok(text.includes(`${SITE}/docs/starknet`) === ON, `${MODE}: llms.txt ${ON ? "links" : "never links"} /docs/starknet`);
if (ON) {
  const summary = text.split("\n").find((l) => l.startsWith("> "))!;
  ok(!/Starknet/.test(summary), `${MODE}: the summary that says payees are hidden leaves Starknet out`);
}

// ---------------------------------------------------------------- docs nav, search and sitemap
const navHrefs = DOCS_NAV.flatMap((g) => g.items.map((i: { href: string }) => i.href));
ok(navHrefs.includes("/docs/starknet") === ON, `${MODE}: the docs nav ${ON ? "lists" : "leaves out"} Starknet`);
ok(DOCS_TABS.some((t) => t.match.includes("/docs/starknet")) === ON, `${MODE}: and the Networks tab matches it only when on`);
const map = await sitemap();
ok(map.some((e) => e.url.endsWith("/docs/starknet")) === ON, `${MODE}: the sitemap ${ON ? "lists" : "leaves out"} /docs/starknet`);
{
  const page = (await import("../src/app/docs/starknet/page")).default;
  let notFound = false;
  let rendered: unknown = null;
  try {
    rendered = page();
  } catch (e) {
    notFound = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(String((e as { digest?: string }).digest ?? (e as Error).message));
  }
  ok(notFound === !ON && (rendered !== null) === ON, `${MODE}: /docs/starknet ${ON ? "renders" : "answers 404"}`);
}

// ---------------------------------------------------------------- the hosted MCP
const ctx = { origin: SITE, ip: "127.0.0.1" };
const tool = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await callTool(name, args, ctx)).content[0] as { text: string }).text) as Record<string, unknown>;
const info = await tool("gloam_info");
const nets = await tool("gloam_networks");
ok(("starknet" in info) === ON && ("starknet" in nets) === ON, `${MODE}: the hosted MCP ${ON ? "lists" : "leaves out"} Starknet in its info and networks`);
ok(/Starknet/.test(JSON.stringify(TOOLS)) === ON, `${MODE}: the tool descriptions ${ON ? "say" : "never say"} so`);
if (ON) {
  const sn = nets.starknet as { name: string; privacy: string; auditor: string; pool: string; assets: { symbol: string; address: string }[]; agents: string };
  ok(sn.name === "Starknet" && sn.privacy === sdk.STARKNET_PRIVACY_NOTE && sn.auditor === sdk.STARKNET_PRIVACY.auditor, `${MODE}: with the plain line and the auditor key`);
  ok(sn.pool === sdk.STARKNET_MAINNET_POOL && sn.assets.map((a) => `${a.symbol}:${a.address}`).join() === `USDC:${sdk.STARKNET_USDC}`, `${MODE}: the canonical pool and USDC`);
  ok(/gloam_starknet_\*/.test(sn.agents) && /@gloamtrade\/sdk\/starknet/.test(sn.agents), `${MODE}: and the SDK and local MCP that cover it`);
  const one = await tool("gloam_networks", { network: "base-mainnet" });
  ok(!("starknet" in one), `${MODE}: not when one network is asked for`);
}

// ---------------------------------------------------------------- Glim
const glim = knowledgeBlock();
ok((starknetFacts() !== null) === ON && /Starknet/.test(glim) === ON, `${MODE}: Glim ${ON ? "knows" : "says nothing about"} Gloam on Starknet`);
if (ON) {
  ok(glim.includes(sdk.STARKNET_PRIVACY_NOTE), `${MODE}: Glim has the plain line`);
  ok(glim.includes("Never say or suggest that the first payment to someone hides who was paid"), `${MODE}: and is told never to say a first payment hides the payee`);
  ok(glim.includes(sdk.STARKNET_PRIVACY.auditor), `${MODE}: and knows the auditor key`);
}

// ---------------------------------------------------------------- the source, every run
const SOURCES = [
  "src/app/docs/starknet/page.tsx",
  "src/app/docs/starknet/starknetDocs.ts",
  "src/app/docs/page.tsx",
  "src/app/docs/chain/page.tsx",
  "src/app/docs/privacy-model/page.tsx",
  "src/app/docs/compare/page.tsx",
  "src/app/docs/sdk/page.tsx",
  "src/app/docs/agents/page.tsx",
  "src/app/docs/payroll/page.tsx",
  "src/lib/telegramBot/knowledge.ts",
  "src/lib/mcpRemote/tools.ts",
  "src/app/llms.txt/route.ts",
  "../packages/sdk/src/starknetInfo.ts",
  "../packages/sdk/src/starknet.ts",
  "../packages/sdk/README.md",
  "../mcp/src/starknet.ts",
  "../mcp/README.md",
];
for (const f of SOURCES) {
  const lines = readFileSync(join(APP, f), "utf8").split("\n");
  // A sentence about Starknet spans a few lines in the docs' JSX: look at each line with its neighbours.
  lines.forEach((line, i) => {
    if (!/starknet/i.test(line)) return;
    const near = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
    ok(!/—|happy to/i.test(line), `${f}:${i + 1}: no em dash or banned phrase`);
    ok(!/\banonymous|untraceable|fully private|live since|is live\b/i.test(line), `${f}:${i + 1}: never anonymous, untraceable or live`);
    if (/hides? who paid, who was paid/i.test(near)) ok(/open/i.test(near), `${f}:${i + 1}: "hides who paid, who was paid" only with the open-channel condition`);
    // (a line that says it never does, a rule or a comment, is the point, not a claim)
    ok(!/first payment[^.]*\bhides\b[^.]*\b(payee|who was paid)\b/i.test(line) || /\b(never|not)\b/i.test(line), `${f}:${i + 1}: never says a first payment hides the payee`);
  });
}
{
  // Any file under src/ that links the Starknet docs or uses their copy is gated by the flag (or is the page itself).
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  for (const f of walk(join(APP, "src"))) {
    const rel = f.slice(APP.length);
    const src = readFileSync(f, "utf8");
    if (!/\/docs\/starknet|STARKNET_DOCS_|starknetFacts|starknetView|starknetLine/.test(src)) continue;
    if (rel === "src/app/docs/starknet/starknetDocs.ts") continue;
    ok(/STARKNET_ENABLED/.test(src), `${rel}: gated by STARKNET_ENABLED`);
  }
}

// ---------------------------------------------------------------- the other run
if (MODE === "off") {
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, GLOAM_SELFTEST_STARKNET_SITE: "on" }, encoding: "utf8" });
  assert.equal(child.status, 0, `the on run failed:\n${child.stdout}\n${child.stderr}`);
  process.stdout.write(child.stdout);
}
console.log(`selftest-starknet-site (${MODE}): ok (${checks} checks)`);
