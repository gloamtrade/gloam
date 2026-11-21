/**
 * Gloam names: @duke for a Gloam address (contracts/src/GloamNames.sol).
 *
 * One registry on Robinhood Chain mainnet points a name at the P-256 key inside
 * a Gloam address. That key receives on every network, so a name read there
 * pays on any of them. Names are paid for per year in $GLOAM, which goes to the
 * treasury. Every read goes through Robinhood Chain mainnet's own RPC list,
 * whichever network the app is on. Nothing here moves money.
 */
import { formatUnits, getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { receiveTagFromPoint } from "./receiveTag";

/** The registry on Robinhood Chain mainnet (deployed 21 Nov 2026, block 119798738). Set to null to switch names off. */
export const GLOAM_NAMES_ADDRESS: Address | null = "0x62c435CE6886fa91e3b0e91500c6dC9219723457";

/** Robinhood Chain mainnet, where the registry and $GLOAM live. */
export const GLOAM_NAMES_CHAIN_ID = 4663;

/** How many years one purchase can cover, as offered in the app. */
export const NAME_YEARS = [1, 2, 5] as const;

/** Grace after expiry (GRACE_PERIOD): the name still pays its holder and only renewal is open. */
export const NAME_GRACE_SECONDS = 30 * 24 * 60 * 60;

export const gloamNamesAbi = [
  {
    type: "function",
    name: "resolve",
    stateMutability: "view",
    inputs: [{ name: "name", type: "string" }],
    outputs: [
      { name: "holder", type: "address" },
      { name: "keyX", type: "bytes32" },
      { name: "keyY", type: "bytes32" },
      { name: "expires", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "available",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "string" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "priceOf",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "string" },
      { name: "years_", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "keyX", type: "bytes32" },
      { name: "keyY", type: "bytes32" },
      { name: "holder", type: "address" },
      { name: "years_", type: "uint256" },
    ],
    outputs: [{ name: "expires", type: "uint64" }],
  },
  {
    type: "function",
    name: "renew",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "years_", type: "uint256" },
    ],
    outputs: [{ name: "expires", type: "uint64" }],
  },
  {
    type: "function",
    name: "setKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "keyX", type: "bytes32" },
      { name: "keyY", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const NAME_RE = /^[a-z0-9_]{3,20}$/;

/** 3 to 20 characters, each a to z, 0 to 9 or underscore (validName in the registry). */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * The name the Pay box's To field holds: "@" then a name, any case, spaces
 * around ignored. "@Duke" is "duke". null for anything else, so plain words,
 * addresses and ENS names keep their own meaning.
 */
export function nameFromPayInput(input: string): string | null {
  const text = input.trim();
  if (!text.startsWith("@")) return null;
  const name = text.slice(1).toLowerCase();
  return isValidName(name) ? name : null;
}

/** What someone types when picking their own name: "@Duke" or "duke" both mean "duke". */
export function nameFromClaimInput(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

/** Why a name someone is typing cannot be registered, or null when the shape is fine. */
export function nameProblem(name: string): string | null {
  if (!name) return null;
  if (name.length < 3) return "Names are at least 3 characters.";
  if (name.length > 20) return "Names are at most 20 characters.";
  if (!isValidName(name)) return "Use only letters, numbers and underscores.";
  return null;
}

export type NameRecord = {
  name: string;
  /** The Gloam address the name pays. */
  tag: string;
  holder: Address;
  /** Unix seconds. Past it the name is in its grace period. */
  expires: number;
};

export type NameReader = (name: string) => Promise<readonly [Address, Hex, Hex, bigint]>;

/**
 * The record for `name`, or null when nobody holds it (never taken, or past
 * its grace period), the read fails, or the key does not make a whole Gloam
 * address. Never throws.
 */
export async function readNameRecord(name: string, read: NameReader): Promise<NameRecord | null> {
  if (!isValidName(name)) return null;
  try {
    const [holder, x, y, expires] = await read(name);
    if (!isAddress(holder) || holder === zeroAddress) return null;
    const tag = receiveTagFromPoint(x, y);
    if (!tag) return null;
    return { name, tag, holder: getAddress(holder), expires: Number(expires) };
  } catch {
    return null;
  }
}

/** True once the paid time is over (the name still pays its holder during the grace period). */
export function nameExpired(record: Pick<NameRecord, "expires">, nowSeconds = Date.now() / 1000): boolean {
  return nowSeconds > record.expires;
}

/** "5", "2.5", "1,200" (whole $GLOAM, up to 2 decimals). */
export function gloamAmount(wei: bigint): string {
  const n = Number(formatUnits(wei, 18));
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "12 March 2027" for an expiry in unix seconds. */
export function nameDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

// ---------------------------------------------------------------- this browser's names

/** Names bought or checked in this browser. Only the names: the chain holds the rest. */
const MINE_KEY = "gloam.names.mine.v1";

export function loadMyNames(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(MINE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string" && isValidName(n)) : [];
  } catch {
    return [];
  }
}

function saveMyNames(names: string[]) {
  try {
    window.localStorage.setItem(MINE_KEY, JSON.stringify(names.slice(0, 20)));
  } catch {
    /* private mode: the name still works, it just is not listed here next time */
  }
}

export function rememberMyName(name: string) {
  if (!isValidName(name)) return;
  saveMyNames([name, ...loadMyNames().filter((n) => n !== name)]);
}

export function forgetMyName(name: string) {
  saveMyNames(loadMyNames().filter((n) => n !== name));
}
