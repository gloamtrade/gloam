/**
 * Self-test: Gloam on Solana on the public site, behind
 * NEXT_PUBLIC_SOLANA_RINGS_ENABLED, and nowhere while it is off.
 *
 * Three runs of this file (the last two as child processes):
 *
 *  - off (the flag unset, as production builds it today): llms.txt, the status
 *    page's parts, the hosted MCP's networks and Glim's knowledge say nothing
 *    about Gloam on Solana, and the banner keeps its BNB Chain note and key.
 *  - on (flag "1", mainnet): each of them names Solana with the plain words of
 *    lib/solanaRings/config (the token and the amount hidden, the two private
 *    accounts and the wallet that added money visible); the status page lists
 *    the Solana relay and Solana's RPC and judges them from /api/solana/relay
 *    and /api/solana/rpc answers faked here; the hosted MCP lists Solana apart,
 *    and not for a single network.
 *  - devnet (flag "1", NEXT_PUBLIC_SOLANA_RINGS_NETWORK "devnet"): the site
 *    says "Solana devnet".
 *
 * Every run reads the source of the files that carry this copy: no sentence
 * that names Solana says or suggests that who paid whom, the sender or the
 * recipient is hidden, and none has an em dash or "happy to". And any file
 * under src/ that names Privacy Rings or /app/solana is gated by the flag, or
 * is Solana's own code.
 *
 * No network: every request fails unless it is one of the Solana answers faked
 * in the on runs. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-site.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const stubs: Record<string, string> = {
  "server-only": fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url)),
};
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return stubs[req] ?? resolveFilename.call(this, req, ...rest);
};

const MODE = process.env.GLOAM_SELFTEST_SOLANA_SITE ?? "off";
delete process.env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED;
delete process.env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.GLOAM_PARTNERS_STORE = "memory";
if (MODE === "on" || MODE === "devnet") process.env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
if (MODE === "devnet") process.env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "devnet";

const SITE = "https://www.gloam.trade";
const RELAYER = "GLoAmRe1ay111111111111111111111111111111111";

/** What the faked /api/solana/* answer: changed per case below. */
const fake = {
  relay: { ok: true, on: true, funded: true, relayer: RELAYER, network: "mainnet" } as Record<string, unknown> | null,
  lamports: 250_000_000 as number | null,
  health: { result: "ok" } as Record<string, unknown> | null,
  rpcStatus: 200,
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${SITE}/api/solana/relay`) {
    if (!fake.relay) throw new TypeError("fetch failed");
    return Response.json(fake.relay);
  }
  if (url === `${SITE}/api/solana/rpc`) {
    const call = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
    if (call.method === "getBalance") {
      assert.equal(call.params?.[0], RELAYER, "the balance read asks for the relay's own address");
      if (fake.lamports === null) throw new TypeError("fetch failed");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: fake.lamports } });
    }
    if (call.method === "getHealth") {
      if (!fake.health) throw new TypeError("fetch failed");
      return Response.json({ jsonrpc: "2.0", id: 1, ...fake.health }, { status: fake.rpcStatus });
    }
  }
  throw new TypeError(`no network in selftest-solana-site (${url})`);
}) as typeof fetch;

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};

const config = await import("../src/lib/solanaRings/config");
const { GET: llms } = await import("../src/app/llms.txt/route");
const statusChecks = await import("../src/lib/status/checks");
const { callTool, TOOLS } = await import("../src/lib/mcpRemote/tools");
const { knowledgeBlock, solanaFacts } = await import("../src/lib/telegramBot/knowledge");

const ON = MODE !== "off";
const NAME = MODE === "devnet" ? "Solana devnet" : "Solana";
ok(config.SOLANA_RINGS_ENABLED === ON, `${MODE}: the flag reads ${ON ? "on" : "off"}`);
ok(config.SOLANA_NAME === NAME, `${MODE}: the site names it ${NAME}`);

// ---------------------------------------------------------------- llms.txt

const text = await (await llms()).text();
ok(text.includes(config.RINGS_PRIVACY_NOTE) === ON, `${MODE}: llms.txt ${ON ? "carries" : "leaves out"} the Solana note`);
ok(/Privacy Rings|\/app\/solana/.test(text) === ON, `${MODE}: llms.txt ${ON ? "names" : "never names"} Gloam on Solana`);
if (ON) {
  ok(text.includes(`Gloam is on ${NAME} too, through Helius Privacy Rings, in the app at ${SITE}/app/solana.`), `${MODE}: llms.txt links the Solana app`);
  ok(text.includes("The SDK (@gloamtrade/sdk/solana) and the local MCP server (@gloamtrade/mcp, gloam_solana_* tools) cover it; the hosted MCP server only lists it."), `${MODE}: llms.txt says the SDK and the local MCP server cover Solana, the hosted one only lists it`);
  // the summary line, which says amounts and payees stay hidden, never names Solana
  const summary = text.split("\n").find((l) => l.startsWith("> "))!;
  ok(!/Solana/.test(summary), `${MODE}: the summary that says payees are hidden leaves Solana out`);
}

// ---------------------------------------------------------------- the status page

const parts = statusChecks.statusParts();
const solParts = parts.filter((p) => p.id === statusChecks.SOLANA_RELAY_PART || p.id === statusChecks.SOLANA_NETWORK_PART);
ok(solParts.length === (ON ? 2 : 0), `${MODE}: the status page lists ${ON ? "the Solana relay and Solana" : "nothing on Solana"}`);
if (ON) {
  const relay = parts.find((p) => p.id === statusChecks.SOLANA_RELAY_PART)!;
  const net = parts.find((p) => p.id === statusChecks.SOLANA_NETWORK_PART)!;
  ok(relay.group === "payments" && relay.name === `Relay on ${NAME}`, `${MODE}: "Relay on ${NAME}" sits with the other relays`);
  ok(net.group === "networks" && net.name === NAME && net.chainId === undefined, `${MODE}: "${NAME}" sits with the networks, with no chain id`);
  // in the app menu's order: right after Base on mainnet, last in its group on devnet
  const ids = parts.map((p) => p.id);
  const before = (g: string, id: string) => parts.filter((p) => p.group === g)[parts.filter((p) => p.group === g).findIndex((p) => p.id === id) - 1];
  if (NAME === "Solana") {
    ok(before("payments", relay.id)?.name === "Relay on Base" && before("networks", net.id)?.name === "Base", `${MODE}: each comes right after Base in its group`);
  } else {
    const lastOf = (g: string, except: string) => Math.max(...parts.filter((p) => p.group === g && p.id !== except).map((p) => ids.indexOf(p.id)));
    ok(ids.indexOf(relay.id) > lastOf("payments", relay.id) && ids.indexOf(net.id) > lastOf("networks", net.id), `${MODE}: each comes last in its group`);
  }

  const run = async () => {
    const s = await statusChecks.runStatusChecks();
    return { relay: s.parts.find((p) => p.id === relay.id)!, net: s.parts.find((p) => p.id === net.id)! };
  };
  let r = await run();
  ok(r.relay.status === "operational" && r.relay.detail === "Gas 0.25 SOL", `${MODE}: a funded relay is operational, with its SOL`);
  ok(r.net.status === "operational" && r.net.reason === null, `${MODE}: a healthy RPC is operational`);

  fake.lamports = 60_000_000;
  r = await run();
  ok(r.relay.status === "degraded" && r.relay.reason === "Low on SOL for fees." && r.relay.detail === "Gas 0.06 SOL", `${MODE}: under ten times its line, low`);

  fake.relay = { ...fake.relay!, funded: false };
  fake.lamports = 4_000_000;
  r = await run();
  ok(r.relay.status === "down" && r.relay.reason === "Out of SOL for fees: paused until it is topped up.", `${MODE}: unfunded and nearly empty, down`);
  fake.lamports = 900_000_000;
  r = await run();
  ok(r.relay.status === "down" && r.relay.reason === "Paused: it could not read its own balance.", `${MODE}: unfunded with SOL in it, it says its read failed`);
  fake.lamports = null;
  r = await run();
  ok(r.relay.status === "down" && r.relay.reason === "Paused: it reports too little SOL for fees." && r.relay.detail === null, `${MODE}: unfunded, balance unread`);

  fake.relay = { ok: true, on: false, funded: false, relayer: null, network: "mainnet" };
  r = await run();
  ok(r.relay.status === "down" && r.relay.reason === "Paused.", `${MODE}: a relay that is not on is paused`);
  fake.relay = null;
  r = await run();
  ok(r.relay.status === "down" && r.relay.reason === "The relay did not answer.", `${MODE}: no answer, down`);

  fake.health = { error: { code: -32005, message: "Node is behind by 120 slots" } };
  r = await run();
  ok(r.net.status === "degraded" && r.net.reason === "The RPC is behind the chain.", `${MODE}: a node that is behind, degraded`);
  ok(!JSON.stringify(r.net).includes("120 slots"), `${MODE}: the RPC's own words never reach the page`);
  fake.health = { error: "off" };
  fake.rpcStatus = 404;
  r = await run();
  ok(r.net.status === "down" && r.net.reason === "The RPC answered 404.", `${MODE}: the proxy switched off, down`);
  fake.health = null;
  r = await run();
  ok(r.net.status === "down" && r.net.reason === "The RPC did not answer.", `${MODE}: no answer, down`);
}

// pure verdicts, every run
ok(statusChecks.judgeSolanaRelay({ api: { ms: 5_000, on: true, funded: true }, lamports: 10n ** 9n }).status === "degraded", `${MODE}: a slow relay answer is degraded`);
ok(statusChecks.judgeSolanaNetwork({ ms: 80, httpStatus: 429, health: null }).reason === "Busy: it asked us to slow down.", `${MODE}: a rate-limited RPC is busy`);
ok(statusChecks.solanaHealthOf({ error: { code: -32601 } }) === "error" && statusChecks.solanaHealthOf({ result: "ok" }) === "ok" && statusChecks.solanaHealthOf(null) === null, `${MODE}: getHealth answers read right`);

// ---------------------------------------------------------------- the hosted MCP

const ctx = { origin: SITE, ip: "127.0.0.1" };
const all = JSON.parse(((await callTool("gloam_networks", {}, ctx)).content[0] as { text: string }).text) as Record<string, unknown>;
ok(("solana" in all) === ON, `${MODE}: the hosted MCP's networks ${ON ? "list" : "leave out"} Solana`);
ok(/Privacy Rings/.test(JSON.stringify(TOOLS)) === ON, `${MODE}: the tool's description ${ON ? "says" : "never says"} so`);
if (ON) {
  const sol = all.solana as { name: string; privacy: string; app: string; assets: { symbol: string }[] };
  ok(sol.name === NAME && sol.privacy === config.RINGS_PRIVACY_NOTE && sol.app === `${SITE}/app/solana`, `${MODE}: with the plain note and the app link`);
  ok(sol.assets.map((a) => a.symbol).join() === config.ringsAssets().map((a) => a.symbol).join(), `${MODE}: and the assets Add lists`);
  const one = JSON.parse(((await callTool("gloam_networks", { network: "base-mainnet" }, ctx)).content[0] as { text: string }).text) as Record<string, unknown>;
  ok(!("solana" in one), `${MODE}: not when one network is asked for`);
}

// ---------------------------------------------------------------- Glim

const glim = knowledgeBlock();
ok((solanaFacts() !== null) === ON && glim.includes(config.RINGS_PRIVACY_NOTE) === ON, `${MODE}: Glim ${ON ? "knows" : "says nothing about"} Gloam on Solana`);
if (ON) ok(glim.includes("Never say or suggest that Gloam on Solana hides who paid whom, the sender or the recipient."), `${MODE}: and is told never to say it hides who paid whom`);
if (ON) ok(glim.includes("the local MCP server (@gloamtrade/mcp 0.11.0 or later, the gloam_solana_* tools with GLOAM_AGENT_SOLANA_KEY) cover Solana") && glim.includes("The hosted MCP server only lists it.") && !/MCP servers do not cover/.test(glim), `${MODE}: Glim says the SDK and the local MCP server cover Solana, the hosted one only lists it`);

// ---------------------------------------------------------------- the banner (source)

const banner = readFileSync(new URL("../src/components/AnnouncementBanner.tsx", import.meta.url), "utf8");
ok(banner.includes('"gloam:announce-dismissed:solana-live-v1"') && banner.includes('"gloam:announce-dismissed:bnb-live-v1"'), "the Solana note has its own dismiss key, and the BNB Chain one keeps its own");
ok(/SOLANA_RINGS_ENABLED \? "solana" : BNB_ENABLED \? "bnb" : null/.test(banner), "Solana's note shows while it is on, else BNB Chain's as before");
ok(banner.includes("Private payments. The token and the amount stay hidden.") && banner.includes('href="/app/solana"'), "the Solana note's words and link");

// ---------------------------------------------------------------- who makes the proof (source)

// On Solana Helius's prover makes the proof: the landing's Solana line and the compare page say so,
// and the compare page's "on your device" claims are scoped to the vault while Solana is on.
const landing = readFileSync(new URL("../src/components/Landing.tsx", import.meta.url), "utf8");
ok(/SOLANA_RINGS_ENABLED \? ` Also on \$\{SOLANA_NAME\}: the token and the amount stay hidden, and Helius's prover makes the proof, not your device\.`/.test(landing), "the landing's Solana line says Helius's prover makes the proof");
ok(landing.includes("Some services, like Helius Privacy, make your proof on their server."), "the landing's EVM line is unchanged");
const compare = readFileSync(new URL("../src/app/docs/compare/page.tsx", import.meta.url), "utf8");
ok(/<h3 id="solana">Gloam on \{SOLANA_NAME\}<\/h3>/.test(compare) && compare.includes("{RINGS_PRIVACY_NOTE} The proof is made by Helius&apos;s") && compare.includes("prover, in an attested enclave, not on your device."), "the compare page's Solana note: Privacy Rings, the plain note, Helius's prover");
ok(compare.includes('SOLANA_RINGS_ENABLED ? "on your device; on Solana, by Helius\'s prover" : "on your device"'), "the compare page's glance scopes 'on your device' while Solana is on");

// ---------------------------------------------------------------- the copy (source)

const FILES = [
  "src/lib/solanaRings/config.ts",
  "src/components/AnnouncementBanner.tsx",
  "src/components/Landing.tsx",
  "src/components/Footer.tsx",
  "src/app/docs/chain/page.tsx",
  "src/app/docs/page.tsx",
  "src/app/docs/privacy-model/page.tsx",
  "src/app/docs/compare/page.tsx",
  "src/app/llms.txt/route.ts",
  "src/lib/status/checks.ts",
  "src/lib/mcpRemote/tools.ts",
  "src/lib/telegramBot/knowledge.ts",
];
/** A sentence that says who, the sender, the recipient or the payee is hidden or private. */
const HIDES_WHO = /\b(hide|hides|hidden|hiding|private|unlinkab\w*)\b[^.]*\b(who paid|whom|sender|recipient|payee|counterpart\w*)\b|\b(who paid|whom|sender|recipient|payee|counterpart\w*)\b[^.]*\b(hidden|private|unlinkab\w*)\b/i;
for (const f of FILES) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const line of src.split("\n").filter((l) => /Solana|SOLANA_NAME|RINGS_/.test(l))) {
    ok(!line.includes("—") && !/happy to/i.test(line), `${f}: no em dash or "happy to": ${line.trim().slice(0, 80)}`);
    for (const sentence of line.split(/(?<=\.)\s+/)) {
      if (/Never say or suggest/.test(sentence)) continue;
      ok(!(/Solana|SOLANA_NAME/.test(sentence) && HIDES_WHO.test(sentence)), `${f}: a Solana sentence never says who is hidden: ${sentence.trim().slice(0, 100)}`);
    }
  }
}
for (const note of [config.RINGS_PRIVACY_NOTE, config.RINGS_PAYROLL_NOTE]) ok(!HIDES_WHO.test(note), "the shared notes never say who is hidden");

// A file under src/ whose code (not its comments) names Privacy Rings or /app/solana is gated by the
// flag, or is Solana's own code: lib/solanaRings, or a Solana screen only the gated /app/solana page renders.
const APP = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(p);
  }
  return out;
};
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const ungated: string[] = [];
for (const file of walk(join(APP, "src"))) {
  const rel = file.slice(APP.length).replace(/^\/+/, "");
  if (rel.startsWith("src/lib/solanaRings/") || /^src\/components\/app\/Solana\w*\.tsx$/.test(rel)) continue;
  const body = codeOf(readFileSync(file, "utf8"));
  if (/Privacy Rings|\/app\/solana/.test(body) && !/\bSOLANA_RINGS_ENABLED\b/.test(body)) ungated.push(rel);
}
ok(ungated.length === 0, `Solana copy with no gate: ${ungated.join(", ")}`);

if (MODE === "off") {
  for (const mode of ["on", "devnet"]) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, GLOAM_SELFTEST_SOLANA_SITE: mode },
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
console.log(`selftest-solana-site (${MODE}): ok (${checks} checks)`);
