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
 *    cash out, a merge.
 *  - shielded pool deposit (15), alone in its transaction: a private account
 *    making money that arrived at its own address private (money brought over
 *    from another chain lands there first, lib/solanaRings/bridgeIn). The
 *    depositor is the signing private account and the relay is named nowhere in
 *    the instruction, so the relay's SOL can only pay the fee: a deposit
 *    creates no account and pays no rent. One deposit of one listed asset (SOL,
 *    USDC, USDT, ZEC), no memo, at least RELAYED_DEPOSIT_MIN of it, so the relay
 *    never pays to put dust into the pool. Counted as a payment by the route.
 *  - associated token account: CreateIdempotent (1) only, alongside a pool
 *    transact (the cash-out recipient's token account). When that account does
 *    not exist yet the relay pays its rent (about 0.002 SOL), so the route
 *    counts it with registrations (ataAccounts names them).
 * Exactly two signers, the relay and the private account: every extra
 * signature is another 5,000 lamports the relay would pay.
 * Version 1 transactions only (what the SDK builds): the priority fee is a
 * config value there, capped here, and there are no compute-budget
 * instructions to inspect. The page sets that fee from Helius's recommended
 * price (lib/solanaRings/landing priorityFeeFor), 10,000 lamports at least;
 * the cap bounds what one busy moment can cost the relay.
 */
import {
  AccountRole,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import { ringsAssets, RINGS_SOL_MINT, SOLANA_RINGS_NETWORK, type RingsNetwork } from "./config";

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
const POOL_DEPOSIT = 15;
const ATA_CREATE_IDEMPOTENT = 1;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]); // ggignore

/**
 * The least of each listed asset a relayed deposit may move, in base units:
 * 0.001 SOL, 0.10 USDC or USDT, 0.001 ZEC. Below it the relay doesn't pay (a
 * bridge delivers at least about a dollar).
 */
export const RELAYED_DEPOSIT_MIN: Readonly<Record<string, bigint>> = { sol: 1_000_000n, usdc: 100_000n, usdt: 100_000n, zec: 100_000n };

/** Mint (the system program's address for SOL) to the least a relayed deposit of it may move, for `network`'s listed assets. */
export function relayedDepositMins(network: RingsNetwork = SOLANA_RINGS_NETWORK): ReadonlyMap<string, bigint> {
  const out = new Map<string, bigint>();
  for (const a of ringsAssets(network)) {
    const min = RELAYED_DEPOSIT_MIN[a.id];
    if (min !== undefined) out.set(a.mint ?? RINGS_SOL_MINT, min);
  }
  return out;
}

export type RelayLimits = {
  /** Most priority fee the relay pays on one transaction, in lamports. */
  maxPriorityFeeLamports: bigint;
  maxComputeUnits: number;
  maxInstructions: number;
  /** The assets a relayed deposit may move (by mint) and the least of each. Defaults to this network's listed assets. */
  depositMins?: ReadonlyMap<string, bigint>;
};

export const RELAY_LIMITS: RelayLimits = { maxPriorityFeeLamports: 50_000n, maxComputeUnits: 1_400_000, maxInstructions: 4 };

export type RelayVerdict =
  | {
      ok: true;
      /**
       * "register" pays a registry record's rent; "transact" a payment, cash out
       * or merge; "deposit" a private account making its own arrived money private.
       */
      kind: "register" | "transact" | "deposit";
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

type DecodedIx = { programAddress: string; accounts?: readonly { address: string; role: AccountRole }[]; data?: Uint8Array };

/**
 * A deposit the relay may pay the fee for, or why not. The SDK's single direct
 * deposit (lib/solanaRings/bridgeIn buildRelayedDeposit):
 *   data: [15][1 asset][kind 0 = SOL | 1, bump = SPL][1 deposit][asset 0]
 *         [32 view tag][32 owner hash][u64 amount][memo 0]
 *   SOL:  tree, depositor (signer), pool, system program, SOL interface
 *   SPL:  tree, depositor (signer), pool, token program, mint, source token account, vault
 */
function readDeposit(ix: DecodedIx, relayer: string, mins: ReadonlyMap<string, bigint>): { ok: true } | { ok: false; reason: string } {
  const data = ix.data ?? new Uint8Array();
  const accounts = ix.accounts ?? [];
  const bad = (why: string) => ({ ok: false as const, reason: `pool instruction not allowed: ${why}` });
  if (data.length < 3 || data[1] !== 1) return bad("one asset per deposit");
  const sol = data[2] === 0;
  if (!sol && data[2] !== 1) return bad("unknown deposit asset");
  const at = sol ? 3 : 4; // where the deposit list starts
  if (data.length !== at + 2 + 32 + 32 + 8 + 1) return bad("one deposit, no memo");
  if (data[at] !== 1 || data[at + 1] !== 0) return bad("one deposit, no memo");
  if (data[at + 2 + 64 + 8] !== 0) return bad("one deposit, no memo");
  const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at + 2 + 64, true);
  if (accounts.length !== (sol ? 5 : 7)) return bad("unexpected deposit accounts");
  if (accounts.some((a) => a.address === relayer)) return bad("the relay is never part of a deposit");
  const depositor = accounts[1]!;
  if (depositor.role !== AccountRole.WRITABLE_SIGNER && depositor.role !== AccountRole.READONLY_SIGNER) return bad("the depositor must sign");
  if (accounts[2]!.address !== SHIELDED_POOL_PROGRAM) return bad("unexpected deposit accounts");
  if (sol ? accounts[3]!.address !== SYSTEM_PROGRAM : !TOKEN_PROGRAMS.has(accounts[3]!.address)) return bad("unexpected deposit accounts");
  const mint = sol ? RINGS_SOL_MINT : accounts[4]!.address;
  const min = mins.get(mint);
  if (min === undefined) return bad("not an asset Gloam lists");
  if (amount < min) return bad("deposit too small");
  return { ok: true };
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

  // The relay and the private account, nobody else. Solana charges the fee payer
  // 5,000 lamports a signature, and a version 1 transaction fits about 40 of them:
  // signers no instruction needs would make the relay pay over its fee cap.
  const signers = Object.keys(tx.signatures);
  if (signers.length < 2) return no("the private account must sign too");
  if (signers.length > 2) return no("only the private account signs with the relay");
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

  const mins = limits.depositMins ?? relayedDepositMins();
  let registry = false;
  let poolTransact = false;
  let deposit = false;
  let ata = false;
  const ataAccounts: string[] = [];
  for (const ix of ixs) {
    const program = ix.programAddress as string;
    const data = ix.data ?? new Uint8Array();
    const tag = data[0];
    if (program === USER_REGISTRY_PROGRAM) {
      if (tag === undefined || !REGISTRY_ALLOWED.has(tag)) return no("registry instruction not allowed");
      registry = true;
    } else if (program === SHIELDED_POOL_PROGRAM && tag === POOL_DEPOSIT) {
      const d = readDeposit(ix as DecodedIx, relayer, mins);
      if (!d.ok) return no(d.reason);
      deposit = true;
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
  if (deposit && ixs.length !== 1) return no("a deposit goes alone in its transaction");

  const programs = new Set<string>([...KNOWN_PROGRAMS, ...(ixs as readonly { programAddress: string }[]).map((ix) => ix.programAddress)]);
  const accounts = [...new Set(statics.filter((a) => a !== relayer && !programs.has(a) && !a.startsWith("Sysvar")))];
  return { ok: true, kind: registry ? "register" : deposit ? "deposit" : "transact", accounts, ataAccounts };
}

export type { Address };
