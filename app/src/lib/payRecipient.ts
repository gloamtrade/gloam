/**
 * What the Pay box's recipient field holds (components/app/MoveView).
 *
 * Pay makes a private note for a Gloam address (gloamr1.…). A plain 0x address
 * or an ENS name has no receive key, so it is not paid with a note: Pay hands
 * it to Cash out, which already sends from the private balance to any address.
 * This file only classifies the text; it moves no money and reads no chain.
 * Resolving a name is `resolveEnsForChain`, the one network call, kept separate
 * so the classifier stays pure.
 */
import { getAddress, isAddress, type Address } from "viem";
import { normalize, toCoinType } from "viem/ens";
import { RECEIVE_TAG_PREFIX } from "./receiveTag";
import { nameFromPayInput } from "./gloamNames";

export type PayRecipient =
  | { kind: "empty" }
  /** Starts like a Gloam address; whether it is a whole one is `isValidReceiveTag`'s call. */
  | { kind: "gloam" }
  /** A valid 0x address (a mixed-case one must have its checksum right). */
  | { kind: "address"; address: Address }
  /** 40 hex digits after 0x, mixed case, wrong checksum: probably a typo. */
  | { kind: "badAddress" }
  /** Looks like an ENS name; `name` is its normalized form, to resolve. */
  | { kind: "ens"; name: string }
  /** A Gloam name ("@duke"), lowercased, to look up for the Gloam address it pays (lib/gloamNames). */
  | { kind: "name"; name: string }
  | { kind: "other" };

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A name worth looking up: no spaces, labels separated by dots, none empty,
 * the last one a real top-level label (letters, not a number like "1.5"), and
 * ENS normalization accepts it. Returns the normalized name, or null.
 */
export function ensCandidate(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text) || !text.includes(".")) return null;
  const labels = text.split(".");
  if (labels.some((l) => l === "")) return null;
  const last = labels[labels.length - 1]!;
  if (last.length < 2 || /^\d+$/.test(last)) return null;
  try {
    return normalize(text);
  } catch {
    return null;
  }
}

/** Sort the recipient text into what Pay does with it. */
export function classifyPayRecipient(input: string): PayRecipient {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  if (text.startsWith(RECEIVE_TAG_PREFIX)) return { kind: "gloam" };
  const gloamName = nameFromPayInput(text);
  if (gloamName) return { kind: "name", name: gloamName };
  if (isAddress(text)) return { kind: "address", address: text as Address };
  if (HEX_ADDRESS.test(text)) return { kind: "badAddress" };
  const name = ensCandidate(text);
  if (name) return { kind: "ens", name };
  return { kind: "other" };
}

/** True when Pay would not make a note for this text: it goes to Cash out instead. */
export function isWalletRecipient(r: PayRecipient): boolean {
  return r.kind === "address" || r.kind === "ens";
}

/** The Cash out fields a Pay hand-off fills. Nothing else about Cash out changes. */
export type CashOutHandoff = {
  dest: "other";
  to: Address;
  /** The amount typed in Pay, as typed; "" when none was. */
  amount: string;
};

/**
 * The state Cash out opens with when Pay hands a wallet over. A typed amount
 * always comes along, even one that does not fit: Cash out then shows its own
 * error, rather than a blank field quietly meaning the whole balance.
 */
export function cashOutHandoff(to: Address, typedAmount: string): CashOutHandoff {
  return { dest: "other", to, amount: typedAmount.trim() };
}

/**
 * Reads one address record of a name: `coinType` undefined is addr(bytes32),
 * the Ethereum mainnet record (coinType 60); otherwise addr(bytes32, coinType)
 * (ENSIP-9/11). Null when the name sets no such record.
 */
export type EnsChainReader = (name: string, coinType: bigint | undefined) => Promise<Address | null>;

/** The default record for every EVM chain (ENSIP-19): coinType 0x80000000. */
export const ENS_DEFAULT_EVM_COIN_TYPE = 0x80000000n;

export type EnsChainLookup =
  /**
   * `source` says which record it came from: "chain" the one the name sets for
   * this network (on Ethereum mainnet, its usual record), "evm" the default for
   * every EVM chain, "mainnet" its Ethereum record, used only because it is a
   * plain wallet (the same key controls it on every EVM chain).
   */
  | { status: "found"; address: Address; source: "chain" | "evm" | "mainnet" }
  /**
   * The name only sets an Ethereum address, and that address is a smart account
   * (or it could not be checked). The same address on another chain may not
   * exist or may belong to someone else, so it is not paid.
   */
  | { status: "unsafe"; address: Address }
  | { status: "none" };

/** EIP-7702 delegated wallets carry this code but are still controlled by their own key. */
const DELEGATION_PREFIX = "0xef0100";

/** True when `code` (eth_getCode) is a contract, not a plain or EIP-7702 delegated wallet. */
export function isContractCode(code: string | undefined | null): boolean {
  if (!code || code === "0x") return false;
  return !(code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 2 + 23 * 2);
}

/**
 * The address to pay a name at on the network with `chainId`, never throwing
 * (GHSA-wxv6-6fjw-c2m9). Asks, in order: the name's record for that network
 * (ENSIP-11), its default EVM record (ENSIP-19), and only then its Ethereum
 * mainnet record, which is used off Ethereum only when `isContract` says that
 * address is a plain wallet on Ethereum. `stale()` is asked after the wait so a
 * slow answer for text the user has since changed is dropped.
 */
export async function resolveEnsForChain(
  name: string,
  chainId: number,
  deps: { read: EnsChainReader; isContract: (address: Address) => Promise<boolean> },
  stale: () => boolean = () => false
): Promise<EnsChainLookup> {
  const none = { status: "none" } as const;
  const record = async (coinType: bigint | undefined): Promise<Address | null> => {
    const found = await deps.read(name, coinType);
    return found && isAddress(found, { strict: false }) ? getAddress(found) : null;
  };
  try {
    if (chainId === 1) {
      const main = await record(undefined);
      if (stale() || !main) return none;
      return { status: "found", address: main, source: "chain" };
    }
    const own = await record(toCoinType(chainId));
    if (stale()) return none;
    if (own) return { status: "found", address: own, source: "chain" };
    const evm = await record(ENS_DEFAULT_EVM_COIN_TYPE);
    if (stale()) return none;
    if (evm) return { status: "found", address: evm, source: "evm" };
    const main = await record(undefined);
    if (stale() || !main) return none;
    let contract: boolean;
    try {
      contract = await deps.isContract(main);
    } catch {
      contract = true;
    }
    if (stale()) return none;
    return contract ? { status: "unsafe", address: main } : { status: "found", address: main, source: "mainnet" };
  } catch {
    return none;
  }
}
