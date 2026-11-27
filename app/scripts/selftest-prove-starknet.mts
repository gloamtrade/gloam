/**
 * Self-test: showing the payments in one Starknet channel (lib/proofs/starknetChannel
 * and starknetChannelRead), with no network: the SDK's in-memory pool (Mocknet)
 * runs real opens and payments, and a stand-in node answers the pool's views
 * from it, and each account's is_valid_signature with its own Stark key.
 *
 *  - the pool's hashes here equal the SDK's own (utils/hashes, utils/encryptions);
 *  - Alice pays Bob twice, Bob pays Alice once: each lists its channels (the
 *    incoming key decrypted from the pool, the outgoing one derived), reads
 *    the payments, and makes a disclosure that verifies, with dates read from
 *    the pool's events;
 *  - tampered fails: the channel key, an address, who made it, the label, the
 *    expiry, the pool, a signature by the other account, an account's own channel;
 *  - wrong chain fails: a devnet disclosure on a mainnet page, the chain id it
 *    was signed for; an unreachable node is "could not check", never a pass.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-prove-starknet.mts
 */
import assert from "node:assert/strict";
import { ec, num, shortString, type RpcProvider } from "starknet";
import { Mocknet } from "@starkware-libs/starknet-privacy-sdk/testing";

for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k === "STARKNET_PROVER_URL") delete process.env[k];

const sc = await import("../src/lib/proofs/starknetChannel");
const rd = await import("../src/lib/proofs/starknetChannelRead");
const chain = await import("../src/lib/proofs/chainProofs");
const account = await import("../src/lib/starknetPrivacy/account");
const actions = await import("../src/lib/starknetPrivacy/actions");
// The SDK's own hashes, by path (its package exports don't list utils).
const sdkHashes = await import("../node_modules/@starkware-libs/starknet-privacy-sdk/dist/utils/hashes.js");
const { encryptions } = await import("../node_modules/@starkware-libs/starknet-privacy-sdk/dist/utils/encryptions.js");

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert.ok(c, m);
  pass++;
};
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  pass++;
};

/* ------------------------------------------------------------------ the pool's hashes, against the SDK's */
{
  const ck = 0x1234abcdn;
  const s = 0x51n;
  const r = 0x52n;
  const rpk = 0x777n;
  const t = 0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7n;
  eq(sc.channelMarker(ck, s, r, rpk), sdkHashes.compute_channel_marker(ck, s, r, rpk), "channel marker");
  eq(sc.subchannelId(ck, 3), sdkHashes.compute_subchannel_id(ck, 3), "subchannel id");
  eq(sc.subchannelMarker(ck, r, rpk, t), sdkHashes.compute_subchannel_marker(ck, r, rpk, t), "subchannel marker");
  eq(sc.noteId(ck, t, 5), sdkHashes.compute_note_id(ck, t, 5), "note id");
  const packed = encryptions.encryptNoteAmount(ck, t, 5, 0x9999n, 600n);
  eq(sc.noteAmount(packed, ck, t, 5), { amount: 600n, open: false }, "a note's amount opens as the SDK seals it");
  eq(sc.noteAmount((1n << 128n) | 42n, ck, t, 5), { amount: 42n, open: true }, "an open note's amount is plain");
  const sub = encryptions.encryptSubchannelInfo(ck, 2, t, 0xabcn);
  eq(sc.subchannelToken(ck, 2, BigInt(sub.salt), BigInt(sub.enc_token)), t, "a subchannel's token opens as the SDK seals it");
}

/* ------------------------------------------------------------------ a stand-in node over Mocknet */
const mocknet = new Mocknet({ validateBalances: true });
const env = mocknet.initialize();
const TOKEN = env.ace;
const POOL = num.toHex(mocknet.poolAddress);
const enc = new TextEncoder();
const alice = await account.keysFromSeed(enc.encode("fake-gloam-seed-alice"), 0);
const bob = await account.keysFromSeed(enc.encode("fake-gloam-seed-bob"), 0);
const carol = await account.keysFromSeed(enc.encode("fake-gloam-seed-carol"), 0);
const ta = mocknet.createPrivateTransfers(BigInt(alice.address), alice.viewingKey);
const tb = mocknet.createPrivateTransfers(BigInt(bob.address), bob.viewingKey);
const tc = mocknet.createPrivateTransfers(BigInt(carol.address), carol.viewingKey);
const send = (r: unknown) => mocknet.executeOutside(r as never);
for (const [t, k] of [[ta, alice], [tb, bob], [tc, carol]] as const) send(await actions.openAccount(t, { self: k.address, tokens: [TOKEN] }));
mocknet.fundUser(BigInt(alice.address), TOKEN, 1_000n);
mocknet.fundUser(BigInt(bob.address), TOKEN, 1_000n);
send(await actions.add(ta, { token: TOKEN, self: alice.address, amount: 1_000n }));
send(await actions.add(tb, { token: TOKEN, self: bob.address, amount: 1_000n }));
send(await actions.pay(ta, { token: TOKEN, self: alice.address, to: bob.address, amount: 600n }));
send(await actions.pay(ta, { token: TOKEN, self: alice.address, to: bob.address, amount: 100n }));
send(await actions.pay(tb, { token: TOKEN, self: bob.address, to: alice.address, amount: 50n }));

const pool = mocknet.pool;
const fullKey = new Map<bigint, string>();
for (const k of [alice, bob, carol]) fullKey.set(BigInt(k.address), Buffer.from(ec.starkCurve.getPublicKey(num.toHex(k.accountKey), false)).toString("hex"));
const VALID = num.toHex(BigInt(shortString.encodeShortString("VALID")));
const events = new Map<bigint, { block: number; tx: string }>();
let offline = false;

const node = {
  async callContract(c: { contractAddress: string; entrypoint: string; calldata: string[] }) {
    if (offline) throw new Error("fetch failed");
    const a = c.calldata.map((x) => BigInt(x));
    const hex = (v: unknown) => num.toHex(BigInt(v as never));
    if (BigInt(c.contractAddress) === BigInt(POOL)) {
      switch (c.entrypoint) {
        case "get_public_key":
          return [hex(pool.get_public_key(a[0]!) ?? 0n)];
        case "channel_exists":
          return [pool.channel_exists(a[0]!) ? "0x1" : "0x0"];
        case "subchannel_exists":
          return [pool.subchannel_exists(a[0]!) ? "0x1" : "0x0"];
        case "get_num_of_channels":
          return [hex(pool.get_num_of_channels(a[0]!))];
        case "get_channel_info": {
          const i = pool.get_channel_info(a[0]!, Number(a[1]));
          return [i.ephemeral_pubkey, i.enc_channel_key, i.enc_sender_addr].map(hex);
        }
        case "get_outgoing_channel_info": {
          const i = pool.get_outgoing_channel_info(a[0]!);
          return [i.salt, i.enc_recipient_addr].map(hex);
        }
        case "get_subchannel_info": {
          const i = pool.get_subchannel_info(a[0]!);
          return [i.salt, i.enc_token].map(hex);
        }
        case "get_note": {
          const n = pool.get_note(a[0]!) as { packed_value: unknown; token: unknown };
          return [hex(n.packed_value ?? 0n), hex(n.token ?? 0n)];
        }
      }
      throw Object.assign(new Error(`no ${c.entrypoint}`), { code: 21 });
    }
    // An account: its own is_valid_signature, ECDSA under its key.
    const pk = fullKey.get(BigInt(c.contractAddress));
    if (!pk) throw Object.assign(new Error("Contract not found"), { code: 20 });
    if (c.entrypoint !== "is_valid_signature" || Number(a[1]) !== 2) return ["0x0"];
    const good = ec.starkCurve.verify(new ec.starkCurve.Signature(a[2]!, a[3]!), num.toHex(a[0]!), pk);
    return [good ? VALID : "0x0"];
  },
  async getEvents(f: { keys: string[][] }) {
    if (offline) throw new Error("fetch failed");
    const out = [];
    for (const id of f.keys[1] ?? []) {
      const e = events.get(BigInt(id));
      if (e) out.push({ from_address: POOL, keys: ["0x0", id], data: [], block_number: e.block, transaction_hash: e.tx });
    }
    return { events: out, continuation_token: undefined };
  },
  async getBlockWithTxHashes(n: number) {
    return { timestamp: 1_790_000_000 + n };
  },
} as unknown as RpcProvider;

const CHAIN = "0x534e5f4d41494e";
const NOW = Math.floor(Date.now() / 1000);
const maker = (k: typeof alice) => ({ address: k.address, viewingKey: k.viewingKey, accountKey: k.accountKey, network: "mainnet" as const, provider: node, pool: POOL, chainId: CHAIN, fromBlock: 0 });
const deps = (over: Partial<{ network: "mainnet" | "devnet"; pool: string | null; chainId: string }> = {}) =>
  rd.channelDeps({ network: over.network ?? "mainnet", provider: node, pool: over.pool === undefined ? POOL : over.pool, chainId: over.chainId ?? CHAIN, fromBlock: 0 });
const failed = (r: Awaited<ReturnType<typeof sc.verifyStarknetChannel>>, label: string) => !r.ok && r.checks.some((c) => c.state === "fail" && c.label.startsWith(label));

/* ------------------------------------------------------------------ channels, payments and a disclosure that verifies */
const bobChannels = await rd.listChannels(maker(bob));
eq(
  bobChannels.map((c) => [c.side, c.sender, c.recipient]),
  [
    ["received", alice.address, bob.address],
    ["sent", bob.address, alice.address],
  ],
  "Bob is in two channels: from Alice, and to Alice (his own channel is left out)"
);
const fromAlice = bobChannels[0]!;
const aliceChannels = await rd.listChannels(maker(alice));
eq(aliceChannels.find((c) => c.side === "sent")?.channelKey, fromAlice.channelKey, "Alice derives the same key for her channel to Bob");
eq((await rd.listChannels(maker(carol))).length, 0, "Carol, paid by nobody and paying nobody, has none");

const preview = await rd.previewChannel(maker(bob), fromAlice);
eq(preview.payments.map((p) => p.amount), [600n, 100n], "Bob sees Alice's two payments, in order");
for (const p of preview.payments) events.set(BigInt(p.noteId), { block: 100 + p.index, tx: `0x${(0xabc0 + p.index).toString(16)}` });

const received = await rd.makeChannelProof(maker(bob), fromAlice, "Acme Bank", NOW + 7 * 86_400);
const r = await sc.verifyStarknetChannel(received, deps());
ok(r.ok, `Bob's disclosure of Alice's payments verifies: ${r.checks.map((c) => `${c.state}:${c.label}`).join(" | ")}`);
eq(
  r.checks.map((c) => c.label),
  ["Made on Starknet's privacy pool on Starknet", 'Made for "Acme Bank"', "Payments from one account to another", "Every payment read from the pool", "Not expired"],
  "the checks, in order"
);
eq(r.payments.map((p) => [p.amount, p.at, p.tx]), [[600n, 1_790_000_100, "0xabc0"], [100n, 1_790_000_101, "0xabc1"]], "each payment with the date read from its event");
eq(received.by, "recipient", "made by the account paid");

const sent = await rd.makeChannelProof(maker(alice), aliceChannels.find((c) => c.side === "sent")!, "Tax office", NOW + 86_400);
const rs = await sc.verifyStarknetChannel(sent, deps());
ok(rs.ok && rs.payments.length === 2, "Alice's disclosure of what she paid Bob verifies, the same two payments");
eq(sent.by, "sender", "made by the account that paid");

// A payment the reader can't date still counts; only dates read from chain are shown.
events.clear();
const undated = await sc.verifyStarknetChannel(received, deps());
ok(undated.ok && undated.payments.every((p) => p.at === undefined), "without events, amounts still verify and no date is made up");

const text = sc.encodeStarknetChannel(received);
ok(text.startsWith("gloamsnpay1:"), "its prefix");
eq(sc.decodeStarknetChannel(text), received, "it decodes to the same disclosure");
ok(chain.isChainProofText(text) && (await chain.decodeChainProof(text)).kind === "starknet-channel", "the verify page's dispatcher reads it");
assert.throws(() => sc.decodeStarknetChannel(sc.encodeStarknetChannel({ ...received, sender: "alice" })), /damaged/);
pass++;

/* ------------------------------------------------------------------ tampered */
ok(failed(await sc.verifyStarknetChannel({ ...received, channelKey: num.toHex(fromAlice.channelKey + 1n) }, deps()), "Made for"), "an edited channel key breaks the signature");
ok(failed(await sc.verifyStarknetChannel({ ...received, sender: carol.address }, deps()), "Made for"), "an edited sender breaks the signature");
ok(failed(await sc.verifyStarknetChannel({ ...received, by: "sender" }, deps()), "Made for"), "claiming the other account made it fails");
ok(failed(await sc.verifyStarknetChannel({ ...received, verifier: "Someone Else" }, deps()), "Made for"), "an edited label breaks the signature");
ok(failed(await sc.verifyStarknetChannel({ ...received, expiresAt: received.expiresAt + 99 }, deps()), "Made for"), "an edited expiry breaks the signature");
ok(failed(await sc.verifyStarknetChannel({ ...received, signature: sent.signature }, deps()), "Made for"), "another account's signature fails");
// Signed again by Bob, with a key or an account that isn't the channel's: the pool has no such channel.
const forged = await rd.makeChannelProof(maker(bob), { ...fromAlice, channelKey: fromAlice.channelKey + 1n }, "Acme Bank", NOW + 600).catch((e: Error) => e);
ok(forged instanceof Error && /no such channel/.test(forged.message), "Bob can't sign a channel the pool doesn't have");
const carolMaker = maker(carol);
const claimed = await rd.makeChannelProof(carolMaker, { ...fromAlice, recipient: carol.address, side: "received" }, "Acme Bank", NOW + 600).catch((e: Error) => e);
ok(claimed instanceof Error, "Carol can't pass Alice's payments to Bob off as hers");
// Built by hand past the maker's own check: a channel from Alice to Carol with Bob's key.
const { signature: _s, ...unsigned } = received;
void _s;
const asCarol = { ...unsigned, recipient: carol.address };
const { Signer, stark, typedData } = await import("starknet");
const carolSig = stark.formatSignature(await new Signer(num.toHex(carol.accountKey)).signMessage(sc.starknetChannelTypedData(asCarol, CHAIN) as never, carol.address)).map((x) => num.toHex(BigInt(x)));
ok(failed(await sc.verifyStarknetChannel({ ...asCarol, signature: carolSig }, deps()), "Payments from one account to another"), "signed by Carol, the key opens no channel to her");
void typedData;
const self = { ...unsigned, recipient: bob.address, sender: bob.address };
const selfSig = stark.formatSignature(await new Signer(num.toHex(bob.accountKey)).signMessage(sc.starknetChannelTypedData(self, CHAIN) as never, bob.address)).map((x) => num.toHex(BigInt(x)));
ok(failed(await sc.verifyStarknetChannel({ ...self, signature: selfSig }, deps()), "Payments from one account to another"), "an account's own channel is not payments");
ok(failed(await sc.verifyStarknetChannel(received, deps({ pool: "0x999" })), "Made on Starknet's privacy pool"), "a pool this page doesn't trust fails");
const expired = await sc.verifyStarknetChannel(await rd.makeChannelProof(maker(bob), fromAlice, "Acme Bank", NOW + 2), { ...deps(), now: () => NOW + 10 });
ok(!expired.ok && expired.expired && expired.checks.at(-1)?.label === "Expired", "an expired disclosure is not ok");

/* ------------------------------------------------------------------ wrong chain, and a node that doesn't answer */
ok(failed(await sc.verifyStarknetChannel({ ...received, network: "devnet" }, deps()), "Made on Starknet devnet"), "a devnet disclosure on a mainnet page fails");
ok(failed(await sc.verifyStarknetChannel(received, deps({ chainId: "0x534e5f4445564e4554" })), "Made for"), "a signature for another chain id fails");
offline = true;
const down = await sc.verifyStarknetChannel(received, deps());
ok(!down.ok && down.checks.some((c) => c.state === "unknown") && !down.checks.some((c) => c.state === "fail"), "an unreachable node is 'could not check', never a pass");
offline = false;

console.log(`selftest-prove-starknet: ${pass} checks passed`);
