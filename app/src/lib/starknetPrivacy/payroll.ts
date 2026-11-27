/**
 * Payroll on Starknet: pay a list of private accounts on the Starknet privacy
 * pool from one private balance, in as few proofs as it takes.
 *
 * Pure rules and the run engine, with everything that touches the chain, the
 * relay or storage passed in (lib/starknetPrivacy/payrollSession for the
 * page's, lib/starknetPrivacy/payrollStore for storage). Checked by
 * scripts/selftest-starknet-payroll.mts and, on devnet, by
 * scripts/e2e-starknet-devnet.mts.
 *
 *  - The list: name, private account, amount; a header is optional. Every row
 *    is checked before anyone is paid: a Starknet address, an amount above
 *    zero within the token's decimals, and a private account the pool knows
 *    (registered). A person who never opened a private account on Starknet
 *    can't be paid privately, and the row says so. Bad rows are skipped.
 *  - One proof, many people: one apply_actions carries a payment to each
 *    person in it, Gloam's fee once, and the change, so a run pays one relay
 *    fee per proof, not per person. A proof is one of a small daily quota, so
 *    the run puts as many people in each as the relay takes (relayPolicy's
 *    MAX_ACTIONS server actions), checked on the pool before any proof is
 *    made (the SDK's simulate). The first payment to someone opens a channel
 *    to them and costs more room than a payment over one already open.
 *  - What shows: a payment over an open channel shows nobody and no amount;
 *    a first payment shows the payee's private account, and a proof with
 *    several first payments shows those accounts together. Each proof shows
 *    how many notes it makes (about one per person), never to whom or how
 *    much, and its fee to Gloam's relay.
 *  - Claim links: a row with no account is paid by a claim link
 *    (lib/starknetPrivacy/claimLink). Before the proof that pays it, the run
 *    keeps a new link (sealed, under Sent links), then opens its one-time
 *    account (deployed by the relay, then its own open, one proof), and the
 *    link is paid in the same proof as everyone else, with Gloam's fee for its
 *    open and for its later claim paid in that proof too.
 *  - Resume without paying twice: before a proof goes to the relay, the run is
 *    saved with the notes it spends and the block it was proven at. A proof
 *    found in flight on resume is settled first: by its transaction when the
 *    run has its hash, else by whether its notes were spent. Only once it can
 *    no longer land (the pool takes a proof for proof_validity_blocks after
 *    its block) with its notes unspent is it proven again.
 */
import { readAmountText } from "@/lib/amountText";
import type { StarknetNetwork, StarknetToken } from "./config";

// ------------------------------------------------------------------ limits

/** Most people per run, as on the other chains. */
export const PAYROLL_MAX_ROWS = 200;
/**
 * Most people one proof is tried with. The relay's cap on server actions
 * (relayPolicy MAX_ACTIONS) is what really decides: the run checks each proof
 * on the pool first and takes fewer when they don't fit.
 */
export const PAYROLL_PROOF_MAX = 28;
/**
 * Server actions a proof's fixed part takes and each person in it, measured
 * on devnet with PRIVACY-0.14.4-RC.2 on 2026-11-27: 6 for one note spent, the
 * change and Gloam's fee (2 more for each further note spent; 8 here, two
 * notes), 2 a payment over an open channel and 7 a first payment (it opens
 * the channel). Only for the estimate a run shows before it starts; the run
 * checks every proof on the pool before it is made.
 */
export const ACTIONS_BASE = 8;
export const ACTIONS_PER_PAYMENT = 2;
export const ACTIONS_PER_FIRST_PAYMENT = 7;
/** The relay's cap (relayPolicy MAX_ACTIONS), repeated here so this file stays pure. */
export const RELAY_MAX_ACTIONS = 64;

/** 429s in a row before the run pauses itself. */
export const RELAY_LIMITED_TRIES = 4;
/** How often a proof in flight is checked again. */
export const INFLIGHT_POLL_MS = 5_000;
/** Longest one look at a proof in flight before the run pauses with it still in flight. */
export const INFLIGHT_MAX_MS = 6 * 60_000;

const U128_MAX = (1n << 128n) - 1n;
/** A Starknet address is a felt below 2^251. */
const ADDRESS_MAX = 1n << 251n;

// ------------------------------------------------------------------ the list

export type DraftRow = {
  /** Line in the list as pasted or uploaded, from 1. */
  line: number;
  name: string;
  /** The private account, as typed (normalised once it reads as an address). */
  address: string;
  amountInput: string;
  /** Base units, or null when the amount can't be read. */
  amount: bigint | null;
  /** Why this row is skipped, or null. */
  error: string | null;
  /** A plain note that doesn't stop the row. */
  note?: string;
  /** The first payment to this account: it opens a channel, which shows their account. */
  first?: boolean;
  /** No account given: paid by a claim link. */
  link?: boolean;
};

const CSV_DELIMITERS = ["\t", ";", ","] as const;
type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

function csvDelimiter(line: string): CsvDelimiter {
  const seen: Record<CsvDelimiter, number> = { "\t": 0, ";": 0, ",": 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in seen) seen[ch as CsvDelimiter]++;
  }
  return CSV_DELIMITERS.reduce((best, d) => (seen[d] > seen[best] ? d : best), CSV_DELIMITERS[0]);
}

/** One line's cells. A quoted cell runs to its closing quote; null when one never closes or has text after it. */
function splitCsvLine(line: string, delimiter: CsvDelimiter): string[] | null {
  const out: string[] = [];
  let cur = "";
  let state: "open" | "quoted" | "closed" = "open";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (state === "quoted") {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else state = "closed";
    } else if (ch === delimiter) {
      out.push(cur.trim());
      cur = "";
      state = "open";
    } else if (state === "closed") {
      if (ch.trim()) return null;
    } else if (ch === '"' && !cur.trim()) {
      cur = "";
      state = "quoted";
    } else {
      cur += ch;
    }
  }
  if (state === "quoted") return null;
  out.push(cur.trim());
  return out;
}

const NAME_KEYS = ["name", "payee", "employee", "person", "contractor", "full name"];
const ADDRESS_KEYS = [
  "address",
  "starknet_address",
  "starknet address",
  "private_account",
  "private account",
  "private_address",
  "private address",
  "account",
  "starknet",
  "wallet",
  "recipient",
  "to",
];
const AMOUNT_KEYS = ["amount", "pay", "salary", "usd", "usdc", "value", "total"];
const NOTE_KEYS = ["note", "notes", "memo", "reference", "ref", "description"];

const headerKey = (h: string) => h.toLowerCase().replace(/\s+/g, " ").trim();
const findCol = (header: string[], keys: string[]) => header.findIndex((h) => keys.includes(headerKey(h)));

/** "1.5" in `decimals` places as base units, or why not. */
export function readPayrollAmount(input: string, decimals: number): { amount: bigint } | { error: string } {
  const read = readAmountText(input.replace(/[$\s]/g, ""), decimals);
  if (!read.ok) return { error: read.error };
  if (!read.text) return { error: "Enter an amount above zero." };
  const [whole, frac = ""] = read.text.split(".");
  const amount = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (amount <= 0n) return { error: "Enter an amount above zero." };
  if (amount > U128_MAX) return { error: "That amount is too large." };
  return { amount };
}

/** A Starknet address as one form (0x, lower case, no leading zeros), or null when it isn't one. */
export function starknetAddressText(v: string): string | null {
  const t = v.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) return null;
  const n = BigInt(t);
  return n > 0n && n < ADDRESS_MAX ? `0x${n.toString(16)}` : null;
}

export type ParsedList = {
  rows: DraftRow[];
  error: string | null;
  /** The list had a note column: Starknet payments carry no note, so it is left out. */
  notesLeftOut: boolean;
};

/**
 * Parse a pasted or uploaded list into rows, each checked on its own (whether
 * an account can be paid privately comes after, in checkRecipients). Columns:
 * name, private account, amount; a header row is optional and may name them
 * in another order. A note column, as EVM lists have, is read past.
 */
export function parseStarknetPayrollCsv(text: string, token: Pick<StarknetToken, "decimals" | "symbol">, opts: { links?: boolean } = {}): ParsedList {
  const lines = text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l, i) => ({ l, i: i + 1 }))
    .filter((x) => x.l.trim().length > 0);
  if (!lines.length) return { rows: [], error: null, notesLeftOut: false };

  const delimiter = csvDelimiter(lines[0]!.l);
  const first = splitCsvLine(lines[0]!.l, delimiter) ?? [];
  let cols = { name: 0, address: 1, amount: 2 };
  let start = 0;
  let notesLeftOut = false;
  const looksLikeHeader = first.some((c) => [...NAME_KEYS, ...ADDRESS_KEYS, ...AMOUNT_KEYS].includes(headerKey(c)));
  if (looksLikeHeader) {
    const address = findCol(first, ADDRESS_KEYS);
    const amount = findCol(first, AMOUNT_KEYS);
    if (address < 0 || amount < 0) return { rows: [], error: "The header needs an address column and an amount column (name, address, amount).", notesLeftOut: false };
    cols = { name: findCol(first, NAME_KEYS), address, amount };
    notesLeftOut = findCol(first, NOTE_KEYS) >= 0;
    start = 1;
  } else if (first.length === 2) {
    cols = { name: -1, address: 0, amount: 1 }; // address, amount
  } else if (first.length === 4) {
    notesLeftOut = true; // name, address, amount, note (the EVM template's order)
  }
  // A row with more cells than the list has columns had a delimiter inside a
  // cell (an unquoted 1,250): its cells have shifted, so it is refused, not read.
  const width = looksLikeHeader ? first.length : first.length === 2 ? 2 : first.length === 4 ? 4 : 3;

  const body = lines.slice(start).filter(({ l }) => {
    const cells = splitCsvLine(l, delimiter);
    return !cells || cells.some((c) => c.length > 0);
  });
  if (body.length > PAYROLL_MAX_ROWS) {
    return { rows: [], error: `Up to ${PAYROLL_MAX_ROWS} people per run. Split the list into smaller runs.`, notesLeftOut };
  }

  const seen = new Map<string, number>();
  const rows = body.map(({ l, i }, idx): DraftRow => {
    const cells = splitCsvLine(l, delimiter);
    const c = cells ?? [];
    const name = ((cols.name >= 0 ? c[cols.name] : "") ?? "").slice(0, 60) || `Person ${idx + 1}`;
    const typed = (c[cols.address] ?? "").trim();
    const amountInput = (c[cols.amount] ?? "").trim();
    const address = starknetAddressText(typed);
    let error: string | null = !cells
      ? "Check the quotes in this row: a quoted cell needs its closing quote, with nothing after it."
      : cells.length > width
        ? 'This row has more cells than the list has columns. Put an amount with a comma in quotes, like "1,250", and use a dot for decimals.'
        : null;
    const link = !error && !typed && opts.links === true;
    if (!error && !typed && !link) error = "Add their private account on Starknet.";
    else if (!error && typed && !address) {
      error = typed.startsWith("gloamr1") ? "That is a Gloam address for the other networks. Use their private account on Starknet." : "Not a Starknet address. Copy their private account again from Gloam.";
    }
    const read = readPayrollAmount(amountInput, token.decimals);
    const amount = !error && "amount" in read ? read.amount : null;
    if (!error && "error" in read) error = read.error;
    const row: DraftRow = { line: i, name, address: address ?? typed, amountInput, amount, error, ...(link ? { link: true } : {}) };
    if (!error && address) {
      const prior = seen.get(address);
      if (prior !== undefined) row.note = `Same account as line ${prior}. Both lines are paid.`;
      else seen.set(address, i);
    }
    return row;
  });
  return { rows, error: null, notesLeftOut };
}

/**
 * Where an account stands for a payment from this one (the SDK's
 * SetupRequirement): "closed" has no private account on Starknet (never
 * registered), "first" can be paid and the first payment opens a channel to
 * it, "ready" has a channel open already.
 */
export type Reach = "closed" | "first" | "ready";

export const NOT_OPEN = "No private account on Starknet yet. They need to open one in Gloam first, then send you its address.";
export const OWN_ACCOUNT = "That is your own private account.";

/** Flag rows that can't be paid privately and mark first payments. Returns new rows. */
export function checkRecipients(rows: readonly DraftRow[], reach: ReadonlyMap<string, Reach>, owner: string): DraftRow[] {
  const self = starknetAddressText(owner);
  return rows.map((r) => {
    if (r.error || r.link) return r;
    if (r.address === self) return { ...r, error: OWN_ACCOUNT, amount: null };
    const at = reach.get(r.address);
    if (at === "closed") return { ...r, error: NOT_OPEN, amount: null };
    if (at === "first") return { ...r, first: true };
    return r;
  });
}

/** The accounts the reach check still has to read. */
export function addressesToCheck(rows: readonly DraftRow[], known: ReadonlyMap<string, Reach>): string[] {
  return [...new Set(rows.filter((r) => !r.error && !r.link && !known.has(r.address)).map((r) => r.address))];
}

/**
 * About how many proofs a list takes: people packed into proofs in order, each
 * proof under the relay's cap. A first payment counts once per account (a
 * second line to the same account in the same proof rides its channel).
 */
export function estimateProofs(rows: readonly { first?: boolean; link?: boolean; address: string }[]): number {
  let proofs = 0;
  let used = Infinity;
  let people = 0;
  let opened = new Set<string>();
  for (const r of rows) {
    // A claim link's one-time account is new: its payment opens a channel.
    const cost = r.link || (r.first && !opened.has(r.address)) ? ACTIONS_PER_FIRST_PAYMENT : ACTIONS_PER_PAYMENT;
    if (used + cost > RELAY_MAX_ACTIONS || people >= PAYROLL_PROOF_MAX) {
      proofs++;
      used = ACTIONS_BASE;
      people = 0;
      opened = new Set();
    }
    used += cost;
    people++;
    if (r.first) opened.add(r.address);
  }
  return proofs;
}

export type DraftSummary = {
  ready: number;
  skipped: number;
  /** What the people are paid. */
  total: bigint;
  /** About how many proofs now: the payments (estimateProofs) and one to open each link's account. */
  proofs: number;
  /** Claim links in it: each takes one more proof later, when it is claimed. */
  links: number;
  /** Gloam's fee: once per payment proof, and twice per link (its open and its claim). */
  fees: bigint;
  /** How many are paid for the first time (their accounts show). */
  first: number;
  /** How much the private balance is short of total and fees (0n when it covers them). */
  short: bigint;
};

/** What the run would pay and cost, against the private balance. `fee` is Gloam's fee per proof. */
export function summarize(rows: readonly DraftRow[], balance: bigint, fee: bigint): DraftSummary {
  const ok = rows.filter((r) => !r.error && r.amount !== null);
  const total = ok.reduce((s, r) => s + r.amount!, 0n);
  const payments = estimateProofs(ok);
  const links = ok.filter((r) => r.link).length;
  const fees = BigInt(payments + 2 * links) * fee;
  const first = new Set(ok.filter((r) => r.first).map((r) => r.address)).size;
  const need = total + fees;
  return { ready: ok.length, skipped: rows.length - ok.length, total, proofs: payments + links, links, fees, first, short: need > balance ? need - balance : 0n };
}

// ------------------------------------------------------------------ the run

export type RowStatus =
  | "queued"
  /** In the proof being made (it waits for Starknet's blocks first). */
  | "proving"
  /** Proven and handed to the relay, no transaction yet. */
  | "sending"
  /** The relay sent it; waiting for Starknet. */
  | "confirming"
  /** In flight when the tab closed or the relay's answer was lost: being checked. */
  | "checking"
  | "paid"
  /** A bad row, never paid. */
  | "skipped"
  /** Left out when the run was closed early. */
  | "not_paid"
  /** Its proof could not be settled either way: never sent again from this run. */
  | "unknown";

export type RunRow = {
  line: number;
  name: string;
  address: string;
  /** Base units. */
  amount: string;
  status: RowStatus;
  /** The first payment to this account (its account shows). */
  first?: boolean;
  /** Why it was skipped, or the last error on it. */
  reason?: string;
  txHash?: string;
  /** Paid by a claim link: its Sent links id once kept (`address` is its one-time account then), and whether that account is open. */
  link?: { id?: string; open?: boolean };
};

/** A proof handed (or about to be handed) to the relay. */
export type Inflight = {
  /** Indexes into run.rows. */
  rows: number[];
  /** Hex ids of the notes it spends: gone means it (or something else) spent them. */
  spends: string[];
  /** Hex ids of the change notes it makes (none when it spends exactly). */
  change: string[];
  /** The block it was proven at: the pool takes it until that plus its validity window. */
  provedAt: number;
  txHash?: string;
  at: number;
};

export type PayrollRun = {
  v: 1;
  id: string;
  network: StarknetNetwork;
  /** The paying private account. */
  owner: string;
  /** The token's address. */
  token: string;
  createdAt: number;
  rows: RunRow[];
  inflight: Inflight | null;
  state: "running" | "paused" | "done";
  /** Why it paused, shown until it runs again. */
  error?: string;
  /** Proofs this run has sent, and what they paid Gloam (base units). */
  proofs: number;
  feesPaid: string;
  /** Set when the run pays a saved schedule (lib/starknetPrivacy/payrollSchedule): which one, and for which payday. */
  scheduleId?: string;
  payday?: string;
};

export function newRun(args: {
  id: string;
  network: StarknetNetwork;
  owner: string;
  token: string;
  rows: readonly DraftRow[];
  now: number;
  schedule?: { id: string; payday: string };
}): PayrollRun {
  return {
    ...(args.schedule ? { scheduleId: args.schedule.id, payday: args.schedule.payday } : {}),
    v: 1,
    id: args.id,
    network: args.network,
    owner: args.owner,
    token: args.token,
    createdAt: args.now,
    rows: args.rows.map((r) => ({
      line: r.line,
      name: r.name,
      address: r.address,
      amount: r.amount !== null && !r.error ? r.amount.toString() : "0",
      status: r.error || r.amount === null ? "skipped" : "queued",
      ...(r.first ? { first: true } : {}),
      ...(r.link && !r.error ? { link: {} } : {}),
      ...(r.error ? { reason: r.error } : {}),
    })),
    inflight: null,
    state: "paused",
    proofs: 0,
    feesPaid: "0",
  };
}

export type RunCounts = { paid: number; toPay: number; skipped: number; unknown: number; paidAmount: bigint; total: bigint };

export function runCounts(run: PayrollRun): RunCounts {
  let paid = 0;
  let toPay = 0;
  let skipped = 0;
  let unknown = 0;
  let paidAmount = 0n;
  let total = 0n;
  for (const r of run.rows) {
    if (r.status === "skipped") {
      skipped++;
      continue;
    }
    total += BigInt(r.amount);
    if (r.status === "paid") {
      paid++;
      paidAmount += BigInt(r.amount);
    } else if (r.status === "unknown") unknown++;
    else if (r.status !== "not_paid") toPay++;
  }
  return { paid, toPay, skipped, unknown, paidAmount, total };
}

/** Rows still to pay or still in flight. A run with none is finished. */
export function runOpen(run: PayrollRun): boolean {
  return run.inflight !== null || run.rows.some((r) => r.status === "queued" || r.status === "proving" || r.status === "sending" || r.status === "confirming" || r.status === "checking");
}

/** Close a paused run early: rows not paid yet stay unpaid. Refused while a proof may still land. */
export function closeRun(run: PayrollRun): PayrollRun {
  if (run.inflight) throw new Error("The last proof may still land. Resume to check it first.");
  return {
    ...run,
    state: "done",
    error: undefined,
    rows: run.rows.map((r) => (r.status === "queued" || r.status === "proving" ? { ...r, status: "not_paid" as const } : r)),
  };
}

/**
 * How long to wait after the `attempt`th 429 in a row (from 1): the relay
 * counts per calendar minute, so the first wait runs to the next minute; each
 * later one adds 30 seconds. A proof stays good for its validity window.
 */
export function rateLimitDelay(attempt: number, now: number): number {
  const toNextMinute = 60_000 - (now % 60_000);
  return toNextMinute + 1_500 + Math.max(0, attempt - 1) * 30_000;
}

// ------------------------------------------------------------------ engine

/** A refusal from Gloam's relay. `maybeSent`: the relay may have sent it before its answer was lost. */
export type RelayRefusal = { status: number; code: string; message: string; maybeSent: boolean };

export function isRelayRefusal(e: unknown): e is RelayRefusal {
  const r = e as Partial<RelayRefusal> | null;
  return Boolean(r) && typeof r!.status === "number" && typeof r!.code === "string" && typeof r!.maybeSent === "boolean";
}

/** A proof made for the first `count` payments it was given. Nothing is sent. */
export type Proven = {
  count: number;
  spends: string[];
  change: string[];
  provedAt: number;
  /** Gloam's fee it pays (base units), with what it pays for its links' opens and claims. */
  fee: bigint;
  /** The call and its proof, handed to `send` as they are. */
  payload: unknown;
};

export type InflightResult =
  | { state: "landed"; txHash?: string }
  /** It reached Starknet and failed there: nobody in it was paid. */
  | { state: "failed"; message: string }
  /** It may still land: check again shortly. */
  | { state: "pending" }
  /** Past its validity window with its notes unspent: it never landed and never will. */
  | { state: "dropped" }
  /** Can't tell (its notes are gone, but nothing ties that to this proof). */
  | { state: "unknown" };

export type PayrollDeps = {
  /** Persist the run. Before a send it must resolve only once the run is stored; if it throws, nothing is sent. */
  save(run: PayrollRun): Promise<void>;
  /**
   * Make one proof paying as many of `payments`, from the first, as fit one
   * transaction (it checks on the pool before proving). `onWait` names the
   * blocks it waits for first. Nothing is sent.
   */
  prove(payments: { address: string; amount: bigint; link?: boolean }[], onWait: (detail: string) => void): Promise<Proven>;
  /** Hand a proof to the relay; its transaction hash. Rejects with a RelayRefusal when the relay says no. */
  send(proven: Proven): Promise<string>;
  /** Keep a new claim link (sealed, before anything is sent for it): its id and its one-time account. Runs with link rows need it. */
  newLink?(row: { name: string; amount: bigint; runId: string }): Promise<{ id: string; address: string }>;
  /** Open a kept link's one-time account (deploy, then its open). Safe to run again. */
  openLink?(id: string, onWait: (detail: string) => void): Promise<void>;
  /** These rows' payment landed (`txHash` when known): a claim link among them is paid. */
  onPaid?(rows: readonly RunRow[], txHash?: string): Promise<void>;
  /** Wait for a sent transaction to land. Rejects if it reverts or takes too long. */
  confirm(txHash: string): Promise<void>;
  /** Where a proof in flight stands. */
  resolve(inflight: Inflight): Promise<InflightResult>;
  /** Plain words for an error. */
  message(e: unknown): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Checked between proofs: pause after the current one. */
  stopRequested(): boolean;
  onChange?(run: PayrollRun, detail?: string): void;
};

export const RELAY_BUSY = "Gloam's relay is at its limit for now. Your run is saved: resume in a few minutes.";
export const SAVE_FAILED = "This browser couldn't save the run, so the next proof wasn't sent. Free some space and resume.";
export const PROOF_DROPPED = "The last proof didn't land on Starknet, so nobody in it was paid. Resume to send it again.";
export const PROOF_STILL_CHECKING = "Starknet hasn't said yet whether the last proof went through. Resume in a minute to check it again.";
export const NOT_SURE = "Couldn't tell whether this landed, so it isn't sent again. Check with them before paying them again.";
export const LINKS_OFF = "Claim links can't be made here.";

function setRows(run: PayrollRun, idx: readonly number[], patch: Partial<RunRow>): void {
  for (const i of idx) run.rows[i] = { ...run.rows[i]!, ...patch };
}

/**
 * Pay a run's queued rows, settling any proof left in flight first. Returns
 * when every row is settled, when it pauses itself (an error, the relay's
 * limit, a stop request), or rejects only if `save` fails after a send (the
 * stored run still has the proof in flight, so a resume settles it).
 * Never sends a proof while an earlier one could still land.
 */
export async function runPayroll(run: PayrollRun, deps: PayrollDeps): Promise<PayrollRun> {
  const changed = async (strict = false, detail?: string) => {
    deps.onChange?.(run, detail);
    if (strict) return deps.save(run);
    try {
      await deps.save(run);
    } catch {
      // a later save, or the in-flight check on resume, covers it
    }
  };
  const pause = async (error?: string) => {
    for (const r of run.rows) if (r.status === "proving") r.status = "queued";
    run.state = "paused";
    run.error = error;
    await changed();
    return run;
  };

  run.state = "running";
  run.error = undefined;
  await changed();

  let limited = 0;
  let drops = 0;
  let checkingSince: number | null = null;

  for (;;) {
    // 1. A proof in flight is settled before anything else is sent.
    if (run.inflight) {
      const f = run.inflight;
      setRows(run, f.rows, { status: "checking" });
      deps.onChange?.(run);
      checkingSince ??= deps.now();
      let r: InflightResult;
      try {
        r = await deps.resolve(f);
      } catch (e) {
        return pause(deps.message(e));
      }
      if (r.state === "pending") {
        if (deps.stopRequested()) return pause();
        if (deps.now() - checkingSince >= INFLIGHT_MAX_MS) return pause(PROOF_STILL_CHECKING);
        await deps.sleep(INFLIGHT_POLL_MS);
        continue;
      }
      checkingSince = null;
      run.inflight = null;
      if (r.state === "landed") {
        drops = 0;
        const hash = r.txHash ?? f.txHash;
        setRows(run, f.rows, { status: "paid", reason: undefined, ...(hash ? { txHash: hash } : {}) });
        await changed();
        await deps.onPaid?.(f.rows.map((i) => run.rows[i]!), hash).catch(() => undefined);
        continue;
      }
      if (r.state === "unknown") {
        setRows(run, f.rows, { status: "unknown", reason: NOT_SURE });
        await changed();
        continue;
      }
      if (r.state === "failed") {
        setRows(run, f.rows, { status: "queued", reason: r.message, txHash: undefined });
        return pause(r.message);
      }
      // dropped: nobody in it was paid
      setRows(run, f.rows, { status: "queued", txHash: undefined });
      if (++drops >= 2) return pause(PROOF_DROPPED);
      await changed();
      continue;
    }

    // 2. The next proof.
    if (deps.stopRequested()) return pause();
    const queued = run.rows.map((r, i) => (r.status === "queued" ? i : -1)).filter((i) => i >= 0);
    if (!queued.length) {
      run.state = "done";
      run.error = undefined;
      await changed();
      return run;
    }
    const idx = queued.slice(0, PAYROLL_PROOF_MAX);

    // Claim links in it: kept, then their one-time accounts opened, one at a time, before its proof.
    for (const i of idx) {
      const row = run.rows[i]!;
      if (!row.link || row.link.open) continue;
      if (!deps.newLink || !deps.openLink) return pause(LINKS_OFF);
      if (deps.stopRequested()) return pause();
      try {
        if (!row.link.id) {
          const made = await deps.newLink({ name: row.name, amount: BigInt(row.amount), runId: run.id });
          run.rows[i] = { ...row, address: made.address, link: { id: made.id } };
          // Saved before anything is sent for it: a resume opens this link, never a second one.
          try {
            await changed(true);
          } catch {
            return pause(SAVE_FAILED);
          }
        }
        setRows(run, [i], { status: "proving" });
        await deps.openLink(run.rows[i]!.link!.id!, (detail) => deps.onChange?.(run, detail));
        run.rows[i] = { ...run.rows[i]!, status: "queued", link: { ...run.rows[i]!.link!, open: true } };
        await changed();
      } catch (e) {
        setRows(run, [i], { status: "queued" });
        return pause(deps.message(e));
      }
    }

    setRows(run, idx, { status: "proving" });
    deps.onChange?.(run);

    let proven: Proven;
    try {
      proven = await deps.prove(
        idx.map((i) => ({ address: run.rows[i]!.address, amount: BigInt(run.rows[i]!.amount), ...(run.rows[i]!.link ? { link: true } : {}) })),
        (detail) => deps.onChange?.(run, detail)
      );
    } catch (e) {
      setRows(run, idx, { status: "queued" });
      return pause(deps.message(e));
    }
    const count = Math.max(0, Math.min(proven.count, idx.length));
    if (count === 0) {
      setRows(run, idx, { status: "queued" });
      return pause("This payment doesn't fit one Starknet transaction.");
    }
    const inProof = idx.slice(0, count);
    setRows(run, idx.slice(count), { status: "queued" });

    // Saved before it is sent: a tab closed from here on resumes by checking it.
    run.inflight = { rows: inProof, spends: proven.spends, change: proven.change, provedAt: proven.provedAt, at: deps.now() };
    setRows(run, inProof, { status: "sending", reason: undefined });
    try {
      await changed(true);
    } catch {
      run.inflight = null;
      setRows(run, inProof, { status: "queued" });
      return pause(SAVE_FAILED);
    }

    let txHash: string | null = null;
    for (;;) {
      try {
        txHash = await deps.send(proven);
        break;
      } catch (e) {
        if (isRelayRefusal(e) && !e.maybeSent) {
          if (e.status === 429 && limited < RELAY_LIMITED_TRIES && !deps.stopRequested()) {
            // The same proof goes again once the minute turns: it stays good for its window.
            limited++;
            await deps.sleep(rateLimitDelay(limited, deps.now()));
            continue;
          }
          // Refused before it was sent: nobody in it was paid.
          run.inflight = null;
          setRows(run, inProof, { status: "queued" });
          return pause(e.status === 429 ? RELAY_BUSY : e.message || deps.message(e));
        }
        break; // it may have been sent: settle it (step 1) before anything else
      }
    }
    if (txHash === null) continue;
    limited = 0;
    run.proofs += 1;
    run.feesPaid = (BigInt(run.feesPaid) + proven.fee).toString();
    run.inflight = { ...run.inflight, txHash };
    setRows(run, inProof, { status: "confirming", txHash });
    await changed();

    try {
      await deps.confirm(txHash);
    } catch {
      continue; // step 1 asks Starknet what happened to it
    }
    drops = 0;
    run.inflight = null;
    setRows(run, inProof, { status: "paid", txHash });
    await changed();
    await deps.onPaid?.(inProof.map((i) => run.rows[i]!), txHash).catch(() => undefined);
  }
}

/**
 * Where a proof in flight stands, from what Starknet says now: its
 * transaction's receipt (when the run has its hash), whether the notes it
 * spends are still unspent, whether its change notes exist, and how far the
 * chain is past its block. Pure, so the self-test holds every case.
 */
export function settleInflight(f: Pick<Inflight, "txHash" | "spends" | "change" | "provedAt">, now: {
  /** The transaction's receipt: null when the node doesn't know it (yet). */
  receipt: { status: "succeeded" | "reverted"; reason?: string } | null;
  /** Ids of this account's unspent notes now. */
  unspent: ReadonlySet<string>;
  head: number;
  /** The pool's proof_validity_blocks. */
  validity: number;
}): InflightResult {
  if (now.receipt?.status === "succeeded") return { state: "landed", ...(f.txHash ? { txHash: f.txHash } : {}) };
  if (now.receipt?.status === "reverted") return { state: "failed", message: `Starknet reverted it${now.receipt.reason ? `: ${now.receipt.reason.slice(0, 120)}` : "."}` };
  const gone = f.spends.some((id) => !now.unspent.has(id));
  if (gone) {
    // Its notes were spent: by this proof when its change is there (or it made none and the hash is known).
    if (f.change.length ? f.change.some((id) => now.unspent.has(id)) : false) return { state: "landed" };
    return f.txHash ? { state: "pending" } : { state: "unknown" };
  }
  // Nothing spent yet: it can still land until the pool's window closes (one block of margin).
  if (now.head > f.provedAt + now.validity + 1) return { state: "dropped" };
  return { state: "pending" };
}

// ------------------------------------------------------------------ results

/** Base units as an exact decimal string in `decimals` places ("1.5", "250"). */
export function formatUnits(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** A cell a spreadsheet would run as a formula gets an apostrophe in front, so it reads as text. */
function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_STATUS: Record<RowStatus, string> = {
  queued: "waiting",
  proving: "waiting",
  sending: "checking",
  confirming: "checking",
  checking: "checking",
  paid: "paid",
  skipped: "skipped",
  not_paid: "not paid",
  unknown: "unknown",
};

/**
 * The run as a CSV: row, name, account, amount, token, status, transaction,
 * claim link, reason. A claim link is a bearer secret: `linkUrl` gives it for
 * a link row (only while it may still be unclaimed), and the file says so on
 * the page that downloads it.
 */
export function resultsCsv(run: PayrollRun, token: Pick<StarknetToken, "decimals" | "symbol">, linkUrl: (id: string) => string | null = () => null): string {
  const head = ["row", "name", "account", "amount", "token", "status", "transaction", "claim link", "reason"];
  const lines = run.rows.map((r) =>
    [
      String(r.line),
      r.name,
      r.address,
      r.status === "skipped" ? "" : formatUnits(BigInt(r.amount), token.decimals),
      token.symbol,
      CSV_STATUS[r.status],
      r.txHash ?? "",
      r.link?.id && r.status === "paid" ? (linkUrl(r.link.id) ?? "") : "",
      r.status === "paid" ? "" : (r.reason ?? ""),
    ]
      .map(csvCell)
      .join(",")
  );
  return [head.join(","), ...lines].join("\n");
}

const HEX = /^0x[0-9a-f]{1,64}$/;

/** Whether `v` is a run this version can resume (what storage hands back is checked before use). */
export function isRun(v: unknown): v is PayrollRun {
  const r = v as Partial<PayrollRun> | null;
  const f = r?.inflight;
  return (
    Boolean(r) &&
    r!.v === 1 &&
    typeof r!.id === "string" &&
    typeof r!.owner === "string" &&
    typeof r!.token === "string" &&
    (r!.network === "mainnet" || r!.network === "sepolia" || r!.network === "devnet") &&
    typeof r!.proofs === "number" &&
    typeof r!.feesPaid === "string" &&
    /^\d+$/.test(r!.feesPaid) &&
    (r!.scheduleId === undefined || typeof r!.scheduleId === "string") &&
    (r!.payday === undefined || typeof r!.payday === "string") &&
    Array.isArray(r!.rows) &&
    r!.rows.every(
      (x) =>
        x &&
        typeof x.address === "string" &&
        typeof x.amount === "string" &&
        /^\d+$/.test(x.amount) &&
        typeof x.status === "string" &&
        x.status in CSV_STATUS &&
        (x.link === undefined || (typeof x.link === "object" && x.link !== null && (x.link.id === undefined || typeof x.link.id === "string")))
    ) &&
    (f === null ||
      (typeof f === "object" &&
        f !== undefined &&
        Array.isArray(f.rows) &&
        f.rows.every((i) => Number.isInteger(i) && i >= 0 && i < r!.rows!.length) &&
        Array.isArray(f.spends) &&
        f.spends.every((s) => typeof s === "string" && HEX.test(s)) &&
        Array.isArray(f.change) &&
        f.change.every((s) => typeof s === "string" && HEX.test(s)) &&
        Number.isSafeInteger(f.provedAt)))
  );
}
