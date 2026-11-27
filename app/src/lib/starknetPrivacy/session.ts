/**
 * One open private account on Starknet, in the browser: its keys (from the
 * Gloam seed, lib/starknetPrivacy/account), the SDK wired to Gloam's routes
 * (reads through /api/starknet/rpc, proofs through /api/starknet/prove), and
 * each money move as the steps it takes, every transaction sent by Gloam's
 * relay (/api/starknet/relay).
 *
 * The prover reads state at least 10 blocks old and Starknet takes a proof only
 * when its block is 10 or more behind, so after each transaction the session
 * waits until 10 blocks have passed before it proves the next one (the SDK's
 * sequencing recipe). The page shows that wait as a step, never as a stall.
 * A session that didn't send the last transaction (a new tab, a reload, another
 * device) doesn't know its block, so before it proves it also checks the block
 * it proves at: the account is there (an open), and no note offered there has
 * been spent since (a payment or a cash out), each of which would make a proof
 * the pool can't take.
 *
 * Every proven move reads the relay again first: a fee, a relay address or a
 * pause that changed since the page loaded would have the relay refuse the
 * transaction after its proof was made (a proof is one of a small daily quota).
 *
 * The account's keys stay in this object, in this tab: never in storage.
 */
import { ProvingServiceProofProvider, SetupRequirement, type PrivateTransfersInterface } from "@starkware-libs/starknet-privacy-sdk";
import { Account, OutsideExecutionVersion, num, outsideExecution, type Call, type RpcProvider, type constants } from "starknet";
import type { StarknetAccountKeys } from "./account";
import { deployAccountCall } from "./account";
import { STARKNET_PROXY_PATHS, type StarknetNetworkConfig, type StarknetToken } from "./config";
import { add as addAction, approveCall, cashOut as cashOutAction, openAccount, pay as payAction, privateBalance, type RelayFee } from "./actions";
import { discoveryFor, gloamTransfers, starknetProvider } from "./client";

/** Blocks a proof's state must sit behind the chain head (the SDK's recipe and the sequencer's rule). */
export const PROOF_DEPTH = 10;

/** How long the page follows a transaction the relay sent before it says it can't tell yet. */
export const CONFIRM_MS = 5 * 60_000;

/** The node's JSON-RPC error code on a failed read (starknet.js RpcError), or null. */
function rpcCode(e: unknown): number | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "number" ? c : null;
}
const CONTRACT_NOT_FOUND = 20;
const BLOCK_NOT_FOUND = 24;

/** Relay answers that sent nothing and can pass the next time: the same proof can go again. */
const RESEND_SAME_PROOF = new Set(["relay_busy", "upstream_unavailable"]);

type Receipt = { finality_status?: string; execution_status?: string; block_number?: number; revert_reason?: string };

export type StarknetRelayInfo = {
  on: boolean;
  funded: boolean;
  /** "off": the relay sends no add, payment or cash out (mainnet with no fee and no sponsored budget). Absent from an older relay: on. */
  moves?: "on" | "off";
  relayer: string | null;
  network: string;
  pool: string | null;
  /** Base units per token address (lowercase hex). */
  fee: Record<string, string>;
  maxApprove: Record<string, string>;
};

/** Names the step a money move is on: one of its steps by index, with an optional detail. */
export type StepReporter = (at: number, detail?: string) => void;

export class StarknetRelayError extends Error {
  override readonly name = "StarknetRelayError";
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Gloam's relay, as the page sees it. */
export async function readRelayInfo(base = ""): Promise<StarknetRelayInfo> {
  const res = await fetch(`${base}${STARKNET_PROXY_PATHS.relay}`, { cache: "no-store" });
  if (!res.ok) throw new StarknetRelayError("relay_unavailable", "Gloam's Starknet relay can't be reached.");
  return (await res.json()) as StarknetRelayInfo;
}

export class StarknetSession {
  readonly provider: RpcProvider;
  readonly transfers: PrivateTransfersInterface;
  private readonly signer: Account;
  /** The block of the last transaction this session saw land (0: none yet). */
  private lastBlock = 0;
  private relayNow: StarknetRelayInfo;

  constructor(
    readonly cfg: StarknetNetworkConfig,
    readonly keys: StarknetAccountKeys,
    relayInfo: StarknetRelayInfo,
    /** The page's origin ("https://www.gloam.trade"); routes are called on it. */
    private readonly origin: string,
    /** Wait between polls. Mainnet makes a block about every 1.7 seconds (read 2026-11-27). Tests pass a short one. */
    private readonly pollMs = 1_000
  ) {
    this.relayNow = relayInfo;
    if (!cfg.pool) throw new Error(`No Starknet privacy pool is set for ${cfg.network}.`);
    const rpcUrl = `${origin}${STARKNET_PROXY_PATHS.rpc}`;
    this.provider = starknetProvider(rpcUrl);
    // A proof can take minutes on mainnet: the route waits up to 270 s, then says busy, and a retry finds the same job.
    const prover = new ProvingServiceProofProvider(`${origin}${STARKNET_PROXY_PATHS.prove}`, cfg.chainId as constants.StarknetChainId, {
      nodeUrl: rpcUrl,
      poolAddress: cfg.pool,
      requestTimeoutMs: 290_000,
      retry: { maxRetries: 4, baseDelayMs: 2_000 },
    });
    this.transfers = gloamTransfers({ cfg, keys, prover, discovery: discoveryFor(cfg, this.provider, `${origin}${STARKNET_PROXY_PATHS.discovery}`) });
    this.signer = new Account({ provider: this.provider, address: keys.address, signer: num.toHex(keys.accountKey), cairoVersion: "1" });
  }

  get address(): string {
    return this.keys.address;
  }

  get relayer(): string | null {
    return this.relayNow.relayer;
  }

  /** The relay as this session last read it (the page shows its fee and whether it is paused). */
  get relayInfo(): StarknetRelayInfo {
    return this.relayNow;
  }

  /** The relay's fee on `token`, or null when it asks none. */
  feeFor(token: StarknetToken): RelayFee | null {
    return relayFee(this.relayNow, token);
  }

  /** Most one add may move (the relay's cap on an approve). */
  maxAdd(token: StarknetToken): bigint {
    return BigInt(this.relayNow.maxApprove[num.toHex(BigInt(token.address))] ?? "0");
  }

  /** Read the relay again; whether what a proof pays it changed (its fee on `token`, or its address). */
  async refreshRelay(token: StarknetToken | null = this.cfg.tokens[0] ?? null): Promise<boolean> {
    const was = this.relayNow;
    const now = await readRelayInfo(this.origin);
    this.relayNow = now;
    const fee = (r: StarknetRelayInfo) => (token ? (relayFee(r, token)?.amount ?? 0n) : 0n);
    return now.relayer !== was.relayer || fee(now) !== fee(was);
  }

  /**
   * Before a proven move: the relay is on and funded, sends moves at all, and
   * asks the fee the page showed (`token` null: a move with no fee, the open).
   * Anything else stops the move here, before its proof is made, with the relay
   * read again for the page.
   */
  private async checkRelay(token: StarknetToken | null): Promise<void> {
    const changed = await this.refreshRelay(token);
    if (!this.relayNow.on || !this.relayNow.funded || !this.relayNow.relayer) {
      throw new StarknetRelayError("relay_paused", "Private payments on Starknet are paused for a moment. Try again later.");
    }
    // The relay would refuse the move after its proof (fee_unset): say so before proving.
    if (token && this.relayNow.moves === "off") {
      throw new StarknetRelayError("moves_off", "Adding, paying and cashing out on Starknet aren't open yet. Nothing was sent. Try again later.");
    }
    if (changed && token) throw new StarknetRelayError("relay_changed", "Gloam's fee on Starknet just changed. Check it and try again.");
  }

  /**
   * Whether the account is deployed, at `block` or now. A node that can't
   * answer throws: that is never "not deployed" (which would forget a kept
   * account, or ask the relay to deploy one that is there).
   */
  async deployed(block?: number): Promise<boolean> {
    try {
      await this.provider.getClassHashAt(this.keys.address, block);
      return true;
    } catch (e) {
      const code = rpcCode(e);
      if (code === CONTRACT_NOT_FOUND || (block !== undefined && code === BLOCK_NOT_FOUND)) return false;
      throw e;
    }
  }

  /** Whether the account this device kept is still open here (deployed and registered); throws when the node can't say. */
  async stillOpen(token: StarknetToken): Promise<boolean> {
    return (await this.deployed()) && (await this.ready(token));
  }

  /** Whether the account is registered with its own channel for `token` (ready to add, pay and cash out). */
  async ready(token: StarknetToken): Promise<boolean> {
    return (await this.transfers.discoverRequirement(this.keys.address, token.address)) === SetupRequirement.Ready;
  }

  /** Whether `to` has a private account here that can be paid. */
  async canBePaid(to: string, token: StarknetToken): Promise<boolean> {
    return (await this.transfers.discoverRequirement(to, token.address)) !== SetupRequirement.Register;
  }

  /** Send one call through Gloam's relay; the transaction hash. */
  async relay(calls: Call[], proof?: { proofFacts: readonly string[]; data: string }): Promise<string> {
    const res = await fetch(`${this.origin}${STARKNET_PROXY_PATHS.relay}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        calls: calls.map((c) => ({ contractAddress: c.contractAddress, entrypoint: c.entrypoint, calldata: ((c.calldata ?? []) as (string | number | bigint)[]).map((x) => num.toHex(x)) })),
        ...(proof ? { proof: { proofFacts: proof.proofFacts.map((f) => num.toHex(f)), proof: proof.data } } : {}),
      }),
    });
    let body: { ok?: boolean; txHash?: string; error?: { code?: string; message?: string } } = {};
    try {
      body = await res.json();
    } catch {
      /* fall through */
    }
    if (!res.ok || !body.ok || !body.txHash) {
      throw new StarknetRelayError(body.error?.code ?? "relay_failed", body.error?.message ?? "Gloam's Starknet relay couldn't send it. Try again.");
    }
    return body.txHash;
  }

  /**
   * Wait for `txHash` to be accepted on Starknet; its block number. Asks at
   * once and then every poll (starknet.js's waitForTransaction sleeps a full
   * interval before its first look and again after the receipt).
   */
  async confirm(txHash: string): Promise<number> {
    const started = Date.now();
    for (let tries = 0; ; tries++) {
      if (tries) await sleep(this.pollMs);
      let r: Receipt | null = null;
      try {
        r = (await this.provider.getTransactionReceipt(txHash)) as unknown as Receipt;
      } catch {
        // Not in a block yet, or the node didn't answer: ask again.
      }
      if (r && (r.finality_status === "ACCEPTED_ON_L2" || r.finality_status === "ACCEPTED_ON_L1")) {
        if (r.execution_status === "REVERTED") throw new Error(`Starknet reverted it${r.revert_reason ? `: ${r.revert_reason.slice(0, 160)}` : "."}`);
        const block = Number(r.block_number ?? (await this.provider.getBlockNumber()));
        this.lastBlock = Math.max(this.lastBlock, block);
        return block;
      }
      if (Date.now() - started > CONFIRM_MS) {
        throw new StarknetRelayError("unconfirmed", "Starknet hasn't confirmed it yet. It may still go through, so check your balance before you try again.");
      }
    }
  }

  /**
   * Wait until the last transaction is PROOF_DEPTH blocks behind the head, and
   * `until` (when given) holds at the block that leaves; the block to prove at.
   * Where notes are read from the pool directly (devnet and Sepolia: the SDK's
   * contract reader reads the latest state, not the block a proof is pinned
   * to), a payment that arrived in the last few blocks could be picked while
   * the proof's block doesn't have it yet, so a spend there waits for the whole
   * head to settle, not only this account's own last transaction. The hosted
   * discovery service (mainnet) reads at the proof's block.
   */
  async settle(onWait?: (left: number) => void, spend = false, until?: (at: number) => Promise<boolean>): Promise<number> {
    if (spend && this.cfg.discovery.kind === "contract") this.lastBlock = Math.max(this.lastBlock, await this.provider.getBlockNumber());
    const started = Date.now();
    for (;;) {
      const head = await this.provider.getBlockNumber();
      const left = this.lastBlock + PROOF_DEPTH + 1 - head;
      if (left <= 0 && (!until || (await until(head - PROOF_DEPTH)))) return head - PROOF_DEPTH;
      // A count when it is known; 0 when the wait is for a block it can't name (`until`).
      onWait?.(Math.max(left, 0));
      if (Date.now() - started > 15 * 60_000) throw new Error("Starknet is slow to make blocks. Try again in a few minutes.");
      await sleep(this.pollMs);
    }
  }

  /**
   * Whether a note the proof at `at` would see has been spent since then (in
   * another tab, or just before a reload): proving there would spend it twice,
   * and the relay could not send it. Hosted discovery only (it reads at a block).
   */
  async spentSince(at: number, token: StarknetToken): Promise<boolean> {
    const tokens = [BigInt(token.address)];
    const [then, now] = await Promise.all([
      this.transfers.discoverNotes({ tokens, blockIdentifier: at }),
      this.transfers.discoverNotes({ tokens, blockIdentifier: "latest" }),
    ]);
    const ids = (r: { notes: { get(k: string): { id: unknown }[] | undefined } }) => (r.notes.get(token.address) ?? []).map((n) => BigInt(n.id as bigint | string));
    const live = new Set(ids(now as never));
    return ids(then as never).some((id) => !live.has(id));
  }

  /** The block a payment or a cash out proves at: settled, and, when this session didn't send the last transaction, nothing spent since. */
  private settleSpend(token: StarknetToken, onWait: (left: number) => void): Promise<number> {
    const blind = this.lastBlock === 0 && this.cfg.discovery.kind === "indexer";
    return this.settle(onWait, true, blind ? async (at) => !(await this.spentSince(at, token)) : undefined);
  }

  /**
   * Send a proven call through the relay and wait for it. A proof is one of a
   * small daily quota, so when the relay answers that it sent nothing for a
   * moment (busy with another send, or the node slow to answer its checks),
   * the same proof goes again, up to three more times, rather than the move
   * failing and a retry proving it again.
   */
  private async sendProven(r: { callAndProof: { call: Call; proof: { proofFacts: readonly string[]; data: string } } }): Promise<string> {
    let hash: string | null = null;
    for (let tries = 0; hash === null; tries++) {
      try {
        hash = await this.relay([r.callAndProof.call], r.callAndProof.proof);
      } catch (e) {
        if (tries >= 3 || !(e instanceof StarknetRelayError) || !RESEND_SAME_PROOF.has(e.code)) throw e;
        await sleep(this.pollMs * 2 ** (tries + 1));
      }
    }
    await this.confirm(hash);
    return hash;
  }

  /**
   * Make sure the account exists and is open: deploy it (the relay pays), then
   * register its viewing key and open its own channel for every listed token,
   * in one transaction. Steps: 0 setting up the account, 1 waiting for Starknet,
   * 2 opening the private account.
   *
   * An account deployed before this session (a reload or a retry after the
   * deploy landed) has a deploy block this session doesn't know: the proof
   * waits for a block where the account is there, or the prover can't run it.
   */
  async ensureOpen(step: StepReporter): Promise<void> {
    const token = this.cfg.tokens[0];
    if (!token) throw new Error("No token is listed for Starknet here.");
    let fresh = false;
    if (!(await this.deployed())) {
      step(0);
      await this.checkRelay(null);
      try {
        await this.confirm(await this.relay([deployAccountCall(this.keys.publicKey, this.cfg.accountClassHash)]));
        fresh = true;
      } catch (e) {
        // Deployed in the meantime (another tab): open it as an account deployed before.
        if (!(e instanceof StarknetRelayError && e.code === "already_deployed")) throw e;
      }
    }
    // An account this call just deployed can't be registered yet: no need to ask.
    if (!fresh && (await this.ready(token))) return;
    if (!fresh) await this.checkRelay(null);
    step(1);
    const at = await this.settle((left) => step(1, waitText(left)), false, fresh ? undefined : (b) => this.deployed(b));
    step(2);
    const r = await openAccount(this.transfers, { self: this.keys.address, tokens: this.cfg.tokens.map((t) => t.address), provingBlockId: at });
    await this.sendProven(r);
  }

  /** The account's own token balance on Starknet (what arrived at its address, not yet private). */
  async publicBalance(token: StarknetToken): Promise<bigint> {
    const r = await this.provider.callContract({ contractAddress: token.address, entrypoint: "balance_of", calldata: [this.keys.address] });
    return BigInt(r[0] ?? "0x0") + (BigInt(r[1] ?? "0x0") << 128n);
  }

  /** The private balance of `token`. */
  privateBalance(token: StarknetToken): Promise<bigint> {
    return privateBalance(this.transfers, token.address);
  }

  /**
   * Add `amount` of what sits at the account's address to the private balance.
   * Steps: 0 approving, 1 waiting for Starknet, 2 adding privately.
   */
  async add(token: StarknetToken, amount: bigint, step: StepReporter): Promise<string> {
    step(0);
    await this.checkRelay(token);
    const fee = this.feeFor(token);
    const cap = this.maxAdd(token);
    if (amount > cap) throw new StarknetRelayError("over_cap", "That is more than one add can move. Add it in smaller parts.");
    const now = Math.floor(Date.now() / 1000);
    const outside = await this.signer.getOutsideTransaction(
      { caller: this.relayNow.relayer!, execute_after: now - 60, execute_before: now + 600 },
      [approveCall(token.address, this.cfg.pool!, amount)],
      OutsideExecutionVersion.V2
    );
    await this.confirm(await this.relay(outsideExecution.buildExecuteFromOutsideCall(outside)));
    step(1);
    const at = await this.settle((left) => step(1, waitText(left)));
    step(2);
    // A deposit carries Starknet's screening attestation, good for 300 seconds: a proof that
    // came back too late to send is made again once (the relay refuses a stale one before paying).
    for (let tries = 0; ; tries++) {
      const r = await addAction(this.transfers, { token: token.address, self: this.keys.address, amount, fee, provingBlockId: at });
      try {
        return await this.sendProven(r);
      } catch (e) {
        if (tries === 0 && e instanceof StarknetRelayError && e.code === "screening_expired") continue;
        throw e;
      }
    }
  }

  /** Pay `amount` privately to the private account `to`. Steps: 0 waiting for Starknet, 1 paying privately. */
  async pay(to: string, token: StarknetToken, amount: bigint, step: StepReporter): Promise<string> {
    step(0);
    await this.checkRelay(token);
    const at = await this.settleSpend(token, (left) => step(0, waitText(left)));
    step(1);
    const r = await payAction(this.transfers, { token: token.address, self: this.keys.address, to, amount, fee: this.feeFor(token), provingBlockId: at });
    return this.sendProven(r);
  }

  /** Cash out `amount` to the public address `to`. Steps: 0 waiting for Starknet, 1 cashing out. */
  async cashOut(to: string, token: StarknetToken, amount: bigint, step: StepReporter): Promise<string> {
    step(0);
    await this.checkRelay(token);
    const at = await this.settleSpend(token, (left) => step(0, waitText(left)));
    step(1);
    const r = await cashOutAction(this.transfers, { token: token.address, self: this.keys.address, to, amount, fee: this.feeFor(token), provingBlockId: at });
    return this.sendProven(r);
  }
}

/** The relay's fee on `token` in `info`, or null when it asks none. */
export function relayFee(info: Pick<StarknetRelayInfo, "fee" | "relayer">, token: Pick<StarknetToken, "address">): RelayFee | null {
  const amount = BigInt(info.fee[num.toHex(BigInt(token.address))] ?? "0");
  return amount > 0n && info.relayer ? { recipient: info.relayer, amount } : null;
}

/** What a wait for blocks says: the count when it is known (0: a block it can't name yet). */
export function waitText(left: number): string {
  if (left <= 0) return "A few more blocks";
  return left === 1 ? "One more block" : `${left} more blocks`;
}
