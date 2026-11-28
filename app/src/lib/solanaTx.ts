/**
 * Server side of a Solana wallet paying a Relay order: Relay returns the
 * order's instructions, and this turns them into one unsigned transaction the
 * person's wallet signs. It is simulated first, so a wallet short of the token
 * or of SOL for the fee hears so here instead of failing on chain.
 *
 * Server only (it pulls in @solana/web3.js). SOLANA_RPC_URL picks the RPC;
 * otherwise the public endpoints below are tried in turn.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const PUBLIC_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
/** Priority fee, in micro-lamports per compute unit: about 0.00002 SOL for a Relay deposit. */
const PRIORITY_MICRO_LAMPORTS = 200_000;
const SIM_UNIT_LIMIT = 600_000;

export type RelaySolanaInstruction = {
  programId: string;
  data: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
};

export type SolanaBuild =
  | { ok: true; tx: string; lastValidBlockHeight: number }
  | { ok: false; reason: "funds" | "rpc" | "invalid" };

function rpcs(): string[] {
  const own = process.env.SOLANA_RPC_URL?.trim();
  return own ? [own, ...PUBLIC_RPCS] : PUBLIC_RPCS;
}

function instruction(i: RelaySolanaInstruction): TransactionInstruction {
  if (!/^[0-9a-fA-F]*$/.test(i.data) || i.data.length % 2 !== 0) throw new Error("bad instruction data");
  return new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: Boolean(k.isSigner), isWritable: Boolean(k.isWritable) })),
    data: Buffer.from(i.data, "hex"),
  });
}

/** True when a failed simulation reads as the wallet not holding enough. */
function shortOfFunds(err: unknown, logs: string[] | null): boolean {
  const text = `${JSON.stringify(err)} ${(logs ?? []).join(" ")}`.toLowerCase();
  return /insufficient (funds|lamports)|insufficientfunds|"custom":1\b|accountnotfound|attempt to debit/.test(text);
}

async function buildOn(
  url: string,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  lookupTables: string[]
): Promise<SolanaBuild> {
  const conn = new Connection(url, { commitment: "confirmed" });
  const tables: AddressLookupTableAccount[] = [];
  for (const key of lookupTables) {
    const res = await conn.getAddressLookupTable(new PublicKey(key));
    if (!res.value) return { ok: false, reason: "invalid" };
    tables.push(res.value);
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const compile = (units: number) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }),
          ...ixs,
        ],
      }).compileToV0Message(tables)
    );

  const sim = await conn.simulateTransaction(compile(SIM_UNIT_LIMIT), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "processed",
  });
  if (sim.value.err) return { ok: false, reason: shortOfFunds(sim.value.err, sim.value.logs) ? "funds" : "invalid" };
  const used = sim.value.unitsConsumed ?? SIM_UNIT_LIMIT;
  const tx = compile(Math.min(1_400_000, Math.ceil(used * 1.3) + 5_000));
  return { ok: true, tx: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight };
}

/** The unsigned transaction for `payer` to sign, or why there is none. */
export async function buildSolanaTx(
  payer: string,
  instructions: RelaySolanaInstruction[],
  lookupTables: string[]
): Promise<SolanaBuild> {
  let payerKey: PublicKey;
  let ixs: TransactionInstruction[];
  try {
    payerKey = new PublicKey(payer);
    ixs = instructions.map(instruction);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  for (const url of rpcs()) {
    try {
      return await buildOn(url, payerKey, ixs, lookupTables);
    } catch {
      /* the next RPC */
    }
  }
  return { ok: false, reason: "rpc" };
}

/**
 * Send a signed transaction, and say why when Solana refuses it: "expired" (its
 * blockhash is gone, so it was approved too late), "refused" (it fails in
 * simulation: too little money, a bad account), or "rpc" (no node answered).
 * The first two can never land; nothing left the wallet.
 */
export async function sendSolanaTxChecked(signedBase64: string): Promise<{ ok: true; signature: string } | { ok: false; reason: "invalid" | "expired" | "refused" | "rpc"; detail?: string }> {
  let raw: Buffer;
  try {
    raw = Buffer.from(signedBase64, "base64");
    VersionedTransaction.deserialize(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  for (const url of rpcs()) {
    try {
      const signature = await new Connection(url, { commitment: "confirmed" }).sendRawTransaction(raw, { maxRetries: 5 });
      return { ok: true, signature };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/blockhash not found|block height exceeded|BlockhashNotFound/i.test(msg)) return { ok: false, reason: "expired" };
      if (/simulation failed|insufficient|custom program error|InstructionError/i.test(msg)) return { ok: false, reason: "refused", detail: msg.split("\n")[0]!.slice(0, 160) };
      /* a node that didn't answer: the next RPC */
    }
  }
  return { ok: false, reason: "rpc" };
}

/** Send a transaction a wallet signed but did not send itself. Returns its signature. */
export async function sendSolanaTx(signedBase64: string): Promise<string | null> {
  let raw: Buffer;
  try {
    raw = Buffer.from(signedBase64, "base64");
    VersionedTransaction.deserialize(raw);
  } catch {
    return null;
  }
  for (const url of rpcs()) {
    try {
      return await new Connection(url, { commitment: "confirmed" }).sendRawTransaction(raw, { maxRetries: 5 });
    } catch {
      /* the next RPC */
    }
  }
  return null;
}
