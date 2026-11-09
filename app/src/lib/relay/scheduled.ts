/**
 * Scheduled cash outs: "cash out later".
 *
 * A cash out is public (the asset, the amount and the wallet it pays), so one
 * that follows a payment within a minute can be matched to it by timing. Here
 * the browser makes the cash-out proof as usual and hands it to the relay with
 * a send time picked at random inside the window the person chose (an hour,
 * six, or a day). A cron sends due jobs through the normal relay path
 * (lib/relay/server).
 *
 * A job holds no secret: the proof and its public inputs. The proof binds the
 * amount and the recipient, so whoever holds the job can only send it as it is
 * or not at all. Before sending, the chain is read at one block: a spent
 * nullifier means the money already moved. The vault accepts every root it
 * ever had (knownRoots, not only its recent history), so a proof does not go
 * stale while it waits; a root it does not know at all means the proof can
 * never land, so the job expires and nothing moved.
 *
 * Sending is idempotent. A job is taken under a short lock, marked "sending"
 * before the relay is called, and the chain is read first on every pass, so a
 * job that was sent but not recorded (a crash, a lost reply) settles as sent
 * instead of going out twice. The relay itself refuses a second copy of a
 * spend while one is in flight (lib/relay/inflight).
 *
 * A proof also carries the vault root it was made against, and the vault keeps
 * every root, so anyone who rebuilds the tree can tell roughly when a waiting
 * proof was made. While the app is open it makes a fresh proof of the same
 * cash out and swaps it in (replaceJobProof): same job, same spend, recipient,
 * amount, asset and send time, only a later root. One that goes out while the
 * app is closed keeps the root of its last proof.
 *
 * Once the relay may have handed a job to the node (a timeout, a lost reply,
 * any answer that is not a clear refusal), the job stays "sending" until the
 * chain settles it: it is never cancelled, failed or said to be unsent on a
 * guess. Only the chain (spent, or a root it does not know with the note
 * unspent, read at one block) or a refusal raised before anything reached
 * the node ends it.
 *
 * Gas: the relay pays it, so above the relay's gas ceiling on a chain
 * (lib/relay/gasCeiling: 3 gwei on Ethereum by default) a due job is not sent.
 * It waits, still scheduled and still cancellable, and is looked at again
 * every few minutes until gas comes back under the ceiling, for up to
 * GAS_WAIT_MAX_MS past its send time. Waiting for gas never counts as a failed
 * try and never uses up the give-up time: once gas comes down, the 2 hours a
 * passing problem gets start from the end of the wait.
 *
 * A job can also be dated: set for a day up to MAX_DATED_DAYS ahead instead of
 * a window (a prepaid agent top-up, lib/agentTopUp). Its send time is drawn at
 * random inside that UTC day, so a weekly top-up never lands like clockwork.
 * Everything above holds for it, and its record lasts as long as it has to
 * wait (liveTtlSec). Nobody is at the screen when one comes due, so a passing
 * problem gets a day (DATED_GIVE_UP_AFTER_MS), not 2 hours, and is tried every
 * few minutes (DATED_RETRY_MS) so it never crowds out what is due now.
 * Dated jobs are refused where they lose money (DATED_OFF_CHAINS), and until the
 * relay can seal them at rest (lib/relay/jobSeal).
 *
 * A dated job can carry a webhook. A run hands back what to tell it
 * (takeNotices) and the route delivers that once every job is settled
 * (lib/relay/webhook): a notice can't change what happens to a job.
 *
 * This file is the logic and an in-memory store (for tests and local runs);
 * lib/relay/scheduledStore.ts keeps jobs in Redis in production.
 */
import type { Address, Hex } from "viem";
import type { JobNotice } from "./webhook";

/** The longest a cash out in a window may wait. A live job's record (liveTtlSec) outlasts it, give-up time included. */
export const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
/** The windows the app offers. */
export const DELAY_WINDOWS = { hour: 60 * 60 * 1000, "6h": 6 * 60 * 60 * 1000, day: MAX_DELAY_MS } as const;
export type DelayWindow = keyof typeof DELAY_WINDOWS;
/** No earlier than this after it is scheduled, so even the shortest draw is not "right away". */
export const MIN_DELAY_MS = 2 * 60 * 1000;
/** One UTC day: a dated cash out goes out at a random time inside the day it is set for. */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** How many days ahead a dated cash out may be set for. */
export const MAX_DATED_DAYS = 90;
/**
 * Chains that take no dated jobs. A top-up is two relay transactions paid for
 * out of the cash-out fee, and Ethereum mainnet's gas costs more than that
 * brings in. Its testnet keeps them.
 */
const DATED_OFF_CHAINS: ReadonlySet<number> = new Set([1]);
export const DATED_OFF_MESSAGE =
  "Agent top-ups aren't offered on Ethereum. Each one takes two relay transactions, and gas there costs more than the fee brings in.";
/** A dated job is held for months, so it waits until the relay can seal it at rest. */
export const DATED_KEY_OFF_MESSAGE = "Agent top-ups aren't switched on yet. Nothing was set aside.";

export function datedOff(chainId: number): boolean {
  return DATED_OFF_CHAINS.has(chainId);
}
/** A job that keeps failing for a passing reason (a busy relay, a slow node) gives up this long after its time. */
export const GIVE_UP_AFTER_MS = 2 * 60 * 60 * 1000;
/** The same for a dated job: nobody is waiting at the screen to send it again, so it keeps trying for longer. */
export const DATED_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
/** A dated job that hit a passing problem is looked at again this often, behind what is due now. */
export const DATED_RETRY_MS = 5 * 60 * 1000;
/** A job marked "sending" longer than this is read again: the send may have died with its instance. */
export const SENDING_STALE_MS = 5 * 60 * 1000;
/** How long a live job record is kept past its send time (refreshed on every save, so a job waiting for gas outlasts this). */
export const JOB_TTL_SEC = 3 * 24 * 60 * 60;
/** How long a finished job is kept, without its proof, so the app can still read what happened. */
export const JOB_DONE_TTL_SEC = 7 * 24 * 60 * 60;
/** While gas is over the relay's ceiling, a due job is looked at again this often. */
export const GAS_RECHECK_MS = 5 * 60 * 1000;
/** The longest a job waits for gas past its send time before it gives up (nothing moves). */
export const GAS_WAIT_MAX_MS = 3 * 24 * 60 * 60 * 1000;
/** What a job waiting for gas says (public, like every reason). */
export const GAS_WAIT_REASON = "Waiting for gas to come down: it goes out once gas is back under the relay's limit.";
const GAS_GAVE_UP_REASON = "Gas stayed over the relay's limit for three days, so it did not go out. Nothing moved.";

export type JobStatus =
  | "scheduled"
  | "sending"
  /** The relay sent it (hash set). The chain settles it. */
  | "sent"
  /** The vault does not know the proof's root and the note is unspent: it can never land, nothing moved. */
  | "expired"
  /** The note was already spent when the job came due (this cash out, or another spend). */
  | "spent"
  /** It could not go out (refused before reaching the node, or reverted). Nothing moved. */
  | "failed"
  | "cancelled";

export type CashOutJob = {
  id: string;
  chainId: number;
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  asset: Address;
  to: Address;
  /** Base units, as a decimal string. */
  amount: string;
  createdAt: number;
  sendAfter: number;
  status: JobStatus;
  attempts: number;
  updatedAt: number;
  hash?: Hex;
  /** A send may have reached the node: from now on only the chain settles the job. */
  maybeSent?: boolean;
  /** Set for a day ahead, not a window: it gives up after DATED_GIVE_UP_AFTER_MS. */
  dated?: boolean;
  /** Where to say this one failed or is held, and which series it is (lib/relay/webhook). Sealed at rest. */
  webhook?: JobWebhook;
  /** What the webhook was last told, so each is said once. */
  notified?: JobNotice["body"]["status"];
  /** Waiting for gas: the runner looks at the job again no sooner than this (ms). */
  notBefore?: number;
  /**
   * The last time the job was held for gas (ms). The 2-hour give-up runs from
   * here once gas comes down, not from the send time the wait already passed.
   */
  gasHeldAt?: number;
  /** A short, public reason when it failed (never a secret). */
  reason?: string;
};

export type JobWebhook = { url: string; series: string };

/** What a person may read about a job: no proof, no inputs. */
export type JobView = Pick<CashOutJob, "id" | "chainId" | "sendAfter" | "status" | "updatedAt" | "hash" | "reason">;

export function jobView(j: CashOutJob): JobView {
  return {
    id: j.id,
    chainId: j.chainId,
    sendAfter: j.sendAfter,
    status: j.status,
    updatedAt: j.updatedAt,
    ...(j.hash ? { hash: j.hash } : {}),
    ...(j.reason ? { reason: j.reason } : {}),
  };
}

/**
 * A uniform draw in [0, 1) from the platform's cryptographic random source (Web
 * Crypto, in Node and the browser alike), 53 bits of it, so a send time can't
 * be worked out from earlier ones.
 */
export function secureRandom(): number {
  const [hi, lo] = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return (hi! * 2 ** 21 + (lo! >>> 11)) / 2 ** 53;
}

/** A send time drawn uniformly inside the window, never sooner than MIN_DELAY_MS. */
export function drawSendAfter(now: number, window: DelayWindow, random: () => number = secureRandom): number {
  const span = DELAY_WINDOWS[window];
  return now + MIN_DELAY_MS + Math.floor(random() * (span - MIN_DELAY_MS));
}

/** The UTC day `t` falls on, as the first millisecond of that day. */
export function dayOf(t: number): number {
  return t - (t % DAY_MS);
}

/** Why a job can't be set for `day` (the first millisecond of a UTC day) at `now`, or null when it can. */
export function sendDayProblem(day: unknown, now: number): string | null {
  if (typeof day !== "number" || !Number.isSafeInteger(day) || day <= 0 || day % DAY_MS !== 0) return "Pick a day to send it.";
  if (day + DAY_MS <= now + MIN_DELAY_MS) return "That day has passed. Pick a later one.";
  if (day > dayOf(now) + MAX_DATED_DAYS * DAY_MS) return `Pick a day within ${MAX_DATED_DAYS} days.`;
  return null;
}

/** A send time drawn uniformly inside the UTC day `day`, never sooner than MIN_DELAY_MS. */
export function drawSendOn(now: number, day: number, random: () => number = secureRandom): number {
  const from = Math.max(day, now + MIN_DELAY_MS);
  return from + Math.floor(random() * Math.max(1, day + DAY_MS - from));
}

/** The day to set a dated cash out for now: the one it was meant for, or tomorrow once that has passed. */
export function nextSendDay(day: number, now: number): number {
  return day + DAY_MS > now + MIN_DELAY_MS ? day : dayOf(now) + DAY_MS;
}

/**
 * How long a live job's record must last from `now`: until its send time, then
 * JOB_TTL_SEC past it. Refreshed on every save, so a job that retries or waits
 * for gas keeps its record, and a proof swapped in months ahead never cuts it short.
 */
export function liveTtlSec(job: Pick<CashOutJob, "sendAfter">, now: number): number {
  return Math.ceil(Math.max(0, job.sendAfter - now) / 1000) + JOB_TTL_SEC;
}

export function isLive(status: JobStatus): boolean {
  return status === "scheduled" || status === "sending";
}

/**
 * When the runner next looks at a live job: its send time (or, while it waits
 * for gas, its next look), or for one going out, once that send is stale.
 */
export function dueAt(job: CashOutJob): number {
  return job.status === "sending" ? job.updatedAt + SENDING_STALE_MS : Math.max(job.sendAfter, job.notBefore ?? 0);
}

/** Whether a new request is the same cash out as a waiting job: same recipient, amount and asset. */
export function sameCashOut(job: CashOutJob, want: { to: string; amount: string; asset: string }): boolean {
  return (
    job.to.toLowerCase() === want.to.toLowerCase() &&
    job.amount === want.amount &&
    job.asset.toLowerCase() === want.asset.toLowerCase()
  );
}

// ---------------------------------------------------------------- store

export interface JobStore {
  get(id: string): Promise<CashOutJob | null>;
  /** Saves the job, and keeps it in the due queue (by dueAt) while it is live. */
  put(job: CashOutJob): Promise<void>;
  /**
   * Saves a new job as the one for its spend, in one step: the spend's pointer,
   * the job and its place in the queue. When the pointer already names another
   * job (other than `replace`), nothing is written and that job's id comes back.
   */
  create(job: CashOutJob, replace?: string): Promise<string>;
  /** Ids due by `now`, oldest first. */
  due(now: number, limit: number): Promise<string[]>;
  /** The live job already scheduled for this spend, if any. */
  byNullifier(chainId: number, nullifier: Hex): Promise<string | null>;
  /** A short lock on one job; returns its release, or null while another run holds it. */
  lock(id: string, ttlSec: number): Promise<(() => Promise<void>) | null>;
  /** Takes an id out of the due queue (its record is gone or over). */
  forget(id: string): Promise<void>;
  /** Moves an id back in the queue without reading its record. */
  defer?(id: string, at: number): Promise<void>;
  /** Seals a few waiting jobs again under the current key, while an old one is kept. Returns how many. */
  reseal?(limit: number): Promise<number>;
}

/** Jobs in this process only: for tests and a local dev server without Redis. */
export function memoryJobStore(): JobStore {
  const jobs = new Map<string, CashOutJob>();
  const locks = new Map<string, number>();
  /** The job named for each spend, like the Redis store's pointer. */
  const spends = new Map<string, string>();
  const spendKey = (chainId: number, nullifier: Hex) => `${chainId}:${nullifier.toLowerCase()}`;
  return {
    async get(id) {
      const j = jobs.get(id);
      return j ? { ...j } : null;
    },
    async put(job) {
      jobs.set(job.id, { ...job });
      if (isLive(job.status)) spends.set(spendKey(job.chainId, job.nullifier), job.id);
    },
    async create(job, replace) {
      const key = spendKey(job.chainId, job.nullifier);
      const held = spends.get(key);
      if (held && held !== job.id && held !== replace) return held;
      jobs.set(job.id, { ...job });
      spends.set(key, job.id);
      return job.id;
    },
    async due(now, limit) {
      return [...jobs.values()]
        .filter((j) => isLive(j.status) && dueAt(j) <= now)
        .sort((a, b) => dueAt(a) - dueAt(b))
        .slice(0, limit)
        .map((j) => j.id);
    },
    async byNullifier(chainId, nullifier) {
      const id = spends.get(spendKey(chainId, nullifier));
      const j = id ? jobs.get(id) : undefined;
      return j && isLive(j.status) ? j.id : null;
    },
    async lock(id, ttlSec) {
      const now = Date.now();
      const held = locks.get(id);
      if (held && held > now) return null;
      locks.set(id, now + ttlSec * 1000);
      return async () => {
        locks.delete(id);
      };
    },
    async forget(id) {
      jobs.delete(id);
    },
  };
}

// ---------------------------------------------------------------- running

/** The chain at send time: is the note spent, and does the vault still keep the proof's root. */
export type ChainView = { spent: boolean; knownRoot: boolean };

/** An error from a send: its relay code (lib/relay/server RelayError). */
export type SendFailure = { code: string; message: string };

export type RunDeps = {
  now: () => number;
  /** Reads the chain for this job; throws when the node can't be read. */
  readChain: (job: CashOutJob) => Promise<ChainView>;
  /** Sends the cash out through the relay; returns the hash, or throws a SendFailure-like error. */
  send: (job: CashOutJob) => Promise<Hex>;
  /**
   * Whether gas on the job's chain is over the relay's ceiling right now
   * (lib/relay/server relayGasHigh). Left out: no chain has a ceiling.
   */
  gasHigh?: (job: CashOutJob) => Promise<boolean>;
};

/**
 * Relay codes raised before anything reaches the node (lib/relay/server): the
 * request was refused, so nothing went out on that try.
 */
const REFUSED = new Set([
  "screened",
  "asset_policy",
  "vault_recipient",
  "bad_request",
  "network",
  "relay_off",
  "relay_empty",
  "busy",
  "rate_limit",
  "check_failed",
  "gas_high",
  "gas_most",
  "spend_cap",
]);
/** Of those, the ones that mean this cash out can never go out as it is. */
const PERMANENT = new Set(["screened", "asset_policy", "vault_recipient", "bad_request", "network"]);
/** The relay's dry run reverted with these: the call reverts, so it was not sent. */
const REVERTED = new Set(["InvalidProof", "InvalidAmount", "ZeroAddress", "VerifierNotSet", "DuplicateCommitment", "InsufficientPoolBalance"]);
/** A dry-run revert that can pass (the vault fills up again): try again later. */
const REVERTED_PASSING = new Set(["InsufficientPoolBalance"]);

const EXPIRED_REASON = "The vault does not know this proof's root, so it can never go out.";

export type RunResult = { id: string; status: JobStatus | "skipped" };

/**
 * Sends the jobs due now, one at a time. Safe to run on several instances at
 * once and to re-run: each job is taken under its own lock, and the chain is
 * read before every send. Stops taking new jobs after `budgetMs`, so a run
 * ends well inside its function limit; the rest go on the next pass.
 */
export async function runDueJobs(store: JobStore, deps: RunDeps, limit = 20, budgetMs = 40_000): Promise<RunResult[]> {
  const out: RunResult[] = [];
  const start = deps.now();
  for (const id of await store.due(start, limit)) {
    if (deps.now() - start > budgetMs) break;
    const release = await store.lock(id, 90);
    if (!release) {
      out.push({ id, status: "skipped" });
      continue;
    }
    try {
      out.push({ id, status: await runOne(store, deps, id) });
    } catch (e) {
      // Sealed with a key the relay doesn't have: it can't be read, which is not the
      // same as gone. It stays on record and behind what is due, until the key is back.
      if ((e as Error)?.name !== "JobSealError") throw e;
      await store.defer?.(id, deps.now() + DATED_RETRY_MS).catch(() => {});
      out.push({ id, status: "skipped" });
    } finally {
      await release();
    }
  }
  return out;
}

/**
 * What a run has to tell webhooks: each job with one that ended unsent, or could
 * not go out on time, once for each. Marked told before anything is sent, so a
 * failed delivery is never tried on a later pass, and a job that is over drops
 * its webhook here. Reads only what the run reports, so a job with none costs
 * one extra read when it fails, and nothing when it goes out.
 */
export async function takeNotices(store: JobStore, results: RunResult[], now: number): Promise<JobNotice[]> {
  const out: JobNotice[] = [];
  for (const r of results) {
    const status = r.status === "failed" || r.status === "expired" ? r.status : r.status === "scheduled" ? "held" : null;
    if (!status) continue;
    const release = await store.lock(r.id, 30).catch(() => null);
    if (!release) continue;
    try {
      const job = await store.get(r.id);
      if (!job?.webhook || job.notified === status) continue;
      await store.put({ ...job, notified: status, webhook: status === "held" ? job.webhook : undefined });
      out.push({ url: job.webhook.url, body: { status, series: job.webhook.series, at: new Date(now).toISOString() } });
    } catch {
      /* a notice is never worth a job's trouble */
    } finally {
      await release();
    }
  }
  return out;
}

/**
 * A job that is done no longer needs its proof: it is dropped, so it can never be sent later.
 * Nor when it was asked for, the one thing here the chain does not already show next to its
 * hash: kept, it would tie the person's visit to the cash out.
 */
function retire(job: CashOutJob, status: JobStatus): CashOutJob {
  if (isLive(status)) return job;
  // a webhook is kept only for the notice this ending owes it (takeNotices)
  const owed = status === "failed" || status === "expired";
  return { ...job, proof: "0x", createdAt: 0, webhook: owed ? job.webhook : undefined };
}

async function settle(store: JobStore, job: CashOutJob, status: JobStatus, now: number, extra: Partial<CashOutJob> = {}) {
  await store.put(retire({ ...job, ...extra, status, updatedAt: now }, status));
  return status;
}

async function runOne(store: JobStore, deps: RunDeps, id: string): Promise<JobStatus | "skipped"> {
  const job = await store.get(id);
  if (!job) {
    await store.forget(id);
    return "skipped";
  }
  const now = deps.now();
  if (!isLive(job.status)) {
    await store.forget(id);
    return job.status;
  }
  if (job.sendAfter > now || (job.status === "scheduled" && (job.notBefore ?? 0) > now)) return "skipped";
  // Another run is sending it right now (its lock may have lapsed mid-send).
  if (job.status === "sending" && now - job.updatedAt < SENDING_STALE_MS) return "skipped";
  // A "sending" job found here may have gone out (the run died, or the node's answer was lost).
  const mayBeOut = job.status === "sending" || job.maybeSent === true;

  let chain: ChainView;
  try {
    chain = await deps.readChain(job);
  } catch {
    // The node did not answer. One that may be out stays "sending" and is read again later;
    // one that never reached the node tries again next pass, or gives up when long overdue.
    if (mayBeOut) return settle(store, job, "sending", now, { maybeSent: true });
    if (now - giveUpFrom(job) > giveUpAfter(job)) return settle(store, job, "failed", now, { reason: "The network could not be read in time." });
    return settle(store, job, "scheduled", now, retryLater(job, now));
  }
  // Spent: by this job on an earlier pass whose result was lost, or elsewhere.
  if (chain.spent) return settle(store, job, job.hash || mayBeOut ? "sent" : "spent", now);
  // Read at one block with the note unspent: no copy of this proof can ever land.
  if (!chain.knownRoot) return settle(store, job, "expired", now, { reason: EXPIRED_REASON });

  // Gas over the relay's ceiling: nothing goes out now. One that may be out is
  // read again later as before; any other waits, untouched and still cancellable.
  if (await gasIsHigh(deps, job)) {
    return mayBeOut ? settle(store, job, "sending", now, { maybeSent: true }) : waitForGas(store, job, now);
  }

  // Marked before the send, so a crash after the send is read back from the chain, not sent again.
  const sending: CashOutJob = {
    ...job,
    status: "sending",
    attempts: job.attempts + 1,
    updatedAt: now,
    notBefore: undefined,
    reason: job.reason === GAS_WAIT_REASON ? undefined : job.reason,
  };
  await store.put(sending);
  try {
    const hash = await deps.send(job);
    return settle(store, sending, "sent", deps.now(), { hash });
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "error";
    const reason = (e instanceof Error ? e.message : "The relay could not send it.").slice(0, 160);
    const t = deps.now();
    // Spent by now: by an earlier try of this job, or by another spend.
    if (code === "AlreadySpent") return settle(store, sending, mayBeOut ? "sent" : "spent", t);
    // Gas went over the ceiling between the check and the send: the relay sent
    // nothing, so this try does not count. It waits like any other.
    if (code === "gas_high" && !mayBeOut) return waitForGas(store, job, t);
    // Anything but a clear refusal may have reached the node (a timeout, a lost
    // reply, another request holding this spend): only the chain settles it now.
    // So does any refusal once an earlier try may have gone out.
    const refused = REFUSED.has(code) || REVERTED.has(code) || code === "UnknownRoot";
    if (!refused || mayBeOut) return settle(store, sending, "sending", t, { maybeSent: true, reason });
    if (code === "UnknownRoot") return settle(store, sending, "expired", t, { reason: EXPIRED_REASON });
    if (PERMANENT.has(code) || (REVERTED.has(code) && !REVERTED_PASSING.has(code))) {
      return settle(store, sending, "failed", t, { reason });
    }
    if (t - giveUpFrom(job) > giveUpAfter(job)) return settle(store, sending, "failed", t, { reason });
    // A passing refusal (busy, out of gas for a moment, the vault short for now): again next pass.
    return settle(store, sending, "scheduled", t, { reason, ...retryLater(job, t) });
  }
}

/** Where the give-up counts from: the send time, or the end of a wait for gas after it. */
function giveUpFrom(job: CashOutJob): number {
  return Math.max(job.sendAfter, job.gasHeldAt ?? 0);
}

/** How long past that a job keeps trying through a passing problem. */
function giveUpAfter(job: CashOutJob): number {
  return job.dated ? DATED_GIVE_UP_AFTER_MS : GIVE_UP_AFTER_MS;
}

/** A dated job tries again in a few minutes, not on the next pass: it has a day, and retrying every pass would sit at the front of the queue. */
function retryLater(job: CashOutJob, now: number): Partial<CashOutJob> {
  return job.dated ? { notBefore: now + DATED_RETRY_MS } : {};
}

/** Whether to hold a due job for gas. A check that fails holds it too: better late than paid blind. */
async function gasIsHigh(deps: RunDeps, job: CashOutJob): Promise<boolean> {
  if (!deps.gasHigh) return false;
  try {
    return await deps.gasHigh(job);
  } catch {
    return true;
  }
}

/** A due job held for gas: looked at again in a few minutes, or given up after GAS_WAIT_MAX_MS (nothing moved). */
function waitForGas(store: JobStore, job: CashOutJob, now: number): Promise<JobStatus> {
  if (now - job.sendAfter > GAS_WAIT_MAX_MS) return settle(store, job, "failed", now, { reason: GAS_GAVE_UP_REASON, notBefore: undefined });
  return settle(store, job, "scheduled", now, { notBefore: now + GAS_RECHECK_MS, reason: GAS_WAIT_REASON, gasHeldAt: now });
}

/** Two hex strings the same, in any letter case. */
function sameHex(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && /^0x[0-9a-fA-F]{64}$/.test(b) && a.toLowerCase() === b.toLowerCase();
}

/**
 * Cancels a job that has not gone out, for whoever holds its note: `nullifier`
 * must be the spend's own (the app works it out from the note's secret; it is
 * not public until the cash out lands). Returns its status after the call:
 * "sending" once a run has reached the send (it may be on its way, so only
 * the chain can settle it), whatever its status says; "not_yours" when the
 * nullifier is not this job's (nothing changes).
 */
export async function cancelJob(store: JobStore, id: string, now: number, nullifier: string): Promise<JobStatus | "not_yours" | null> {
  const release = await store.lock(id, 30);
  if (!release) return "sending";
  try {
    const job = await store.get(id);
    if (!job) return null;
    if (!sameHex(job.nullifier, nullifier)) return "not_yours";
    if (job.status === "scheduled" && (job.attempts > 0 || job.maybeSent)) return "sending";
    if (job.status !== "scheduled") return job.status;
    await store.put(retire({ ...job, status: "cancelled", updatedAt: now }, "cancelled"));
    return "cancelled";
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------- a fresher proof

/** A waiting job's proof is swapped only while its send time is at least this far off, so the runner never meets it mid-change. */
export const REPROVE_MIN_LEAD_MS = 60 * 1000;

/** A newer proof of a waiting cash out: it must be the same spend, paying the same amount of the same asset to the same address. */
export type ProofReplacement = {
  chainId: number;
  proof: Hex;
  root: Hex;
  nullifier: Hex;
  asset: Address;
  to: Address;
  /** Base units, as a decimal string. */
  amount: string;
};

export type ReplaceRefusal =
  /** No such job. */
  | "not_found"
  /** It is no longer waiting untouched: sending, sent, over, or a send was already tried. */
  | "not_live"
  /** Its send time is under REPROVE_MIN_LEAD_MS away (or past). */
  | "too_late"
  /** Another spend, chain, recipient, amount or asset. */
  | "mismatch"
  /** Another run holds the job right now. */
  | "busy";

/** Why `next` can't replace `job`'s proof at `now`, or null when it can. */
export function replaceRefusal(job: CashOutJob | null, next: ProofReplacement, now: number): ReplaceRefusal | null {
  if (!job) return "not_found";
  // A job a run already tried may be on its way: only the chain settles it now.
  if (job.status !== "scheduled" || job.attempts > 0 || job.maybeSent) return "not_live";
  if (job.sendAfter - now < REPROVE_MIN_LEAD_MS) return "too_late";
  const same =
    job.chainId === next.chainId && job.nullifier.toLowerCase() === next.nullifier.toLowerCase() && sameCashOut(job, next);
  return same ? null : "mismatch";
}

export type ReplaceOutcome = { ok: true; job: CashOutJob } | { ok: false; code: ReplaceRefusal; job?: CashOutJob };

/**
 * Swaps a waiting job's proof and root for a newer proof of the same cash
 * out, under the job's lock (so a run can't take it mid-change). The job keeps
 * its id, send time, spend, recipient, amount and asset, and stays the one job
 * for its spend: nothing new is created, and a refused swap leaves the old
 * proof as it was. The caller dry-runs the new proof first
 * (lib/relay/server checkUnshieldForLater), so only a proof the vault takes
 * now replaces one it took before.
 */
export async function replaceJobProof(store: JobStore, id: string, next: ProofReplacement, now: number): Promise<ReplaceOutcome> {
  const release = await store.lock(id, 30);
  if (!release) return { ok: false, code: "busy" };
  try {
    const job = await store.get(id);
    const code = replaceRefusal(job, next, now);
    if (code) return job ? { ok: false, code, job } : { ok: false, code };
    const replaced: CashOutJob = { ...job!, proof: next.proof, root: next.root, updatedAt: now };
    await store.put(replaced);
    return { ok: true, job: replaced };
  } finally {
    await release();
  }
}

export type ScheduleOutcome = {
  job: CashOutJob;
  /** created: saved now. existing: the same cash out was already waiting. conflict: another one is. */
  outcome: "created" | "existing" | "conflict";
};

/**
 * Saves `job` as the one live job for its spend. Another live job for the same
 * spend comes back instead: "existing" when it is the same cash out, "conflict"
 * when it pays another address (or amount). A spend whose last job is over is
 * taken over once; two requests at the same moment can't both be saved.
 */
export async function scheduleJob(store: JobStore, job: CashOutJob): Promise<ScheduleOutcome> {
  let replace: string | undefined;
  for (let i = 0; i < 2; i++) {
    const holder = await store.create(job, replace);
    if (holder === job.id) return { job, outcome: "created" };
    const other = await store.get(holder);
    if (other && isLive(other.status)) return { job: other, outcome: sameCashOut(other, job) ? "existing" : "conflict" };
    replace = holder;
  }
  throw new Error("cash out later: the spend is being scheduled by another request");
}
