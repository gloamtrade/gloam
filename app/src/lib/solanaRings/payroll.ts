/**
 * Payroll on Solana: pay a list of Gloam private accounts privately, through
 * Gloam's relay, in as few Solana transactions as it takes.
 *
 * Pure rules and the run engine, with everything that touches the chain, the
 * relay or storage passed in (the browser's are in lib/solanaRings/client and
 * payrollStore). Checked by scripts/selftest-solana-payroll.mts and, on devnet,
 * scripts/e2e-solana-payroll.mts.
 *
 *  - The list: name, Solana private address, amount; a header is optional.
 *    Every row is checked before anyone is paid: a Solana address, an amount
 *    above zero within the asset's decimals, and a Rings registry record (a
 *    Gloam private account on Solana). Bad rows are flagged and skipped. While
 *    claim links are on (config SOLANA_CLAIM_LINKS_ENABLED), a row with no
 *    address gets a claim link instead (lib/solanaRings/claimLink), as on the
 *    other chains: the run pays the link's one-time account, and the link is
 *    shared after the run. The run keeps the link, sealed with it. Off, a row
 *    with no address is flagged as before.
 *  - Batches: one Privacy Rings transfer pays up to PAYROLL_BATCH_MAX people
 *    (the SDK's buildMultiTransferTransaction, one private output each). A
 *    batch lands whole or not at all. When the SDK says a batch is too large
 *    for one transaction, the batch is halved and built again; nothing was sent.
 *  - Pacing: the relay takes RINGS_RELAY_LIMITS.transact.perIpPerMin (10) per
 *    minute from one address. Sends are spaced RELAY_MIN_GAP_MS apart, so at
 *    most 9 land in any minute. A 429 waits for the next minute and tries
 *    again; any other error stops the run and shows it.
 *  - Resume without paying twice: before a batch goes to the relay, the run
 *    is saved with the notes the batch spends (their nullifiers) and the
 *    transaction's blockhash. A batch found in flight on resume is settled
 *    first: by its signature when the run has one, else by whether its notes
 *    were spent. Only once its blockhash has expired (so it can never land) and
 *    its notes are still unspent is it sent again.
 */
import { isAddress } from "@solana/kit";
import { readAmountText } from "@/lib/amountText";
import { SOLANA_CLAIM_LINKS_ENABLED, type RingsAsset, type RingsNetwork } from "./config";

// ------------------------------------------------------------------ limits

/** Most people per run, as on the other chains. */
export const PAYROLL_MAX_ROWS = 200;
/** Most people one Privacy Rings transfer pays (the SDK's MAX_TRANSFER_PAYMENTS: 16 outputs, one for change). */
export const PAYROLL_BATCH_MAX = 15;
/** Least time between two sends to the relay: at most 9 in any minute, under its 10 per address. */
export const RELAY_MIN_GAP_MS = 7_000;
/** 429s in a row before the run pauses itself (about 13 minutes of waiting in all). */
export const RELAY_LIMITED_TRIES = 6;
/** How often an in-flight batch is checked again while its blockhash is still valid. */
export const INFLIGHT_POLL_MS = 4_000;
/** Longest an in-flight batch is checked before the run pauses with it still in flight (a blockhash lasts about a minute). */
export const INFLIGHT_MAX_MS = 4 * 60_000;

const U64_MAX = (1n << 64n) - 1n;

// ------------------------------------------------------------------ the list

export type DraftRow = {
  /** Line in the list as pasted or uploaded, from 1. */
  line: number;
  name: string;
  address: string;
  amountInput: string;
  /** Base units, or null when the amount can't be read. */
  amount: bigint | null;
  /** Why this row is skipped, or null. */
  error: string | null;
  /** A plain note that doesn't stop the row (the same address on another line). */
  note?: string;
  /** No address: this person gets a claim link. */
  link?: boolean;
  /** The claim link made for the run (its body), and its one-time account as `address`: set just before the run starts. */
  linkBody?: string;
};

const CSV_DELIMITERS = ["\t", ";", ","] as const;
type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** The one delimiter a list uses: whichever splits its first line into the most cells outside quotes. */
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
  "solana_address",
  "solana address",
  "private_address",
  "private address",
  "solana",
  "wallet",
  "recipient",
  "to",
];
const AMOUNT_KEYS = ["amount", "pay", "salary", "usd", "usdc", "sol", "zec", "value", "total"];

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
  if (amount > U64_MAX) return { error: "That amount is too large." };
  return { amount };
}

/** A Solana address by shape (base58, 32 bytes). Whether it can be paid privately is checked on chain. */
export function isSolanaAddressText(v: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) && isAddress(v);
}

/** Said for a row with no address while claim links are off. */
export const NO_ADDRESS = "Add their Solana private address.";

/**
 * Parse a pasted or uploaded list into rows, each checked on its own (the
 * registry check comes after, in checkRecipients). Columns: name, address,
 * amount; a header row is optional and may name them in another order.
 * `links`: a row with no address gets a claim link (on while claim links are
 * on); without it, such a row is flagged.
 */
export function parseSolanaPayrollCsv(
  text: string,
  asset: Pick<RingsAsset, "decimals" | "symbol">,
  opts: { links?: boolean } = {}
): { rows: DraftRow[]; error: string | null } {
  const links = opts.links ?? SOLANA_CLAIM_LINKS_ENABLED;
  const lines = text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l, i) => ({ l, i: i + 1 }))
    .filter((x) => x.l.trim().length > 0);
  if (!lines.length) return { rows: [], error: null };

  const delimiter = csvDelimiter(lines[0]!.l);
  const first = splitCsvLine(lines[0]!.l, delimiter) ?? [];
  let cols = { name: 0, address: 1, amount: 2 };
  let start = 0;
  const looksLikeHeader = first.some((c) => [...NAME_KEYS, ...ADDRESS_KEYS, ...AMOUNT_KEYS].includes(headerKey(c)));
  if (looksLikeHeader) {
    const address = findCol(first, ADDRESS_KEYS);
    const amount = findCol(first, AMOUNT_KEYS);
    if (address < 0 || amount < 0) return { rows: [], error: "The header needs an address column and an amount column (name, address, amount)." };
    cols = { name: findCol(first, NAME_KEYS), address, amount };
    start = 1;
  } else if (first.length === 2) {
    cols = { name: -1, address: 0, amount: 1 }; // address, amount
  }
  // A row with more cells than the list has columns had a delimiter inside a
  // cell (an unquoted 1,250): its cells have shifted, so it is refused, not read.
  const width = looksLikeHeader ? first.length : first.length === 2 ? 2 : 3;

  // A spreadsheet's empty rows come out as ",,,": nothing to pay, and no error either.
  const body = lines.slice(start).filter(({ l }) => {
    const cells = splitCsvLine(l, delimiter);
    return !cells || cells.some((c) => c.length > 0);
  });
  if (body.length > PAYROLL_MAX_ROWS) {
    return { rows: [], error: `Up to ${PAYROLL_MAX_ROWS} people per run. Split the list into smaller runs.` };
  }

  const seen = new Map<string, number>();
  const rows = body.map(({ l, i }, idx): DraftRow => {
    const cells = splitCsvLine(l, delimiter);
    const c = cells ?? [];
    const name = ((cols.name >= 0 ? c[cols.name] : "") ?? "").slice(0, 60) || `Person ${idx + 1}`;
    const address = (c[cols.address] ?? "").trim();
    const amountInput = (c[cols.amount] ?? "").trim();
    let error: string | null = !cells
      ? "Check the quotes in this row: a quoted cell needs its closing quote, with nothing after it."
      : cells.length > width
        ? 'This row has more cells than the list has columns. Put an amount with a comma in quotes, like "1,250", and use a dot for decimals.'
        : null;
    const link = !error && !address && links;
    if (link) {
      // no address: a claim link, made when the run starts
    } else if (!error && !address) {
      error = NO_ADDRESS;
    } else if (!error && !isSolanaAddressText(address)) {
      error = /^0x[0-9a-fA-F]{40}$/.test(address)
        ? "That is an EVM address. Use their Gloam private address on Solana."
        : "Not a Solana address. Copy their private address again from Gloam.";
    }
    const read = readPayrollAmount(amountInput, asset.decimals);
    const amount = !error && "amount" in read ? read.amount : null;
    if (!error && "error" in read) error = read.error;
    const row: DraftRow = { line: i, name, address, amountInput, amount, error, ...(link && !error ? { link: true } : {}) };
    if (!error && !link) {
      const prior = seen.get(address);
      if (prior !== undefined) row.note = `Same address as line ${prior}. Both lines are paid.`;
      else seen.set(address, i);
    }
    return row;
  });
  return { rows, error: null };
}

export const NOT_SET_UP =
  "Not set up yet. They need to set up a Gloam private account on Solana first, then send you that address.";
export const OWN_ACCOUNT = "That is your own private account.";

/**
 * Flag rows whose address can't be paid privately: no Rings registry record
 * (`registered` has the answer for every address checked), or the payer's own
 * private account. Returns new rows.
 */
export function checkRecipients(rows: readonly DraftRow[], registered: ReadonlyMap<string, boolean>, owner: string): DraftRow[] {
  return rows.map((r) => {
    if (r.error || r.link) return r;
    if (r.address === owner) return { ...r, error: OWN_ACCOUNT, amount: null };
    if (registered.get(r.address) !== true) return { ...r, error: NOT_SET_UP, amount: null };
    return r;
  });
}

/** The addresses the registry check still has to read. */
export function addressesToCheck(rows: readonly DraftRow[], known: ReadonlyMap<string, boolean>): string[] {
  return [...new Set(rows.filter((r) => !r.error && !r.link && !known.has(r.address)).map((r) => r.address))];
}

export type DraftSummary = { ready: number; skipped: number; total: bigint; short: bigint };

/** What the run would pay, against the private balance (`short` is 0n when it covers it). */
export function summarize(rows: readonly DraftRow[], balance: bigint): DraftSummary {
  const ok = rows.filter((r) => !r.error && r.amount !== null);
  const total = ok.reduce((s, r) => s + r.amount!, 0n);
  return { ready: ok.length, skipped: rows.length - ok.length, total, short: total > balance ? total - balance : 0n };
}

// ------------------------------------------------------------------ the run

export type RowStatus =
  | "queued"
  /** Handed to the relay, no signature yet. */
  | "sending"
  /** The relay sent it; waiting for Solana. */
  | "confirming"
  /** In flight when the tab closed or the relay's answer was lost: being checked. */
  | "checking"
  | "paid"
  /** A bad row, never paid. */
  | "skipped"
  /** Left out when the run was closed early. */
  | "not_paid"
  /** Its batch could not be settled either way: never sent again from this run. */
  | "unknown";

export type RunRow = {
  line: number;
  name: string;
  address: string;
  /** Base units. */
  amount: string;
  status: RowStatus;
  /** Why it was skipped, or the last error on it. */
  reason?: string;
  signature?: string;
  /** A claim link's body, for a row with no address: `address` is then its one-time account. Bearer. */
  link?: string;
};

/** A batch handed (or about to be handed) to the relay. */
export type Inflight = {
  /** Indexes into run.rows. */
  rows: number[];
  /** Hex nullifiers of the notes it spends: spent means it landed. */
  nullifiers: string[];
  /** Its recent blockhash: once that expires it can never land. */
  blockhash: string;
  signature?: string;
  at: number;
};

export type PayrollRun = {
  v: 1;
  id: string;
  network: RingsNetwork;
  /** The paying private account. */
  owner: string;
  /** RingsAsset id ("sol", "usdc", "zec"). */
  asset: string;
  createdAt: number;
  rows: RunRow[];
  inflight: Inflight | null;
  state: "running" | "paused" | "done";
  /** Why it paused, shown until it runs again. */
  error?: string;
  lastSentAt?: number;
};

export function newRun(args: { id: string; network: RingsNetwork; owner: string; asset: string; rows: readonly DraftRow[]; now: number }): PayrollRun {
  if (args.rows.some((r) => r.link && !r.error && (!r.linkBody || !r.address))) throw new Error("Make the claim links first.");
  return {
    v: 1,
    id: args.id,
    network: args.network,
    owner: args.owner,
    asset: args.asset,
    createdAt: args.now,
    rows: args.rows.map((r) => ({
      line: r.line,
      name: r.name,
      address: r.address,
      amount: r.amount !== null && !r.error ? r.amount.toString() : "0",
      status: r.error || r.amount === null ? "skipped" : "queued",
      ...(r.error ? { reason: r.error } : {}),
      ...(r.link && !r.error && r.linkBody ? { link: r.linkBody } : {}),
    })),
    inflight: null,
    state: "paused",
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
  return run.inflight !== null || run.rows.some((r) => r.status === "queued" || r.status === "sending" || r.status === "confirming" || r.status === "checking");
}

/** Close a paused run early: rows not paid yet stay unpaid. Refused while a batch may still land. */
export function closeRun(run: PayrollRun): PayrollRun {
  if (run.inflight) throw new Error("The last batch may still land. Resume to check it first.");
  return {
    ...run,
    state: "done",
    error: undefined,
    rows: run.rows.map((r) => (r.status === "queued" ? { ...r, status: "not_paid" as const } : r)),
  };
}

// ------------------------------------------------------------------ pacing

/** How long to wait before the next send, so sends are at least `gap` apart. */
export function paceDelay(lastSentAt: number | undefined, now: number, gap = RELAY_MIN_GAP_MS): number {
  return lastSentAt === undefined ? 0 : Math.max(0, lastSentAt + gap - now);
}

/**
 * How long to wait after the `attempt`th 429 in a row (from 1). The relay
 * counts per calendar minute, so the first wait runs to the next minute; each
 * later one adds 30 seconds, for a daily cap or a busy shared address.
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

export type Built = { wire: Uint8Array; nullifiers: string[]; blockhash: string };

export type InflightResult =
  | { state: "landed"; signature?: string }
  /** It reached Solana and failed there: nobody in it was paid. */
  | { state: "failed"; message: string }
  /** It may still land: check again shortly. */
  | { state: "pending" }
  /** Its blockhash expired and its notes are unspent: it never landed and never will. */
  | { state: "dropped" }
  /** Can't tell (its notes are not in this account's history). */
  | { state: "unknown" };

export type PayrollDeps = {
  /** Persist the run. Before a send it must resolve only once the run is stored; if it throws, nothing is sent. */
  save(run: PayrollRun): Promise<void>;
  /** Build and sign one private transfer paying `payments` (a claim link's one-time account with its `link`). Nothing is sent. */
  build(payments: { address: string; amount: bigint; link?: string }[]): Promise<Built>;
  /** Hand a built transfer to the relay; its signature. Rejects with a RelayRefusal when the relay says no. */
  send(wire: Uint8Array): Promise<string>;
  /** After a refusal that sent nothing: free the notes the build set aside. */
  release(): Promise<void>;
  /** Wait for a sent transfer to land and read it back. Rejects if it fails or takes too long. */
  confirm(signature: string): Promise<void>;
  /** Where an in-flight batch stands. */
  resolve(inflight: Inflight): Promise<InflightResult>;
  /** Plain words for an error. */
  message(e: unknown): string;
  /** Whether a build error means "fewer people per transaction" (too large, too many inputs). */
  tooBig(e: unknown): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Checked between batches: pause after the current one. */
  stopRequested(): boolean;
  onChange?(run: PayrollRun): void;
};

export const RELAY_BUSY = "Gloam's relay is at its limit for now. Your run is saved: resume in a few minutes.";
export const SAVE_FAILED = "This browser couldn't save the run, so the next batch wasn't sent. Free some space and resume.";
export const BATCH_DROPPED = "The last batch didn't land on Solana, so nobody in it was paid. Resume to send it again.";
export const BATCH_STILL_CHECKING = "Solana hasn't said yet whether the last batch went through. Resume in a minute to check it again.";

function setRows(run: PayrollRun, idx: readonly number[], patch: Partial<RunRow>): void {
  for (const i of idx) run.rows[i] = { ...run.rows[i]!, ...patch };
}

/**
 * Pay a run's queued rows, settling any batch left in flight first. Returns
 * when every row is settled, when it pauses itself (an error, the relay's
 * limit, a stop request), or rejects only if `save` fails after a send (the
 * stored run still has the batch in flight, so a resume settles it).
 * Never sends a batch while an earlier one could still land.
 */
export async function runPayroll(run: PayrollRun, deps: PayrollDeps): Promise<PayrollRun> {
  const changed = async (strict = false) => {
    deps.onChange?.(run);
    if (strict) return deps.save(run);
    try {
      await deps.save(run);
    } catch {
      // a later save, or the in-flight check on resume, covers it
    }
  };
  const pause = async (error?: string) => {
    run.state = "paused";
    run.error = error;
    await changed();
    return run;
  };

  run.state = "running";
  run.error = undefined;
  await changed();

  let size = PAYROLL_BATCH_MAX;
  let limited = 0;
  let drops = 0;
  let checkingSince: number | null = null;

  for (;;) {
    // 1. A batch in flight is settled before anything else is sent.
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
        // never forever: it stays in flight, so a resume checks it again first
        if (deps.now() - checkingSince >= INFLIGHT_MAX_MS) return pause(BATCH_STILL_CHECKING);
        await deps.sleep(INFLIGHT_POLL_MS);
        continue;
      }
      checkingSince = null;
      run.inflight = null;
      if (r.state === "landed") {
        drops = 0;
        setRows(run, f.rows, { status: "paid", reason: undefined, ...(r.signature ? { signature: r.signature } : {}) });
        await changed();
        continue;
      }
      if (r.state === "unknown") {
        setRows(run, f.rows, { status: "unknown", reason: "Couldn't tell whether this landed, so it isn't sent again. Check before paying them." });
        await changed();
        continue;
      }
      if (r.state === "failed") {
        setRows(run, f.rows, { status: "queued", reason: r.message, signature: undefined });
        return pause(r.message);
      }
      // dropped: nobody in it was paid
      setRows(run, f.rows, { status: "queued", signature: undefined });
      if (++drops >= 2) return pause(BATCH_DROPPED);
      await changed();
      continue;
    }

    // 2. The next batch.
    if (deps.stopRequested()) return pause();
    const queued = run.rows.map((r, i) => (r.status === "queued" ? i : -1)).filter((i) => i >= 0);
    if (!queued.length) {
      run.state = "done";
      run.error = undefined;
      await changed();
      return run;
    }
    const idx = queued.slice(0, size);

    const wait = paceDelay(run.lastSentAt, deps.now());
    if (wait > 0) {
      await deps.sleep(wait);
      if (deps.stopRequested()) return pause();
    }

    let built: Built;
    try {
      built = await deps.build(
        idx.map((i) => {
          const row = run.rows[i]!;
          return { address: row.address, amount: BigInt(row.amount), ...(row.link ? { link: row.link } : {}) };
        })
      );
    } catch (e) {
      if (deps.tooBig(e) && size > 1) {
        size = Math.max(1, Math.floor(Math.min(size, idx.length) / 2));
        continue;
      }
      return pause(deps.message(e));
    }

    // Saved before it is sent: a tab closed from here on resumes by checking it.
    run.inflight = { rows: idx, nullifiers: built.nullifiers, blockhash: built.blockhash, at: deps.now() };
    setRows(run, idx, { status: "sending", reason: undefined });
    try {
      await changed(true);
    } catch {
      run.inflight = null;
      setRows(run, idx, { status: "queued" });
      await deps.release().catch(() => undefined);
      return pause(SAVE_FAILED);
    }

    let signature: string;
    try {
      signature = await deps.send(built.wire);
    } catch (e) {
      if (isRelayRefusal(e) && !e.maybeSent) {
        // Refused before it was sent: nobody in it was paid.
        run.inflight = null;
        setRows(run, idx, { status: "queued" });
        await deps.release().catch(() => undefined);
        if (e.status === 429) {
          limited++;
          run.lastSentAt = deps.now();
          await changed();
          if (limited > RELAY_LIMITED_TRIES) return pause(RELAY_BUSY);
          if (deps.stopRequested()) return pause();
          await deps.sleep(rateLimitDelay(limited, deps.now()));
          continue;
        }
        return pause(e.message || deps.message(e));
      }
      // It may have been sent: settle it (step 1) before anything else.
      continue;
    }
    limited = 0;
    run.lastSentAt = deps.now();
    run.inflight = { ...run.inflight, signature };
    setRows(run, idx, { status: "confirming", signature });
    await changed();

    try {
      await deps.confirm(signature);
    } catch {
      continue; // step 1 asks Solana what happened to it
    }
    drops = 0;
    run.inflight = null;
    setRows(run, idx, { status: "paid", signature });
    await changed();
  }
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
  sending: "checking",
  confirming: "checking",
  checking: "checking",
  paid: "paid",
  skipped: "skipped",
  not_paid: "not paid",
  unknown: "unknown",
};

/**
 * The run as a CSV: row, name, address, amount, asset, status, signature,
 * reason, and a claim_link column when the run has claim links (each paid
 * row's link, which is bearer: the file is money while a link is unclaimed).
 * `linkFor` writes a link's body as the link to share.
 */
export function resultsCsv(run: PayrollRun, asset: Pick<RingsAsset, "decimals" | "symbol">, linkFor?: (body: string) => string): string {
  const withLinks = run.rows.some((r) => r.link);
  const head = ["row", "name", "address", "amount", "asset", "status", "signature", "reason", ...(withLinks ? ["claim_link"] : [])];
  const lines = run.rows.map((r) =>
    [
      String(r.line),
      r.name,
      r.link ? "claim link" : r.address,
      r.status === "skipped" ? "" : formatUnits(BigInt(r.amount), asset.decimals),
      asset.symbol,
      CSV_STATUS[r.status],
      r.signature ?? "",
      r.status === "paid" ? "" : (r.reason ?? ""),
      ...(withLinks ? [r.link && r.status === "paid" ? (linkFor ? linkFor(r.link) : r.link) : ""] : []),
    ]
      .map(csvCell)
      .join(",")
  );
  return [head.join(","), ...lines].join("\n");
}

/** Whether `v` is a run this version can resume (what storage hands back is checked before use). */
export function isRun(v: unknown): v is PayrollRun {
  const r = v as Partial<PayrollRun> | null;
  return (
    Boolean(r) &&
    r!.v === 1 &&
    typeof r!.id === "string" &&
    typeof r!.owner === "string" &&
    typeof r!.asset === "string" &&
    (r!.network === "mainnet" || r!.network === "devnet") &&
    Array.isArray(r!.rows) &&
    r!.rows.every(
      (x) =>
        x &&
        typeof x.address === "string" &&
        typeof x.amount === "string" &&
        /^\d+$/.test(x.amount) &&
        typeof x.status === "string" &&
        x.status in CSV_STATUS &&
        (x.link === undefined || typeof x.link === "string")
    ) &&
    (r!.inflight === null ||
      (typeof r!.inflight === "object" &&
        Array.isArray(r!.inflight.rows) &&
        r!.inflight.rows.every((i) => Number.isInteger(i) && i >= 0 && i < r!.rows!.length) &&
        Array.isArray(r!.inflight.nullifiers) &&
        typeof r!.inflight.blockhash === "string"))
  );
}
