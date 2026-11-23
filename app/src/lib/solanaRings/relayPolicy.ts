/**
 * What Gloam's Solana relay (/api/solana/relay) will pay the fee for. The relay
 * co-signs as fee payer, so anything it signs can spend its SOL: it signs only
 * a Privacy Rings transaction built by the SDK for a Gloam private account,
 * already signed by that account, and nothing that could move its own SOL
 * beyond the fee and a bounded rent. Pure rules, checked by
 * scripts/selftest-solana-rings.mts.
 *
 * Allowed instructions:
 *  - user registry: register (0) and setMergeEncryption (1). The relay pays the
 *    record's rent (about 0.0016 SOL), so registrations are rate limited.
 *  - shielded pool: transact (16) and mergeTransact (17): a private payment, a
 *    cash out, a merge. Never deposit (15): with the relay as depositor that
 *    would move the relay's own SOL into someone's private balance.
 *  - associated token account: CreateIdempotent (1) only, alongside a pool
 *    transact (the cash-out recipient's token account). When that account does
 *    not exist yet the relay pays its rent (about 0.002 SOL), so the route
 *    counts it with registrations (ataAccounts names them).
 * Version 1 transactions only (what the SDK builds): the priority fee is a
 * config value there, capped here, and there are no compute-budget
 * instructions to inspect. The page sets that fee from Helius's recommended
 * price (lib/solanaRings/landing priorityFeeFor), 10,000 lamports at least;
 * the cap bounds what one busy moment can cost the relay.
 */
import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";

export const SHIELDED_POOL_PROGRAM = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
export const USER_REGISTRY_PROGRAM = "regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Programs and well-known accounts that are never anyone's wallet: not screened. */
const KNOWN_PROGRAMS = [
  SHIELDED_POOL_PROGRAM,
  USER_REGISTRY_PROGRAM,
  ATA_PROGRAM,
  "11111111111111111111111111111111",
  // public Solana program ids (SPL Token, Token-2022), not secrets
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // ggignore
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // ggignore
  "ComputeBudget111111111111111111111111111111",
];

const REGISTRY_ALLOWED = new Set([0, 1]);
const POOL_ALLOWED = new Set([16, 17]);
const ATA_CREATE_IDEMPOTENT = 1;

export type RelayLimits = {
  /** Most priority fee the relay pays on one transaction, in lamports. */
  maxPriorityFeeLamports: bigint;
  maxComputeUnits: number;
  maxInstructions: number;
};

export const RELAY_LIMITS: RelayLimits = { maxPriorityFeeLamports: 50_000n, maxComputeUnits: 1_400_000, maxInstructions: 4 };

export type RelayVerdict =
  | {
      ok: true;
      /** "register" pays a registry record's rent; "transact" a payment, cash out or merge. */
      kind: "register" | "transact";
      /** Every account the transaction names, but the programs and the relay: what the relay screens. */
      accounts: string[];
      /** Token accounts the transaction creates if missing (the relay pays their rent). */
      ataAccounts: string[];
    }
  | { ok: false; reason: string };

const no = (reason: string): RelayVerdict => ({ ok: false, reason });

function isEmptySignature(s: Uint8Array | null | undefined): boolean {
  return !s || s.every((b) => b === 0);
}

/** Decide whether the relay may co-sign `wire` (a serialized transaction) as `relayer`. */
export function checkSponsoredTransaction(wire: Uint8Array, relayer: string, limits: RelayLimits = RELAY_LIMITS): RelayVerdict {
  let tx: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    tx = getTransactionDecoder().decode(wire);
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    return no("not a Solana transaction");
  }
  if (compiled.version !== 1) return no("only version 1 transactions");
  const statics = compiled.staticAccounts as readonly string[];
  if (statics[0] !== relayer) return no("the relay must be the fee payer");

  const signers = Object.keys(tx.signatures);
  if (signers.length < 2) return no("the private account must sign too");
  for (const [who, sig] of Object.entries(tx.signatures)) {
    if (who === relayer) {
      if (!isEmptySignature(sig as Uint8Array | null)) return no("the relay signs last");
    } else if (isEmptySignature(sig as Uint8Array | null)) {
      return no("a required signature is missing");
    }
  }

  let message: ReturnType<typeof decompileTransactionMessage>;
  try {
    message = decompileTransactionMessage(compiled as never);
  } catch {
    return no("unreadable message");
  }
  const config = (message as { config?: { computeUnitLimit?: number; priorityFeeLamports?: bigint } }).config ?? {};
  if ((config.priorityFeeLamports ?? 0n) > limits.maxPriorityFeeLamports) return no("priority fee too high");
  if ((config.computeUnitLimit ?? 0) > limits.maxComputeUnits) return no("compute limit too high");

  const ixs = message.instructions;
  if (ixs.length === 0 || ixs.length > limits.maxInstructions) return no("unexpected number of instructions");

  let registry = false;
  let poolTransact = false;
  let ata = false;
  const ataAccounts: string[] = [];
  for (const ix of ixs) {
    const program = ix.programAddress as string;
    const data = ix.data ?? new Uint8Array();
    const tag = data[0];
    if (program === USER_REGISTRY_PROGRAM) {
      if (tag === undefined || !REGISTRY_ALLOWED.has(tag)) return no("registry instruction not allowed");
      registry = true;
    } else if (program === SHIELDED_POOL_PROGRAM) {
      if (tag === undefined || !POOL_ALLOWED.has(tag)) return no("pool instruction not allowed");
      poolTransact = true;
    } else if (program === ATA_PROGRAM) {
      if (data.length !== 1 || tag !== ATA_CREATE_IDEMPOTENT) return no("token account instruction not allowed");
      // accounts: funder, the new token account, its owner, mint, system, token program
      const funder = ix.accounts?.[0]?.address as string | undefined;
      const created = ix.accounts?.[1]?.address as string | undefined;
      if (funder !== relayer || !created) return no("token account instruction not allowed");
      ataAccounts.push(created);
      ata = true;
    } else {
      return no(`program not allowed: ${program}`);
    }
  }
  if (ata && !poolTransact) return no("a token account only with a cash out");
  if (registry && poolTransact) return no("register and pay in separate transactions");

  const programs = new Set<string>([...KNOWN_PROGRAMS, ...(ixs as readonly { programAddress: string }[]).map((ix) => ix.programAddress)]);
  const accounts = [...new Set(statics.filter((a) => a !== relayer && !programs.has(a) && !a.startsWith("Sysvar")))];
  return { ok: true, kind: registry ? "register" : "transact", accounts, ataAccounts };
}

export type { Address };
