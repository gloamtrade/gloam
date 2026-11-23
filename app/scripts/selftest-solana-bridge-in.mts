/**
 * Self-test: bringing money from another chain into a private balance on
 * Solana (lib/solanaRings/bridgeIn, arrivals, the relay policy's deposit rule,
 * /api/bridge/solana and /api/solana/relay).
 *
 *  - the relay policy: a deposit the private account signs of money at its own
 *    address passes, as "deposit", with the relay paying only the fee; refused
 *    when the relay is the depositor or named anywhere in it, with anything
 *    else in the transaction, more than one deposit, a memo, an unlisted asset,
 *    under the floor, an unsigned depositor, or the mint's setup alongside;
 *  - the relay route: such a deposit counts as a payment, not rent (the rent
 *    limit would stop the sixth), is screened, simulated and sent;
 *  - what is waiting at the account: token accounts read from their bytes,
 *    the floor, frozen and unlisted ones left out;
 *  - making it private against a fake chain that keeps a ledger: landed by
 *    signature, refused before sending, a lost relay answer that landed or
 *    didn't (told apart once the blockhash expires, by the money still being
 *    there), a failure on chain, nothing left to do, no answer at all. Money
 *    goes private once, and a retry after "nothing moved" finishes it;
 *  - the flow: arrived but not private (and tried again), refunded, failed,
 *    a tab closed and picked up again, money already waiting before a
 *    transfer, Relay's word never moving backwards;
 *  - the quote route with Relay faked: what it asks Relay for, what it refuses.
 *
 * No network. Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-solana-bridge-in.mts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Transaction,
} from "@solana/kit";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};

const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_SOLANA_RINGS_ENABLED = "1";
env.NEXT_PUBLIC_SOLANA_RINGS_NETWORK = "mainnet";
env.NEXT_PUBLIC_SOLANA_BRIDGE_IN = "1";
env.HELIUS_API_KEY = "selftest-helius-key-0000";
delete env.CHAINALYSIS_API_KEY;
delete env.RELAY_API_KEY;
delete env.BRIDGE_FEE_BPS;
// The relay's key: a throwaway made here, in this process only.
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  env.GLOAM_SOLANA_RELAYER_SECRET = getBase58Decoder().decode(new Uint8Array([...seed, ...pub]));
}

const policy = await import("../src/lib/solanaRings/relayPolicy");
const bridgeIn = await import("../src/lib/solanaRings/bridgeIn");
const arrivals = await import("../src/lib/solanaRings/arrivals");
const landing = await import("../src/lib/solanaRings/landing");
const { displayAmount } = await import("../src/lib/amountShort");
const config = await import("../src/lib/solanaRings/config");
const server = await import("../src/lib/solanaRings/server");
const ofac = (await import("../src/lib/solanaRings/ofacSolana.json", { with: { type: "json" } })).default;
const spr = await import("@heliuslabs/spr");
const sprIface = await import("@heliuslabs/spr/interface");
const { getTreeAddress, getAssociatedTokenAddress } = await import("@heliuslabs/spr/addresses");

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};

const relayer = (await server.relayerSigner())!;
ok(relayer, "the throwaway relay key loads");
await spr.initializePoseidon();
const mk = () => spr.ShieldedKeypair.fromKeypair(spr.SigningKey.fromEd25519Bytes(crypto.getRandomValues(new Uint8Array(32)) as never));
const priv = mk();
const owner = priv.toSolanaSigner();
const recipient = priv.shieldedAddress();
const assets = config.ringsAssets("mainnet");
const USDC = assets.find((a) => a.id === "usdc")!;
const USDT = assets.find((a) => a.id === "usdt")!;
const SOL = assets.find((a) => a.id === "sol")!;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address; // ggignore
const usdcAccount = await getAssociatedTokenAddress(owner.address, USDC.mint as Address, TOKEN);
const lifetime = { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(7)) as never, lastValidBlockHeight: 1_000n };
const fakeClient = { tree: getTreeAddress(0), treeId: 0, getLatestBlockhash: async () => lifetime, getAccount: async () => undefined };

const encode = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));
async function signedBy(tx: Transaction, ...signers: { signTransactions: (t: never[]) => Promise<readonly Record<string, Uint8Array>[]> }[]): Promise<Uint8Array> {
  let out = tx;
  for (const s of signers) {
    const [sigs] = await s.signTransactions([out as never]);
    out = { ...out, signatures: { ...out.signatures, ...sigs } } as Transaction;
  }
  return encode(out);
}
const deposit = (o: Partial<Parameters<typeof arrivals.buildRelayedDeposit>[0]> = {}) =>
  arrivals.buildRelayedDeposit({
    client: fakeClient as never,
    feePayer: relayer.address,
    depositor: owner.address,
    recipient,
    asset: USDC,
    amount: 19_840_000n,
    tokenAccount: usdcAccount,
    ...o,
  });
const check = (w: Uint8Array) => policy.checkSponsoredTransaction(w, relayer.address);

// ---------------------------------------------------------------- the relay policy's deposit rule

let v = check(await signedBy(await deposit(), owner));
ok(v.ok && v.kind === "deposit", "a USDC deposit the private account signs, of money at its own address, passes as a deposit");
ok(v.ok && v.ataAccounts.length === 0, "it creates no token account, so the relay pays no rent");
ok(v.ok && v.accounts.includes(owner.address) && v.accounts.includes(usdcAccount) && !v.accounts.includes(relayer.address), "it screens the private account and its token account, not the relay");
{
  const tx = await deposit();
  const cfg = (decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as never) as { config?: { priorityFeeLamports?: bigint } }).config;
  ok(cfg?.priorityFeeLamports === landing.RELAY_PRIORITY_FEE_FLOOR, "it pays the relay's floor priority fee unless Helius's price is given");
  const priced = await deposit({ priorityFeeLamports: landing.priorityFeeFor(1_000_000, 200_000) });
  const pricedCfg = (decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(priced.messageBytes) as never) as { config?: { priorityFeeLamports?: bigint } }).config;
  ok(pricedCfg?.priorityFeeLamports === policy.RELAY_LIMITS.maxPriorityFeeLamports && check(await signedBy(priced, owner)).ok, "a high Helius price is capped at the relay's limit, and still passes");
  ok(getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version === 1, "version 1, as the relay takes");
}
v = check(await signedBy(await deposit({ asset: USDT, tokenAccount: await getAssociatedTokenAddress(owner.address, USDT.mint as Address, TOKEN) }), owner));
ok(v.ok && v.kind === "deposit", "USDT passes too");
v = check(await signedBy(await deposit({ asset: SOL, amount: 270_400_917n, tokenAccount: null }), owner));
ok(v.ok && v.kind === "deposit", "a SOL deposit passes");
v = check(await signedBy(await deposit({ asset: SOL, amount: policy.RELAYED_DEPOSIT_MIN.sol!, tokenAccount: null }), owner));
ok(v.ok, "exactly the floor passes");

const refuse = async (what: string, w: Uint8Array | Promise<Uint8Array>, reason?: RegExp) => {
  const r = check(await w);
  ok(!r.ok && (!reason || reason.test(r.reason)), `refused: ${what}${r.ok ? "" : ` (${r.reason})`}`);
};
await refuse("the relay as depositor", deposit({ asset: SOL, depositor: relayer.address, tokenAccount: null, amount: 5_000_000n }).then((t) => encode(t)));
await refuse(
  "the relay's own address as the token account the money comes from",
  deposit({ tokenAccount: relayer.address }).then((t) => signedBy(t, owner)),
  /relay is never part of a deposit/
);
await refuse("under the floor", deposit({ asset: SOL, amount: policy.RELAYED_DEPOSIT_MIN.sol! - 1n, tokenAccount: null }).then((t) => signedBy(t, owner)), /too small/);
await refuse("USDC under the floor", deposit({ amount: 99_999n }).then((t) => signedBy(t, owner)), /too small/);
{
  const other = { ...USDC, id: "other", mint: "So11111111111111111111111111111111111111112" };
  await refuse("an asset Gloam doesn't list", deposit({ asset: other, tokenAccount: await getAssociatedTokenAddress(owner.address, other.mint as Address, TOKEN) }).then((t) => signedBy(t, owner)), /lists/);
}

/** A deposit instruction from parts, signed into a version 1 transaction with extra instructions. */
async function custom(opts: { deposits?: number; memo?: boolean; unsignedDepositor?: boolean; extra?: Instruction[]; before?: Instruction[] }): Promise<Uint8Array> {
  const entry = {
    viewTag: new Uint8Array(32).fill(3),
    recipientOwnerHash: new Uint8Array(32).fill(4),
    amount: 5_000_000n,
    asset: sprIface.DepositAsset.sol(),
    ...(opts.memo ? { memo: Uint8Array.of(1, 2, 3) } : {}),
  };
  const ix = await sprIface.depositInstruction({ tree: getTreeAddress(0), depositor: owner.address, deposits: Array.from({ length: opts.deposits ?? 1 }, () => entry) } as never);
  // Unsigned: someone else's account as depositor, the private account signing in another slot (so the transaction itself is fully signed).
  const stranger = await generateKeyPairSigner();
  const accounts = (ix.accounts ?? []).map((a, i) =>
    opts.unsignedDepositor && i === 0
      ? { address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: owner }
      : opts.unsignedDepositor && i === 1
        ? { address: stranger.address, role: AccountRole.WRITABLE }
        : i === 1
          ? { ...a, signer: owner }
          : a
  );
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(relayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => setTransactionMessageConfig({ computeUnitLimit: 200_000, priorityFeeLamports: 10_000n }, m),
    (m) => appendTransactionMessageInstructions([...(opts.before ?? []), { ...ix, accounts } as Instruction, ...(opts.extra ?? [])], m)
  );
  return signedBy(compileTransaction(message as never) as Transaction, owner);
}
v = check(await custom({}));
ok(v.ok && v.kind === "deposit", "the same deposit built from parts passes (the rule reads the SDK's wire format)");
await refuse("two deposits in one instruction", custom({ deposits: 2 }), /one deposit/);
await refuse("a deposit with a memo", custom({ memo: true }), /one deposit, no memo/);
await refuse("a depositor that doesn't sign", custom({ unsignedDepositor: true }), /depositor must sign/);
const transact = { programAddress: policy.SHIELDED_POOL_PROGRAM as Address, data: Uint8Array.of(16, 1, 2, 3), accounts: [{ address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: owner }] } as unknown as Instruction;
await refuse("a deposit with a payment in the same transaction", custom({ extra: [transact] }), /alone/);
const ata = {
  programAddress: policy.ATA_PROGRAM as Address,
  data: Uint8Array.of(1),
  accounts: [
    { address: relayer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: usdcAccount, role: AccountRole.WRITABLE },
    { address: owner.address, role: AccountRole.READONLY },
    { address: USDC.mint as Address, role: AccountRole.READONLY },
    { address: "11111111111111111111111111111111" as Address, role: AccountRole.READONLY },
    { address: TOKEN, role: AccountRole.READONLY },
  ],
} as Instruction;
await refuse("a deposit that also creates a token account on the relay's SOL", custom({ before: [ata] }));
const setup = { programAddress: policy.SHIELDED_POOL_PROGRAM as Address, data: Uint8Array.of(7), accounts: [{ address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: owner }] } as unknown as Instruction;
await refuse("the mint's one-time setup alongside a deposit", custom({ before: [setup] }), /pool instruction/);
{
  const raw = { programAddress: policy.SHIELDED_POOL_PROGRAM as Address, data: Uint8Array.of(15, 0), accounts: [{ address: owner.address, role: AccountRole.WRITABLE_SIGNER, signer: owner }] } as unknown as Instruction;
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(relayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions([raw], m)
  );
  await refuse("a malformed deposit", signedBy(compileTransaction(message as never) as Transaction, owner), /pool instruction/);
}

// ---------------------------------------------------------------- the relay route takes it as a payment

const realFetch = globalThis.fetch;
const sent: string[] = [];
const rpcCalls: string[] = [];
function fakeHelius(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("helius")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
  rpcCalls.push(body.method);
  const reply = (result: unknown) => Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } }));
  if (body.method === "simulateTransaction") return reply({ value: { err: null, logs: [] } });
  if (body.method === "sendTransaction") {
    sent.push(String(body.params[0]));
    return reply(getBase58Decoder().decode(new Uint8Array(64).fill(sent.length)));
  }
  if (body.method === "getMultipleAccounts") return reply({ value: (body.params[0] as unknown[]).map(() => null) });
  if (body.method === "getBalance") return reply({ value: 1_000_000_000 });
  if (body.method === "getSignatureStatuses") return reply({ value: [{ err: null, confirmationStatus: "confirmed", slot: 1 }] });
  return reply(null);
}
globalThis.fetch = fakeHelius as typeof fetch;
const relayRoute = await import("../src/app/api/solana/relay/route");
const postRelay = (wire: Uint8Array, ip = "203.0.113.7") =>
  relayRoute.POST(
    new Request("http://localhost/api/solana/relay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ tx: getBase64Decoder().decode(wire) }),
    })
  );
{
  const wire = await signedBy(await deposit(), owner);
  const res = await postRelay(wire);
  const json = (await res.json()) as { ok: boolean; signature?: string };
  ok(res.status === 200 && json.ok && json.signature, "the relay route signs and sends a deposit");
  ok(rpcCalls.includes("simulateTransaction") && !rpcCalls.includes("getMultipleAccounts"), "it simulates first, and reads no token accounts (a deposit creates none)");
  const out = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(sent[0]!)));
  ok(Object.values(out.signatures).every((s) => s && s.some((b) => b !== 0)), "what went out carries both signatures");
  // Counted as a payment: the rent limit (5 a day) would refuse the sixth from one IP, the payment limit (10 a minute) the eleventh.
  let passed = 1;
  for (let i = 0; i < 12; i++) if ((await postRelay(await signedBy(await deposit({ amount: 20_000_000n + BigInt(i) }), owner))).status === 200) passed++;
  ok(passed === server.RINGS_RELAY_LIMITS.transact.perIpPerMin, `deposits count as payments: ${passed} a minute from one IP, past the rent limit of ${server.RINGS_RELAY_LIMITS.rent.perIpPerDay}`);
  const relayAsDepositor = await postRelay(encode(await deposit({ asset: SOL, depositor: relayer.address, tokenAccount: null, amount: 5_000_000n })), "203.0.113.8");
  ok(relayAsDepositor.status === 422, "the route refuses the relay as depositor before simulating");
  const screened = await (async () => {
    const bad = ofac.addresses[0] as Address;
    return postRelay(await signedBy(await deposit({ tokenAccount: bad }), owner), "203.0.113.9");
  })();
  ok(screened.status === 403, "a deposit naming an OFAC-listed Solana address is refused");
}
globalThis.fetch = realFetch;

// ---------------------------------------------------------------- what is waiting at the account

function tokenAccountBytes(mint: string, holder: string, amount: bigint, state = 1): Uint8Array {
  const b = new Uint8Array(165);
  b.set(getAddressEncoder().encode(mint as Address), 0);
  b.set(getAddressEncoder().encode(holder as Address), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  b[108] = state;
  return b;
}
{
  const t = bridgeIn.readTokenAccount(tokenAccountBytes(USDC.mint!, owner.address, 19_840_000n));
  ok(t && t.amount === 19_840_000n && !t.frozen && getBase58Decoder().decode(t.owner) === owner.address, "a token account's owner and amount read from its bytes");
  ok(bridgeIn.readTokenAccount(tokenAccountBytes(USDC.mint!, owner.address, 1n, 0)) === null, "an uninitialized one isn't read");
  ok(bridgeIn.readTokenAccount(new Uint8Array(100)) === null, "short data isn't read");
  const list = bridgeIn.arrivalsFrom(
    {
      lamports: 999_999n,
      tokens: [
        { account: "A1", mint: USDC.mint!, amount: 19_840_000n },
        { account: "A2", mint: USDT.mint!, amount: 99_999n },
        { account: "A3", mint: USDT.mint!, amount: 5_000_000n, frozen: true },
        { account: "A4", mint: "So11111111111111111111111111111111111111112", amount: 10n ** 12n },
      ],
    },
    "mainnet"
  );
  ok(list.length === 1 && list[0]!.assetId === "usdc" && list[0]!.tokenAccount === "A1", "only listed assets over the floor, not frozen, count as waiting");
  ok(bridgeIn.arrivalsFrom({ lamports: 270_400_917n, tokens: [] }, "mainnet")[0]?.amount === 270_400_917n, "SOL counts whole: all of it goes private");
  // readArrivals over a fake RPC: only token accounts this owner holds
  const fakeRpc: import("../src/lib/solanaRings/arrivals").Rpc = async <T,>(method: string): Promise<T> => {
    if (method === "getBalance") return { value: 0 } as T;
    return {
      value: [
        { pubkey: "A1", account: { data: [getBase64Decoder().decode(tokenAccountBytes(USDC.mint!, owner.address, 20_000_000n)), "base64"] } },
        { pubkey: "A9", account: { data: [getBase64Decoder().decode(tokenAccountBytes(USDC.mint!, relayer.address, 50_000_000n)), "base64"] } },
      ],
    } as T;
  };
  const read = await arrivals.readArrivals(fakeRpc, owner.address, "mainnet");
  ok(read.length === 1 && read[0]!.amount === 20_000_000n && read[0]!.tokenAccount === "A1", "readArrivals reads the account's own token accounts only");
}

// ---------------------------------------------------------------- making it private, against a fake chain

type Mode = "ok" | "refused" | "lost-after-send" | "lost-before-send" | "fails-on-chain" | "never-answers" | "dropped-once" | "dropped-twice";
function chain() {
  return {
    atAddress: 20_000_000n,
    private: 0n,
    now: 0,
    blockhashExpiresAt: 0,
    sends: 0,
    rebroadcasts: 0,
    landed: [] as string[],
    pending: null as null | { sig: string; amount: bigint; lands: boolean },
  };
}
type Chain = ReturnType<typeof chain>;
function settle(c: Chain) {
  if (!c.pending || !c.pending.lands || c.landed.includes(c.pending.sig)) return;
  if (c.atAddress < c.pending.amount) return; // spent already: Solana refuses it
  c.atAddress -= c.pending.amount;
  c.private += c.pending.amount;
  c.landed.push(c.pending.sig);
}
function deps(c: Chain, mode: Mode, opts: { landsLate?: boolean } = {}): import("../src/lib/solanaRings/arrivals").ShieldDeps {
  const clock = { sleep: async (ms: number) => void (c.now += ms), now: () => c.now };
  return {
    ...clock,
    relay: async () => ({ address: relayer.address, price: null }),
    build: async () => {
      if (c.atAddress === 0n) return null;
      c.blockhashExpiresAt = c.now + 90_000;
      return { wire: new Uint8Array([1]), blockhash: "bh", amount: c.atAddress };
    },
    send: async () => {
      const amount = c.atAddress;
      if (mode === "refused") return { ok: false, message: "Gloam's Solana relay is paused for a moment. Try again shortly.", maybeSent: false };
      if (mode === "lost-before-send") return { ok: false, message: "Gloam's relay didn't answer. Check your connection.", maybeSent: true };
      c.sends++;
      const sig = `sig${c.sends}`;
      const dropped = mode === "dropped-twice" || (mode === "dropped-once" && c.sends === 1);
      const lands = mode !== "fails-on-chain" && mode !== "never-answers" && !dropped;
      c.pending = { sig, amount, lands };
      if (lands && !opts.landsLate) settle(c);
      return mode === "lost-after-send" ? { ok: false, message: "Solana is slow to answer. Try again.", maybeSent: true } : { ok: true, signature: sig, signed: "c2lnbmVk" };
    },
    // the same wait every relayed send uses
    wait: (sent) =>
      landing.awaitLanding({
        ...clock,
        status: async () => {
          if (mode === "never-answers") throw new Error("no answer");
          if (c.pending?.sig === sent.signature && opts.landsLate && c.now > 10_000) settle(c);
          if (c.landed.includes(sent.signature)) return { seen: true, failed: false, confirmed: true, slot: 123n };
          if (mode === "fails-on-chain" && c.pending?.sig === sent.signature) return { seen: true, failed: true, confirmed: false, slot: 1n };
          return { seen: false };
        },
        blockhashValid: mode === "never-answers" ? async () => true : async () => c.now < c.blockhashExpiresAt,
        rebroadcast: async () => void c.rebroadcasts++,
      }),
    blockhashValid: async () => c.now < c.blockhashExpiresAt,
    left: async () => c.atAddress,
  };
}
{
  let c = chain();
  let r = await arrivals.settleShield(deps(c, "ok"));
  ok(r.state === "landed" && r.signature === "sig1" && r.slot === 123n && c.private === 20_000_000n && c.atAddress === 0n, "landed: read by its signature, all of it private");
  r = await arrivals.settleShield(deps(c, "ok"));
  ok(r.state === "none" && c.sends === 1, "nothing left at the address: nothing to do, nothing sent");

  c = chain();
  r = await arrivals.settleShield(deps(c, "refused"));
  ok(r.state === "notSent" && /paused/.test(r.message) && c.sends === 0 && c.atAddress === 20_000_000n, "refused before sending: nothing moved, the money stays put, the reason is said");
  r = await arrivals.settleShield(deps(c, "ok"));
  ok(r.state === "landed" && c.private === 20_000_000n, "tried again: it goes private");

  c = chain();
  r = await arrivals.settleShield(deps(c, "lost-after-send"));
  ok(r.state === "landed" && r.signature === null && c.private === 20_000_000n && c.sends === 1, "answer lost after the send: once the blockhash is past, the money gone from the address says it landed");

  c = chain();
  r = await arrivals.settleShield(deps(c, "lost-before-send"));
  ok(r.state === "notSent" && c.sends === 0 && c.atAddress === 20_000_000n && c.now >= 90_000, "answer lost and it never went out: told only after its blockhash expired, money still there");
  r = await arrivals.settleShield(deps(c, "ok"));
  ok(r.state === "landed" && c.private === 20_000_000n && c.landed.length === 1, "then a retry makes it private, once");

  c = chain();
  r = await arrivals.settleShield(deps(c, "fails-on-chain"));
  ok(r.state === "notSent" && c.atAddress === 20_000_000n && c.private === 0n && c.sends === 1, "failed on Solana: nothing moved, not sent again on its own");

  c = chain();
  r = await arrivals.settleShield(deps(c, "ok", { landsLate: true }));
  ok(r.state === "landed" && c.private === 20_000_000n && c.rebroadcasts > 0, "a confirmation that comes late is waited for, the same transaction sent again meanwhile");

  c = chain();
  r = await arrivals.settleShield(deps(c, "dropped-once"));
  ok(r.state === "landed" && r.signature === "sig2" && c.sends === 2 && c.private === 20_000_000n, "dropped for sure (expired, never seen): built and sent once more on its own, and it lands once");

  c = chain();
  r = await arrivals.settleShield(deps(c, "dropped-twice"));
  ok(r.state === "notSent" && /twice/.test(r.message) && c.sends === 2 && c.atAddress === 20_000_000n, "dropped twice: it stops and says nothing moved");

  c = chain();
  r = await arrivals.settleShield(deps(c, "never-answers"));
  ok(r.state === "unknown" && c.now >= landing.LANDING_MAX_MS && c.atAddress === 20_000_000n && c.sends === 1, "no answer at all: it says it can't tell yet rather than guess, and sends nothing new");
  r = await arrivals.settleShield(deps(c, "ok"));
  ok(r.state === "landed" && c.private === 20_000_000n && c.atAddress === 0n, "and the next try makes what is still there private, once");

  // Two shields racing for the same money (two tabs): it goes private once.
  c = chain();
  const [a, b] = await Promise.all([arrivals.settleShield(deps(c, "ok", { landsLate: true })), arrivals.settleShield(deps(c, "ok", { landsLate: true }))]);
  ok(c.private === 20_000_000n && c.atAddress === 0n && [a, b].some((x) => x.state === "landed"), "two at once: the money goes private once, never twice");
}

// ---------------------------------------------------------------- the flow

const quote: import("../src/lib/solanaRings/bridgeIn").SolanaBridgeQuote = {
  requestId: `0x${"ab".repeat(32)}`,
  depositAddress: "0x4f7c92be9f4d36b71f35b602664e2a86785ce0ec",
  evmTxs: null,
  send: { amount: "20", symbol: "USDC", chain: "Base", chainId: 8453, logo: "/brand/tokens/usdc.png", usd: 19.99 },
  receive: { amount: "19.842157", minimum: "19.445314", symbol: "USDC", assetId: "usdc", decimals: 6, logo: "/brand/tokens/usdc.png" },
  refundTo: "0x1111111111111111111111111111111111111111",
  feeUsd: 0.16,
  appFee: null,
  gasUsd: null,
  timeSec: 1,
  bitcoin: false,
};
const R = bridgeIn.flowReducer;
type F = import("../src/lib/solanaRings/bridgeIn").Flow;
const run = (s: F, ...events: Parameters<typeof R>[1][]) => events.reduce(R, s);
const tracked = bridgeIn.trackedFrom(quote, "address", Date.UTC(2026, 10, 23));
{
  let s = run(bridgeIn.FORM, { type: "quoting" }, { type: "quoteFailed", error: "That amount is too small to bridge. Try a little more." });
  ok(s.kind === "form" && s.error === "That amount is too small to bridge. Try a little more.", "a quote that fails goes back to the form and says why");

  s = run(bridgeIn.FORM, { type: "quoting" }, { type: "review", quote: { ...quote, depositAddress: "", evmTxs: [] }, at: 1 }, { type: "signing", progress: "Approve in your wallet first (1 of 2)…" }, { type: "signFailed", error: "You cancelled it in your wallet. Nothing moved." });
  ok(s.kind === "review" && !s.signing && s.error === "You cancelled it in your wallet. Nothing moved.", "a wallet that says no stays on the review with the reason");

  // The happy path: address, paid, moving, arrived, private.
  s = run(bridgeIn.FORM, { type: "quoting" }, { type: "track", t: tracked });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "waiting" && bridgeIn.watchingRelay(s) && bridgeIn.watchingArrivals(s), "an address shown: waiting, watching Relay and the account");
  s = run(s, { type: "status", stage: "moving" }, { type: "status", stage: "waiting" });
  ok(s.kind === "track" && s.relay === "moving", "Relay's word never moves backwards");
  s = run(s, { type: "status", stage: "done" });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "arrived" && !bridgeIn.watchingRelay(s), "Relay done: it stops asking Relay");
  s = run(s, { type: "arrived", amount: 19_842_157n });
  ok(s.kind === "track" && s.shield.kind === "arrived", "the money shows at the account: arrived, to be made private");
  s = run(s, { type: "shielding" });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "shielding" && !bridgeIn.watchingArrivals(s), "making it private: the account isn't read meanwhile");
  s = run(s, { type: "shielded", amount: 19_842_157n, signature: "sig" });
  ok(s.kind === "landed" && s.amount === 19_842_157n, "private: done, with what went in");

  // Arrived, not private: the relay paused. The money waits; tried again; or it goes private elsewhere.
  s = run(bridgeIn.FORM, { type: "track", t: tracked }, { type: "arrived", amount: 19_842_157n }, { type: "shielding" }, { type: "shieldFailed", message: "Gloam's Solana relay is paused for a moment. Try again shortly." });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "notPrivate" && s.shield.kind === "failed" && s.shield.amount === 19_842_157n, "arrived but not private: said so, with the reason, the amount kept");
  ok(bridgeIn.watchingArrivals(s), "it keeps an eye on the account meanwhile");
  const retried = run(s, { type: "shielding" }, { type: "shielded", amount: 19_842_157n, signature: "sig2" });
  ok(retried.kind === "landed", "tried again: private");
  const elsewhere = run(s, { type: "gone" });
  ok(elsewhere.kind === "landed" && elsewhere.amount === 19_842_157n, "gone from the account (another tab made it private): done");
  const more = run(s, { type: "arrived", amount: 25_000_000n });
  ok(more.kind === "track" && more.shield.kind === "failed" && more.shield.amount === 25_000_000n, "more arrives meanwhile: the amount waiting is updated");

  // Refunded and failed.
  s = run(bridgeIn.FORM, { type: "track", t: tracked }, { type: "status", stage: "refunded" });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "refunded" && !bridgeIn.watchingRelay(s), "refunded: said, and Relay isn't asked again");
  ok(bridgeIn.refundPlace(tracked) === "your Base address" && bridgeIn.refundPlace({ ...tracked, mode: "wallet" }) === "your wallet on Base", "it says where the money went back");
  s = run(bridgeIn.FORM, { type: "track", t: tracked }, { type: "status", stage: "failed" });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "failed", "failed: said");
  s = run(s, { type: "status", stage: "refunded" });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "refunded", "failed, then refunded: refunded");
  s = run(s, { type: "arrived", amount: 5_000_000n });
  ok(s.kind === "track" && bridgeIn.trackPhase(s) === "arrived", "money at the account wins over Relay's word: it is there either way");

  // Money already waiting before the transfer started: only more than that is this transfer arriving.
  const withOld = bridgeIn.trackedFrom(quote, "address", 1, { baseline: 7_000_000n });
  s = run(bridgeIn.FORM, { type: "track", t: withOld }, { type: "arrived", amount: 7_000_000n });
  ok(s.kind === "track" && s.shield.kind === "idle", "what was already waiting isn't taken for this transfer");
  s = run(s, { type: "arrived", amount: 26_842_157n });
  ok(s.kind === "track" && s.shield.kind === "arrived" && s.shield.amount === 26_842_157n, "once more arrives, all of it goes private together");
  s = run(bridgeIn.FORM, { type: "track", t: withOld }, { type: "gone" }, { type: "arrived", amount: 5_000_000n });
  ok(s.kind === "track" && s.shield.kind === "arrived", "the old money made private meanwhile: anything after counts as this transfer's");

  // A tab closed mid-way, picked up again.
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, val: string) => void mem.set(k, val), removeItem: (k: string) => void mem.delete(k) };
  const key = bridgeIn.trackedKey("mainnet", owner.address);
  bridgeIn.saveTracked(store, key, tracked);
  const back = bridgeIn.loadTracked(store, key);
  ok(back?.requestId === tracked.requestId && back.depositAddress === tracked.depositAddress && back.receive.assetId === "usdc", "a transfer is kept in the browser and read back after a reload");
  ok(!mem.get(key)!.includes(owner.address) && Object.keys(JSON.parse(mem.get(key)!)).every((k) => k in tracked), "nothing secret is kept, not even the account's address: Relay's id, the address paid to, the quote");
  ok(bridgeIn.trackedLive(back, tracked.startedAt + 60_000) && !bridgeIn.trackedLive(back, tracked.startedAt + bridgeIn.TRACKED_STALE_MS + 1), "an unpaid address stops being offered after a day");
  bridgeIn.saveTracked(store, key, null);
  ok(bridgeIn.loadTracked(store, key) === null, "cleared once private or started over");
  store.setItem(key, "{not json");
  ok(bridgeIn.loadTracked(store, key) === null, "a damaged entry is no transfer");
  store.setItem(key, JSON.stringify({ ...tracked, requestId: "nope" }));
  ok(bridgeIn.loadTracked(store, key) === null, "an entry with a bad id is no transfer");
  ok(bridgeIn.loadTracked({ getItem: () => { throw new Error("blocked"); }, setItem() {}, removeItem() {} }, key) === null, "blocked storage is no transfer, not a crash");
}

// ---------------------------------------------------------------- copy and sources

ok(!/\u2014/.test(bridgeIn.SOLANA_BRIDGE_PRIVACY_NOTE) && /public/.test(bridgeIn.SOLANA_BRIDGE_PRIVACY_NOTE) && /token and amount stay hidden/.test(bridgeIn.SOLANA_BRIDGE_PRIVACY_NOTE), "the privacy line says the bridge is public and what stays hidden, no em dash");
{
  const ids = bridgeIn.solanaBridgeSources().map((c) => c.id);
  ok(!ids.includes(792703809) && !ids.includes(81457) && ids.includes(8453) && ids.includes(728126428) && ids.includes(8253038), "sources: every bridge chain but Solana itself and Blast (Relay refused it)");
  ok(bridgeIn.landingAssets().map((a) => a.id).join() === "usdc,usdt,sol", "it lands as SOL, USDC or USDT");
  ok(bridgeIn.defaultLanding({ symbol: "USDT0" }) === "usdt" && bridgeIn.defaultLanding({ symbol: "ETH" }) === "usdc" && bridgeIn.defaultLanding({ symbol: "USDT" }, { usdt: false }) === "usdc", "USDT stays USDT, the rest lands as USDC, never on an asset not set up");
  ok(bridgeIn.relayCurrency(SOL) === "11111111111111111111111111111111" && bridgeIn.relayCurrency(USDC) === USDC.mint, "Relay's names for SOL and a mint");
  ok(
    !("formatLanding" in bridgeIn) && displayAmount(19_842_157n, 6) === "19.84" && displayAmount(270_400_917n, 9) === "0.27" && displayAmount(1_000n, 9) === "<0.01",
    "amounts it shows read two places, cut down, through the one shared formatter (lib/amountShort)"
  );
}

// ---------------------------------------------------------------- the quote route, Relay faked

{
  let asked: Record<string, unknown> | null = null;
  let relayReply: (body: Record<string, unknown>) => unknown = () => ({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.relay.link/quote")) {
      asked = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(relayReply(asked)), { headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const route = await import("../src/app/api/bridge/solana/route");
  let ip = 10;
  const post = (body: Record<string, unknown>) =>
    route.POST(new Request("http://localhost/api/bridge/solana", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${ip++}` }, body: JSON.stringify(body) }));
  const addressReply = (b: Record<string, unknown>) => ({
    steps: [{ id: "deposit", kind: "transaction", requestId: quote.requestId, depositAddress: "0x4f7c92be9f4d36b71f35b602664e2a86785ce0ec", items: [{}] }],
    details: {
      currencyIn: { amountUsd: "19.99", amount: b.amount },
      currencyOut: { amount: "19842157", minimumAmount: "19445314", currency: { chainId: 792703809, address: b.destinationCurrency } },
      timeEstimate: 1,
    },
    fees: { relayer: { amountUsd: "0.157" }, app: { amountUsd: "0" }, gas: { amountUsd: "0.0009" } },
  });
  relayReply = addressReply;
  const base = { chainId: 8453, symbol: "USDC", asset: "usdc", amount: "20", recipient: owner.address, refundTo: "0x1111111111111111111111111111111111111111" };
  let res = await post(base);
  let json = (await res.json()) as { ok: boolean; data?: import("../src/lib/solanaRings/bridgeIn").SolanaBridgeQuote; error?: { message: string } };
  ok(res.status === 200 && json.ok && json.data?.depositAddress.startsWith("0x") && json.data.receive.assetId === "usdc" && json.data.receive.amount === "19.842157", "a deposit address into the private account, with what lands");
  const a = asked as unknown as Record<string, unknown>;
  ok(
    a.recipient === owner.address && a.destinationChainId === 792703809 && a.destinationCurrency === USDC.mint && a.tradeType === "EXACT_INPUT" && a.useDepositAddress === true && a.refundTo === base.refundTo,
    "it asks Relay to deliver USDC to the private account's own address, exact input, refunds to the address given"
  );
  ok(json.data!.feeUsd === 0.16 && json.data!.appFee === null, "fees as Relay prices them; no Gloam cut unless it is set");

  res = await post({ ...base, asset: "sol" });
  ok(res.status === 200 && (asked as unknown as Record<string, unknown>).destinationCurrency === "11111111111111111111111111111111", "SOL lands as SOL");

  relayReply = (b) => ({ ...addressReply(b), details: { ...addressReply(b).details, currencyOut: { amount: "19842157", currency: { chainId: 8453, address: b.destinationCurrency } } } });
  res = await post(base);
  ok(res.status === 502, "a route that lands anywhere but Solana is refused");
  relayReply = (b) => ({ ...addressReply(b), details: { ...addressReply(b).details, currencyOut: { amount: "19842157", currency: { chainId: 792703809, address: USDT.mint } } } });
  res = await post(base);
  ok(res.status === 502, "a route that lands as another asset is refused");
  relayReply = addressReply;

  // The wallet pays: only the plain approve and deposit reach it.
  const sender = "0x2222222222222222222222222222222222222222";
  const approve = `0x095ea7b3${"0".repeat(24)}${"4cd00e387622c35bddb9b4c962c136462338bc31"}${(20_000_000n).toString(16).padStart(64, "0")}`;
  relayReply = (b) => ({
    ...addressReply(b),
    steps: [
      { id: "approve", kind: "transaction", requestId: quote.requestId, items: [{ data: { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", data: approve, value: "0", chainId: 8453, from: sender } }] },
      { id: "deposit", kind: "transaction", requestId: quote.requestId, depositAddress: "", items: [{ data: { to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", data: "0xe8017952", value: "0", chainId: 8453, from: sender } }] },
    ],
  });
  res = await post({ ...base, refundTo: undefined, sender });
  json = (await res.json()) as typeof json;
  ok(res.status === 200 && json.data?.evmTxs?.length === 2 && json.data.depositAddress === "" && json.data.refundTo === sender, "the wallet pays: an approve and the deposit, refunds to the wallet");
  ok((asked as unknown as Record<string, unknown>).user === sender && (asked as unknown as Record<string, unknown>).useDepositAddress === false, "Relay builds it for that wallet");
  relayReply = (b) => {
    const r = addressReply(b);
    return { ...r, steps: [{ id: "deposit", kind: "transaction", requestId: quote.requestId, items: [{ data: { to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", data: "0xe8017952", value: "1", chainId: 8453, from: sender } }] }] };
  };
  res = await post({ ...base, refundTo: undefined, sender });
  ok(res.status === 502, "a token deposit that would send ETH along is refused, never handed to the wallet");
  relayReply = addressReply;

  for (const [what, body, status] of [
    ["Solana itself as the source", { ...base, chainId: 792703809 }, 400],
    ["Blast (Relay refused it)", { ...base, chainId: 81457, symbol: "ETH" }, 400],
    ["an asset Gloam doesn't list", { ...base, asset: "eth" }, 400],
    ["a recipient that isn't a Solana address", { ...base, recipient: "0x1111111111111111111111111111111111111111" }, 400],
    ["a stablecoin over the limit", { ...base, amount: "25001" }, 400],
    ["no refund address for a deposit address", { ...base, refundTo: "" }, 400],
    ["a Tron refund address that isn't one", { ...base, chainId: 728126428, symbol: "USDT", refundTo: "0x1111111111111111111111111111111111111111" }, 400],
    ["an OFAC-listed private account", { ...base, recipient: ofac.addresses[0] }, 403],
  ] as [string, Record<string, unknown>, number][]) {
    res = await post(body);
    ok(res.status === status, `refused: ${what} (${res.status})`);
  }
  globalThis.fetch = realFetch;
}

console.log(`selftest-solana-bridge-in: ${n} checks passed`);
