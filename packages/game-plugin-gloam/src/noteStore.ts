/**
 * The agent's private notes, kept on the agent's own machine.
 *
 * A note is a bearer secret: whoever knows its secret can spend it. So secrets
 * never reach the GAME planner. Functions hand out short handles
 * ("n-k3x9p2qw7m") plus facts that are not secret (network, asset, amount,
 * status, the transaction that made it), and the secrets stay here, in a local
 * JSON file encrypted with AES-256-GCM. This is the Gloam MCP server's store
 * (mcp/src/noteStore.ts), with a separate default path and key label so the
 * two never write over each other:
 *
 *   path  GLOAM_NOTE_STORE, or ~/.gloam/game-notes.<agent>.json
 *   key   GLOAM_NOTE_KEY (32 random bytes in hex), or, when that is unset,
 *         derived from GLOAM_AGENT_PRIVATE_KEY with HKDF-SHA256, so it is never
 *         the signing key itself
 *
 * The whole store is one ciphertext (amounts and counts are hidden too), bound
 * to the agent id. Writes take a lock, so two calls or two processes cannot lose
 * each other's notes, and a store that does not decrypt is never overwritten:
 * it holds the only copy of the money.
 *
 * Besides notes it keeps the agent's receive key (the private half of its
 * Gloam address) and where the last scan for incoming payments stopped.
 *
 * Where the ciphertext lives is pluggable (NoteStoreBackend): a local file by
 * default, or a kit's own secret storage. The backend only ever holds the
 * encrypted store; encryption and the key stay here.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatUnits, type Address, type Hex } from "viem";
import type { ReceiveKey } from "@gloamtrade/sdk";
import { withFileLock } from "./fileLock.js";

type Env = Record<string, string | undefined>;

export type NoteStatus = "unspent" | "pending" | "spent";
/**
 * Where a note came from:
 *   shield    an add to the private balance
 *   change    what was left of a note after a payment
 *   received  a payment to this agent, moved into a note only it knows
 *   payment   a payment this agent sent (the payee's money; kept until it lands)
 *   claim     a payment this agent made as a claim link (the holder's money
 *             once claimed; the agent can take back one nobody claimed)
 * Only shield, change and received count as the agent's balance.
 */
export type NoteOrigin = "shield" | "change" | "received" | "payment" | "claim";
export type KeySource = "GLOAM_NOTE_KEY" | "signer";

export type StoredNote = {
  handle: string;
  network: string;
  chainId: number;
  pool: Address;
  asset: Address;
  symbol: string;
  decimals: number;
  amountWei: string;
  secret: Hex;
  commitment: Hex;
  nullifier: Hex;
  status: NoteStatus;
  /** Only while pending: being created, or the input of a spend in flight. */
  pending?: "create" | "spend";
  origin: NoteOrigin;
  createdTx: Hex | null;
  spentTx?: Hex | null;
  /** Received notes: the nullifier of the payment note this was swept from (stops a replay). */
  sweptFrom?: Hex;
  /** What the note is for: "payout job 440", "claim link for ..." (never a secret). */
  label?: string;
  /** Claim links and payments: the private note the payment carries, if any. */
  memo?: string;
  /** The input of a spend: when its send started (it may have gone out even without a hash). */
  spendStarted?: string;
  /** A payment: the sealed payment message, until it is posted for the payee (sealed, so not a secret). */
  deliver?: string;
  /** An x402 payment: the X-PAYMENT value it was made for (the note sealed to the payee, never in the clear). */
  x402?: string;
  /**
   * A payment, claim link or cash out: what identifies it (payee or address,
   * asset, amount, note), so the same one is never sent twice while it may land.
   * On a cash out it sits on the note being cashed out.
   */
  requestKey?: string;
  /**
   * A note a spend creates (change, payment, claim, split, swept): the nullifier
   * of the note that spend spends, and that note's handle. Once that nullifier is
   * spent and this note is not in the vault, the spend that would make it can
   * never land, and it is dropped. A retry of the same payment spends that same
   * note, so at most one of them can land.
   */
  spends?: Hex;
  spendsHandle?: string;
  /**
   * Pending for over an hour with nothing on chain: most likely never landed.
   * Still checked on every refresh (it settles if it lands after all), but no
   * longer counted as confirming or as a payment in flight.
   */
  stale?: boolean;
  /**
   * A payment, claim link or cash out (and a split made for one): the spending-log
   * entry it was counted under, so a retry replaces that entry instead of counting
   * the same money twice.
   */
  spendId?: string;
  /**
   * When this note was put behind a proof of funds. The proof carries the note's
   * nullifier, which a cash out of the whole note would show next to where the
   * money went and how much, so a cash out moves such a note to a fresh note
   * first (GloamAgent.cashOut), as the app does.
   */
  fundsProofAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type NewNote = Omit<StoredNote, "handle" | "createdAt" | "updatedAt">;

type StoreData = {
  notes: StoredNote[];
  receiveKey: ReceiveKey | null;
  /** Per chain id: the first block not yet scanned for incoming payments. */
  scanFrom: Record<string, string>;
};

type StoreFile = {
  format: "gloam-note-store";
  version: 1;
  agent: string;
  keySource: KeySource;
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

const SALT = Buffer.from("gloam/note-store");
const INFO = "gloam-game-note-store-v1";
const HANDLE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function agentId(env: Env = process.env): string {
  return env.GLOAM_AGENT_ID?.trim() || "default";
}

export function noteStorePath(agent: string, env: Env = process.env): string {
  return env.GLOAM_NOTE_STORE?.trim() || join(homedir(), ".gloam", `game-notes.${agent.replace(/[^\w.-]+/g, "_")}.json`);
}

/** The store key: GLOAM_NOTE_KEY, else derived from the signer key. Throws a plain reason when neither works. */
export function noteStoreKey(env: Env = process.env): { key: Buffer; source: KeySource } {
  const raw = env.GLOAM_NOTE_KEY?.trim();
  if (raw) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error("GLOAM_NOTE_KEY must be 32 random bytes in hex (make one with: openssl rand -hex 32).");
    }
    const ikm = Buffer.from(raw.replace(/^0x/, ""), "hex");
    return { key: Buffer.from(hkdfSync("sha256", ikm, SALT, `${INFO}:GLOAM_NOTE_KEY`, 32)), source: "GLOAM_NOTE_KEY" };
  }
  const pk = env.GLOAM_AGENT_PRIVATE_KEY?.trim();
  if (pk && /^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
    const ikm = Buffer.from(pk.replace(/^0x/, ""), "hex");
    return { key: Buffer.from(hkdfSync("sha256", ikm, SALT, `${INFO}:signer`, 32)), source: "signer" };
  }
  throw new Error(
    "There is no key for the note store. Set GLOAM_NOTE_KEY (32 random bytes in hex: openssl rand -hex 32), or GLOAM_AGENT_PRIVATE_KEY to derive one from the agent's key."
  );
}

/**
 * Where the encrypted store is kept. It only ever sees ciphertext. Every call is
 * synchronous, so a backend is a file, an OS keychain or another local store,
 * not a network round trip.
 */
export interface NoteStoreBackend {
  /** Where the store lives, for messages. Never a secret. */
  readonly where: string;
  /** The encrypted store as last written, or null when nothing was written yet. */
  read(): string | null;
  /** Replace the store with `text`. Must be atomic: a half-written store loses money. */
  write(text: string): void;
  /** Run fn with no other writer in between (across processes too, when the store is shared). */
  lock<T>(fn: () => T): T;
}

/** The default backend: one JSON file, written through a temporary file and a rename, under a lock file. */
export function fileNoteBackend(path: string): NoteStoreBackend {
  return {
    where: path,
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    write(text) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, path);
    },
    lock: (fn) => withFileLock(path, "note store", fn),
  };
}

function newHandle(prefix = "n"): string {
  const bytes = randomBytes(10);
  return `${prefix}-` + Array.from(bytes, (b) => HANDLE_ALPHABET[b % HANDLE_ALPHABET.length]).join("");
}

export class NoteStore {
  /** Where the store lives (the file path for the default backend). */
  readonly path: string;
  private readonly backend: NoteStoreBackend;

  constructor(
    at: string | NoteStoreBackend,
    readonly agent: string,
    private readonly key: Buffer,
    readonly keySource: KeySource
  ) {
    this.backend = typeof at === "string" ? fileNoteBackend(at) : at;
    this.path = this.backend.where;
  }

  private aad(): Buffer {
    return Buffer.from(`${INFO}:${this.agent}`);
  }

  /** Decrypt the store. Missing file: empty. Anything unreadable throws and nothing is written. */
  read(): StoreData {
    const raw = this.backend.read();
    if (raw === null) return { notes: [], receiveKey: null, scanFrom: {} };
    const unusable = (why: string) =>
      new Error(
        `The note store at ${this.path} cannot be opened: ${why}. It holds the only copy of this agent's private balance, so it is never overwritten. Restore the key it was written with, or move the file away to start a new store.`
      );
    let file: StoreFile;
    try {
      file = JSON.parse(raw) as StoreFile;
    } catch {
      throw unusable("it is not valid JSON");
    }
    if (file?.format !== "gloam-note-store" || file.version !== 1) throw unusable("it is not a Gloam note store");
    if (file.agent !== this.agent) throw unusable(`it belongs to agent "${file.agent}", not "${this.agent}"`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(file.iv, "base64"));
      decipher.setAAD(this.aad());
      decipher.setAuthTag(Buffer.from(file.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);
      const data = JSON.parse(plain.toString("utf8")) as Partial<StoreData>;
      return {
        notes: Array.isArray(data.notes) ? data.notes : [],
        receiveKey: data.receiveKey ?? null,
        scanFrom: data.scanFrom && typeof data.scanFrom === "object" ? data.scanFrom : {},
      };
    } catch {
      const hint =
        file.keySource !== this.keySource
          ? `it was written with ${file.keySource === "signer" ? "a key derived from the agent's key" : "GLOAM_NOTE_KEY"}, and the plugin is now using ${this.keySource === "signer" ? "a key derived from the agent's key" : "GLOAM_NOTE_KEY"}`
          : "the key does not match (or the file was changed)";
      throw unusable(hint);
    }
  }

  private write(data: StoreData) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad());
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    const file: StoreFile = {
      format: "gloam-note-store",
      version: 1,
      agent: this.agent,
      keySource: this.keySource,
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: enc.toString("base64"),
    };
    this.backend.write(JSON.stringify(file, null, 2));
  }

  private mutate<T>(fn: (data: StoreData) => T): T {
    return this.backend.lock(() => {
      const data = this.read();
      const out = fn(data);
      this.write(data);
      return out;
    });
  }

  list(): StoredNote[] {
    return this.read().notes;
  }

  get(handle: string): StoredNote | undefined {
    return this.list().find((n) => n.handle === handle);
  }

  add(note: NewNote): StoredNote {
    return this.mutate((d) => {
      const now = new Date().toISOString();
      const prefix = note.origin === "claim" ? "c" : "n";
      let handle = newHandle(prefix);
      while (d.notes.some((n) => n.handle === handle)) handle = newHandle(prefix);
      const stored: StoredNote = { ...note, handle, createdAt: now, updatedAt: now };
      d.notes.push(stored);
      return stored;
    });
  }

  update(handle: string, patch: Partial<Omit<StoredNote, "handle" | "secret" | "commitment" | "nullifier">>): StoredNote | undefined {
    return this.mutate((d) => {
      const i = d.notes.findIndex((n) => n.handle === handle);
      if (i < 0) return undefined;
      const next: StoredNote = { ...d.notes[i]!, ...patch, updatedAt: new Date().toISOString() };
      if (next.status !== "pending") delete next.pending;
      d.notes[i] = next;
      return next;
    });
  }

  /** Forget a note whose creating transaction never happened. */
  remove(handle: string) {
    this.mutate((d) => {
      d.notes = d.notes.filter((n) => n.handle !== handle);
    });
  }

  /** Take an unspent note for a spend: under the lock, check it, then mark it pending so a second call cannot spend it too. */
  reserveForSpend(handle: string, check: (n: StoredNote) => string | null = () => null): StoredNote {
    return this.mutate((d) => {
      const i = d.notes.findIndex((n) => n.handle === handle);
      const note = d.notes[i];
      if (!note) throw new Error(`There is no note "${handle}".`);
      if (note.status !== "unspent") {
        throw new Error(`Note ${handle} is ${note.status === "pending" ? "in use by a transaction that has not confirmed" : "already spent"}.`);
      }
      const why = check(note);
      if (why) throw new Error(why);
      const next: StoredNote = { ...note, status: "pending", pending: "spend", updatedAt: new Date().toISOString() };
      d.notes[i] = next;
      return next;
    });
  }

  /**
   * Mark notes as behind a proof of funds, before the proof is made. Under the lock each must still be
   * unspent: a note a spend has already taken is never put in a proof, and one taken later sees the mark.
   */
  markFundsProof(handles: string[], at: string) {
    this.mutate((d) => {
      const picked = handles.map((h) => d.notes.findIndex((n) => n.handle === h));
      if (picked.some((i) => i < 0 || d.notes[i]!.status !== "unspent")) {
        throw new Error("A note picked for the proof was just taken by a payment or cash out. Try again.");
      }
      for (const i of picked) d.notes[i] = { ...d.notes[i]!, fundsProofAt: at, updatedAt: at };
    });
  }

  receiveKey(): ReceiveKey | null {
    return this.read().receiveKey;
  }

  /** Save a receive key unless one is there; returns the one in the store. `fromBlock` is where incoming scans can start. */
  keepReceiveKey(key: ReceiveKey, chainId: number, fromBlock: bigint): ReceiveKey {
    return this.mutate((d) => {
      if (!d.receiveKey) {
        d.receiveKey = key;
        d.scanFrom[String(chainId)] = fromBlock.toString();
      }
      return d.receiveKey;
    });
  }

  scanFrom(chainId: number): bigint | null {
    const v = this.read().scanFrom[String(chainId)];
    return v ? BigInt(v) : null;
  }

  setScanFrom(chainId: number, block: bigint) {
    this.mutate((d) => {
      d.scanFrom[String(chainId)] = block.toString();
    });
  }
}

/** Open this agent's note store (throws with a plain reason when there is no usable key). */
export function openNoteStore(env: Env = process.env, agent = agentId(env)): NoteStore {
  const { key, source } = noteStoreKey(env);
  return new NoteStore(noteStorePath(agent, env), agent, key, source);
}

// ------------------------------------------------------------------ what the agent may see

/** A note as the planner sees it: a handle and public facts, never the secret, commitment or nullifier. */
export function noteView(n: StoredNote) {
  return {
    handle: n.handle,
    network: n.network,
    asset: n.symbol,
    amount: formatUnits(BigInt(n.amountWei), n.decimals),
    status: n.status,
    ...(n.pending ? { pending: n.pending } : {}),
    ...(n.stale && n.status === "pending" ? { stale: true } : {}),
    origin: n.origin,
    createdTx: n.createdTx,
    ...(n.label ? { label: n.label } : {}),
  };
}

/** Private balance per asset: spendable now, still confirming, and the largest single payment possible. */
export function balances(notes: StoredNote[], chainId: number) {
  const by = new Map<string, { asset: Address; symbol: string; decimals: number; unspent: bigint; pending: bigint; notes: number; largest: bigint }>();
  for (const n of notes) {
    if (n.chainId !== chainId) continue;
    if (n.status === "spent" || n.origin === "payment" || n.origin === "claim") continue;
    if (n.status === "pending" && (n.pending === "spend" || n.stale)) continue;
    const k = n.asset.toLowerCase();
    const cur = by.get(k) ?? { asset: n.asset, symbol: n.symbol, decimals: n.decimals, unspent: 0n, pending: 0n, notes: 0, largest: 0n };
    const amt = BigInt(n.amountWei);
    if (n.status === "unspent") {
      cur.unspent += amt;
      cur.notes += 1;
      if (amt > cur.largest) cur.largest = amt;
    } else cur.pending += amt;
    by.set(k, cur);
  }
  return [...by.values()].map((b) => ({
    asset: b.symbol,
    address: b.asset,
    spendable: formatUnits(b.unspent, b.decimals),
    confirming: formatUnits(b.pending, b.decimals),
    notes: b.notes,
    /** A payment spends one note, so this is the most one payment can be right now. */
    largestPayment: formatUnits(b.largest, b.decimals),
  }));
}
