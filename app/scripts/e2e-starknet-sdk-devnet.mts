/**
 * End to end on a local starknet-devnet: @gloamtrade/sdk/starknet, as a server
 * or an agent uses it, against Gloam's real routes (/api/starknet/rpc, relay,
 * prove, served from this process) and the Starknet privacy pool built from
 * starkware-libs/starknet-privacy at PRIVACY-0.14.4-RC.2. Only the SDK's public
 * functions and a base URL: no app session, no Next.
 *
 *  1. Off: with NEXT_PUBLIC_STARKNET_ENABLED unset (a child process serving the
 *     same routes), the relay says it is off and every move throws
 *     StarknetOffError before anything is proven or sent.
 *  2. On, with the relay asking 0.01 a move: three accounts open (one from a
 *     viem wallet, the same account the app opens for that wallet), Alice adds
 *     1.0 from her account's address, pays Bob twice (the first payment shows
 *     Bob's account, the second shows nobody), pays Bob and Carol in one proof,
 *     Bob cashes out; every balance and the relay's fees exact.
 *  3. Typed errors, each before a proof: too little private balance, a payee
 *     with no account, a fee that changed and a fee above maxFee, an add above
 *     what sits at the address; the relay's day of opens used is StarknetBusyError.
 *  4. Claim links: one is kept before anything is paid, claims once into Bob
 *     for exactly its amount, reads empty after; another is taken back.
 *
 * Proofs are the SDK's mock (devnet runs with --proof-mode none); the pool's
 * screener is the SDK's test screener key. Every proof the prover is asked for
 * is counted, so a check that says "before a proof" is checked.
 *
 * Local only. Run from app/:
 *   STARKNET_DEVNET_BIN=<starknet-devnet 0.10.1> STARKNET_POOL_ARTIFACTS=<repo>/target/dev \
 *     ../mcp/node_modules/.bin/tsx scripts/e2e-starknet-sdk-devnet.mts
 * Ports: STARKNET_DEVNET_PORT (default 5151) for devnet, the next two for the routes.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new globalThis.URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolveFilename = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolveFilename.call(this, req, ...rest);
};
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
for (const k of ["STARKNET_RPC_URL", "STARKNET_PROVER_URL", "STARKSCAN_API_KEY", "VERCEL", "STARKNET_OPENS_PER_DAY", "STARKNET_APPLIES_PER_DAY"]) delete process.env[k];

const MODE = process.env.GLOAM_E2E_SN_SDK_MODE ?? "on";
const PORT = Number(process.env.STARKNET_DEVNET_PORT ?? 5151);
const NODE = `http://127.0.0.1:${PORT}`;
const log = (...a: unknown[]) => console.log("[e2e-starknet-sdk]", ...a);

let checks = 0;
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  checks++;
};
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  checks++;
};

/** Gloam's routes from this process on `port`; every proof asked for is counted. */
async function serveRoutes(port: number, proofs: { ok: boolean; why?: string }[], ipFor: () => string) {
  const routes: Record<string, Record<string, (req: Request) => Promise<Response>>> = {
    "/api/starknet/rpc": (await import("../src/app/api/starknet/rpc/route")) as never,
    "/api/starknet/relay": (await import("../src/app/api/starknet/relay/route")) as never,
    "/api/starknet/prove": (await import("../src/app/api/starknet/prove/route")) as never,
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const url = `http://127.0.0.1:${port}${req.url ?? "/"}`;
      const path = new globalThis.URL(url).pathname;
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      headers.set("x-forwarded-for", ipFor());
      const handler = routes[path]?.[method];
      const out = handler ? await handler(new Request(url, { method, headers, body: method === "GET" ? undefined : body })) : new Response("not found", { status: 404 });
      const text = await out.text();
      if (path === "/api/starknet/prove" && method === "POST" && body.length) {
        const call = JSON.parse(body.toString()) as { method?: string };
        if (call.method === "starknet_proveTransaction") {
          let j: { error?: { message?: string } } = {};
          try {
            j = JSON.parse(text);
          } catch {
            j = { error: { message: text.slice(0, 80) } };
          }
          proofs.push(j.error || out.status !== 200 ? { ok: false, why: j.error?.message ?? String(out.status) } : { ok: true });
        }
      }
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(text);
    })().catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  return server;
}

// ------------------------------------------------------------------ 1. off (a child process)

if (MODE === "off") {
  delete process.env.NEXT_PUBLIC_STARKNET_ENABLED;
  process.env.NEXT_PUBLIC_STARKNET_NETWORK = "devnet";
  const sn = await import("@gloamtrade/sdk/starknet");
  const proofs: { ok: boolean }[] = [];
  const port = PORT + 2;
  const server = await serveRoutes(port, proofs, () => "10.9.0.1");
  const opts = { network: "devnet" as const, baseUrl: `http://127.0.0.1:${port}`, pollMs: 100 };
  try {
    const st = await sn.starknetRelayStatus(opts);
    ok(st.reachable && !st.on, "off: the relay answers and says it is off");
    const a = await sn.openStarknetAccount({ ...opts, seed: new TextEncoder().encode("e2e-sdk-off-account-0001") });
    ok(sn.isStarknetAddress(a.address), "off: an account still opens offline (its address is known)");
    const off = (e: unknown) => e instanceof sn.StarknetOffError;
    await assert.rejects(sn.registerStarknetAccount(a), off, "off: register");
    await assert.rejects(sn.addToStarknetPrivate(a, { amount: 1n }), off, "off: add");
    await assert.rejects(sn.payStarknetPrivately(a, { to: "0x1234", amount: 1n }), off, "off: pay");
    await assert.rejects(sn.payStarknetMany(a, { payments: [{ to: "0x1234", amount: 1n }] }), off, "off: pay many");
    await assert.rejects(sn.cashOutStarknet(a, { to: "0x1234", amount: 1n }), off, "off: cash out");
    await assert.rejects(sn.makeStarknetClaimLink(a, { amount: 1n, keep: () => {} }), off, "off: make a link");
    checks += 6;
    eq(proofs.length, 0, "off: nothing was proven");
    // The routes themselves, as any client meets them.
    const relay = await fetch(`${opts.baseUrl}/api/starknet/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    eq([relay.status, ((await relay.json()) as { error?: { code?: string } }).error?.code], [404, "off"], "off: the relay route refuses with 404 off");
  } finally {
    server.close();
  }
  console.log(`OFF_PASS ${checks}`);
  process.exit(0);
}

// ------------------------------------------------------------------ 2 to 4. on, against a devnet

{
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, GLOAM_E2E_SN_SDK_MODE: "off" }, encoding: "utf8" });
  const passed = /OFF_PASS (\d+)/.exec(child.stdout ?? "");
  assert.ok(child.status === 0 && passed, `the off run failed:\n${child.stdout}\n${child.stderr}`);
  checks += Number(passed[1]);
  log(`off: ok (${passed[1]} checks)`);
}

process.env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
process.env.NEXT_PUBLIC_STARKNET_NETWORK = "devnet";
process.env.NEXT_PUBLIC_STARKNET_DEVNET_RPC = NODE;
const ART = process.env.STARKNET_POOL_ARTIFACTS ?? "";
if (!ART) throw new Error("Set STARKNET_POOL_ARTIFACTS to the pool's target/dev folder.");
const TEST_SCREENER_KEY = "0xCAFEBABE"; // the privacy SDK's test screener (its mock prover signs with it)

const { Account, CallData, ec, hash, num, RpcProvider } = await import("starknet");
const { privateKeyToAccount } = await import("viem/accounts");
const sn = await import("@gloamtrade/sdk/starknet");
const appAccount = await import("../src/lib/starknetPrivacy/account");

const rpc = (method: string, params: unknown = []) =>
  fetch(NODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result: unknown }>);

const devnet = spawn(
  process.env.STARKNET_DEVNET_BIN ?? "starknet-devnet",
  ["--lite-mode", "--seed", "42", "--block-generation-on", "transaction", "--state-archive-capacity", "full", "--chain-id", "SN_DEVNET", "--proof-mode", "none", "--port", String(PORT)],
  { stdio: ["ignore", "ignore", "inherit"] }
);
const stop = () => {
  if (devnet.exitCode === null) devnet.kill("SIGINT");
};
process.on("exit", stop);

async function main() {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${NODE}/is_alive`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error("starknet-devnet did not start.");
    await new Promise((r) => setTimeout(r, 100));
  }
  const node = new RpcProvider({ nodeUrl: NODE, batch: 0 });
  const pre = (await rpc("devnet_getPredeployedAccounts")).result as { address: string; private_key: string }[];
  const admin = new Account({ provider: node, address: pre[0]!.address, signer: pre[0]!.private_key, cairoVersion: "1" });

  // The pool: governance admin, auditor key (a dummy here), screener key, proof validity 450 blocks.
  const contract = JSON.parse(readFileSync(join(ART, "privacy_Privacy.contract_class.json"), "utf8"));
  const casm = JSON.parse(readFileSync(join(ART, "privacy_Privacy.compiled_contract_class.json"), "utf8"));
  const declared = await admin.declare({ contract, casm, compiledClassHash: hash.computeCompiledClassHash(casm) });
  await node.waitForTransaction(declared.transaction_hash);
  const deployed = await admin.deployContract({ classHash: declared.class_hash, constructorCalldata: [admin.address, "0x1", ec.starkCurve.getStarkKey(TEST_SCREENER_KEY), "450"], salt: "0x0" });
  const pool = num.toHex(BigInt(deployed.contract_address));
  for (let i = 0; i < 10; i++) await rpc("devnet_createBlock");

  // Gloam's relay is devnet's predeployed account 3 (its published throwaway key, this process only).
  const env = process.env;
  env.NEXT_PUBLIC_STARKNET_POOL = pool;
  env.GLOAM_STARKNET_RELAYER_ADDRESS = pre[3]!.address;
  env.GLOAM_STARKNET_RELAYER_SECRET = pre[3]!.private_key;
  env.STARKNET_RELAY_FEE = "0.01";
  const relayer = num.toHex(BigInt(pre[3]!.address));

  const proofs: { ok: boolean; why?: string }[] = [];
  let ip = "10.8.0.1";
  const port = PORT + 1;
  const server = await serveRoutes(port, proofs, () => ip);
  const miner = setInterval(() => void rpc("devnet_createBlock").catch(() => {}), 250);
  const opts = { network: "devnet" as const, baseUrl: `http://127.0.0.1:${port}`, pollMs: 120 };
  const TOKEN = sn.STARKNET_DEVNET_TEST_TOKEN;
  const ONE = 10n ** 18n;
  const C = ONE / 100n; // 0.01, the relay's fee
  const balanceOf = async (who: string) => BigInt((await node.callContract({ contractAddress: TOKEN, entrypoint: "balance_of", calldata: [who] }))[0]!);
  const names = async (txHash: string, who: string) => {
    const tx = (await node.getTransactionByHash(txHash)) as unknown as { calldata: string[] };
    const r = (await node.getTransactionReceipt(txHash)) as unknown as { events: { keys: string[]; data: string[] }[] };
    return [...tx.calldata, ...r.events.flatMap((e) => [...e.keys, ...e.data])].map((x) => BigInt(x)).includes(BigInt(who));
  };
  const priv = async (a: import("@gloamtrade/sdk/starknet").GloamStarknetAccount) => (await sn.starknetBalances(a)).test!.private;
  const noProofSince = (from: number, what: string) => eq(proofs.length - from, 0, `${what}: no proof was made`);

  try {
    const st = await sn.starknetRelayStatus(opts);
    ok(st.on && st.funded && st.moves === "on" && st.network === "devnet" && sn.sameStarknetAddress(st.pool!, pool), "on: the relay is on, funded, sends moves, names the pool");
    eq(sn.starknetRelayFee(st, { address: TOKEN }), C, "on: the relay asks 0.01 a move");

    const RUN = String(Date.now());
    const alice = await sn.openStarknetAccount({ ...opts, seed: new TextEncoder().encode(`e2e-sdk-alice-${RUN}`) });
    const bob = await sn.openStarknetAccount({ ...opts, seed: new TextEncoder().encode(`e2e-sdk-bob-${RUN}`) });
    // Carol is an agent with an EVM key: the SDK opens the account the app opens for that wallet.
    const carolKey = privateKeyToAccount(`0x${"22".repeat(31)}${RUN.slice(-2).padStart(2, "0")}`);
    const carol = await sn.openStarknetAccount({ ...opts, wallet: sn.starknetViemWallet(carolKey) });
    const appSeed = await appAccount.seedFromWallet((m) => carolKey.signMessage({ message: m }), 0, async () => true);
    eq(carol.address, (await appAccount.keysFromSeed(appSeed, 0)).address, "on: a viem wallet opens the account the app opens for it");

    for (const [name, a] of [["alice", alice], ["bob", bob], ["carol", carol]] as const) {
      ip = `10.8.1.${name.length}`;
      eq(await sn.isStarknetAccountOpen(a), false, `${name}: not open before`);
      const r = await sn.registerStarknetAccount(a);
      ok(!r.alreadyOpen && r.deployTx && r.openTx, `${name}: deployed and opened by the relay`);
      eq(await sn.isStarknetAccountOpen(a), true, `${name}: open`);
    }
    eq((await sn.registerStarknetAccount(alice)).alreadyOpen, true, "on: registering again does nothing");
    eq(await balanceOf(alice.address) === 0n && (await node.callContract({ contractAddress: sn.STARKNET_STRK, entrypoint: "balance_of", calldata: [alice.address] }))[0] === "0x0", true, "on: alice holds no STRK and no token yet");

    // Money arrives at Alice's account address (a wallet or a bridge sends it there).
    await admin.execute({ contractAddress: TOKEN, entrypoint: "transfer", calldata: CallData.compile([alice.address, num.toHex(2n * ONE), "0x0"]) }).then((r) => node.waitForTransaction(r.transaction_hash));
    eq(await sn.starknetBalances(alice), { test: { private: 0n, public: 2n * ONE } }, "on: 2.0 waits at alice's address");

    ip = "10.8.2.1";
    let from = proofs.length;
    await assert.rejects(sn.addToStarknetPrivate(alice, { amount: 3n * ONE }), (e) => e instanceof sn.StarknetInsufficientError && e.have === 2n * ONE && e.need === 3n * ONE, "an add above what sits at the address");
    checks++;
    noProofSince(from, "too much to add");
    const relayBefore = await balanceOf(relayer);
    const added = await sn.addToStarknetPrivate(alice, { amount: ONE });
    ok(added.fee === C && added.txHash && added.explorer === null, "add: paid the relay 0.01 (no explorer on a devnet)");
    eq(await sn.starknetBalances(alice), { test: { private: ONE - C, public: ONE } }, "add: 0.99 private, 1.0 left at the address");
    ok(await names(added.txHash, alice.address), "add: shows the account it went into");

    from = proofs.length;
    await assert.rejects(sn.cashOutStarknet(alice, { to: relayer, amount: 5n * ONE }), (e) => e instanceof sn.StarknetInsufficientError && e.have === ONE - C && e.need === 5n * ONE + C, "a cash out above the private balance");
    const never = (await sn.starknetAccountKeys(new TextEncoder().encode(`e2e-sdk-never-${RUN}`), 0)).address;
    eq(await sn.starknetPayeeState(alice, never), "closed", "a never-opened address reads closed");
    await assert.rejects(sn.payStarknetPrivately(alice, { to: never, amount: C }), (e) => e instanceof sn.StarknetError && e.code === "payee_not_open", "paying an address with no account");
    await assert.rejects(sn.cashOutStarknet(alice, { to: relayer, amount: C, maxFee: C / 2n }), (e) => e instanceof sn.StarknetFeeChangedError && e.fee === C, "a fee above maxFee");
    checks += 3;
    noProofSince(from, "the refusals");

    ip = "10.8.3.1";
    eq(await sn.starknetPayeeState(alice, bob.address), "first", "bob: a first payment");
    const p1 = await sn.payStarknetPrivately(alice, { to: bob.address, amount: (3n * ONE) / 10n });
    eq(p1.firstPayment, true, "pay: the first payment says it shows bob's account");
    ok((await names(p1.txHash, bob.address)) && !(await names(p1.txHash, alice.address)), "pay: the first payment names bob, never alice");
    eq(await sn.starknetPayeeState(alice, bob.address), "ready", "bob: a channel is open now");
    const p2 = await sn.payStarknetPrivately(alice, { to: bob.address, amount: ONE / 10n });
    eq(p2.firstPayment, false, "pay: the second is over the open channel");
    ok(!(await names(p2.txHash, bob.address)) && !(await names(p2.txHash, alice.address)), "pay: the second names neither");
    eq([await priv(alice), await priv(bob)], [ONE - C - (4n * ONE) / 10n - 2n * C, (4n * ONE) / 10n], "pay: alice 0.57, bob 0.4");

    ip = "10.8.4.1";
    from = proofs.length;
    const many = await sn.payStarknetMany(alice, { payments: [{ to: bob.address, amount: 5n * C }, { to: carol.address, amount: 6n * C }] });
    eq(proofs.length - from, 1, "pay many: two people, one proof");
    eq([many.fee, many.firstPayments], [C, [num.toHex(BigInt(carol.address))]], "pay many: one fee, carol's first payment named");
    ok((await names(many.txHash, carol.address)) && !(await names(many.txHash, bob.address)) && !(await names(many.txHash, alice.address)), "pay many: shows carol (a first payment), never bob or alice");
    eq([await priv(alice), await priv(bob), await priv(carol)], [ONE - 4n * C - (4n * ONE) / 10n - 11n * C, (4n * ONE) / 10n + 5n * C, 6n * C], "pay many: each got exactly their amount");

    ip = "10.8.5.1";
    env.STARKNET_RELAY_FEE = "0.02";
    from = proofs.length;
    await assert.rejects(sn.cashOutStarknet(bob, { to: relayer, amount: C }), (e) => e instanceof sn.StarknetFeeChangedError && e.fee === 2n * C && e.was === C, "the fee changed since bob's account read it");
    checks++;
    noProofSince(from, "a changed fee");
    const OUT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abce";
    const out = await sn.cashOutStarknet(bob, { to: OUT, amount: ONE / 10n });
    eq([out.fee, await balanceOf(OUT)], [2n * C, ONE / 10n], "cash out: at the new fee, the address got 0.1");
    ok(!(await names(out.txHash, bob.address)), "cash out: never names bob's account");
    eq(await priv(bob), (4n * ONE) / 10n + 5n * C - ONE / 10n - 2n * C, "cash out: bob keeps 0.33");
    env.STARKNET_RELAY_FEE = "0.01";

    // 4. Claim links.
    ip = "10.8.6.1";
    const kept: string[] = [];
    from = proofs.length;
    const aliceWas = await priv(alice);
    const made = await sn.makeStarknetClaimLink(alice, { amount: 4n * C, maxFee: C, keep: (l) => void kept.push(l.url) });
    eq(kept, [made.url], "link: kept before anything was paid");
    eq(proofs.length - from, 2, "link: two proofs (its open, the payment)");
    eq([made.fee, made.cost], [C, 4n * C + 3n * C], "link: three fees (this proof, the link's open, its claim)");
    eq(await priv(alice), aliceWas - made.cost, "link: alice paid the amount and three fees");
    ok(made.url.startsWith(`${opts.baseUrl}/c#sn=`), "link: gloam's /c#sn= link on this base");
    const read = await sn.readStarknetLink(made.url, opts);
    eq([read.open, read.balance, read.amount, read.network], [true, 5n * C, 4n * C, "devnet"], "link: holds 0.04 and its claim's fee");
    ok((await names(made.txHash, made.address)) && !(await names(made.txHash, alice.address)), "link: paying it shows the link's account, never alice");
    ip = "10.8.6.2";
    const bobWas = await priv(bob);
    const claimed = await sn.claimStarknetLink({ ...opts, link: made.url, to: bob.address });
    ok(claimed.state === "claimed" && claimed.amount === 4n * C, "link: claimed 0.04");
    eq(await priv(bob), bobWas + 4n * C, "link: bob got the whole 0.04");
    from = proofs.length;
    eq(await sn.claimStarknetLink({ ...opts, link: made.url, to: carol.address }), { state: "empty", open: true }, "link: a second claim finds it empty");
    noProofSince(from, "an empty link");
    ip = "10.8.6.3";
    const back = await sn.makeStarknetClaimLink(alice, { amount: 3n * C, keep: () => {} });
    const beforeBack = await priv(alice);
    const took = await sn.claimStarknetLink({ ...opts, link: back.url, to: alice.address });
    ok(took.state === "claimed" && took.amount === 3n * C, "link: taken back");
    eq(await priv(alice), beforeBack + 3n * C, "link: alice has 0.03 back");
    await assert.rejects(sn.claimStarknetLink({ ...opts, link: made.url.slice(0, -3), to: bob.address }), (e) => e instanceof sn.StarknetError && e.code === "bad_link", "a cut link is refused");
    checks++;

    // The relay's day of opens used: busy, said plainly.
    ip = "10.8.7.1";
    env.STARKNET_OPENS_PER_DAY = "1";
    const late = await sn.openStarknetAccount({ ...opts, seed: new TextEncoder().encode(`e2e-sdk-late-${RUN}`) });
    await assert.rejects(sn.registerStarknetAccount(late), (e) => e instanceof sn.StarknetBusyError && e.code === "relay_day_used", "the day's opens used: StarknetBusyError");
    checks++;
    delete env.STARKNET_OPENS_PER_DAY;

    // add 1, two pays 2, pay many 1, cash out at 0.02 2, each link's payment 2 (its proof and the link's open), each claim 1
    eq((await balanceOf(relayer)) - relayBefore, 12n * C, "the relay got every fee it asked (add, two pays, pay many, cash out, two links, two claims)");
    ok(proofs.every((p) => p.ok), `every proof asked for came back (${JSON.stringify(proofs.filter((p) => !p.ok))})`);
    log(`on: ${proofs.length} proofs`);
  } finally {
    clearInterval(miner);
    server.close();
  }
  log(`PASS, ${checks} checks`);
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
