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
 * The key stays on the server. A request is keyed by a hash of its body and a
 * round (Idempotency-Key), so a retried submit (the SDK retries a busy prover
 * with the same body) finds the same job and Starkscan charges one proof. A
 * result is handed over once and then dropped by Starkscan: a job that already
 * gave its result moves the body to the next round (`rounds`, shared through
 * Redis in the route) and proves again under a new key.
 *
 * The answer is the prover's, cut to the fields the SDK reads (it parses them
 * strictly). additional_data carries a deposit's screening attestation, which
 * the pool needs with the deposit and refuses after 300 seconds. A failed job
 * passes the prover's own code on (10000 is a screening refusal).
 */
import { ProvingServiceProofProvider, type Proof, type ProofInvocation, type ProofProviderInterface, type ProvingBlockId } from "@starkware-libs/starknet-privacy-sdk";
import type { constants } from "starknet";

export type StarkscanProveResult = {
  proof: string;
  proof_facts: string[];
  l2_to_l1_messages: { from_address: string; to_address: string; payload: string[] }[];
  additional_data?: { signature?: { issued_at: number; sig_r: string; sig_s: string } };
};

export type StarkscanErrorCode = "no_key" | "no_scope" | "relay_off" | "rejected" | "failed" | "timeout" | "bad_answer" | "unavailable" | "lost" | "quota" | "limited";

/**
 * Whether a new Starkscan job may start under `idempotencyKey` (each new key
 * is a new proof and one unit of the key's daily budget; a key already sent is
 * a retry of the same job and costs nothing): "quota" when Gloam's day of
 * proofs is used, "limited" when this caller's is, "unavailable" when the count
 * can't be kept.
 */
export type StarkscanAdmit = (idempotencyKey: string) => Promise<"ok" | "limited" | "quota" | "unavailable">;

export class StarkscanProveError extends Error {
  override readonly name = "StarkscanProveError";
  constructor(
    readonly code: StarkscanErrorCode,
    message: string,
    /** The prover's own JSON-RPC code and data on a failed job (10000: refused by screening). */
    readonly prover?: { code: number; data?: unknown }
  ) {
    super(message);
  }
}

/** Which round a request body is on: a new round is a new Idempotency-Key, so a new job. */
export type StarkscanRounds = {
  get(body: string): Promise<number>;
  next(body: string): Promise<number>;
};

/** Rounds kept in this process (tests, or where Redis isn't set). */
export function memoryRounds(): StarkscanRounds {
  const m = new Map<string, number>();
  return {
    get: async (b) => m.get(b) ?? 0,
    next: async (b) => {
      const n = (m.get(b) ?? 0) + 1;
      m.set(b, n);
      return n;
    },
  };
}

const processRounds = memoryRounds();

export type StarkscanOptions = {
  /** https://api.starkscan.co/v1/SN_MAIN/prove */
  url: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Give up after this long, submit and polls together; a timeout is "busy", so the caller retries into the same job. */
  timeoutMs?: number;
  /** Wait between polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Where a body's round is kept (default: this process). */
  rounds?: StarkscanRounds;
  /** Asked before every submit; a key it refuses is never sent (default: every key may go). */
  admit?: StarkscanAdmit;
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

/** The prover's answer, cut to exactly the fields the SDK parses; null when one is missing or malformed. */
export function asResult(x: unknown): StarkscanProveResult | null {
  const r = x as Partial<StarkscanProveResult> | null;
  if (!r || typeof r !== "object") return null;
  if (typeof r.proof !== "string" || !r.proof || !Array.isArray(r.proof_facts) || !Array.isArray(r.l2_to_l1_messages)) return null;
  if (!r.proof_facts.every((f) => typeof f === "string")) return null;
  const messages: StarkscanProveResult["l2_to_l1_messages"] = [];
  for (const m of r.l2_to_l1_messages) {
    if (!m || typeof m.from_address !== "string" || typeof m.to_address !== "string" || !Array.isArray(m.payload) || !m.payload.every((p) => typeof p === "string")) return null;
    messages.push({ from_address: m.from_address, to_address: m.to_address, payload: [...m.payload] });
  }
  const out: StarkscanProveResult = { proof: r.proof, proof_facts: [...r.proof_facts], l2_to_l1_messages: messages };
  const sig = (r.additional_data as { signature?: unknown } | undefined)?.signature as { issued_at?: unknown; sig_r?: unknown; sig_s?: unknown } | undefined;
  if (r.additional_data !== undefined) {
    if (!r.additional_data || typeof r.additional_data !== "object") return null;
    if (sig === undefined) out.additional_data = {};
    else if (typeof sig.issued_at === "number" && Number.isSafeInteger(sig.issued_at) && typeof sig.sig_r === "string" && typeof sig.sig_s === "string") {
      out.additional_data = { signature: { issued_at: sig.issued_at, sig_r: sig.sig_r, sig_s: sig.sig_s } };
    } else return null;
  }
  return out;
}

function jobError(j: Job): string {
  const e = j.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message.slice(0, 300) : `The prover answered ${String(j.status ?? "with an error")}.`;
}

/**
 * The code of a refused request. Starkscan's API answers an HTTP error with its
 * envelope, the code at the top ({ code, message, docSlug, requestId }, read
 * from api.starkscan.co on 2026-11-27); a job's own failure has it under
 * `error`. Both are read.
 */
function httpErrorCode(j: (Job & { code?: unknown }) | null): string {
  if (!j || typeof j !== "object") return "";
  if (typeof j.code === "string") return j.code;
  const e = j.error as { code?: unknown } | string | undefined;
  if (typeof e === "string") return e;
  return typeof e?.code === "string" ? e.code : "";
}

function httpErrorMessage(j: (Job & { message?: unknown }) | null): string | null {
  if (!j || typeof j !== "object") return null;
  if (typeof j.message === "string") return j.message.slice(0, 300);
  const e = j.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message.slice(0, 300) : null;
}

/** The prover's own code and data on a failed job, when it gave them. */
function proverError(j: Job): { code: number; data?: unknown } | undefined {
  const e = j.error as { code?: unknown; data?: unknown } | undefined;
  return typeof e?.code === "number" && Number.isInteger(e.code) ? { code: e.code, ...(e.data !== undefined ? { data: e.data } : {}) } : undefined;
}

/** A job that already handed its result over (Starkscan keeps none after that). */
function resultGone(j: Job & { resultUnavailableReason?: unknown }): boolean {
  return j.status === "succeeded" && j.result === undefined && typeof j.resultUnavailableReason === "string";
}

/** Prove one transaction at `blockId` through Starkscan, waiting for the job. */
export async function starkscanProve(opts: StarkscanOptions, blockId: ProvingBlockId | undefined, transaction: unknown): Promise<StarkscanProveResult> {
  if (!opts.apiKey) throw new StarkscanProveError("no_key", "No Starkscan key is set.");
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const rounds = opts.rounds ?? processRounds;
  const deadline = Date.now() + (opts.timeoutMs ?? 50_000);
  const body = JSON.stringify({ block_id: blockParam(blockId), transaction });
  if (body.length > MAX_BODY) throw new StarkscanProveError("rejected", "That transaction is too large to prove.");
  const digest = (await sha256Hex(body)).slice(0, 48);
  const headers = { "content-type": "application/json", "X-Starkscan-Api-Key": opts.apiKey };
  const left = () => Math.max(1_000, deadline - Date.now());

  const read = async (res: Response): Promise<Job> => {
    try {
      return (await res.json()) as Job;
    } catch {
      throw new StarkscanProveError("bad_answer", "The prover's answer could not be read.");
    }
  };
  const httpError = (status: number, j: Job | null): StarkscanProveError => {
    const code = httpErrorCode(j);
    if (status === 403) return new StarkscanProveError("no_scope", "Gloam's Starkscan key can't prove yet.");
    if (status === 404) return new StarkscanProveError("relay_off", "Starkscan's prover is not on right now.");
    // Gloam's daily proof quota is used up: say busy, and never retry into it (it resets at UTC midnight).
    if (status === 429 && code === "prover_daily_budget_exhausted") return new StarkscanProveError("quota", "Starknet is busy. Try again later.");
    if (status === 429 || status === 503) return new StarkscanProveError("unavailable", "The prover is busy. Try again shortly.");
    if (status >= 400 && status < 500) return new StarkscanProveError("rejected", httpErrorMessage(j) ?? `The prover refused it (${status}).`);
    return new StarkscanProveError("unavailable", `The prover answered ${status}.`);
  };
  const ask = async (url: string, init: RequestInit): Promise<Job> => {
    let res: Response;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(left()) });
    } catch {
      if (Date.now() >= deadline) throw new StarkscanProveError("timeout", "The proof is taking a while. Still working on it.");
      throw new StarkscanProveError("unavailable", "The prover could not be reached.");
    }
    const job = await read(res).catch((e) => {
      if (!res.ok) throw httpError(res.status, null);
      throw e;
    });
    if (!res.ok) throw httpError(res.status, job);
    return job;
  };

  // A job whose result was already handed over can't give it again: the next round is a new job.
  for (let fresh = 0; fresh < 3; fresh++) {
    const round = await rounds.get(digest);
    const idem = `gloam-${digest}-r${round}`;
    const admitted = opts.admit ? await opts.admit(idem) : "ok";
    if (admitted === "quota") throw new StarkscanProveError("quota", "Starknet is busy. Try again later.");
    if (admitted === "limited") throw new StarkscanProveError("limited", "Too many proofs. Try again in a little while.");
    if (admitted === "unavailable") throw new StarkscanProveError("unavailable", "Proving is paused for a moment. Try again shortly.");
    let job = await ask(opts.url, { method: "POST", headers: { ...headers, "Idempotency-Key": idem }, body });
    const id = typeof job.jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(job.jobId) ? job.jobId : null;
    if (!id && job.status !== "succeeded") throw new StarkscanProveError("bad_answer", "The prover gave no job.");
    for (;;) {
      if (resultGone(job)) break;
      if (job.status === "succeeded") {
        const out = asResult(job.result);
        if (!out) throw new StarkscanProveError("bad_answer", "The prover's proof could not be read.");
        return out;
      }
      if (job.status === "failed") throw new StarkscanProveError("failed", jobError(job), proverError(job));
      if (job.status === "unavailable") throw new StarkscanProveError("unavailable", "The prover is busy. Try again shortly.");
      if (job.status === "unknown_delivery") throw new StarkscanProveError("lost", "Starkscan lost track of that proof. Try again in a few minutes.");
      if (job.terminal === true && TERMINAL.has(String(job.status))) throw new StarkscanProveError("failed", jobError(job), proverError(job));
      if (!id) throw new StarkscanProveError("bad_answer", "The prover gave no job.");
      const wait = typeof job.pollAfterSeconds === "number" && job.pollAfterSeconds > 0 ? Math.min(job.pollAfterSeconds, 5) * 1000 : 1_000;
      if (Date.now() + wait > deadline) throw new StarkscanProveError("timeout", "The proof is taking a while. Still working on it.");
      await sleep(wait);
      job = await ask(`${opts.url}/${id}`, { method: "GET", headers: { "X-Starkscan-Api-Key": opts.apiKey } });
    }
    await rounds.next(digest);
  }
  throw new StarkscanProveError("lost", "The proof's answer was lost. Try again.");
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
