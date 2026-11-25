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

export type StarknetRelayInfo = {
  on: boolean;
  funded: boolean;
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
  private lastBlock = 0;

  constructor(
    readonly cfg: StarknetNetworkConfig,
    readonly keys: StarknetAccountKeys,
    private readonly relayInfo: StarknetRelayInfo,
    /** The page's origin ("https://www.gloam.trade"); routes are called on it. */
    private readonly origin: string,
    /** Wait between polls (tests pass a short one). */
    private readonly pollMs = 2_000
  ) {
    if (!cfg.pool) throw new Error(`No Starknet privacy pool is set for ${cfg.network}.`);
    const rpcUrl = `${origin}${STARKNET_PROXY_PATHS.rpc}`;
    this.provider = starknetProvider(rpcUrl);
    const prover = new ProvingServiceProofProvider(`${origin}${STARKNET_PROXY_PATHS.prove}`, cfg.chainId as constants.StarknetChainId, {
      nodeUrl: rpcUrl,
      poolAddress: cfg.pool,
      requestTimeoutMs: 60_000,
    });
    this.transfers = gloamTransfers({ cfg, keys, prover, discovery: discoveryFor(cfg, this.provider) });
    this.signer = new Account({ provider: this.provider, address: keys.address, signer: num.toHex(keys.accountKey), cairoVersion: "1" });
  }

  get address(): string {
    return this.keys.address;
  }

  get relayer(): string | null {
    return this.relayInfo.relayer;
  }

  /** The relay's fee on `token`, or null when it asks none. */
  feeFor(token: StarknetToken): RelayFee | null {
    const amount = BigInt(this.relayInfo.fee[num.toHex(BigInt(token.address))] ?? "0");
    return amount > 0n && this.relayInfo.relayer ? { recipient: this.relayInfo.relayer, amount } : null;
  }

  /** Most one add may move (the relay's cap on an approve). */
  maxAdd(token: StarknetToken): bigint {
    return BigInt(this.relayInfo.maxApprove[num.toHex(BigInt(token.address))] ?? "0");
  }

  /** Whether the account is deployed on chain yet. */
  async deployed(): Promise<boolean> {
    try {
      await this.provider.getClassHashAt(this.keys.address);
      return true;
    } catch {
      return false;
    }
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

  /** Wait for `txHash` to land; its block number. */
  async confirm(txHash: string): Promise<number> {
    const receipt = (await this.provider.waitForTransaction(txHash, { retryInterval: this.pollMs })) as unknown as {
      block_number?: number;
      isSuccess?: () => boolean;
      revert_reason?: string;
    };
    if (receipt.isSuccess && !receipt.isSuccess()) throw new Error(`Starknet reverted it${receipt.revert_reason ? `: ${receipt.revert_reason.slice(0, 160)}` : "."}`);
    const block = Number(receipt.block_number ?? (await this.provider.getBlockNumber()));
    this.lastBlock = Math.max(this.lastBlock, block);
    return block;
  }

  /**
   * Wait until the last transaction is PROOF_DEPTH blocks behind the head; the
   * block to prove at. Where notes are read from the pool directly (devnet and
   * Sepolia: the SDK's contract reader reads the latest state, not the block a
   * proof is pinned to), a payment that arrived in the last few blocks could be
   * picked while the proof's block doesn't have it yet, so a spend there waits
   * for the whole head to settle, not only this account's own last transaction.
   * The hosted discovery service (mainnet) reads at the proof's block.
   */
  async settle(onWait?: (left: number) => void, spend = false): Promise<number> {
    if (spend && this.cfg.discovery.kind === "contract") this.lastBlock = Math.max(this.lastBlock, await this.provider.getBlockNumber());
    const started = Date.now();
    for (;;) {
      const head = await this.provider.getBlockNumber();
      const left = this.lastBlock + PROOF_DEPTH + 1 - head;
      if (left <= 0) return head - PROOF_DEPTH;
      onWait?.(left);
      if (Date.now() - started > 15 * 60_000) throw new Error("Starknet is slow to make blocks. Try again in a few minutes.");
      await sleep(this.pollMs);
    }
  }

  private async sendProven(r: { callAndProof: { call: Call; proof: { proofFacts: readonly string[]; data: string } } }): Promise<string> {
    const hash = await this.relay([r.callAndProof.call], r.callAndProof.proof);
    await this.confirm(hash);
    return hash;
  }

  /**
   * Make sure the account exists and is open: deploy it (the relay pays), then
   * register its viewing key and open its own channel for every listed token,
   * in one transaction. Steps: 0 setting up the account, 1 waiting for Starknet,
   * 2 opening the private account.
   */
  async ensureOpen(step: StepReporter): Promise<void> {
    const token = this.cfg.tokens[0];
    if (!token) throw new Error("No token is listed for Starknet here.");
    if (!(await this.deployed())) {
      step(0);
      await this.confirm(await this.relay([deployAccountCall(this.keys.publicKey, this.cfg.accountClassHash)]));
    }
    if (await this.ready(token)) return;
    step(1);
    const at = await this.settle((left) => step(1, waitText(left)));
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
    const fee = this.feeFor(token);
    step(0);
    const now = Math.floor(Date.now() / 1000);
    const outside = await this.signer.getOutsideTransaction(
      { caller: this.relayInfo.relayer!, execute_after: now - 60, execute_before: now + 600 },
      [approveCall(token.address, this.cfg.pool!, amount)],
      OutsideExecutionVersion.V2
    );
    await this.confirm(await this.relay(outsideExecution.buildExecuteFromOutsideCall(outside)));
    step(1);
    const at = await this.settle((left) => step(1, waitText(left)));
    step(2);
    const r = await addAction(this.transfers, { token: token.address, self: this.keys.address, amount, fee, provingBlockId: at });
    return this.sendProven(r);
  }

  /** Pay `amount` privately to the private account `to`. Steps: 0 waiting for Starknet, 1 paying privately. */
  async pay(to: string, token: StarknetToken, amount: bigint, step: StepReporter): Promise<string> {
    step(0);
    const at = await this.settle((left) => step(0, waitText(left)), true);
    step(1);
    const r = await payAction(this.transfers, { token: token.address, self: this.keys.address, to, amount, fee: this.feeFor(token), provingBlockId: at });
    return this.sendProven(r);
  }

  /** Cash out `amount` to the public address `to`. Steps: 0 waiting for Starknet, 1 cashing out. */
  async cashOut(to: string, token: StarknetToken, amount: bigint, step: StepReporter): Promise<string> {
    step(0);
    const at = await this.settle((left) => step(0, waitText(left)), true);
    step(1);
    const r = await cashOutAction(this.transfers, { token: token.address, self: this.keys.address, to, amount, fee: this.feeFor(token), provingBlockId: at });
    return this.sendProven(r);
  }
}

function waitText(left: number): string {
  return left <= 1 ? "One more block" : `${left} more blocks`;
}
