/**
 * Self-test: bringing USDC in to Starknet from a Solana wallet with Circle's
 * CCTP V2 (lib/starknetPrivacy/cctpSolanaServer and /api/starknet/cctp/solana),
 * with no network.
 *
 *  - the accounts: Circle's PDAs for a burn to Starknet, the same addresses
 *    read on Solana mainnet on 2026-11-27 (each exists and belongs to Circle's
 *    programs; the remote messenger for domain 25 holds Starknet's minter);
 *  - the instruction: Anchor's deposit_for_burn discriminator, then the amount,
 *    domain 25, the Starknet account, anyone delivers, Circle's fee with its
 *    margin, fast; 20 accounts with the owner, the rent payer and the event
 *    account as signers;
 *  - the message Circle's program wrote when Solana mainnet simulated this
 *    instruction (sigVerify off, nothing sent; 10 USDC from a real holder): it
 *    decodes as a burn from Solana to the Starknet account, and once signed it
 *    passes the relay's receive policy;
 *  - the transaction handed to the wallet: built by lib/solanaTx (faked here),
 *    with the event account's signature already on it and the owner's slot left
 *    for the wallet;
 *  - the route's refusals before building anything.
 *
 * Run from app/:  ../mcp/node_modules/.bin/tsx scripts/selftest-starknet-cctp-solana.mts
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { hash, num } from "starknet";

const stub = fileURLToPath(new URL("./server-only-stub.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "server-only" ? stub : resolve.call(this, req, ...rest);
};
const env = process.env as Record<string, string | undefined>;
for (const k of Object.keys(env)) if (k.startsWith("NEXT_PUBLIC_STARKNET_") || k.startsWith("STARKNET_") || k.startsWith("GLOAM_STARKNET_")) delete env[k];
env.NEXT_PUBLIC_STARKNET_ENABLED = "1";
env.NEXT_PUBLIC_STARKNET_NETWORK = "mainnet";

const cctp = await import("../src/lib/starknetPrivacy/cctp");
const sol = await import("../src/lib/starknetPrivacy/cctpSolanaServer");
const config = await import("../src/lib/starknetPrivacy/config");

let pass = 0;
const ok = (c: unknown, msg: string) => {
  assert.ok(c, msg);
  pass++;
};
const eq = <T,>(a: T, b: T, msg: string) => {
  assert.deepEqual(a, b, msg);
  pass++;
};

const OWNER = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const ACCOUNT = "0x0444444444444444444444444444444444444444444444444444444444444444";

/* ------------------------------------------------------------------ the accounts */
{
  const a = sol.solanaBurnAccounts(OWNER);
  const b58 = (k: PublicKey) => k.toBase58();
  eq(
    [b58(a.senderAuthority), b58(a.messageTransmitter), b58(a.tokenMessenger), b58(a.remoteTokenMessenger), b58(a.tokenMinter), b58(a.localToken), b58(a.burnTokenAccount)],
    [
      "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE",
      "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU",
      "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W",
      "DVtUfkzPW6yDkA7sqWMetskjKB8wwzcU5Y7pdTqcSDLN",
      "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux",
      "CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1",
      "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B",
    ],
    "the PDAs read on Solana mainnet (sender authority, transmitter, messenger, Starknet's remote messenger, minter, USDC, the owner's USDC account)"
  );
}

/* ------------------------------------------------------------------ the instruction */
const event = new PublicKey("Evnt111111111111111111111111111111111111111");
{
  const data = sol.solanaBurnData({ amount: 10_000_000n, account: ACCOUNT, bps: 1 });
  eq(data.length, 96, "8 + 8 + 4 + 32 + 32 + 8 + 4 bytes");
  eq([...data.subarray(0, 8)], [215, 60, 61, 46, 114, 55, 128, 176], "deposit_for_burn's discriminator");
  const dv = new DataView(data.buffer, data.byteOffset);
  eq(dv.getBigUint64(8, true), 10_000_000n, "amount");
  eq(dv.getUint32(16, true), 25, "to Starknet");
  eq(cctp.bytesToHex(data.subarray(20, 52)), cctp.starknetToBytes32(ACCOUNT), "the Starknet account");
  eq(cctp.bytesToHex(data.subarray(52, 84)), cctp.ZERO_BYTES32, "anyone delivers");
  eq(dv.getBigUint64(84, true), cctp.burnMaxFee(10_000_000n, 1, true), "Circle's fee with its margin");
  eq(dv.getUint32(92, true), 1000, "fast");
  assert.throws(() => sol.solanaBurnData({ amount: 0n, account: ACCOUNT, bps: 1 }));
  pass++;
  const ix = sol.solanaBurnInstruction(OWNER, event, { amount: 10_000_000n, account: ACCOUNT, bps: 1 });
  eq(ix.programId, "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", "Circle's TokenMessengerMinterV2");
  eq(ix.keys.length, 20, "20 accounts");
  eq(ix.keys.flatMap((k, i) => (k.isSigner ? [i] : [])), [0, 1, 11], "signers: the owner, the rent payer, the event account");
  eq(ix.keys.flatMap((k, i) => (k.isWritable ? [i] : [])), [0, 1, 3, 5, 9, 10, 11], "writable: owner, payer, its USDC, the transmitter, the local token, the mint, the event");
  eq(ix.keys[11]!.pubkey, event.toBase58(), "the event account");
}

/* ------------------------------------------------------------------ the message Circle's program wrote (Solana mainnet simulation) */
{
  const SIMULATED =
    "0x0000000100000005000000190000000000000000000000000000000000000000000000000000000000000000a65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e9389307d421b9ca8aa32df259965cda8acb93f7599f69209a41872ae84638b2a20f2a0000000000000000000000000000000000000000000000000000000000000000000003e80000000000000001c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61044444444444444444444444444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000009896807e8c088760bfde1dddcf32c17f209b8242ee52aaf131facd88d0ea2c6d0b06f200000000000000000000000000000000000000000000000000000000000004b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
  const m = cctp.decodeBurnMessage(SIMULATED)!;
  eq([m.sourceDomain, m.destinationDomain, m.minFinalityThreshold, m.body.amount, m.body.maxFee], [5, 25, 1000, 10_000_000n, 1_200n], "from Solana to Starknet, fast, 10 USDC, the max fee set");
  ok(cctp.sameBytes32(m.body.mintRecipient, ACCOUNT), "to the Starknet account");
  ok(cctp.sameBytes32(m.body.messageSender, "0x" + Buffer.from(OWNER.toBytes()).toString("hex")), "sent by the owner");
  const solana = cctp.cctpSourceByDomain(5)!;
  ok(cctp.sameBytes32(m.sender, solana.messenger) && cctp.sameBytes32(m.body.burnToken, solana.usdc), "Circle's Solana messenger, Solana's USDC: the source Gloam lists");
  // What Circle fills in when it signs, then the relay's receive policy.
  const signed = cctp.encodeBurnMessage({ ...m, nonce: "0x" + "5a".repeat(32), finalityThresholdExecuted: 1000, body: { ...m.body, feeExecuted: 1_000n, expirationBlock: 20_000_000n } });
  const RELAY = "0x25a6c9f0c15ef30c139065096b4b8e563e6b86191fd600a4f0616df8f22fb77";
  const MAIN = cctp.STARKNET_CCTP.mainnet;
  const pool = config.starknetConfig("mainnet", {}).pool!;
  const NOW = 1_800_000_000;
  const outside = {
    contractAddress: ACCOUNT,
    entrypoint: "execute_from_outside_v2",
    calldata: [RELAY, "0x9", num.toHex(NOW - 60), num.toHex(NOW + 600), "0x2", MAIN.usdc, hash.getSelectorFromName("transfer"), "0x3", RELAY, num.toHex(250_000n), "0x0", MAIN.usdc, hash.getSelectorFromName("approve"), "0x3", pool, num.toHex(9_749_000n), "0x0", "0x2", "0x1", "0x2"],
  };
  const d = cctp.checkCctpReceive({ message: signed, attestation: "0x" + "11".repeat(130), outside }, { cctp: MAIN, relay: RELAY, pool, now: NOW, minFee: 250_000n, maxApprove: 10_000_000_000n });
  ok(d.ok, `once signed, the relay's receive policy takes it${d.ok ? "" : `: ${d.reason}`}`);
  if (d.ok) eq([d.sourceDomain, d.minted], [5, 9_999_000n], "from Solana, 10 USDC less Circle's fee");
}

/* ------------------------------------------------------------------ the transaction for the wallet */
{
  let asked: { payer: string; ixs: number } | null = null;
  const fakeBuild = async (payer: string, ixs: { programId: string; data: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }[]) => {
    asked = { payer, ixs: ixs.length };
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(payer),
        recentBlockhash: "11111111111111111111111111111111",
        instructions: ixs.map((i) => new TransactionInstruction({ programId: new PublicKey(i.programId), data: Buffer.from(i.data, "hex"), keys: i.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })) })),
      }).compileToV0Message()
    );
    return { ok: true as const, tx: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 123 };
  };
  const built = await sol.buildSolanaBurn(OWNER.toBase58(), { amount: 10_000_000n, account: ACCOUNT, bps: 1 }, fakeBuild as never);
  ok(built.ok, "built");
  eq(asked, { payer: OWNER.toBase58(), ixs: 1 }, "the owner pays, one instruction");
  if (built.ok) {
    const tx = VersionedTransaction.deserialize(Buffer.from(built.tx, "base64"));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    eq(tx.message.header.numRequiredSignatures, 2, "two signers: the owner and the event account");
    eq(keys[0], OWNER.toBase58(), "the owner first (fee payer)");
    ok(tx.signatures[0]!.every((b) => b === 0), "the owner's signature is left for the wallet");
    ok(!tx.signatures[1]!.every((b) => b === 0), "the event account already signed");
    eq(built.lastValidBlockHeight, 123, "its last valid block height is handed on");
  }
  const failed = await sol.buildSolanaBurn(OWNER.toBase58(), { amount: 10_000_000n, account: ACCOUNT, bps: 1 }, (async () => ({ ok: false, reason: "funds" })) as never);
  eq(failed, { ok: false, reason: "funds" }, "a wallet short of funds hears so");
  eq(await sol.buildSolanaBurn("not a key", { amount: 1n, account: ACCOUNT, bps: 1 }), { ok: false, reason: "invalid" }, "not a Solana address");
}

/* ------------------------------------------------------------------ the route's refusals (nothing built) */
{
  const route = await import("../src/app/api/starknet/cctp/solana/route");
  const post = async (body: unknown, headers: Record<string, string> = {}) =>
    (await route.POST(new Request("https://www.gloam.trade/api/starknet/cctp/solana", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": "198.51.100.60", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers } }))).status;
  const good = { owner: OWNER.toBase58(), amount: "10", account: ACCOUNT };
  eq(await post({ ...good, owner: "0x1234" }), 400, "a Solana wallet");
  eq(await post({ ...good, amount: "0.5" }), 400, "at least 1 USDC");
  eq(await post({ ...good, amount: "10000.01" }), 400, "at most 10,000 USDC");
  eq(await post({ ...good, account: "0x0" }), 400, "an open Starknet account");
  eq(await post(good, { "sec-fetch-site": "cross-site" }), 403, "same site only");
  const get = async (q: string) => (await route.GET(new Request(`https://www.gloam.trade/api/starknet/cctp/solana?${q}`, { headers: { "x-forwarded-for": "198.51.100.61" } }))).status;
  eq(await get("owner=0x12"), 400, "a balance only for a Solana wallet");
  eq(await get("signature=abc&lastValid=1"), 400, "a status only for a signature");
}

console.log(`\nselftest-starknet-cctp-solana: ${pass} checks passed`);
