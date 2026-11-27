/**
 * End to end on a local starknet-devnet: two Gloam private accounts on the
 * Starknet privacy pool, through lib/starknetPrivacy only, with every
 * transaction sent by a relay that first passes lib/starknetPrivacy/relayPolicy.
 *
 *  1. The relay deploys both accounts (keys from a seed, the same seeds as the
 *     spike that first proved this, so the same addresses). Neither ever holds STRK.
 *  2. Each opens its account: viewing key and its own channel, one transaction.
 *  3. Alice gets 1.0 of the devnet test token (a bridge would land it on her
 *     address), approves the pool (signed by her, sent by the relay), adds it.
 *  4. Alice pays Bob 0.6, then 0.1. Bob cashes out 0.25 with a relay fee of
 *     0.01, then 0.05. Balances are checked exactly, and the relay's fee arrives.
 *  5. What each transaction shows, read from its calldata and events: the first
 *     payment names Bob (the channel it opens), the second names nobody; no cash
 *     out names Bob; Alice is named only when she registers and adds.
 *
 * Local only (not in CI). Needs:
 *  - starknet-devnet 0.10.1 on PATH (or STARKNET_DEVNET_BIN), Starknet 0.14.4 proof facts;
 *  - the pool built from starkware-libs/starknet-privacy at PRIVACY-0.14.4-RC.2
 *    (`scarb build`), its target/dev in STARKNET_POOL_ARTIFACTS.
 * Proofs are the SDK's mock (the pool contract runs for real; devnet runs with
 * --proof-mode none). The pool's screener is the SDK's test screener key.
 * Every transaction goes out through the server's own relaySend and relayChain
 * (lib/starknetPrivacy/server: the lock, the nonce read at the pre-confirmed
 * block, the estimate there with the proof's facts), and both opens go with
 * the relay's fee asked (an open owes none).
 *
 * Run from app/:
 *   STARKNET_POOL_ARTIFACTS=<repo>/target/dev ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-devnet.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Account, CallData, OutsideExecutionVersion, ec, hash, num, outsideExecution, type Call } from "starknet";
import { ScreeningCallMockProofProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import type { StarknetAccountKeys } from "../src/lib/starknetPrivacy/account";
import type { RelayContext, RelayProof } from "../src/lib/starknetPrivacy/relayPolicy";

const stub = fileURLToPath(new globalThis.URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolveFilename.call(this, req, ...rest);
};
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const PORT = Number(process.env.STARKNET_DEVNET_PORT ?? 5071);
const URL = `http://127.0.0.1:${PORT}`;

// Part 6 runs Gloam's own routes in this process, on devnet: Starknet on, devnet, before any of lib/starknetPrivacy loads.
process.env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
process.env.NEXT_PUBLIC_STARKNET_NETWORK = "devnet";
process.env.NEXT_PUBLIC_STARKNET_DEVNET_RPC = URL;
for (const k of ["STARKNET_RPC_URL", "STARKNET_PROVER_URL", "STARKSCAN_API_KEY", "VERCEL"]) delete process.env[k];
const { keysFromSeed, deployAccountCall } = await import("../src/lib/starknetPrivacy/account");
const { starknetConfig, STARKNET_ACCOUNT_CLASS_HASH } = await import("../src/lib/starknetPrivacy/config");
const { starknetProvider, discoveryFor, gloamTransfers } = await import("../src/lib/starknetPrivacy/client");
const { openAccount, add, pay, cashOut, approveCall, privateBalance } = await import("../src/lib/starknetPrivacy/actions");
const { checkRelayCall } = await import("../src/lib/starknetPrivacy/relayPolicy");
const ART = process.env.STARKNET_POOL_ARTIFACTS ?? "";
if (!ART) throw new Error("Set STARKNET_POOL_ARTIFACTS to the pool's target/dev folder.");
const TEST_SCREENER_KEY = "0xCAFEBABE"; // the SDK's test screener (ScreeningCallMockProofProvider signs with it)

const log = (...a: unknown[]) => console.log("[e2e-starknet]", ...a);
const rpc = (method: string, params: unknown = []) =>
  fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result: unknown; error?: unknown }>);
const mine = async (n: number) => {
  for (let i = 0; i < n; i++) await rpc("devnet_createBlock");
};

const devnet = spawn(
  process.env.STARKNET_DEVNET_BIN ?? "starknet-devnet",
  // STARKNET_DEVNET_BLOCK_SECONDS=2 makes blocks on a timer, as mainnet does, to time the session's moves.
  ["--lite-mode", "--seed", "42", "--block-generation-on", process.env.STARKNET_DEVNET_BLOCK_SECONDS ?? "transaction", "--state-archive-capacity", "full", "--chain-id", "SN_DEVNET", "--proof-mode", "none", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "inherit"] }
);
const stop = () => {
  if (devnet.exitCode === null) devnet.kill("SIGINT");
};
process.on("exit", stop);

async function main() {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${URL}/is_alive`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error("starknet-devnet did not start.");
    await new Promise((r) => setTimeout(r, 100));
  }
  const node = starknetProvider(URL);
  const server = await import("../src/lib/starknetPrivacy/server");
  const pre = (await rpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
  // devnet's own throwaway account (seed 42) is the relay.
  const relayKeys = { address: num.toHex(BigInt(pre[2].address)), secret: pre[2].private_key };
  const admin = new Account({ provider: node, address: pre[0].address, signer: pre[0].private_key, cairoVersion: "1" });
  const relay = new Account({ provider: node, address: pre[2].address, signer: pre[2].private_key, cairoVersion: "1" });
  eq(num.toHex(BigInt(await node.getClassHashAt(pre[0].address))), num.toHex(BigInt(STARKNET_ACCOUNT_CLASS_HASH)), "devnet's accounts use Gloam's account class");

  // The pool: governance admin, auditor key (a dummy here), screener key, proof validity 450 blocks.
  const contract = JSON.parse(readFileSync(join(ART, "privacy_Privacy.contract_class.json"), "utf8"));
  const casm = JSON.parse(readFileSync(join(ART, "privacy_Privacy.compiled_contract_class.json"), "utf8"));
  const declared = await admin.declare({ contract, casm, compiledClassHash: hash.computeCompiledClassHash(casm) });
  await node.waitForTransaction(declared.transaction_hash);
  const deployed = await admin.deployContract({
    classHash: declared.class_hash,
    constructorCalldata: [admin.address, "0x1", ec.starkCurve.getStarkKey(TEST_SCREENER_KEY), "450"],
    salt: "0x0",
  });
  const pool = num.toHex(BigInt(deployed.contract_address));
  await mine(10);

  const cfg = starknetConfig("devnet", { NEXT_PUBLIC_STARKNET_POOL: pool, NEXT_PUBLIC_STARKNET_DEVNET_RPC: URL });
  const TOKEN = cfg.tokens[0].address;
  const ONE = 10n ** 18n;
  const ctx = (minFee?: Record<string, bigint>): RelayContext => ({
    cfg,
    relay: relay.address,
    now: Math.floor(Date.now() / 1000),
    maxApprove: { [num.toHex(BigInt(TOKEN))]: 10n * ONE },
    ...(minFee ? { minFee } : {}),
  });
  log("pool", pool, "relay", relay.address);

  const seen: Record<string, { calldata: bigint[]; events: bigint[] }> = {};
  /** The relay: policy first, then send, then let 10+ blocks pass (the prover reads state 10 blocks back). */
  async function relaySend(label: string, calls: Call[], proof?: RelayProof, minFee?: Record<string, bigint>) {
    const d = checkRelayCall(calls, ctx(minFee), proof);
    assert.ok(d.ok, `${label}: relay policy refused it: ${JSON.stringify(d, big)} calls ${JSON.stringify(calls, big)}`);
    const out = await server.relaySend({
      calls,
      proof,
      cfg,
      relay: relayKeys.address,
      chain: server.relayChain(URL, relayKeys),
      env: { STARKNET_MAX_APPROVE: "10", ...(minFee ? { STARKNET_RELAY_FEE: "0.01" } : {}) },
      rate: async () => "ok",
    });
    assert.ok(out.ok, `${label}: the relay refused it: ${JSON.stringify(out, big)}`);
    const r = { transaction_hash: out.txHash };
    const receipt = await node.waitForTransaction(r.transaction_hash);
    assert.ok(receipt.isSuccess(), `${label}: ${JSON.stringify(receipt)}`);
    const tx = (await node.getTransactionByHash(r.transaction_hash)) as unknown as { calldata: string[]; sender_address: string };
    eq(num.toHex(BigInt(tx.sender_address)), num.toHex(BigInt(relay.address)), `${label}: sent by the relay`);
    const ev = (receipt as unknown as { events: { keys: string[]; data: string[] }[] }).events.flatMap((e) => [...e.keys, ...e.data]);
    seen[label] = { calldata: tx.calldata.map((x) => BigInt(x)), events: ev.map((x) => BigInt(x)) };
    await mine(12);
    return d;
  }

  async function makeAccount(seedText: string) {
    const keys = await keysFromSeed(new TextEncoder().encode(seedText), 0);
    await relaySend(`deploy ${seedText}`, [deployAccountCall(keys.publicKey)]);
    eq(num.toHex(BigInt(await node.getClassHashAt(keys.address))), num.toHex(BigInt(STARKNET_ACCOUNT_CLASS_HASH)), `${seedText}: deployed at its derived address`);
    const signerAccount = new Account({ provider: node, address: keys.address, signer: num.toHex(keys.accountKey), cairoVersion: "1" });
    const prover = new ScreeningCallMockProofProvider(node as never, cfg.chainId as never);
    const t = gloamTransfers({ cfg, keys, prover, discovery: discoveryFor(cfg, node) });
    return { keys, signerAccount, t };
  }

  const alice = await makeAccount("fake-gloam-seed-alice");
  const bob = await makeAccount("fake-gloam-seed-bob");
  eq(alice.keys.address, "0x68b843b246348a56c37e5b4f485ae3cc0df3d6f6ab80f8d89406a70780ee656", "alice's address is the spike's");

  const proofOf = (r: { callAndProof: { proof: { proofFacts: readonly string[]; data: string } } }): RelayProof => ({ proofFacts: r.callAndProof.proof.proofFacts, proof: r.callAndProof.proof.data });
  const sendProven = (label: string, r: Awaited<ReturnType<typeof add>>, minFee?: Record<string, bigint>) => relaySend(label, [r.callAndProof.call], proofOf(r), minFee);

  // With the relay's fee asked, an open still goes (it spends nothing to pay one from) and says it is an open.
  const openFee = { [num.toHex(BigInt(TOKEN))]: ONE / 100n };
  for (const [label, who] of [["alice-open", alice], ["bob-open", bob]] as const) {
    const d = await sendProven(label, await openAccount(who.t, { self: who.keys.address, tokens: [TOKEN] }), openFee);
    ok(d.ok && d.kind === "apply" && d.setup && d.fee === null, `${label}: a real open owes no fee and is counted as an open`);
  }

  // Alice's money arrives on her account (a bridge in the app), then the approve she signs, sent by the relay.
  await admin.execute({ contractAddress: TOKEN, entrypoint: "transfer", calldata: CallData.compile([alice.keys.address, num.toHex(ONE), "0x0"]) }).then((r) => node.waitForTransaction(r.transaction_hash));
  await mine(12);
  const now = Math.floor(Date.now() / 1000);
  const outside = await alice.signerAccount.getOutsideTransaction(
    { caller: relay.address, execute_after: now - 60, execute_before: now + 600 },
    [approveCall(TOKEN, pool, ONE)],
    OutsideExecutionVersion.V2
  );
  await relaySend("alice-approve", outsideExecution.buildExecuteFromOutsideCall(outside));

  await sendProven("alice-add", await add(alice.t, { token: TOKEN, self: alice.keys.address, amount: ONE }));
  await sendProven("alice-pays-bob", await pay(alice.t, { token: TOKEN, self: alice.keys.address, to: bob.keys.address, amount: (6n * ONE) / 10n }));
  await sendProven("alice-pays-bob-2", await pay(alice.t, { token: TOKEN, self: alice.keys.address, to: bob.keys.address, amount: ONE / 10n }));

  const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
  const relayBefore = await balanceOf(TOKEN, relay.address);
  const fee = { [num.toHex(BigInt(TOKEN))]: ONE / 100n };
  await sendProven("bob-cash-out", await cashOut(bob.t, { token: TOKEN, self: bob.keys.address, to: OUT, amount: ONE / 4n, fee: { recipient: relay.address, amount: ONE / 100n } }), fee);
  await sendProven("bob-cash-out-2", await cashOut(bob.t, { token: TOKEN, self: bob.keys.address, to: OUT, amount: ONE / 20n }));

  eq(await privateBalance(alice.t, TOKEN), (3n * ONE) / 10n, "alice keeps 0.3 privately");
  eq(await privateBalance(bob.t, TOKEN), (39n * ONE) / 100n, "bob keeps 0.39 privately (0.7 - 0.25 - 0.01 fee - 0.05)");
  eq(await balanceOf(TOKEN, OUT), (3n * ONE) / 10n, "the cash-out wallet got 0.3");
  eq((await balanceOf(TOKEN, relay.address)) - relayBefore, ONE / 100n, "the relay got its fee");
  eq(await balanceOf("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", alice.keys.address), 0n, "alice never held STRK");
  eq(await balanceOf("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", bob.keys.address), 0n, "bob never held STRK");

  // What each transaction put on the public record.
  const named = (label: string, k: StarknetAccountKeys) => {
    const a = BigInt(k.address);
    return seen[label].calldata.includes(a) || seen[label].events.includes(a);
  };
  const table = Object.keys(seen)
    .filter((l) => !l.startsWith("deploy"))
    .map((l) => ({ tx: l, alice: named(l, alice.keys), bob: named(l, bob.keys) }));
  console.table(table);
  ok(named("alice-add", alice.keys), "an add shows the account it went into");
  ok(named("alice-pays-bob", bob.keys) && !named("alice-pays-bob", alice.keys), "the first payment shows the payee (the channel it opens), never the payer");
  ok(!named("alice-pays-bob-2", bob.keys) && !named("alice-pays-bob-2", alice.keys), "a later payment shows neither");
  ok(!named("bob-cash-out", bob.keys) && !named("bob-cash-out-2", bob.keys), "no cash out shows the account it came from");

  await sessionThroughRoutes({ pool, relayer: pre[3], admin, token: TOKEN, one: ONE });

  log(`PASS, ${checks} checks`);
}

/* ------------------------------------------------------------------ 6. the page's session over Gloam's routes */

/**
 * The page's own code (lib/starknetPrivacy/session) against Gloam's real routes
 * (/api/starknet/rpc, /relay, /prove, served from this process on PORT + 1),
 * with blocks made on a timer as on mainnet (SESSION_BLOCK_MS, default 300) and
 * a relay fee of 0.01. Every proof the prover is asked for and every relay
 * refusal is counted, so a proof made and then refused shows. Each scenario
 * runs even when one before it failed; the failures are listed at the end.
 */
async function sessionThroughRoutes(input: { pool: string; relayer: { address: string; private_key: string }; admin: Account; token: string; one: bigint }) {
  const { pool, admin, token, one } = input;
  const env = process.env;
  env.NEXT_PUBLIC_STARKNET_POOL = pool;
  // devnet's own predeployed account and its published throwaway key, in this process only
  env.GLOAM_STARKNET_RELAYER_ADDRESS = input.relayer.address;
  env.GLOAM_STARKNET_RELAYER_SECRET = input.relayer.private_key;
  // The relay asks 0.01 a move (an open owes none). SESSION_NO_FEE=1 leaves it off, to time the
  // moves alone (the balance checks, which count the fee, then fail).
  if (env.SESSION_NO_FEE === "1") delete env.STARKNET_RELAY_FEE;
  else env.STARKNET_RELAY_FEE = "0.01";
  const routes: Record<string, Record<string, (req: Request) => Promise<Response>>> = {
    "/api/starknet/rpc": (await import("../src/app/api/starknet/rpc/route")) as never,
    "/api/starknet/relay": (await import("../src/app/api/starknet/relay/route")) as never,
    "/api/starknet/prove": (await import("../src/app/api/starknet/prove/route")) as never,
  };
  const { StarknetSession, readRelayInfo } = await import("../src/lib/starknetPrivacy/session");

  const proofs: { ok: boolean; why?: string }[] = [];
  const refused: string[] = [];
  let ip = "10.0.0.1";
  /** The next RPC call of this method answers "busy" (a node or proxy hiccup). */
  let failNext: string | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const url = `http://127.0.0.1:${PORT + 1}${req.url ?? "/"}`;
      const path = new globalThis.URL(url).pathname;
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      headers.set("x-forwarded-for", ip);
      let out: Response;
      const parsed = method === "POST" && body.length ? (JSON.parse(body.toString()) as { method?: string; id?: unknown } | { method?: string; id?: unknown }[]) : null;
      const items = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
      const call = Array.isArray(parsed) ? null : parsed;
      if (path === "/api/starknet/rpc" && failNext && items.some((c) => c.method === failNext)) {
        // As the proxy answers when it is rate limited: every call in the request gets the error.
        failNext = null;
        const replies = items.map((c) => ({ jsonrpc: "2.0", id: c.id ?? null, error: { code: -32005, message: "Too many requests, rate limited" } }));
        out = Response.json(Array.isArray(parsed) ? replies : replies[0], { status: 429 });
      } else {
        const handler = routes[path]?.[method];
        out = handler ? await handler(new Request(url, { method, headers, body: method === "GET" ? undefined : body })) : new Response("not found", { status: 404 });
      }
      const text = await out.text();
      if (path === "/api/starknet/prove" && call?.method === "starknet_proveTransaction") {
        const j = JSON.parse(text) as { error?: { message?: string } };
        proofs.push(j.error ? { ok: false, why: j.error.message } : { ok: true });
      }
      if (path === "/api/starknet/relay" && method === "POST" && out.status !== 200) refused.push((JSON.parse(text) as { error?: { code?: string } }).error?.code ?? String(out.status));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(text);
    })().catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(PORT + 1, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${PORT + 1}`;
  const BLOCK_MS = Number(env.SESSION_BLOCK_MS ?? 300);
  const POLL = env.SESSION_POLL_MS ? Number(env.SESSION_POLL_MS) : BLOCK_MS < 1_000 && !env.STARKNET_DEVNET_BLOCK_SECONDS ? 150 : undefined;
  const miner = process.env.STARKNET_DEVNET_BLOCK_SECONDS ? null : setInterval(() => void rpc("devnet_createBlock").catch(() => {}), BLOCK_MS);
  const failed: string[] = [];
  const scenario = async (name: string, f: () => Promise<void>) => {
    try {
      await f();
      log(`session: ${name}: ok`);
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message.split("\n")[0]!.slice(0, 300)}`);
      log(`session: ${name}: FAILED`, (e as Error).message.split("\n")[0]!.slice(0, 300));
    }
  };
  /** A step reporter that keeps when each step started, to show where a move spends its time. */
  const timeline = (label: string) => {
    const t0 = Date.now();
    const marks: string[] = [];
    let last = -1;
    return {
      step: (at: number) => {
        if (at === last) return;
        last = at;
        marks.push(`step ${at} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      },
      done: () => log(`session: ${label} took ${((Date.now() - t0) / 1000).toFixed(1)}s (${marks.join(", ")})`),
    };
  };

  try {
    const cfg = starknetConfig("devnet", { NEXT_PUBLIC_STARKNET_POOL: pool, NEXT_PUBLIC_STARKNET_DEVNET_RPC: URL });
    const tok = cfg.tokens[0]!;
    const info = await readRelayInfo(origin);
    ok(info.on && info.funded, "session: the relay route is on and funded");
    const RUN = String(Date.now());
    const sessionFor = async (who: string) => new StarknetSession(cfg, await keysFromSeed(new TextEncoder().encode(`e2e-session-${who}-${RUN}`), 0, cfg.accountClassHash), info, origin, POLL);
    const dave = await sessionFor("dave");
    const erinKeys = await keysFromSeed(new TextEncoder().encode(`e2e-session-erin-${RUN}`), 0, cfg.accountClassHash);
    const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abce";
    const proofsOk = (from: number) => proofs.slice(from).every((p) => p.ok);

    await scenario("a new account opens (deploy, wait, register)", async () => {
      const t = timeline("open");
      await dave.ensureOpen(t.step);
      t.done();
      eq(await dave.ready(tok), true, "session: dave is open");
    });

    await scenario("a page that deployed and then reloaded opens without a failed proof", async () => {
      ip = "10.0.0.2";
      // The page before the reload: its deploy landed, then the tab went away.
      const before = new StarknetSession(cfg, erinKeys, info, origin, POLL);
      await before.confirm(await before.relay([deployAccountCall(erinKeys.publicKey, cfg.accountClassHash)]));
      const from = proofs.length;
      const after = new StarknetSession(cfg, erinKeys, info, origin, POLL);
      await after.ensureOpen(() => {});
      eq(await after.ready(tok), true, "session: erin is open");
      ok(proofsOk(from), `session: no proof failed opening erin (${JSON.stringify(proofs.slice(from))})`);
    });

    await admin.execute({ contractAddress: token, entrypoint: "transfer", calldata: CallData.compile([dave.address, num.toHex(2n * one), "0x0"]) }).then((r) => starknetProvider(URL).waitForTransaction(r.transaction_hash));
    eq(info.fee[num.toHex(BigInt(token))] ?? "0", env.SESSION_NO_FEE === "1" ? "0" : (one / 100n).toString(), "session: the relay asks 0.01 a move");

    await scenario("add 1.0 with the relay's fee", async () => {
      ip = "10.0.0.3";
      const t = timeline("add");
      await dave.add(tok, one, t.step);
      t.done();
      eq(await dave.privateBalance(tok), one - one / 100n, "session: dave holds 0.99 privately (1.0 less the 0.01 fee)");
      eq(await dave.publicBalance(tok), one, "session: 1.0 is left on dave's account");
    });

    await scenario("pay 0.3 privately", async () => {
      const t = timeline("pay");
      ok(await dave.canBePaid(erinKeys.address, tok), "session: erin can be paid");
      await dave.pay(erinKeys.address, tok, (3n * one) / 10n, t.step);
      t.done();
      eq(await dave.privateBalance(tok), (68n * one) / 100n, "session: dave keeps 0.68 (0.99 - 0.3 - 0.01)");
    });

    await scenario("the relay's fee changes while the page is open: nothing is proved for the old fee", async () => {
      env.STARKNET_RELAY_FEE = "0.02";
      const from = proofs.length;
      const r0 = refused.length;
      let said = "";
      try {
        await dave.cashOut(OUT, tok, one / 10n, () => {});
      } catch (e) {
        said = (e as Error).message;
      }
      ok(said !== "", "session: the cash out at the old fee stops");
      eq(proofs.length - from, 0, `session: no proof was made for it (relay refused: ${JSON.stringify(refused.slice(r0))})`);
      const t = timeline("cash out");
      await dave.cashOut(OUT, tok, one / 10n, t.step);
      t.done();
      eq(await dave.privateBalance(tok), (56n * one) / 100n, "session: dave keeps 0.56 (0.68 - 0.1 - the new 0.02 fee)");
      eq(await balanceOf(token, OUT), one / 10n, "session: the cash-out address got 0.1");
    });

    await scenario("payroll: three people in one proof, Gloam's fee once", async () => {
      ip = "10.0.0.4";
      const P = await import("../src/lib/starknetPrivacy/payroll");
      const S = await import("../src/lib/starknetPrivacy/payrollStore");
      const { payrollReach, starknetPayrollDeps } = await import("../src/lib/starknetPrivacy/payrollSession");
      const { relayFee } = await import("../src/lib/starknetPrivacy/session");
      const frank = await sessionFor("frank");
      const gina = await sessionFor("gina");
      await frank.ensureOpen(() => {});
      await gina.ensureOpen(() => {});
      const erin = new StarknetSession(cfg, erinKeys, info, origin, POLL);
      const never = (await keysFromSeed(new TextEncoder().encode(`e2e-session-never-${RUN}`), 0, cfg.accountClassHash)).address;
      const norm = (a: string) => P.starknetAddressText(a)!;

      const reach = await payrollReach(dave, tok, [erin.address, frank.address, gina.address, never].map(norm));
      eq(
        [reach.get(norm(erin.address)), reach.get(norm(frank.address)), reach.get(norm(gina.address)), reach.get(norm(never))],
        ["ready", "first", "first", "closed"],
        "payroll: erin was paid before, frank and gina are new, the last never opened an account"
      );
      const list = [`name,address,amount`, `Erin,${erin.address},0.05`, `Frank,${frank.address},0.06`, `Gina,${gina.address},0.07`, `Never,${never},0.01`].join("\n");
      const rows = P.checkRecipients(P.parseStarknetPayrollCsv(list, tok).rows, reach, dave.address);
      eq(rows.map((r) => r.error), [null, null, null, P.NOT_OPEN], "payroll: an account that never opened is skipped, said plainly");
      await dave.refreshRelay(tok);
      const fee = relayFee(dave.relayInfo, tok)?.amount ?? 0n;
      ok(fee > 0n, "payroll: the relay asks a fee");
      const summary = P.summarize(rows, await dave.privateBalance(tok), fee);
      eq([summary.ready, summary.proofs, summary.fees, summary.first, summary.short], [3, 1, fee, 2, 0n], "payroll: three people, about one proof, one fee, two first payments");

      const mem = new Map<string, string>();
      const store = S.payrollStore({
        key: S.payrollStoreKey("devnet", dave.address),
        cipher: await S.runCipher(dave.keys.viewingKey, dave.address),
        storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) },
      });
      const engine = (run: import("../src/lib/starknetPrivacy/payroll").PayrollRun) =>
        P.runPayroll(run, {
          ...starknetPayrollDeps(dave, tok),
          save: (x) => store.save(x),
          message: (e) => (e instanceof Error ? e.message : String(e)),
          sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2_000))),
          now: () => Date.now(),
          stopRequested: () => false,
        });
      const was = {
        dave: await dave.privateBalance(tok),
        erin: await erin.privateBalance(tok),
        frank: await frank.privateBalance(tok),
        gina: await gina.privateBalance(tok),
        relay: await balanceOf(token, input.relayer.address),
      };
      const from = proofs.length;
      const t = timeline("payroll of three");
      const out = await engine(P.newRun({ id: "e2e-1", network: "devnet", owner: dave.address, token: tok.address, rows, now: Date.now() }));
      t.done();
      eq([out.state, out.error], ["done", undefined], "payroll: the run is done");
      eq([out.proofs, BigInt(out.feesPaid)], [1, fee], "payroll: one proof sent, one fee paid");
      eq(proofs.length - from, 1, "payroll: the prover was asked for one proof for three people");
      eq(out.rows.map((r) => r.status), ["paid", "paid", "paid", "skipped"], "payroll: three paid, one skipped");
      const hash = out.rows[0]!.txHash!;
      ok(out.rows.slice(0, 3).every((r) => r.txHash === hash), "payroll: all three in one transaction");
      const c = one / 100n;
      eq(await dave.privateBalance(tok), was.dave - 18n * c - fee, "payroll: dave paid 0.18 and the fee once");
      eq([await erin.privateBalance(tok), await frank.privateBalance(tok), await gina.privateBalance(tok)], [was.erin + 5n * c, was.frank + 6n * c, was.gina + 7n * c], "payroll: each got exactly their amount");
      eq((await balanceOf(token, input.relayer.address)) - was.relay, fee, "payroll: the relay got its fee once");
      const stored = (await store.load())[0]!;
      ok(stored.id === "e2e-1" && stored.state === "done" && !P.runOpen(stored), "payroll: the sealed run reads back done");
      ok(![...mem.values()].some((v) => v.includes("Frank")), "payroll: the stored run is sealed");

      // What the transaction shows: the two new payees (the channels it opened), never dave or erin.
      const shows = async (h: string, who: string) => {
        const node = starknetProvider(URL);
        const tx = (await node.getTransactionByHash(h)) as unknown as { calldata: string[] };
        const r = (await node.getTransactionReceipt(h)) as unknown as { events: { keys: string[]; data: string[] }[] };
        const all = [...tx.calldata, ...r.events.flatMap((e) => [...e.keys, ...e.data])].map((x) => BigInt(x));
        return all.includes(BigInt(who));
      };
      eq(
        [await shows(hash, frank.address), await shows(hash, gina.address), await shows(hash, erin.address), await shows(hash, dave.address)],
        [true, true, false, false],
        "payroll: the first payments show frank and gina together, never erin or dave"
      );
      const gas = (await starknetProvider(URL).getTransactionReceipt(hash)) as unknown as { execution_resources?: { l2_gas?: number } };
      log(`session: payroll of three used ${gas.execution_resources?.l2_gas ?? "?"} L2 gas`);

      // Again, every channel open now: still one proof, and it names nobody.
      const again = P.checkRecipients(P.parseStarknetPayrollCsv(list, tok).rows, await payrollReach(dave, tok, [erin.address, frank.address, gina.address, never].map(norm)), dave.address);
      ok(again.slice(0, 3).every((r) => !r.error && !r.first), "payroll: no first payments the second time");
      const from2 = proofs.length;
      const out2 = await engine(P.newRun({ id: "e2e-2", network: "devnet", owner: dave.address, token: tok.address, rows: again, now: Date.now() }));
      eq([out2.state, out2.proofs, proofs.length - from2], ["done", 1, 1], "payroll: the second run, one proof");
      const hash2 = out2.rows[0]!.txHash!;
      eq(
        [await shows(hash2, frank.address), await shows(hash2, gina.address), await shows(hash2, erin.address), await shows(hash2, dave.address)],
        [false, false, false, false],
        "payroll: over open channels the transaction names nobody"
      );
      eq(await dave.privateBalance(tok), was.dave - 36n * c - 2n * fee, "payroll: dave paid both runs and two fees");
    });

    await scenario("claim links: make one, claim it, take one back, a payroll pays one", async () => {
      ip = "10.0.0.5";
      const P = await import("../src/lib/starknetPrivacy/payroll");
      const S = await import("../src/lib/starknetPrivacy/payrollStore");
      const SL = await import("../src/lib/starknetPrivacy/sentLinks");
      const L = await import("../src/lib/starknetPrivacy/claimLink");
      const { starknetPayrollDeps } = await import("../src/lib/starknetPrivacy/payrollSession");
      const { starknetLinkDeps, linkSession, claimInto, readLink } = await import("../src/lib/starknetPrivacy/claimSession");
      const { relayFee } = await import("../src/lib/starknetPrivacy/session");
      const C = await import("../src/lib/starknetPrivacy/claim");
      const node = starknetProvider(URL);
      // More in dave's private balance for three links.
      await dave.add(tok, (9n * one) / 10n, () => {});
      await dave.refreshRelay(tok);
      const fee = relayFee(dave.relayInfo, tok)?.amount ?? 0n;
      ok(fee > 0n, "links: the relay asks a fee");
      const erin = new StarknetSession(cfg, erinKeys, info, origin, POLL);
      const gina = await sessionFor("gina");
      const mem = new Map<string, string>();
      const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
      const sent = SL.sentLinksStore({ key: SL.sentLinksKey("devnet", dave.address), cipher: await S.runCipher(dave.keys.viewingKey, dave.address, SL.SENT_LINKS_DOMAIN), storage });
      const runs = S.payrollStore({ key: "links-runs", cipher: await S.runCipher(dave.keys.viewingKey, dave.address), storage });
      const engine = (run: import("../src/lib/starknetPrivacy/payroll").PayrollRun) =>
        P.runPayroll(run, {
          ...starknetPayrollDeps(dave, tok),
          ...starknetLinkDeps(dave, tok, sent, origin, POLL),
          save: (x) => runs.save(x),
          message: (e) => (e instanceof Error ? e.message : String(e)),
          sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2_000))),
          now: () => Date.now(),
          stopRequested: () => false,
        });
      const oneLink = (id: string, name: string, amount: bigint) =>
        P.newRun({ id, network: "devnet", owner: dave.address, token: tok.address, rows: [{ line: 1, name, address: "", amountInput: "", amount, error: null, link: true }], now: Date.now() });
      const shows = async (h: string, who: string) => {
        const tx = (await node.getTransactionByHash(h)) as unknown as { calldata: string[] };
        const r = (await node.getTransactionReceipt(h)) as unknown as { events: { keys: string[]; data: string[] }[] };
        return [...tx.calldata, ...r.events.flatMap((e) => [...e.keys, ...e.data])].map((x) => BigInt(x)).includes(BigInt(who));
      };
      const c = one / 100n;

      // 1. A link of 0.04: kept, its account opened (one proof), paid (one proof).
      const was = { dave: await dave.privateBalance(tok), erin: await erin.privateBalance(tok), relay: await balanceOf(token, input.relayer.address) };
      const from = proofs.length;
      const t = timeline("make a link");
      const made = await engine(oneLink("link-1", "Erin", 4n * c));
      t.done();
      eq([made.state, made.rows[0]!.status], ["done", "paid"], "links: the link is paid");
      eq(proofs.length - from, 2, "links: two proofs to make it (its account's open, the payment)");
      const link1 = (await sent.load()).find((l) => l.id === made.rows[0]!.link!.id)!;
      eq([link1.state, link1.address], ["paid", made.rows[0]!.address], "links: kept under Sent links, marked paid");
      const url = SL.sentLinkUrl(link1, "https://www.gloam.trade");
      const claim = L.claimFromHash(new globalThis.URL(url).hash)!;
      eq([claim.network, claim.amount], ["devnet", 4n * c], "links: the URL carries the network and the amount");
      eq(await dave.privateBalance(tok), was.dave - 4n * c - 3n * fee, "links: dave paid 0.04 and Gloam's fee three times (the proof, the link's open, its claim)");
      eq((await balanceOf(token, input.relayer.address)) - was.relay, 2n * fee, "links: the relay got two fees now (the proof and the open)");
      const a = await linkSession(cfg, info, origin, claim.secret, POLL);
      eq(BigInt(a.address), BigInt(link1.address), "links: the link's secret opens its account");
      eq(await readLink(a, tok), { open: true, balance: 4n * c + fee }, "links: it holds 0.04 and its claim's fee");
      eq([await shows(made.rows[0]!.txHash!, link1.address), await shows(made.rows[0]!.txHash!, dave.address)], [true, false], "links: paying it shows the link's account, never dave");

      // 2. Erin claims it, from her own device: one proof, she gets exactly 0.04.
      // (Each person here has an address of their own: devnet's discovery reads the pool directly, many reads a move.)
      ip = "10.0.0.6";
      const from2 = proofs.length;
      const r = await claimInto(await linkSession(cfg, info, origin, claim.secret, POLL), erin.address, tok, () => {});
      ok(r.state === "claimed" && r.amount === 4n * c, `links: claimed 0.04 (${JSON.stringify(r, big)})`);
      eq(proofs.length - from2, 1, "links: one proof to claim");
      eq(await erin.privateBalance(tok), was.erin + 4n * c, "links: erin got the whole 0.04");
      eq((await balanceOf(token, input.relayer.address)) - was.relay, 3n * fee, "links: the claim paid the relay the fee the link carried");
      eq(await readLink(a, tok), { open: true, balance: 0n }, "links: the link is empty");
      const ch = (r as { txHash: string }).txHash;
      eq([await shows(ch, erin.address), await shows(ch, link1.address), await shows(ch, dave.address)], [true, false, false], "links: the claim shows erin's account, never the link or dave");

      // 3. The same link again: empty, nothing proven.
      ip = "10.0.0.7";
      const from3 = proofs.length;
      const again = await claimInto(await linkSession(cfg, info, origin, claim.secret, POLL), gina.address, tok, () => {});
      eq([again, C.claimMessage(again)], [{ state: "empty", open: true }, C.LINK_EMPTY], "links: used once; a second claim finds it empty");
      eq(proofs.length - from3, 0, "links: and makes no proof");

      // 4. A link nobody used, taken back.
      ip = "10.0.0.8";
      const made2 = await engine(oneLink("link-2", "Nobody", 3n * c));
      const link2 = (await sent.load()).find((l) => l.id === made2.rows[0]!.link!.id)!;
      const daveBefore = await dave.privateBalance(tok);
      ip = "10.0.0.9";
      const back = await claimInto(await linkSession(cfg, info, origin, L.bytesOf(link2.secret), POLL), dave.address, tok, () => {});
      ok(back.state === "claimed" && back.amount === 3n * c, "links: taken back");
      eq(await dave.privateBalance(tok), daveBefore + 3n * c, "links: dave has the 0.03 back");

      // 5. A payroll with a link row: erin by account, Hal by link. One payment proof, one open.
      ip = "10.0.0.10";
      const rows = P.checkRecipients(
        P.parseStarknetPayrollCsv(`name,address,amount\nErin,${erin.address},0.01\nHal,,0.02`, tok, { links: true }).rows,
        new Map([[P.starknetAddressText(erin.address)!, "ready" as const]]),
        dave.address
      );
      eq(P.summarize(rows, await dave.privateBalance(tok), fee).proofs, 2, "links: the estimate says two proofs (the payment, the link's open)");
      const from5 = proofs.length;
      const pr = await engine(P.newRun({ id: "link-payroll", network: "devnet", owner: dave.address, token: tok.address, rows, now: Date.now() }));
      eq([pr.state, pr.proofs, proofs.length - from5], ["done", 1, 2], "links: one payment proof for both, and the link's open");
      eq(BigInt(pr.feesPaid), 3n * fee, "links: the run paid the fee for its proof, the link's open and its claim");
      const hal = (await sent.load()).find((l) => l.id === pr.rows[1]!.link!.id)!;
      eq([hal.name, hal.state, hal.runId], ["Hal", "paid", "link-payroll"], "links: Hal's link is under Sent links, from that run");
      ip = "10.0.0.11";
      const ginaWas = await gina.privateBalance(tok);
      const hr = await claimInto(await linkSession(cfg, info, origin, L.bytesOf(hal.secret), POLL), gina.address, tok, () => {});
      ok(hr.state === "claimed", "links: Hal's link claimed (by whoever holds it)");
      eq(await gina.privateBalance(tok), ginaWas + 2n * c, "links: 0.02 arrived whole");
      log(`session: links: ${proofs.length - from} proofs for three links (two made alone, one in a payroll), two claims and a take back`);
    });

    await scenario("a node hiccup is not 'not deployed'", async () => {
      failNext = "starknet_getClassHashAt";
      let threw = false;
      let said: boolean | null = null;
      try {
        said = await dave.deployed();
      } catch {
        threw = true;
      }
      ok(threw, `session: deployed() says it can't tell, not ${String(said)}`);
      failNext = null;
      eq(await dave.deployed(), true, "session: and reads true once the node answers");
    });

    await scenario("every proof made was used", async () => {
      ok(proofs.every((p) => p.ok), `session: every proof the prover was asked for came back (${JSON.stringify(proofs.filter((p) => !p.ok))})`);
      eq(refused.filter((c) => c !== "already_deployed"), [], "session: the relay refused nothing it was sent");
    });
    log(`session: ${proofs.length} proofs, relay refusals ${JSON.stringify(refused)}`);
  } finally {
    if (miner) clearInterval(miner);
    server.close();
  }
  assert.deepEqual(failed, [], `session scenarios failed:\n  ${failed.join("\n  ")}`);
}

let checks = 0;
function big(_k: string, v: unknown) {
  return typeof v === "bigint" ? num.toHex(v) : v;
}
function eq<T>(a: T, b: T, msg: string) {
  assert.deepEqual(a, b, msg);
  checks++;
}
function ok(c: unknown, msg: string) {
  assert.ok(c, msg);
  checks++;
}
async function balanceOf(token: string, who: string): Promise<bigint> {
  const node = starknetProvider(URL);
  const r = await node.callContract({ contractAddress: token, entrypoint: "balance_of", calldata: [who] });
  return BigInt(r[0]);
}

main()
  .then(() => {
    stop();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    stop();
    process.exit(1);
  });
