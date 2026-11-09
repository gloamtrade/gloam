/**
 * Who pays the network fee when a Gloam wallet (lib/embeddedWallet) sends a
 * transaction. A new Gloam wallet holds no gas, so this matters on its very
 * first step.
 *
 * Most of what a new wallet does first needs no gas from it at all:
 *  - claiming a payment link, and receiving a private payment: the Gloam relay
 *    sends the claim (lib/claimSweep), so the wallet never pays
 *  - paying privately, cashing out, payroll and private swaps: the relay sends
 *  - bringing money over from Solana or another wallet straight into the
 *    private balance: that wallet pays on its own chain and Relay makes the
 *    deposit (lib/bridgePrivate)
 *  - backing up the private balance and making proofs: signatures, no sends
 *
 * The wallet pays only when it sends from its own public balance: adding money
 * privately (approve and deposit), a public send, paying a bridge order from
 * this wallet on another chain, and setting a fee token on Tempo. For those:
 *  - Tempo has no gas coin. Fees come out of a USD stablecoin the wallet holds,
 *    and the wallet's fee token is set first when it needs one (lib/feeSponsor),
 *    the same as for a browser wallet. Nothing is sponsored there.
 *  - Elsewhere the wallet pays from its own ETH when it holds enough. When it
 *    doesn't, and the chain is in NEXT_PUBLIC_TURNKEY_SPONSOR_CHAINS, Turnkey's
 *    gas station sends it and Gloam's Turnkey account pays the fee, for two
 *    calls only: the deposit into that chain's Gloam vault, and the approve, on
 *    a token Add lists there, that lets the vault take it (sponsorableCall). Never anything else, and
 *    never a call whose gas estimate failed. That needs Gas Sponsorship on in
 *    the Turnkey dashboard, with its spend limits.
 *  - Otherwise nothing is sent, and the wallet says how to get money in
 *    without gas.
 *
 * Sponsoring only when the wallet can't pay keeps the cost to Gloam down: a
 * wallet that brought ETH over pays its own way.
 */

import { decodeFunctionData, isAddress, isAddressEqual, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { EmbeddedMaybeSentError, EmbeddedNotSentError } from "./embeddedErrors";

/**
 * Chains Turnkey's gas station sponsors (docs.turnkey.com/features/transaction-management,
 * read 2 November 2026). Gloam's four mainnets and their testnets are all here, with
 * the bridge's other EVM chains Turnkey covers.
 */
export const TURNKEY_SPONSORABLE: ReadonlySet<number> = new Set([
  // mainnets
  1, 10, 56, 137, 143, 4217, 4663, 5042, 8453, 42161,
  // testnets
  97, 10143, 42431, 46630, 80002, 84532, 421614, 5042002, 11155111, 11155420,
]);

/** Tempo mainnet and Moderato: fees in a USD stablecoin, never sponsored here. */
export const TEMPO_FEE_CHAIN_IDS: ReadonlySet<number> = new Set([4217, 42431]);

/**
 * The chains whose sends Gloam lets Turnkey sponsor, from NEXT_PUBLIC_TURNKEY_SPONSOR_CHAINS:
 * a comma-separated list of chain ids, or "all" for every chain in TURNKEY_SPONSORABLE.
 * Unset, empty or "off" sponsors nothing. Ids Turnkey can't sponsor are dropped, and
 * so is Tempo, which pays its own fees in stablecoins.
 */
export function sponsorChainsFrom(raw: string | undefined | null): ReadonlySet<number> {
  const v = raw?.trim().toLowerCase() ?? "";
  if (!v || v === "off" || v === "none" || v === "false" || v === "0") return new Set();
  const wanted = v === "all" ? [...TURNKEY_SPONSORABLE] : v.split(/[\s,]+/).map((x) => (/^\d{1,10}$/.test(x) ? Number(x) : NaN));
  return new Set(wanted.filter((id) => TURNKEY_SPONSORABLE.has(id) && !TEMPO_FEE_CHAIN_IDS.has(id)));
}

export const SPONSOR_CHAINS: ReadonlySet<number> = sponsorChainsFrom(process.env.NEXT_PUBLIC_TURNKEY_SPONSOR_CHAINS);

/** OP Stack chains add a data fee for Ethereum on top of gas times price. */
const OP_STACK = new Set([10, 130, 480, 8453, 57073, 84532, 11155420]);
/** Room for that data fee: 0.00002 ETH, far above what one deposit has cost on Base. */
const L1_FEE_ROOM = 20_000_000_000_000n;

/**
 * What a send may cost in the chain's gas coin: the gas at the highest fee per gas
 * it can pay, a fifth more for a price that moves before it lands, and room for the
 * data fee on OP Stack chains.
 */
export function gasBudget(chainId: number, gas: bigint, maxFeePerGas: bigint): bigint {
  const base = (gas * maxFeePerGas * 12n) / 10n;
  return OP_STACK.has(chainId) ? base + L1_FEE_ROOM : base;
}

export type GasRoute =
  /** The wallet pays from its own balance (ETH, or a stablecoin on Tempo). */
  | { kind: "self" }
  /** Tempo: the fee comes out of a stablecoin; the fee token is set first when needed. */
  | { kind: "stablecoin" }
  /** Turnkey's gas station sends it and Gloam's account pays the fee. */
  | { kind: "sponsored" }
  /** Nothing can pay: "no-gas" for the fee, "no-funds" for the value itself. */
  | { kind: "none"; why: "no-gas" | "no-funds" };

export type GasRouteInput = {
  chainId: number;
  /** The wallet's balance of the chain's gas coin, or null when it couldn't be read. */
  balance: bigint | null;
  /** The value the transaction carries (native ETH sent with it). */
  value: bigint;
  /** gasBudget for this send, or null when it couldn't be estimated. */
  cost: bigint | null;
  sponsorChains: ReadonlySet<number>;
  /** The call is one Gloam sponsors (sponsorableCall): a vault deposit or the approve for it. */
  sponsorable: boolean;
};

export function pickGasRoute(p: GasRouteInput): GasRoute {
  if (TEMPO_FEE_CHAIN_IDS.has(p.chainId)) return { kind: "stablecoin" };
  // Sponsorship pays the fee, never the value: that has to be in the wallet.
  if (p.balance !== null && p.balance < p.value) return { kind: "none", why: "no-funds" };
  if (p.balance !== null && p.cost !== null && p.balance - p.value >= p.cost) return { kind: "self" };
  // Sponsored only with a fee estimate: a call whose estimate reverts is never handed to the gas station.
  if (p.sponsorable && p.cost !== null && p.sponsorChains.has(p.chainId)) return { kind: "sponsored" };
  // Couldn't tell: let the send try, and the chain answer.
  if (p.balance === null || p.cost === null) return { kind: "self" };
  return { kind: "none", why: "no-gas" };
}

const VAULT_ABI = parseAbi([
  "function shieldBound(address asset, uint256 amount, bytes32 commitment, bytes proof)",
  "function shield(address asset, uint256 amount, bytes32 commitment)",
]);
const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const DEPOSIT_SELECTORS = new Set<string>(VAULT_ABI.map((f) => toFunctionSelector(f).toLowerCase()));
const APPROVE_SELECTOR: string = toFunctionSelector(APPROVE_ABI[0]).toLowerCase();

/** What a sponsored send may call on a chain: its Gloam vault, and the tokens Add lists there. */
export type SponsorTargets = { vault: Address; tokens: readonly Address[] };

/**
 * The only calls Gloam pays a Gloam wallet's fee for: a deposit into this chain's
 * Gloam vault (shieldBound, or shield on the older testnet pools), and an approve
 * sent to one of the tokens Add lists on that chain, whose spender is the vault,
 * carrying no value. Anything else (a public send, a bridge order, an approve on
 * any other contract) is the wallet's own to pay for.
 */
export function sponsorableCall(p: { to: string; data?: Hex; value: bigint; targets: SponsorTargets | null }): boolean {
  const vault = p.targets?.vault;
  if (!vault || !isAddress(p.to) || !p.data || p.data.length < 10) return false;
  const selector = p.data.slice(0, 10).toLowerCase();
  if (DEPOSIT_SELECTORS.has(selector)) {
    if (!isAddressEqual(p.to as Address, vault)) return false;
    try {
      decodeFunctionData({ abi: VAULT_ABI, data: p.data });
      return true;
    } catch {
      return false;
    }
  }
  if (selector === APPROVE_SELECTOR && p.value === 0n) {
    if (!p.targets!.tokens.some((t) => isAddress(t) && isAddressEqual(t, p.to as Address))) return false;
    try {
      const { args } = decodeFunctionData({ abi: APPROVE_ABI, data: p.data });
      return isAddressEqual(args[0], vault);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * What the wallet says when nothing can pay. Short enough for the app's error
 * lines, which cut a message at 180 characters.
 */
export function noGasText(why: "no-gas" | "no-funds", chainName: string, coin: string): string {
  if (why === "no-funds") return `This wallet doesn't hold enough ${coin} on ${chainName} for this, so nothing was sent.`;
  return `No ${coin} in this wallet for the network fee on ${chainName}, so nothing was sent. Send it a little ${coin}, or add money with a claim link or the bridge.`;
}

/** Turnkey refused to sponsor it, before anything went out. */
export function sponsorRefusedText(coin: string): string {
  return `Network fees for this wallet aren't covered right now, so nothing was sent. Send it a little ${coin}, or add money with a claim link or the bridge.`;
}

/** Turnkey took it, and no transaction hash came back in time. It may still land. */
export const SPONSOR_SLOW_TEXT =
  "The network fee service took this, but no transaction showed up yet. Check your activity in a minute before trying again.";

/** Turnkey took it and then said it failed. Whether it reached the chain isn't certain. */
export const SPONSOR_FAILED_TEXT =
  "The network fee service couldn't finish this send. Check your activity before trying again: it may still have gone out.";

/** Anything else after the first submit left: the send may still go out. */
export const SPONSOR_UNSURE_TEXT =
  "The network fee service didn't confirm this send. It may still go through: check your activity in a minute before trying again.";

/**
 * The gRPC codes Turnkey documents for its 4xx answers (docs.turnkey.com/api-reference/overview/errors,
 * read 2 November 2026): InvalidArgument 3, NotFound 5, PermissionDenied 7,
 * ResourceExhausted 8, Unauthenticated 16. Each means the request was turned down
 * before any work. Turnkey says not to rely on these, so turnkeyErrorCode wins
 * whenever an answer carries one.
 */
const REFUSED_GRPC = new Set([3, 5, 7, 8, 16]);

/**
 * turnkeyErrorCode values Turnkey documents for a request it turned down before
 * doing anything: an invalid request, no or a bad signature, not allowed, an unknown
 * organization or key, a rate limit or quota. Anything else, including codes added
 * later, is read as "may have been taken".
 */
const REFUSED_TURNKEY = new Set([
  "REQUEST_INVALID",
  "INVALID_TRANSACTION",
  "INVALID_ORGANIZATION_ID",
  "ORGANIZATION_MISMATCH",
  "UNAUTHENTICATED",
  "SIGNATURE_MISSING",
  "SIGNATURE_INVALID",
  "API_KEY_EXPIRED",
  "FORBIDDEN",
  "REQUEST_NOT_AUTHORIZED",
  "INVALID_ACTIVITY_CALLER",
  "ORGANIZATION_NOT_FOUND",
  "PUBLIC_KEY_NOT_FOUND",
  "CREDENTIAL_NOT_FOUND",
  "RATE_LIMIT_EXCEEDED",
  "SIGNING_QUOTA_EXCEEDED",
]);

/** The turnkeyErrorCode values an error answer carries, at its top or in its details. */
function turnkeyErrorCodes(body: unknown): string[] {
  const b = body as { turnkeyErrorCode?: unknown; details?: unknown } | null;
  const out: string[] = [];
  if (typeof b?.turnkeyErrorCode === "string") out.push(b.turnkeyErrorCode);
  if (Array.isArray(b?.details)) {
    for (const d of b.details) {
      const c = (d as { turnkeyErrorCode?: unknown } | null)?.turnkeyErrorCode;
      if (typeof c === "string") out.push(c);
    }
  }
  return out;
}

/**
 * Whether the first submit of a sponsored send was refused before Turnkey did any
 * work, from the HTTP status and the body it answered with. Only a 4xx counts, and
 * only when its turnkeyErrorCode is one that means refused (or, with none given,
 * its gRPC code is). A 5xx, a body that isn't Turnkey's JSON, an unknown code, or no
 * answer at all could come after the activity was made. Never use it on a later
 * call (the activity poll, the status poll): once an activity exists, the send may
 * go out.
 */
export function submitRefused(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  const turnkey = turnkeyErrorCodes(body);
  if (turnkey.length) return turnkey.every((c) => REFUSED_TURNKEY.has(c));
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "number" && REFUSED_GRPC.has(code);
}

export type SponsorStatus = {
  txStatus?: string;
  eth?: { txHash?: string };
  error?: { message?: string };
  txError?: string;
};

/**
 * Waits for a sponsored send's hash. Turnkey's own poller waits for inclusion and
 * gives up after a minute; the app only needs the hash, then waits for the receipt
 * the way it does for any wallet. A failure here does not mean nothing went out, so
 * it never throws EmbeddedNotSentError: the app keeps what it saved ahead of the send.
 */
export async function waitForSponsoredHash(
  getStatus: () => Promise<SponsorStatus>,
  { intervalMs = 700, timeoutMs = 120_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = Date.now } = {},
): Promise<`0x${string}`> {
  const end = now() + timeoutMs;
  for (;;) {
    const s = await getStatus().catch(() => null);
    const hash = s?.eth?.txHash;
    if (hash && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash as `0x${string}`;
    if (s?.txStatus === "FAILED" || s?.txStatus === "CANCELLED") {
      throw new EmbeddedMaybeSentError(SPONSOR_FAILED_TEXT, new Error(s.error?.message || s.txError || "failed"));
    }
    if (now() >= end) throw new EmbeddedMaybeSentError(SPONSOR_SLOW_TEXT);
    await sleep(intervalMs);
  }
}

/** The slice of Turnkey's client (react-wallet-kit's httpClient) a sponsored send uses. */
export type SponsorClient = {
  stampEthSendTransaction(input: Record<string, unknown>): Promise<{ body: string; stamp: { stampHeaderName: string; stampHeaderValue: string }; url: string } | undefined>;
  getActivity(input: { activityId: string; organizationId: string }): Promise<{ activity?: { status?: string; result?: { ethSendTransactionResult?: { sendTransactionStatusId?: string } } } }>;
  getSendTransactionStatus(input: { organizationId: string; sendTransactionStatusId: string }): Promise<SponsorStatus>;
};

export type SponsorRequest = {
  organizationId: string;
  chainId: number;
  from: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
  /** The chain's gas coin, for the refusal message. */
  coin: string;
};

const ACTIVITY_DONE = "ACTIVITY_STATUS_COMPLETED";
const ACTIVITY_ENDED = new Set(["ACTIVITY_STATUS_COMPLETED", "ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);

/**
 * A sponsored send through Turnkey's gas station, in three steps whose failures
 * mean different things:
 *  1. The submit. Only a refusal Turnkey answered before any work (submitRefused)
 *     is EmbeddedNotSentError. A lost answer, a 5xx or anything odd is maybe sent.
 *  2. The activity, polled until it ends. It exists now, so any failure from here
 *     on (a refused poll, a failed activity, no status id) is maybe sent.
 *  3. The transaction status, until it has a hash (waitForSponsoredHash).
 * The submit is stamped by the kit and sent here, so the first answer is read
 * before anything polls.
 */
export async function sendSponsored(
  client: SponsorClient,
  req: SponsorRequest,
  {
    fetch: doFetch = globalThis.fetch,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now,
    intervalMs = 700,
    activityTimeoutMs = 60_000,
    hashTimeoutMs = 120_000,
  } = {},
): Promise<Hex> {
  const refused = () => new EmbeddedNotSentError(sponsorRefusedText(req.coin));
  const unsure = (cause?: unknown) => new EmbeddedMaybeSentError(SPONSOR_UNSURE_TEXT, cause);

  let stamped: Awaited<ReturnType<SponsorClient["stampEthSendTransaction"]>>;
  try {
    stamped = await client.stampEthSendTransaction({
      organizationId: req.organizationId,
      from: req.from,
      caip2: `eip155:${req.chainId}`,
      to: req.to,
      ...(req.value !== undefined ? { value: req.value.toString() } : {}),
      ...(req.data ? { data: req.data } : {}),
      sponsor: true,
    });
  } catch {
    // Nothing was sent: the request couldn't even be signed (no session).
    throw refused();
  }
  if (!stamped) throw refused();

  let res: Response;
  try {
    res = await doFetch(stamped.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [stamped.stamp.stampHeaderName]: stamped.stamp.stampHeaderValue },
      body: stamped.body,
    });
  } catch (e) {
    // No answer: the request may have arrived.
    throw unsure(e);
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (submitRefused(res.status, answer)) throw refused();
    throw unsure(new Error(`${res.status} ${(answer as { message?: string } | null)?.message ?? res.statusText}`));
  }

  const first = (answer as { activity?: { id?: string; status?: string; result?: { ethSendTransactionResult?: { sendTransactionStatusId?: string } } } } | null)?.activity;
  if (!first?.id) throw unsure(new Error("no activity in the answer"));
  let activity = first;
  const until = now() + activityTimeoutMs;
  while (!ACTIVITY_ENDED.has(activity.status ?? "")) {
    if (now() >= until) throw unsure(new Error("activity still running"));
    await sleep(intervalMs);
    try {
      const polled = await client.getActivity({ activityId: first.id, organizationId: req.organizationId });
      if (polled.activity) activity = { ...polled.activity, id: first.id };
    } catch (e) {
      // A refused or lost poll says nothing about the send itself: keep waiting until the deadline.
      if (now() >= until) throw unsure(e);
    }
  }
  if (activity.status !== ACTIVITY_DONE) throw unsure(new Error(String(activity.status)));
  const statusId = activity.result?.ethSendTransactionResult?.sendTransactionStatusId;
  if (!statusId) throw unsure(new Error("no status id"));

  return waitForSponsoredHash(
    () => client.getSendTransactionStatus({ organizationId: req.organizationId, sendTransactionStatusId: statusId }),
    { sleep, now, intervalMs, timeoutMs: hashTimeoutMs },
  );
}
