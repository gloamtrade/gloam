/**
 * Starkscan's STRK20 prover relay (starkscan.co/docs/api/strk20-prover), the
 * mainnet prover: a job API, not the SDK's JSON-RPC proving service. POST the
 * transaction and the block to prove at, then poll the job until it is done.
 * Mainnet only ("There is no Sepolia prover"); prove scope is issued by
 * Starkscan to an approved key (the Starknet Foundation whitelists Gloam's key
 * by its id, never its value).
 *
 *  - starkscanProve: one proof, as the proving service's result shape
 *    ({ proof, proof_facts, l2_to_l1_messages, additional_data }), so
 *    /api/starknet/prove answers the SDK's ProvingServiceProofProvider in the
 *    browser exactly as a proving service would.
 *  - StarkscanProofProvider: the same as an SDK ProofProviderInterface, for code
 *    that proves on the server (the SDK, the MCP).
 *
 * The key stays on the server. A request is keyed by a hash of its body
 * (Idempotency-Key), so a retried submit finds the same job. Results are given
 * once and then dropped by Starkscan, so a poll that loses its answer cannot
 * get it again: the caller proves again.
 */
import { ProvingServiceProofProvider, type Proof, type ProofInvocation, type ProofProviderInterface, type ProvingBlockId } from "@starkware-libs/starknet-privacy-sdk";
import type { constants } from "starknet";

export type StarkscanProveResult = {
  proof: string;
  proof_facts: string[];
  l2_to_l1_messages: { from_address: string; to_address: string; payload: string[] }[];
  additional_data?: { signature?: { issued_at: number; sig_r: string; sig_s: string } };
};

export type StarkscanErrorCode = "no_key" | "no_scope" | "relay_off" | "rejected" | "failed" | "timeout" | "bad_answer" | "unavailable" | "lost";

export class StarkscanProveError extends Error {
  override readonly name = "StarkscanProveError";
  constructor(
    readonly code: StarkscanErrorCode,
    message: string
  ) {
    super(message);
  }
}

export type StarkscanOptions = {
  /** https://api.starkscan.co/v1/SN_MAIN/prove */
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Give up after this long, submit and polls together. */
  timeoutMs?: number;
  /** Wait between polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
};

const MAX_BODY = 1024 * 1024;
const TERMINAL = new Set(["succeeded", "failed", "unavailable", "unknown_delivery"]);

type Job = {
  jobId?: unknown;
  status?: unknown;
  terminal?: unknown;
  pollAfterSeconds?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | unknown;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The block a proof is pinned to, in the API's shape: { block_number } or { block_hash } or a tag. */
function blockParam(b: ProvingBlockId | undefined): unknown {
  if (b === undefined) return "latest";
  if (typeof b === "number" || typeof b === "bigint") return { block_number: Number(b) };
  return b;
}

function asResult(x: unknown): StarkscanProveResult | null {
  const r = x as Partial<StarkscanProveResult> | null;
  if (!r || typeof r !== "object") return null;
  if (typeof r.proof !== "string" || !Array.isArray(r.proof_facts) || !Array.isArray(r.l2_to_l1_messages)) return null;
  if (!r.proof_facts.every((f) => typeof f === "string")) return null;
  for (const m of r.l2_to_l1_messages) {
    if (!m || typeof m.from_address !== "string" || !Array.isArray(m.payload) || !m.payload.every((p) => typeof p === "string")) return null;
  }
  return r as StarkscanProveResult;
}

function jobError(j: Job): string {
  const e = j.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message.slice(0, 300) : `The prover answered ${String(j.status ?? "with an error")}.`;
}

/** Prove one transaction at `blockId` through Starkscan, waiting for the job. */
export async function starkscanProve(opts: StarkscanOptions, blockId: ProvingBlockId | undefined, transaction: unknown): Promise<StarkscanProveResult> {
  if (!opts.apiKey) throw new StarkscanProveError("no_key", "No Starkscan key is set.");
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + (opts.timeoutMs ?? 50_000);
  const body = JSON.stringify({ block_id: blockParam(blockId), transaction });
  if (body.length > MAX_BODY) throw new StarkscanProveError("rejected", "That transaction is too large to prove.");
  const idem = `gloam-${(await sha256Hex(body)).slice(0, 48)}`;
  const headers = { "content-type": "application/json", "X-Starkscan-Api-Key": opts.apiKey };

  const read = async (res: Response): Promise<Job> => {
    try {
      return (await res.json()) as Job;
    } catch {
      throw new StarkscanProveError("bad_answer", "The prover's answer could not be read.");
    }
  };
  const httpError = (status: number, j: Job | null): StarkscanProveError => {
    if (status === 403) return new StarkscanProveError("no_scope", "Gloam's Starkscan key can't prove yet.");
    if (status === 404) return new StarkscanProveError("relay_off", "Starkscan's prover is not on right now.");
    if (status === 429 || status === 503) return new StarkscanProveError("unavailable", "The prover is busy. Try again shortly.");
    if (status >= 400 && status < 500) return new StarkscanProveError("rejected", j ? jobError(j) : `The prover refused it (${status}).`);
    return new StarkscanProveError("unavailable", `The prover answered ${status}.`);
  };

  let res: Response;
  try {
    res = await f(opts.url, { method: "POST", headers: { ...headers, "Idempotency-Key": idem }, body, signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) });
  } catch {
    throw new StarkscanProveError("unavailable", "The prover could not be reached.");
  }
  let job = await read(res).catch((e) => {
    if (!res.ok) throw httpError(res.status, null);
    throw e;
  });
  if (!res.ok) throw httpError(res.status, job);

  const id = typeof job.jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(job.jobId) ? job.jobId : null;
  if (!id && job.status !== "succeeded") throw new StarkscanProveError("bad_answer", "The prover gave no job.");

  for (;;) {
    if (job.status === "succeeded") {
      const out = asResult(job.result);
      if (!out) throw new StarkscanProveError("bad_answer", "The prover's proof could not be read.");
      return out;
    }
    if (job.status === "failed") throw new StarkscanProveError("failed", jobError(job));
    if (job.status === "unavailable") throw new StarkscanProveError("unavailable", "The prover is busy. Try again shortly.");
    if (job.status === "unknown_delivery") throw new StarkscanProveError("lost", "The proof was made but its answer was lost. Try again.");
    if (job.terminal === true && TERMINAL.has(String(job.status))) throw new StarkscanProveError("failed", jobError(job));
    const wait = typeof job.pollAfterSeconds === "number" && job.pollAfterSeconds > 0 ? Math.min(job.pollAfterSeconds, 5) * 1000 : 1_000;
    if (Date.now() + wait > deadline) throw new StarkscanProveError("timeout", "The proof is taking too long. Try again.");
    await sleep(wait);
    try {
      res = await f(`${opts.url}/${id}`, { method: "GET", headers: { "X-Starkscan-Api-Key": opts.apiKey }, signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) });
    } catch {
      throw new StarkscanProveError("unavailable", "The prover could not be reached.");
    }
    job = await read(res).catch((e) => {
      if (!res.ok) throw httpError(res.status, null);
      throw e;
    });
    if (!res.ok) throw httpError(res.status, job);
  }
}

/** The pool's message in a proof: its payload is [class_hash, ...server actions], what apply_actions takes. */
export function poolOutput(result: StarkscanProveResult, pool: string): string[] {
  const p = BigInt(pool);
  return result.l2_to_l1_messages.find((m) => {
    try {
      return BigInt(m.from_address) === p;
    } catch {
      return false;
    }
  })?.payload ?? [];
}

/**
 * Starkscan as the SDK's prover. Nonces and the invocation's other details come
 * from the SDK's own proving-service provider (it reads the pool's nonce from
 * the node and never calls its proving URL for that), and each proof from
 * Starkscan's job API.
 */
export class StarkscanProofProvider implements ProofProviderInterface {
  private readonly details: ProvingServiceProofProvider;
  constructor(
    private readonly starkscan: StarkscanOptions,
    chainId: constants.StarknetChainId,
    node: { nodeUrl: string; poolAddress: string }
  ) {
    // Only its getDefaultDetails is used: its proving URL is never called.
    this.details = new ProvingServiceProofProvider("http://127.0.0.1:9/unused", chainId, node);
  }

  getDefaultDetails() {
    return this.details.getDefaultDetails();
  }

  invalidateNonceCache(): void {
    this.details.invalidateNonceCache();
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: ProvingBlockId): Promise<Proof> {
    const r = await starkscanProve(this.starkscan, blockIdentifier, invocation);
    return {
      data: r.proof,
      output: poolOutput(r, String(invocation.sender_address)),
      proofFacts: r.proof_facts,
      ...(r.additional_data ? { additionalData: r.additional_data } : {}),
    } as Proof;
  }
}
