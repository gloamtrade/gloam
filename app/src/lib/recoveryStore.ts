/**
 * Encrypted recovery backups, server side. Server only.
 *
 * The browser encrypts its private balance (notes and receive key) with a key
 * that comes from a wallet signature or a passkey, and sends only the
 * ciphertext here, filed under an id derived from the same secret. The server
 * cannot read a backup or tell which wallet it belongs to. Replacing or
 * deleting one needs a write token that also comes from that secret; only its
 * hash is kept.
 *
 * Stored in the partner program's store (lib/partnersKv: Upstash Redis in
 * production, in-process locally) under its own prefix.
 */
import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { jsonOf, kv } from "./partnersKv";
import type { NEWER_KEY } from "./recoveryEnd";

const PREFIX = "gloam:recovery:v1:";
/**
 * Ciphertext size cap, in base64 characters (about 380 KB of notes). Kept at
 * 512,000: a backup also carries every payroll run with a payment that may
 * still land (up to 200 rows, about 1.5 KB each with its codes and secrets),
 * so a real one for a team that pays by link is already in the hundreds of KB.
 */
export const MAX_BACKUP_CHARS = 512_000;
const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `v`: a save under a newer key has reached this backup. Records older than the marker have none. */
type Stored = { w: string; c: string; n: number; t: number; v?: typeof NEWER_KEY };

export type BackupView = { c: string; n: number; t: number };

export const BACKUP_GONE = "This backup isn't on the server any more.";
export const VERSION1_ENDED = "This page no longer saves backups. Reload it to carry on.";

export class RecoveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

let clockOverride: (() => number) | null = null;

/** Swap the server's clock (self-tests), to run past a date. Pass null to restore the real one. */
export function setRecoveryClock(clock: (() => number) | null) {
  clockOverride = clock;
}

/** The server's clock, which is the one the version 1 end date goes by. */
export function recoveryNow(): number {
  return clockOverride ? clockOverride() : Date.now();
}

const keyFor = (id: string) => PREFIX + id;
const lockFor = (id: string) => PREFIX + id + ":lock";

/**
 * How long one save may hold a backup's lock. A save is three store calls, each
 * capped at a few seconds, so this is far longer than a save ever takes; it only
 * matters if a server dies mid-save, when the lock frees itself.
 */
const LOCK_TTL_SEC = 15;

/**
 * Runs a read-check-write on one backup with nobody else changing it in
 * between. Two devices saving from the same version used to both pass the
 * version check, and the later write dropped the other device's data from the
 * backup. Now the second one finds the lock taken and gets a 409, so it fetches
 * the newer backup, merges it in, and saves on top (lib/recovery upload).
 *
 * The lock is a plain SET NX with an expiry, which the production store and the
 * in-process store both speak, so they behave the same. It is released only if
 * it is still ours.
 */
async function withBackupLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockFor(id);
  const token = randomBytes(16).toString("hex");
  const [got] = await kv([["SET", lock, token, "NX", "EX", LOCK_TTL_SEC]]);
  if (got !== "OK") throw new RecoveryError(409, "Another device is saving this backup right now. Try again.");
  try {
    return await fn();
  } finally {
    try {
      const [held] = await kv([["GET", lock]]);
      if (held === token) await kv([["DEL", lock]]);
    } catch {
      // the lock expires on its own
    }
  }
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

/** Whether a backup is filed under this id, without reading it. */
export async function backupExists(id: string): Promise<boolean> {
  const [n] = await kv([["EXISTS", keyFor(id)]]);
  return Number(n) > 0;
}

export async function readBackup(id: string): Promise<BackupView | null> {
  const [raw] = await kv([["GET", keyFor(id)]]);
  const s = jsonOf<Stored>(raw);
  return s ? { c: s.c, n: s.n, t: s.t } : null;
}

/** Why this is not a backup that could be saved, or null. Checked before anything is counted or read. */
export function backupInputProblem(p: { c: unknown; n: unknown }): string | null {
  if (typeof p.c !== "string" || !p.c || p.c.length > MAX_BACKUP_CHARS || !B64.test(p.c)) {
    return "The backup is empty, too large or not encrypted.";
  }
  if (!Number.isSafeInteger(p.n) || (p.n as number) < 1) return "Bad backup version.";
  return null;
}

/**
 * Saves a backup. The first write sets the write token; later writes must
 * present the same token and a higher version number, so an older copy can
 * never replace a newer one. `created` says this id held nothing before.
 *
 * With `mustExist`, an id holding nothing is refused with a 410. The check is
 * under the lock, so a backup deleted a moment ago can't come back this way.
 *
 * `v` goes on the record and stays there: a later save without it (a tab on an
 * earlier build) doesn't take it off. What a save may do goes by the request
 * (app/api/recovery), since records older than the marker have none.
 */
export async function writeBackup(p: {
  id: string;
  write: string;
  c: string;
  n: number;
  mustExist?: boolean;
  v?: typeof NEWER_KEY;
}): Promise<{ n: number; t: number; created: boolean }> {
  const problem = backupInputProblem(p);
  if (problem) throw new RecoveryError(400, problem);

  return withBackupLock(p.id, async () => {
    const [raw] = await kv([["GET", keyFor(p.id)]]);
    const current = jsonOf<Stored>(raw);
    if (!current && p.mustExist) throw new RecoveryError(410, BACKUP_GONE);
    const w = sha256(p.write);
    if (current) {
      if (!sameHash(current.w, w)) throw new RecoveryError(403, "This backup belongs to a different key.");
      if (p.n <= current.n) throw new RecoveryError(409, "A newer backup is already saved.");
    }
    const v = p.v ?? current?.v;
    const next: Stored = { w, c: p.c, n: p.n, t: Date.now(), ...(v ? { v } : {}) };
    await kv([["SET", keyFor(p.id), JSON.stringify(next)]]);
    return { n: next.n, t: next.t, created: !current };
  });
}

/** Deletes a backup. Needs the write token; a missing backup counts as deleted. */
export async function deleteBackup(id: string, write: string): Promise<void> {
  await withBackupLock(id, async () => {
    const [raw] = await kv([["GET", keyFor(id)]]);
    const current = jsonOf<Stored>(raw);
    if (!current) return;
    if (!sameHash(current.w, sha256(write))) throw new RecoveryError(403, "This backup belongs to a different key.");
    await kv([["DEL", keyFor(id)]]);
  });
}
