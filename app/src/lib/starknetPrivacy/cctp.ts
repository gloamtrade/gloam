/**
 * Bringing USDC into a Gloam private account on Starknet with Circle's CCTP
 * V2 (Starknet is CCTP domain 25). Shared by the browser and the server; pure,
 * checked by scripts/selftest-starknet-cctp.mts.
 *
 * The flow, and who pays what:
 *  1. On the source chain the person's own wallet burns USDC with
 *     depositForBurn(amount, 25, mintRecipient = their Gloam Starknet account,
 *     USDC, destinationCaller = 0, maxFee, minFinalityThreshold). It pays that
 *     chain's gas, and Circle's fast transfer fee (a few hundredths of a
 *     percent, read from Circle's API) comes out of the amount at the mint.
 *  2. Circle's attestation service (Iris) signs the message. Gloam reads it
 *     through /api/starknet/cctp/message.
 *  3. Gloam's relay sends ONE Starknet transaction that does two things:
 *     MessageTransmitterV2.receive_message(message, attestation), which mints
 *     the USDC to the account, then the account's own signed outside execution
 *     (SNIP-9, caller = the relay) of exactly [USDC.transfer(relay, fee),
 *     USDC.approve(pool, rest)]. So the receive pays for itself from the money
 *     it delivers: the relay never pays STRK to mint for an account that didn't
 *     sign its fee, and checkCctpReceive below is the whole shape it sends.
 *  4. The existing Add privately proves the deposit of `rest` (its approve is
 *     already done) and pays the relay's usual fee inside the proof.
 *
 * Circle has no forwarding service into Starknet (its fee API answers
 * "Destination domain not supported for forwarding" for domain 25, read
 * 2026-11-27), so Gloam's relay is the one that calls receive_message.
 *
 * destinationCaller is 0 (anyone may deliver the message), on purpose: the
 * mint recipient is inside Circle's signed message, so whoever delivers it can
 * only put the person's own money in the person's own account. Naming the relay
 * instead would strand a transfer if the relay's account ever changes or Gloam
 * is down; with 0, any CCTP relayer or the person themselves can finish it, and
 * the money then sits on the account, where the plain Add privately takes it.
 *
 * What is public: the burn on the source chain (the wallet, the amount, and the
 * Starknet account it is for), the mint on Starknet into that account, and the
 * add from that account. The same as funding the account from any wallet: the
 * private part starts after the add.
 */
import { hash, num, type Call } from "starknet";
import type { StarknetNetwork } from "./config";

/** Circle's domain for Starknet. */
export const CCTP_STARKNET_DOMAIN = 25;

/** The message header's version and the burn message body's version (CCTP V2). */
export const CCTP_MESSAGE_VERSION = 1;
export const CCTP_BODY_VERSION = 1;

/** Circle's finality thresholds: 1000 is a fast transfer, 2000 a standard one. */
export const CCTP_FAST = 1000;
export const CCTP_STANDARD = 2000;

/** Where the message body starts in a message, and the burn body's fixed part (CCTP technical guide). */
const HEADER_BYTES = 148;
const BODY_FIXED_BYTES = 228;
/** An attestation is one or more 65-byte signatures; Starknet's transmitter wanted 2 of 2 attesters on 2026-11-27. */
export const CCTP_SIGNATURE_BYTES = 65;
export const CCTP_MAX_SIGNATURES = 4;

export type StarknetCctp = {
  messageTransmitter: string;
  tokenMessengerMinter: string;
  /** Circle's native USDC on Starknet, the token the minter mints. */
  usdc: string;
  /** Circle's attestation service for this network. */
  iris: string;
  /**
   * The contracts' classes the relay sends to (null: not pinned). Circle can
   * upgrade both; until Gloam checks a new class, bringing money in pauses.
   */
  classHashes: { messageTransmitter: string; tokenMessengerMinter: string } | null;
};

/**
 * Circle's CCTP V2 contracts on Starknet (developers.circle.com, CCTP Starknet
 * contracts, read 2026-11-27). On mainnet, read on chain the same day: the
 * transmitter's local domain is 25, version 1, 2 enabled attesters and a
 * threshold of 2, not paused; the minter's transmitter is that one, it is a
 * minter of the USDC below, and get_local_token maps USDC on every source
 * listed in CCTP_SOURCES to it. Sepolia is Circle's testnet set, not pinned.
 */
export const STARKNET_CCTP: Record<Exclude<StarknetNetwork, "devnet">, StarknetCctp> = {
  mainnet: {
    messageTransmitter: "0x02ebb5777b6dd8b26ea11d68fdf1d2c85cd2099335328be845a28c77a8aef183",
    tokenMessengerMinter: "0x07d421b9ca8aa32df259965cda8acb93f7599f69209a41872ae84638b2a20f2a",
    usdc: "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    iris: "https://iris-api.circle.com",
    classHashes: {
      messageTransmitter: "0x01a82c735c08fb38dbc5b7b6e5f57973ad3a8fcf224a5f082fb9a7c8388f7ba1",
      tokenMessengerMinter: "0x03de0c68dad6bab78275624542e25ffab0d4a80f5bfdfc19765d177746cb3c35",
    },
  },
  sepolia: {
    messageTransmitter: "0x04db7926c64f1f32a840f3fa95cb551f3801a3600bae87af87807a54dce12fe8",
    tokenMessengerMinter: "0x04bdde1e09a4b09a2f95d893d94a967b7717eb85a3f6deca8c080ee01fbc3370",
    usdc: "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343",
    iris: "https://iris-api-sandbox.circle.com",
    classHashes: null,
  },
};

/** CCTP on this Starknet network, or null (a local devnet has none unless a test passes one). */
export function starknetCctp(network: StarknetNetwork): StarknetCctp | null {
  return network === "devnet" ? null : STARKNET_CCTP[network];
}

/** TokenMessengerV2 and MessageTransmitterV2 on every EVM chain below (Circle's contract addresses page, 2026-11-27). */
export const EVM_TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const EVM_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
/** Solana's TokenMessengerMinterV2 program as bytes32 (what Starknet's minter has for domain 5, read 2026-11-27). */
const SOLANA_TOKEN_MESSENGER = "0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893";

export type CctpSource = {
  /** The chain id Gloam's bridge lists it under (lib/bridge BRIDGE_CHAINS). */
  chainId: number;
  name: string;
  kind: "evm" | "svm";
  domain: number;
  /** Circle's native USDC there (an EVM address, or a Solana mint as bytes32). */
  usdc: string;
  /** Its TokenMessengerV2 as bytes32: the message's sender, checked before the relay sends. */
  messenger: string;
  /**
   * Fast transfer (minFinalityThreshold 1000, a small fee). Chains where
   * Circle's standard attestation is already quick have none: those burn at
   * 2000, with no fee.
   */
  fast: boolean;
  /** Circle's typical time to sign, in seconds, the way Gloam burns there (Circle's finality page, 2026-11-27). */
  attestSeconds: number;
};

const evm = (chainId: number, name: string, domain: number, usdc: string, fast: boolean, attestSeconds: number): CctpSource => ({
  chainId,
  name,
  kind: "evm",
  domain,
  usdc: usdc.toLowerCase(),
  messenger: evmToBytes32(EVM_TOKEN_MESSENGER_V2),
  fast,
  attestSeconds,
});

/**
 * Where money can come from, in the order lists show them: the chains Gloam's
 * bridge lists with Circle's native USDC (lib/bridge) that CCTP V2 serves.
 * BNB Chain is CCTP for USYC only; Robinhood Chain, Tempo and Elysium have no
 * CCTP: they need a first hop to a CCTP chain (Relay to Base).
 */
export const CCTP_SOURCES: readonly CctpSource[] = [
  evm(8453, "Base", 6, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", true, 8),
  evm(1, "Ethereum", 0, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", true, 20),
  { chainId: 792703809, name: "Solana", kind: "svm", domain: 5, usdc: "0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61", messenger: SOLANA_TOKEN_MESSENGER, fast: true, attestSeconds: 2 },
  evm(42161, "Arbitrum", 3, "0xaf88d065e77c8cc2239327c5edb3a432268e5831", true, 8),
  evm(10, "Optimism", 2, "0x0b2c639c533813f4aa9d7837caf62653d097ff85", true, 8),
  evm(137, "Polygon", 7, "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", false, 8),
  evm(43114, "Avalanche", 1, "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", false, 8),
  evm(130, "Unichain", 10, "0x078d782b760474a361dda0af3839290b0ef57ad6", true, 8),
  evm(480, "World Chain", 14, "0x79a02482a880bce3f13e09da970dc34db4cd24d1", true, 8),
  evm(59144, "Linea", 11, "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", true, 8),
  evm(143, "Monad", 15, "0x754704bc059f8c67012fed69bc8a327a5aafb603", false, 5),
  evm(999, "HyperEVM", 19, "0xb88339cb7199b77e23db6e890353e22632ba630f", false, 5),
  evm(146, "Sonic", 13, "0x29219dd400f2bf60e5a23d13be72b486d4038894", false, 8),
  evm(196, "X Layer", 37, "0xb6ceceab302e2e4948951ee7843fc24e92933061", true, 8),
];

export function cctpSourceByDomain(domain: number): CctpSource | null {
  return CCTP_SOURCES.find((s) => s.domain === domain) ?? null;
}

export function cctpSourceByChain(chainId: number): CctpSource | null {
  return CCTP_SOURCES.find((s) => s.chainId === chainId) ?? null;
}

/** The finality threshold Gloam burns with on `source`. */
export function burnFinality(source: Pick<CctpSource, "fast">): number {
  return source.fast ? CCTP_FAST : CCTP_STANDARD;
}

// ------------------------------------------------------------------ bytes

const HEX = /^0x[0-9a-fA-F]*$/;

export function hexToBytes(h: string): Uint8Array {
  if (!HEX.test(h) || h.length % 2 !== 0) throw new Error("Not hex bytes.");
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const big = (b: Uint8Array): bigint => (b.length ? BigInt(bytesToHex(b)) : 0n);
const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const b32 = (b: Uint8Array, at: number): string => bytesToHex(b.subarray(at, at + 32));

/** A Starknet address as CCTP's bytes32 (a felt is below 2^252, so it always fits). */
export function starknetToBytes32(address: string | bigint): string {
  const v = BigInt(address);
  if (v <= 0n || v >= 1n << 251n) throw new Error("Not a Starknet address.");
  return "0x" + v.toString(16).padStart(64, "0");
}

/** An EVM address as CCTP's bytes32 (left padded). */
export function evmToBytes32(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Not an EVM address.");
  return "0x" + address.slice(2).toLowerCase().padStart(64, "0");
}

/** The same 32 bytes, any case or padding. */
export function sameBytes32(a: string | bigint, b: string | bigint): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/**
 * Bytes as a Cairo ByteArray in calldata: the count of full 31-byte words, each
 * word, then the last partial word and its length. Checked against a real
 * receive_message on Starknet mainnet (tx 0x67508a74...f56a, 2026-11-27).
 */
export function byteArrayCalldata(b: Uint8Array): string[] {
  const full = Math.floor(b.length / 31);
  const out = [num.toHex(full)];
  for (let i = 0; i < full; i++) out.push(num.toHex(big(b.subarray(i * 31, i * 31 + 31))));
  const rest = b.subarray(full * 31);
  out.push(num.toHex(big(rest)), num.toHex(rest.length));
  return out;
}

// ------------------------------------------------------------------ the message

export type CctpBurnMessage = {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /** bytes32, hex. Circle sets it when it signs. */
  nonce: string;
  sender: string;
  recipient: string;
  destinationCaller: string;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: {
    version: number;
    burnToken: string;
    mintRecipient: string;
    amount: bigint;
    messageSender: string;
    maxFee: bigint;
    feeExecuted: bigint;
    /** The destination block it must be received before (0: none). Circle can sign it again (reattest). */
    expirationBlock: bigint;
    hookData: string;
  };
};

/** A CCTP V2 burn message, or null when it isn't one exactly (the technical guide's layout). */
export function decodeBurnMessage(message: string | Uint8Array): CctpBurnMessage | null {
  let b: Uint8Array;
  try {
    b = typeof message === "string" ? hexToBytes(message) : message;
  } catch {
    return null;
  }
  if (b.length < HEADER_BYTES + BODY_FIXED_BYTES) return null;
  const body = b.subarray(HEADER_BYTES);
  return {
    version: u32(b, 0),
    sourceDomain: u32(b, 4),
    destinationDomain: u32(b, 8),
    nonce: b32(b, 12),
    sender: b32(b, 44),
    recipient: b32(b, 76),
    destinationCaller: b32(b, 108),
    minFinalityThreshold: u32(b, 140),
    finalityThresholdExecuted: u32(b, 144),
    body: {
      version: u32(body, 0),
      burnToken: b32(body, 4),
      mintRecipient: b32(body, 36),
      amount: big(body.subarray(68, 100)),
      messageSender: b32(body, 100),
      maxFee: big(body.subarray(132, 164)),
      feeExecuted: big(body.subarray(164, 196)),
      expirationBlock: big(body.subarray(196, 228)),
      hookData: bytesToHex(body.subarray(228)),
    },
  };
}

/**
 * The bytes of a burn message, decodeBurnMessage's inverse. For self-tests and
 * the fork e2e, which stands in for Circle (it fills in the nonce, the fee and
 * the finality Circle sets when it signs).
 */
export function encodeBurnMessage(m: CctpBurnMessage): string {
  const w32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const w256 = (v: string | bigint) => {
    const h = BigInt(v).toString(16).padStart(64, "0");
    if (h.length > 64) throw new Error("More than 32 bytes.");
    return Array.from(hexToBytes("0x" + h));
  };
  const hook = Array.from(hexToBytes(m.body.hookData));
  return bytesToHex(
    Uint8Array.from([
      ...w32(m.version),
      ...w32(m.sourceDomain),
      ...w32(m.destinationDomain),
      ...w256(m.nonce),
      ...w256(m.sender),
      ...w256(m.recipient),
      ...w256(m.destinationCaller),
      ...w32(m.minFinalityThreshold),
      ...w32(m.finalityThresholdExecuted),
      ...w32(m.body.version),
      ...w256(m.body.burnToken),
      ...w256(m.body.mintRecipient),
      ...w256(m.body.amount),
      ...w256(m.body.messageSender),
      ...w256(m.body.maxFee),
      ...w256(m.body.feeExecuted),
      ...w256(m.body.expirationBlock),
      ...hook,
    ])
  );
}

/** What the mint puts in the recipient's account: the amount less Circle's fee. */
export function mintedAmount(m: Pick<CctpBurnMessage, "body">): bigint {
  const v = m.body.amount - m.body.feeExecuted;
  return v > 0n ? v : 0n;
}

/** The nonce as the transmitter's is_nonce_used takes it (a u256: low, high). */
export function nonceCalldata(nonce: string): [string, string] {
  const v = BigInt(nonce);
  return [num.toHex(v & ((1n << 128n) - 1n)), num.toHex(v >> 128n)];
}

/** The transmitter's receive_message(message, attestation), both as ByteArrays. */
export function receiveMessageCall(cctp: Pick<StarknetCctp, "messageTransmitter">, message: string, attestation: string): Call {
  return {
    contractAddress: cctp.messageTransmitter,
    entrypoint: "receive_message",
    calldata: [...byteArrayCalldata(hexToBytes(message)), ...byteArrayCalldata(hexToBytes(attestation))],
  };
}

// ------------------------------------------------------------------ fees

/** Circle's fee API gives basis points, maybe with decimals (1.3): as hundredths of a basis point. */
export function feeCentiBps(bps: number): bigint {
  if (!Number.isFinite(bps) || bps < 0 || bps > 100) throw new Error("Circle's fee is out of range.");
  return BigInt(Math.round(bps * 100));
}

/** Circle's fast transfer fee on `amount` at `bps`, rounded up (what the mint takes, at most). */
export function circleFee(amount: bigint, bps: number): bigint {
  const c = feeCentiBps(bps);
  return c === 0n ? 0n : (amount * c + 999_999n) / 1_000_000n;
}

/**
 * The maxFee Gloam burns with: Circle's fee with a 20% margin (Circle's own
 * advice), at least 1 base unit when there is a fee. A higher maxFee costs
 * nothing: the mint takes only the fee Circle executes. A standard transfer
 * (fast false) has none.
 */
export function burnMaxFee(amount: bigint, bps: number, fast: boolean): bigint {
  if (!fast) return 0n;
  const fee = circleFee(amount, bps);
  if (fee === 0n) return 0n;
  const withMargin = (fee * 120n + 99n) / 100n;
  return withMargin < amount ? withMargin : amount - 1n;
}

/** Circle's fee API row for a threshold (GET /v2/burn/USDC/fees/{src}/{dst}). */
export function feeBpsFrom(json: unknown, threshold: number): number | null {
  if (!Array.isArray(json)) return null;
  const row = json.find((r) => (r as { finalityThreshold?: unknown })?.finalityThreshold === threshold) as { minimumFee?: unknown } | undefined;
  const v = Number(row?.minimumFee);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

// ------------------------------------------------------------------ Circle's attestation API

export type IrisMessage =
  | { status: "pending" }
  | { status: "complete"; message: string; attestation: string; nonce: string; decoded: CctpBurnMessage };

/**
 * The message from Iris (GET /v2/messages/{domain}?transactionHash=) that goes
 * to Starknet, or pending while Circle hasn't signed it. Null when the answer
 * has no such message (a burn to another chain, or not a burn).
 */
export function irisMessageFrom(json: unknown, toDomain = CCTP_STARKNET_DOMAIN): IrisMessage | null {
  const list = (json as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return null;
  for (const raw of list) {
    const m = raw as { message?: unknown; attestation?: unknown; status?: unknown; decodedMessage?: { destinationDomain?: unknown } | null };
    const message = typeof m.message === "string" && HEX.test(m.message) && m.message.length > 2 ? m.message : null;
    const decoded = message ? decodeBurnMessage(message) : null;
    if (!decoded) {
      // Before Circle signs, the message is "0x"; its decoded form, when Iris gives one, says where it goes.
      const to = m.decodedMessage?.destinationDomain;
      if (m.status !== "complete" && (to === undefined || to === null || Number(to) === toDomain)) return { status: "pending" };
      continue;
    }
    if (decoded.destinationDomain !== toDomain) continue;
    const attestation = typeof m.attestation === "string" ? m.attestation : "";
    const signed = m.status === "complete" && validAttestation(attestation);
    // Before Circle signs, the message's nonce is still zero; it is the signed message that counts.
    if (!signed || BigInt(decoded.nonce) === 0n) return { status: "pending" };
    return { status: "complete", message: message!.toLowerCase(), attestation: attestation.toLowerCase(), nonce: decoded.nonce, decoded };
  }
  return null;
}

export function validAttestation(a: string): boolean {
  if (!HEX.test(a) || a.length % 2 !== 0) return false;
  const n = (a.length - 2) / 2;
  return n > 0 && n % CCTP_SIGNATURE_BYTES === 0 && n / CCTP_SIGNATURE_BYTES <= CCTP_MAX_SIGNATURES;
}

// ------------------------------------------------------------------ the relay's receive

const FELT_MAX = (1n << 251n) + 17n * (1n << 192n);
const U128 = 1n << 128n;
export const TRANSFER_SELECTOR = hash.getSelectorFromName("transfer");
export const APPROVE_SELECTOR_CCTP = hash.getSelectorFromName("approve");
export const OUTSIDE_V2 = "execute_from_outside_v2";
/** An outside execution may run for at most this long after the relay gets it. */
export const CCTP_OUTSIDE_WINDOW_S = 3_600;
const MAX_SIGNATURE_FELTS = 4;

export type CctpReceiveContext = {
  cctp: Pick<StarknetCctp, "messageTransmitter" | "tokenMessengerMinter" | "usdc">;
  /** The relay's own account. */
  relay: string;
  pool: string;
  /** Unix seconds. */
  now: number;
  /** The least the receive must pay the relay, in USDC base units (0: none asked). */
  minFee: bigint;
  /** The most the approve may allow (the relay's cap on one add). */
  maxApprove: bigint;
  /** Source domains the relay takes (default: every one in CCTP_SOURCES). */
  sources?: readonly CctpSource[];
};

export type CctpReceiveDecision =
  | {
      ok: true;
      account: string;
      nonce: string;
      sourceDomain: number;
      /** What the mint puts in the account (amount less Circle's fee). */
      minted: bigint;
      fee: bigint;
      approve: bigint;
      expirationBlock: bigint;
    }
  | { ok: false; reason: string };

const no = (reason: string): CctpReceiveDecision => ({ ok: false, reason });

function felts(call: Call): bigint[] | null {
  if (!Array.isArray(call.calldata)) return null;
  const out: bigint[] = [];
  for (const x of call.calldata as unknown[]) {
    try {
      const v = BigInt(x as string);
      if (v < 0n || v >= FELT_MAX) return null;
      out.push(v);
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * The one shape the relay sends to bring money in: Circle's signed message for
 * a USDC burn to Starknet from a listed source, minted to `outside`'s account,
 * and that account's outside execution of exactly [USDC.transfer(relay, fee),
 * USDC.approve(pool, rest)] with fee + rest at most what the mint delivers.
 * The route also checks the chain (the account is a Gloam account, the nonce is
 * unused, the message hasn't expired, the cost is under the cap) and that the
 * whole transaction runs before it sends (not pure, so not here).
 */
export function checkCctpReceive(input: { message: string; attestation: string; outside: Call }, ctx: CctpReceiveContext): CctpReceiveDecision {
  if (typeof input.message !== "string" || typeof input.attestation !== "string") return no("bad_message");
  const m = decodeBurnMessage(input.message);
  if (!m) return no("bad_message");
  if (m.version !== CCTP_MESSAGE_VERSION || m.body.version !== CCTP_BODY_VERSION) return no("message_version");
  if (m.destinationDomain !== CCTP_STARKNET_DOMAIN) return no("not_to_starknet");
  if (!sameBytes32(m.recipient, ctx.cctp.tokenMessengerMinter)) return no("not_a_burn");
  const source = (ctx.sources ?? CCTP_SOURCES).find((s) => s.domain === m.sourceDomain);
  if (!source) return no("source_not_listed");
  if (!sameBytes32(m.sender, source.messenger)) return no("not_circles_messenger");
  if (!sameBytes32(m.body.burnToken, source.usdc)) return no("not_usdc");
  if (BigInt(m.nonce) === 0n) return no("not_signed");
  if (!(BigInt(m.destinationCaller) === 0n || sameBytes32(m.destinationCaller, ctx.relay))) return no("other_caller");
  if (m.body.hookData !== "0x") return no("hook_data");
  if (!validAttestation(input.attestation)) return no("bad_attestation");
  const minted = mintedAmount(m);
  if (minted <= 0n) return no("nothing_minted");

  const call = input.outside;
  if (!call || typeof call.contractAddress !== "string" || call.entrypoint !== OUTSIDE_V2) return no("outside_shape");
  let account: bigint;
  try {
    account = BigInt(call.contractAddress);
  } catch {
    return no("outside_shape");
  }
  if (account !== BigInt(m.body.mintRecipient)) return no("not_the_recipient");
  const cd = felts(call);
  if (!cd) return no("outside_shape");
  // caller, nonce, execute_after, execute_before, calls_len, then
  // transfer: to, selector, 3, recipient, low, high; approve: to, selector, 3, spender, low, high;
  // then signature_len, ...signature.
  if (cd.length < 5 + 12 + 1) return no("outside_shape");
  const [caller, , after, before, nCalls] = cd;
  if (!sameBytes32(caller!, ctx.relay)) return no("outside_caller");
  if (nCalls !== 2n) return no("outside_two_calls");
  const now = BigInt(Math.floor(ctx.now));
  if (before! <= now) return no("outside_expired");
  if (before! - now > BigInt(CCTP_OUTSIDE_WINDOW_S) || after! >= before!) return no("outside_window");
  const usdc = BigInt(ctx.cctp.usdc);
  const [t1, s1, l1, to, feeLow, feeHigh] = cd.slice(5, 11);
  const [t2, s2, l2, spender, appLow, appHigh] = cd.slice(11, 17);
  if (t1 !== usdc || s1 !== BigInt(TRANSFER_SELECTOR) || l1 !== 3n) return no("fee_transfer_only");
  if (!sameBytes32(to!, ctx.relay)) return no("fee_to_relay");
  if (t2 !== usdc || s2 !== BigInt(APPROVE_SELECTOR_CCTP) || l2 !== 3n) return no("approve_only");
  if (!sameBytes32(spender!, ctx.pool)) return no("approve_spender");
  if (feeHigh !== 0n || feeLow! >= U128 || appHigh !== 0n || appLow! >= U128) return no("amount_shape");
  const sigLen = cd[17]!;
  if (sigLen === 0n || sigLen > BigInt(MAX_SIGNATURE_FELTS)) return no("outside_signature");
  if (cd.length !== 18 + Number(sigLen)) return no("outside_shape");
  const fee = feeLow!;
  const approve = appLow!;
  if (fee < ctx.minFee) return no("fee_too_low");
  if (approve <= 0n || approve > ctx.maxApprove) return no("approve_amount");
  if (fee + approve > minted) return no("more_than_minted");
  return {
    ok: true,
    account: num.toHex(account),
    nonce: m.nonce,
    sourceDomain: m.sourceDomain,
    minted,
    fee,
    approve,
    expirationBlock: m.body.expirationBlock,
  };
}

/** The two calls the account signs for the relay's receive: the fee, then the approve for the add. */
export function receiveOutsideCalls(input: { usdc: string; relay: string; pool: string; fee: bigint; approve: bigint }): Call[] {
  const u256 = (v: bigint) => [num.toHex(v % U128), num.toHex(v / U128)];
  return [
    { contractAddress: input.usdc, entrypoint: "transfer", calldata: [input.relay, ...u256(input.fee)] },
    { contractAddress: input.usdc, entrypoint: "approve", calldata: [input.pool, ...u256(input.approve)] },
  ];
}

// ------------------------------------------------------------------ the EVM burn

/** TokenMessengerV2's burn and USDC's two reads and approve, as viem's parseAbi takes them. */
export const EVM_CCTP_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

export const ZERO_BYTES32 = "0x" + "0".repeat(64);

/** depositForBurn's arguments for a burn from `source` to the Starknet account `account`. */
export function depositForBurnArgs(input: { source: CctpSource; account: string; amount: bigint; bps: number }) {
  if (input.source.kind !== "evm") throw new Error("Not an EVM source.");
  if (input.amount <= 0n) throw new Error("Invalid amount.");
  return [
    input.amount,
    CCTP_STARKNET_DOMAIN,
    starknetToBytes32(input.account) as `0x${string}`,
    `0x${input.source.usdc.slice(-40)}` as `0x${string}`,
    ZERO_BYTES32 as `0x${string}`,
    burnMaxFee(input.amount, input.bps, input.source.fast),
    burnFinality(input.source),
  ] as const;
}

// ------------------------------------------------------------------ what a bring-in costs

export type BringInCosts = {
  /** Circle's fee at most (taken from the amount at the mint). */
  circle: bigint;
  /** Gloam's relay fee on the receive (from the minted USDC). */
  receive: bigint;
  /** Gloam's relay fee on the private add (inside its proof). */
  add: bigint;
  /** What lands in the private balance, at least. */
  lands: bigint;
};

/** What a bring-in of `amount` from `source` costs and leaves, in USDC base units. Null when it leaves nothing. */
export function bringInCosts(amount: bigint, source: Pick<CctpSource, "fast">, bps: number, receiveFee: bigint, addFee: bigint): BringInCosts | null {
  const circle = source.fast ? circleFee(amount, bps) : 0n;
  const lands = amount - circle - receiveFee - addFee;
  if (lands <= 0n) return null;
  return { circle, receive: receiveFee, add: addFee, lands };
}
