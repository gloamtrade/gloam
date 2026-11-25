/**
 * Zcash mainnet addresses, as far as Gloam needs them: a transparent address
 * (t1 or t3) that NEAR Intents can send a refund to (lib/solanaRings/zcashIn).
 * Shared by the browser, the server and the self-tests; no network.
 *
 * Only t1 (P2PKH) and t3 (P2SH) are taken. 1Click refused a shielded (zs) and a
 * unified (u1) refund address when checked on 2026-11-25, and a testnet address
 * would lose a mainnet refund.
 */
import { getBase58Encoder } from "@solana/kit";
import { sha256 } from "viem";

/** The two version bytes in front of a mainnet transparent address: t1 (P2PKH) and t3 (P2SH). */
const VERSIONS: readonly (readonly [number, number])[] = [
  [0x1c, 0xb8],
  [0x1c, 0xbd],
];

/** A mainnet transparent Zcash address, t1 or t3, with its checksum right. */
export function validZcashTransparent(v: string): boolean {
  if (typeof v !== "string" || !/^t[13][1-9A-HJ-NP-Za-km-z]{30,36}$/.test(v)) return false;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase58Encoder().encode(v));
  } catch {
    return false;
  }
  if (bytes.length !== 26 || !VERSIONS.some(([a, b]) => bytes[0] === a && bytes[1] === b)) return false;
  const sum = sha256(sha256(bytes.slice(0, 22), "bytes"), "bytes");
  return sum[0] === bytes[22] && sum[1] === bytes[23] && sum[2] === bytes[24] && sum[3] === bytes[25];
}

/**
 * Why a typed refund address won't do, in plain words, or null when it will
 * (or nothing is typed yet).
 */
export function zcashRefundProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v || validZcashTransparent(v)) return null;
  const lower = v.toLowerCase();
  if (/^(zs1|u1|zc)/.test(lower)) return "Use a transparent address, starting with t1 or t3. A refund can't go to a shielded or unified address.";
  if (/^(tm|t2|ztestsapling|utest|textest)/.test(lower)) return "That's a testnet address. Use a Zcash mainnet address, starting with t1 or t3.";
  if (lower.startsWith("tex1")) return "Use a t1 or t3 address. A TEX address isn't taken for refunds here.";
  return "Check your Zcash address. It starts with t1 or t3.";
}
