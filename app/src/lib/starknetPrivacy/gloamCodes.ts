"use client";

/**
 * Where a Gloam wallet's backup-code secret for Starknet is kept: the same way
 * Solana keeps its own (lib/solanaRings/gloamCodes), sealed with sealJson under
 * the private balance's data key (lib/noteVault) in localStorage under the
 * signed-in account's own key (lib/accountSlot), as { [Gloam wallet address]:
 * secret }. A secret is never replaced: the person saved that code, and their
 * private account on Starknet comes from it (lib/starknetPrivacy/account
 * seedFromGloamRoot). A stored list that can't be opened is set aside, never
 * overwritten. The code itself (lib/solanaRings/gloamRoot backupCodeFor) is
 * made in the browser: Turnkey and Gloam's servers never see it.
 *
 * The plain logic (parseStarknetCodes) is checked by scripts/selftest-starknet-core.mts.
 */
import { scopedKey, writableKey } from "../accountSlot";
import { openJson, sealJson } from "../noteVault";
import { CODE_SECRET_BYTES, GloamRootError } from "../solanaRings/gloamRoot";

export const STARKNET_CODES_KEY = "gloam.starknet-codes.v1";
const UNREADABLE_KEY = "gloam.starknet-codes.unreadable.v1";

const OWNER = /^0x[0-9a-f]{40}$/;
const SECRET_HEX = new RegExp(`^[0-9a-f]{${CODE_SECRET_BYTES * 2}}$`);

/** The kept secrets in `value`, with anything malformed left out. */
export function parseStarknetCodes(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [owner, secret] of Object.entries(value as Record<string, unknown>)) {
    if (OWNER.test(owner) && typeof secret === "string" && SECRET_HEX.test(secret)) out[owner] = secret;
  }
  return out;
}

const toHex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function readAll(): Promise<Record<string, string>> {
  if (typeof window === "undefined") return {};
  const key = scopedKey(STARKNET_CODES_KEY);
  const raw = key ? window.localStorage.getItem(key) : null;
  if (!raw) return {};
  const value = await openJson<unknown>(raw);
  if (value === null) {
    const aside = scopedKey(UNREADABLE_KEY);
    if (aside && !window.localStorage.getItem(aside)) window.localStorage.setItem(aside, raw);
    return {};
  }
  return parseStarknetCodes(value);
}

let writeQueue: Promise<unknown> = Promise.resolve();

/** The backup-code secret kept here for `owner` (a Gloam wallet's address, lower case), or null. */
export async function keptStarknetCode(owner: string): Promise<Uint8Array | null> {
  await writeQueue;
  const hex = (await readAll())[owner.toLowerCase()];
  return hex ? fromHex(hex) : null;
}

/** Keep `secret` for `owner`: the secret kept afterwards (this one, or the one kept before, never replaced). */
function keep(owner: string, secret: Uint8Array): Promise<Uint8Array> {
  const o = owner.toLowerCase();
  if (!OWNER.test(o) || secret.length !== CODE_SECRET_BYTES) return Promise.reject(new Error("Nothing to keep."));
  const run = writeQueue.then(async () => {
    const kept = await readAll();
    if (kept[o]) return fromHex(kept[o]);
    window.localStorage.setItem(writableKey(STARKNET_CODES_KEY), await sealJson({ ...kept, [o]: toHex(secret) }));
    return secret.slice();
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

/**
 * The backup-code secret that opens `owner`'s private account on Starknet now
 * (a copy: wipe it when done), the way Solana's codeRootFor decides: `secret`
 * null is the one kept here; a code just made here is kept first, never over
 * another; a typed code opens even when another is kept.
 */
export async function starknetCodeRootFor(owner: string, secret: Uint8Array | null, typed = false): Promise<Uint8Array> {
  if (!secret) {
    const kept = await keptStarknetCode(owner);
    if (!kept) throw new GloamRootError("This browser no longer holds your backup code. Enter it to open your private account.", "badcode");
    return kept;
  }
  const kept = await keep(owner, secret);
  if (kept.length === secret.length && kept.every((b, i) => b === secret[i])) return kept;
  kept.fill(0);
  if (typed) return secret.slice();
  throw new GloamRootError("This browser holds another backup code for this account. Reload the page to open with it.", "badcode");
}
