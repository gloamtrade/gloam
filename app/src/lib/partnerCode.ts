/**
 * The shape of a partner link code (lib/partnerLinks issues them): 20 letters
 * and digits, carried as `p=<code>` in a pay link's or swap link's fragment.
 * Shared by the app and the server; the shape says nothing about whether a code
 * is live, which only the server knows.
 *
 * linkNullifierHash names one spend without revealing it: the app registers it
 * with the code before a wallet sends (lib/partnerAttribution), and the server
 * finds it again from the nullifier the transaction makes public. linkBindHash
 * ties that registration to something only the spender knows when it sends (a
 * private payment's new note commitment, a cash out's proof), so knowing a
 * nullifier ahead of time is not enough to register its spend.
 */
import { encodePacked, keccak256, type Hex } from "viem";

/**
 * Chains where a pending transaction's calldata can be read before its block's
 * timestamp: Ethereum's public mempool, and Base, whose public RPC shows the
 * pending block about 1.5 s early. A wallet send's registration there could be
 * copied from it, so only relay-sent link payments count there.
 */
export const PUBLIC_MEMPOOL_CHAINS: readonly number[] = [
  1,
  11155111,
  8453,
  84532,
  // Elysium mainnet and testnet: treated as public until its sequencer is checked
  // not to show a pending transaction before its block (it is an Orbit chain like
  // Robinhood Chain, which does not). Relay-sent link payments still count there.
  99901,
  99801,
];

export const LINK_CODE_LENGTH = 20;
const CODE_RE = new RegExp(`^[A-Za-z0-9]{${LINK_CODE_LENGTH}}$`);

export function isLinkCodeShape(raw: unknown): raw is string {
  return typeof raw === "string" && CODE_RE.test(raw);
}

/** The code in a link's `p`, or null when there is none or it is not a code's shape. */
export function readLinkCode(params: { get(name: string): string | null }): string | null {
  const raw = params.get("p");
  return isLinkCodeShape(raw) ? raw : null;
}

/** The hash a spend is registered under: keccak256("gloam-partner-link-v1" ‖ nullifier). */
export function linkNullifierHash(nullifier: Hex): Hex {
  return keccak256(encodePacked(["string", "bytes32"], ["gloam-partner-link-v1", nullifier]));
}

export function isBytes32(raw: unknown): raw is Hex {
  return typeof raw === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw);
}

/** The hash a registration's binding is kept under: keccak256("gloam-partner-bind-v1" ‖ value). */
export function linkBindHash(value: Hex): Hex {
  return keccak256(encodePacked(["string", "bytes32"], ["gloam-partner-bind-v1", value]));
}

/** What a wallet cash out binds to: its proof, which nobody but the spender has before it is sent. */
export function proofBindValue(proof: Hex): Hex {
  return keccak256(proof);
}
