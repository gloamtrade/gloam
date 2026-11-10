/**
 * Securing a claim on a weak connection (lib/claimSweep): which failures are
 * the connection's, trying those again before anyone is told, and saying which
 * part failed.
 *
 * Only reads and downloads are tried again here: the chain reads a secure makes
 * (isSpent, commitmentSeen, a receipt) and the proving files. A send to the
 * Gloam relay never is: a reply lost on the way back can still mean it went
 * out, so claimSweep looks on the chain for it instead (settleEarlier).
 */
import { BaseError, HttpRequestError, TimeoutError } from "viem";
import { nodeFailed } from "./rpcList";

/** The part of securing that failed: a chain read, the proving files, or the Gloam relay. */
export type SecureStep = "chain" | "files" | "relay";

/** A read or download that kept failing on the connection, named by the part of securing it was for. */
export class SecureStepError extends Error {
  readonly step: SecureStep;
  readonly original: unknown;
  constructor(step: SecureStep, original: unknown) {
    super(firstLine(original));
    this.name = "SecureStepError";
    this.step = step;
    this.original = original;
  }
}

function firstLine(e: unknown): string {
  const o = e as { shortMessage?: unknown; message?: unknown } | null;
  const text = typeof o?.shortMessage === "string" ? o.shortMessage : typeof o?.message === "string" ? o.message : String(e);
  return text.split("\n")[0] ?? "";
}

/**
 * What browsers say when a fetch never got an answer: Chrome "Failed to fetch",
 * Safari "Load failed" and its connection messages, Firefox "NetworkError when
 * attempting to fetch resource.", Node "fetch failed".
 */
const FETCH_FAILED =
  /failed to fetch|load failed|fetch failed|networkerror|network error|network connection was lost|internet connection appears to be offline|request timed out|specified hostname could not be found|err_(network|internet|connection|timed)/i;

/** viem's connection failures, by name too, in case the error came from another copy of viem. */
const VIEM_NET_NAMES = new Set(["HttpRequestError", "TimeoutError", "WebSocketRequestError", "SocketClosedError"]);

function viemNetFailure(e: unknown): boolean {
  if (e instanceof HttpRequestError || e instanceof TimeoutError || nodeFailed(e)) return true;
  if (e instanceof BaseError && e.walk((x) => VIEM_NET_NAMES.has((x as { name?: string })?.name ?? "")) !== null) return true;
  // a plain chain of causes (an error from another copy of viem is no BaseError here)
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    if (VIEM_NET_NAMES.has((cur as { name?: string }).name ?? "")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The connection failed, not the request: a chain read that got no answer (or
 * a rate limit), a fetch that never completed, a download cut off, a page
 * chunk that would not load. Asking again can change the outcome. A revert, a
 * refusal, a wrong answer or a hash mismatch is not one of these.
 */
export function isTransientNetError(e: unknown): boolean {
  if (e instanceof SecureStepError) return isTransientNetError(e.original);
  if (!e || typeof e !== "object") return false;
  if (viemNetFailure(e)) return true;
  const name = (e as { name?: string }).name ?? "";
  if (name === "AbortError" || name === "ChunkLoadError") return true;
  const msg = firstLine(e);
  if (name === "TypeError" && FETCH_FAILED.test(msg)) return true;
  // a proving file the server answered with an error of its own (lib/circuitArtifacts)
  if (/^Missing circuit file .* \((0|408|429|5\d\d)\)/.test(msg)) return true;
  return FETCH_FAILED.test(msg) && !/revert/i.test(msg);
}

/** How often and how long to try a step again: a wait before each retry, and a time after which none starts. */
export type RetryPlan = { readonly delays: readonly number[]; readonly budgetMs: number };

/**
 * Chain reads. Each read already goes out three times in quick succession
 * (lib/rhClient); these waits are for a connection that drops for a few
 * seconds. A read that failed by timing out (25 s each) leaves no room in the
 * budget for another.
 */
export const READ_RETRY: RetryPlan = { delays: [1_500, 4_000, 8_000], budgetMs: 45_000 };
/** The proving files (a few MB): a download cut off part way is started again. */
export const FILES_RETRY: RetryPlan = { delays: [2_000, 6_000], budgetMs: 120_000 };
/** Waiting for a receipt the relay's send has: reading it again never sends anything. */
export const RECEIPT_RETRY: RetryPlan = { delays: [2_000, 5_000], budgetMs: 180_000 };

export type RetryHooks = {
  /** Test hook: how to wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Told before each retry (1 for the first). */
  onRetry?: (attempt: number, e: unknown) => void;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `fn`, tried again on a connection failure (isTransientNetError) as `plan` allows. Any other error is thrown at once. */
export async function retryTransient<T>(fn: () => Promise<T>, plan: RetryPlan = READ_RETRY, hooks: RetryHooks = {}): Promise<T> {
  const sleep = hooks.sleep ?? realSleep;
  const now = hooks.now ?? Date.now;
  const start = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const wait = plan.delays[attempt];
      if (wait === undefined || !isTransientNetError(e) || now() - start + wait > plan.budgetMs) throw e;
      hooks.onRetry?.(attempt + 1, e);
      await sleep(wait);
    }
  }
}

/** `fn` with retries; a connection failure that outlasts them comes out as a SecureStepError for `step`. */
export function retryStep<T>(step: SecureStep, fn: () => Promise<T>, plan: RetryPlan, hooks: RetryHooks = {}): Promise<T> {
  return retryTransient(fn, plan, hooks).catch((e: unknown) => {
    throw e instanceof SecureStepError || !isTransientNetError(e) ? e : new SecureStepError(step, e);
  });
}

/** Why a secure did not go through, in terms of the part that failed. */
export type SecureFailure =
  | { step: "chain" | "files" | "connection"; retried?: boolean }
  | { step: "relay"; code: string; reached: boolean; maybeSent: boolean };

/**
 * The failure a thrown error stands for, or null when it is not about the
 * connection (then its own message is the reason). A chain read names the
 * chain; a fetch that failed without saying where names the connection.
 */
export function secureFailureOf(e: unknown): SecureFailure | null {
  if (e instanceof SecureStepError) {
    return e.step === "relay" ? { step: "relay", code: "network", reached: false, maybeSent: true } : { step: e.step, retried: true };
  }
  if (!isTransientNetError(e)) return null;
  return viemNetFailure(e) ? { step: "chain" } : { step: "connection" };
}

/**
 * The reason, after "not secured yet: ", in plain words. `network` is the
 * chain's name as the app shows it (Robinhood Chain).
 */
export function secureFailureReason(f: SecureFailure, network: string): string {
  switch (f.step) {
    case "chain":
      return `${network} could not be reached on this connection${f.retried ? ", even after a few tries" : ""}`;
    case "files":
      return "the files needed to secure it could not be downloaded on this connection";
    case "connection":
      return "the connection dropped before it finished";
    case "relay":
      if (!f.reached) return "the Gloam relay could not be reached on this connection";
      if (f.maybeSent) return "the Gloam relay did not confirm that it went out, so it may still land";
      return "the Gloam relay could not take it just now";
  }
}

/** What happens next: tried again with no one asking while the relay is on, or by tapping. */
export function secureNextStep(retrying: boolean): string {
  return retrying
    ? "Gloam keeps trying while this page is open, or tap Secure it now."
    : "Tap Secure it now to try again.";
}
