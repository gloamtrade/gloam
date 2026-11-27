import "server-only";

/**
 * Bringing USDC in to Starknet from a Solana wallet with Circle's CCTP V2
 * (lib/starknetPrivacy/cctp says the whole flow): the deposit_for_burn
 * instruction of Circle's TokenMessengerMinterV2 program, built and simulated
 * here (lib/solanaTx), for the person's Solana wallet to sign and send.
 *
 * Circle's Solana programs keep each MessageSent event in an account of its
 * own, created by the burn and signed for by a fresh keypair: made here, used
 * to sign this one transaction, and dropped. It holds no money; its rent
 * (about 0.004 SOL for its 428 bytes) is paid by the wallet and can be taken back after five
 * days with Circle's reclaim_event_account, signed by the wallet.
 *
 * The accounts follow Circle's "Transfer USDC from Solana" quickstart (2026)
 * and its program's PDA seeds; scripts/selftest-starknet-cctp-solana.mts
 * checks the layout, and the PDAs were read on Solana mainnet (they exist and
 * belong to Circle's programs).
 */
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { buildSolanaTx, type RelaySolanaInstruction, type SolanaBuild } from "@/lib/solanaTx";
import { CCTP_STARKNET_DOMAIN, burnFinality, burnMaxFee, cctpSourceByDomain, hexToBytes, starknetToBytes32 } from "./cctp";

export const SOLANA_MESSAGE_TRANSMITTER_V2 = new PublicKey("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
export const SOLANA_TOKEN_MESSENGER_MINTER_V2 = new PublicKey("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
export const SOLANA_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Anchor's discriminator of deposit_for_burn (Circle's quickstart). */
const DEPOSIT_FOR_BURN = Uint8Array.from([215, 60, 61, 46, 114, 55, 128, 176]);

const enc = new TextEncoder();
const pda = (program: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** The program accounts a burn from `owner` needs (Circle's seeds). */
export function solanaBurnAccounts(owner: PublicKey) {
  const tmm = SOLANA_TOKEN_MESSENGER_MINTER_V2;
  const mt = SOLANA_MESSAGE_TRANSMITTER_V2;
  return {
    senderAuthority: pda(tmm, enc.encode("sender_authority")),
    burnTokenAccount: pda(ASSOCIATED_TOKEN_PROGRAM, owner.toBytes(), TOKEN_PROGRAM.toBytes(), SOLANA_USDC.toBytes()),
    denylist: pda(tmm, enc.encode("denylist_account"), owner.toBytes()),
    messageTransmitter: pda(mt, enc.encode("message_transmitter")),
    tokenMessenger: pda(tmm, enc.encode("token_messenger")),
    // CCTP V2 on Solana keys the remote messenger by the domain written out as text.
    remoteTokenMessenger: pda(tmm, enc.encode("remote_token_messenger"), enc.encode(String(CCTP_STARKNET_DOMAIN))),
    tokenMinter: pda(tmm, enc.encode("token_minter")),
    localToken: pda(tmm, enc.encode("local_token"), SOLANA_USDC.toBytes()),
    eventAuthority: pda(tmm, enc.encode("__event_authority")),
    mtEventAuthority: pda(mt, enc.encode("__event_authority")),
  };
}

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};

/** deposit_for_burn's data: amount, domain 25, the Starknet account, anyone delivers, maxFee, finality. */
export function solanaBurnData(input: { amount: bigint; account: string; bps: number }): Uint8Array {
  const source = cctpSourceByDomain(5)!;
  if (input.amount <= 0n || input.amount >= 1n << 64n) throw new Error("Invalid amount.");
  return Uint8Array.from([
    ...DEPOSIT_FOR_BURN,
    ...u64(input.amount),
    ...u32(CCTP_STARKNET_DOMAIN),
    ...hexToBytes(starknetToBytes32(input.account)),
    ...new Uint8Array(32),
    ...u64(burnMaxFee(input.amount, input.bps, source.fast)),
    ...u32(burnFinality(source)),
  ]);
}

/** The instruction, in lib/solanaTx's shape, for `owner` and the event account `event`. */
export function solanaBurnInstruction(owner: PublicKey, event: PublicKey, input: { amount: bigint; account: string; bps: number }): RelaySolanaInstruction {
  const a = solanaBurnAccounts(owner);
  const k = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable });
  return {
    programId: SOLANA_TOKEN_MESSENGER_MINTER_V2.toBase58(),
    data: Buffer.from(solanaBurnData(input)).toString("hex"),
    keys: [
      k(owner, true, true), // owner
      k(owner, true, true), // event_rent_payer
      k(a.senderAuthority, false, false),
      k(a.burnTokenAccount, false, true),
      k(a.denylist, false, false),
      k(a.messageTransmitter, false, true),
      k(a.tokenMessenger, false, false),
      k(a.remoteTokenMessenger, false, false),
      k(a.tokenMinter, false, false),
      k(a.localToken, false, true),
      k(SOLANA_USDC, false, true),
      k(event, true, true), // message_sent_event_data
      k(SOLANA_MESSAGE_TRANSMITTER_V2, false, false),
      k(SOLANA_TOKEN_MESSENGER_MINTER_V2, false, false),
      k(TOKEN_PROGRAM, false, false),
      k(SystemProgram.programId, false, false),
      k(a.eventAuthority, false, false),
      k(SOLANA_TOKEN_MESSENGER_MINTER_V2, false, false),
      k(a.mtEventAuthority, false, false),
      k(SOLANA_MESSAGE_TRANSMITTER_V2, false, false),
    ],
  };
}

/**
 * The burn for `owner` to sign: built, simulated (so a wallet short of USDC or
 * SOL hears so before it signs), and signed by the fresh event account.
 */
export async function buildSolanaBurn(owner: string, input: { amount: bigint; account: string; bps: number }, build: typeof buildSolanaTx = buildSolanaTx): Promise<SolanaBuild> {
  let ownerKey: PublicKey;
  try {
    ownerKey = new PublicKey(owner);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const event = Keypair.generate();
  const built = await build(owner, [solanaBurnInstruction(ownerKey, event.publicKey, input)], []);
  if (!built.ok) return built;
  const tx = VersionedTransaction.deserialize(Buffer.from(built.tx, "base64"));
  tx.sign([event]);
  return { ...built, tx: Buffer.from(tx.serialize()).toString("base64") };
}

const PUBLIC_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
function solanaRpcs(): string[] {
  const own = process.env.SOLANA_RPC_URL?.trim();
  return own ? [own, ...PUBLIC_RPCS] : PUBLIC_RPCS;
}

/** The wallet's USDC and SOL, base units; null where no RPC answered. */
export async function solanaBalances(owner: string): Promise<{ usdc: bigint | null; sol: bigint | null }> {
  let key: PublicKey;
  try {
    key = new PublicKey(owner);
  } catch {
    return { usdc: null, sol: null };
  }
  const ata = solanaBurnAccounts(key).burnTokenAccount;
  for (const url of solanaRpcs()) {
    try {
      const conn = new Connection(url, { commitment: "confirmed" });
      const [lamports, tok] = await Promise.all([conn.getBalance(key), conn.getTokenAccountBalance(ata).catch(() => null)]);
      return { usdc: tok ? BigInt(tok.value.amount) : 0n, sol: BigInt(lamports) };
    } catch {
      /* the next RPC */
    }
  }
  return { usdc: null, sol: null };
}

/**
 * Where a burn the wallet sent stands: landed (Circle can sign it), failed on
 * chain, expired (its blockhash ran out unseen: it never went), or pending.
 */
export async function solanaBurnStatus(signature: string, lastValidBlockHeight: number): Promise<"landed" | "failed" | "expired" | "pending"> {
  for (const url of solanaRpcs()) {
    try {
      const conn = new Connection(url, { commitment: "confirmed" });
      const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (st?.err) return "failed";
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "landed";
      if (!st && (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) return "expired";
      return "pending";
    } catch {
      /* the next RPC */
    }
  }
  return "pending";
}
