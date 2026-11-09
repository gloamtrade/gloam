/**
 * Secret detection for the hosted MCP server (www.gloam.trade/mcp).
 *
 * The hosted server only reads and plans. It never needs a private key, a
 * recovery phrase or a Gloam note secret, so any tool call whose arguments
 * look like one is refused before the tool runs, with a warning. The match is
 * never echoed back or logged.
 *
 * What counts as a secret:
 *  - 64 hex characters (an EVM private key; a transaction hash looks the same,
 *    so both are refused)
 *  - 12 or more BIP-39 words in a row (a recovery phrase)
 *  - an extended private key (xprv, tprv, yprv, zprv)
 *  - Gloam notes and tickets: gloam1. / gloam1e. (note package), gloam2t.
 *    (sealed payment ticket), gloambak1. (backup), gloamenc1: (encrypted note
 *    vault), gloamnote1: (x402 note), gloamx402pay1: (x402 payment payload)
 *  - a claim link (#claim=..., or the short gloam.trade/c#...) and a short
 *    payment code (gloam3.)
 *  - a JWK with its private part ("d")
 *
 * A receive tag (gloamr1.) is public and is not matched.
 */
import { english } from "viem/accounts";

const BIP39 = new Set(english);
const MIN_PHRASE_WORDS = 12;

type Pattern = { what: string; re: RegExp };

const PATTERNS: Pattern[] = [
  { what: "a private key", re: /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/ },
  { what: "an extended private key", re: /(?<![A-Za-z0-9])[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,}/ },
  { what: "a Gloam note", re: /(?<![A-Za-z0-9])gloam1e?\.[A-Za-z0-9_-]{8,}/ },
  { what: "a sealed Gloam payment ticket", re: /(?<![A-Za-z0-9])gloam2t\.[A-Za-z0-9_-]{8,}/ },
  { what: "a Gloam backup", re: /(?<![A-Za-z0-9])gloambak1\.\S{8,}/ },
  { what: "an encrypted Gloam note store", re: /(?<![A-Za-z0-9])gloamenc1:\S{8,}/ },
  { what: "a Gloam note secret", re: /(?<![A-Za-z0-9])gloamnote1:\S{8,}/ },
  { what: "a Gloam x402 payment", re: /(?<![A-Za-z0-9])gloamx402pay1:\S{8,}/ },
  { what: "a Gloam claim link", re: /(?:#|%23)claim(?:=|%3D)\S{8,}/i },
  { what: "a short Gloam payment code", re: /(?<![A-Za-z0-9])gloam3(?:[.=]|%2E)[0-9A-Za-z]{8,}/i },
  { what: "a Gloam claim link", re: /gloam\.trade(?:\/|%2F)c\/?(?:#|%23)[0-9A-Za-z]{8,}/i },
  { what: "a private key (JWK)", re: /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/ },
];

/** True when the text has 12 or more BIP-39 words in a row. */
function hasRecoveryPhrase(text: string): boolean {
  let run = 0;
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue;
    if (BIP39.has(word)) {
      run++;
      if (run >= MIN_PHRASE_WORDS) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/** Every string inside a value (object keys too), depth-limited. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 500) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out, depth + 1);
    }
  }
  return out;
}

/**
 * What kind of secret the arguments seem to hold, or null. Checks each string
 * on its own and the whole call as JSON (for a JWK passed as an object).
 */
export function findSecret(args: unknown): string | null {
  const texts = strings(args);
  let whole = "";
  try {
    whole = JSON.stringify(args ?? null);
  } catch {
    /* circular or odd input: the per-string checks still run */
  }
  for (const text of [...texts, whole]) {
    for (const p of PATTERNS) if (p.re.test(text)) return p.what;
  }
  for (const text of texts) if (hasRecoveryPhrase(text)) return "a recovery phrase";
  return null;
}

/** The refusal shown instead of running the tool. Never repeats the secret. */
export function secretWarning(what: string): string {
  return [
    `Stopped. What you sent looks like ${what}. Do not share it, here or anywhere else.`,
    "Gloam's hosted server only reads and plans. It never needs a private key, a recovery phrase or a note secret, and it did not use or keep what you sent.",
    "It has already left your device (it is in this chat), so if it is real, treat it as exposed: move the funds to a new wallet, or into a fresh note from the Gloam app.",
    "If it was a transaction hash, leave it out: it looks the same as a private key.",
    "To sign or spend, use the Gloam app (https://www.gloam.trade/app) or the local MCP server (npx -y @gloamtrade/mcp), which keep keys on your own machine.",
  ].join("\n\n");
}
