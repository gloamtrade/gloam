/**
 * A gloam charge paywall over plain Fetch Request/Response, no MPP library
 * needed. Same handler shape as mppx (`charge(options)(request)` resolves to a
 * 402 with a challenge, or a 200 with `withReceipt`), so moving to mppx later
 * is a swap of the factory, not a rewrite of the routes.
 *
 *   const paywall = createGloamPaywall({ secretKey, server: { receiveKey, chain, prove, submit, beforeSubmit } })
 *   const r = await paywall.charge({ amount: "0.01" })(request)
 *   if (r.status === 402) return r.challenge
 *   return r.withReceipt(Response.json(data))
 */

import { parseUnits, type Address } from "viem";
import {
  assetDecimals,
  buildGloamChargeRequest,
  resolveNetwork,
  isGloamChargeChallenge,
  parseGloamChargeRequest,
  termsMismatch,
  GloamChargeError,
  GLOAM_CHARGE_INTENT,
  GLOAM_METHOD,
  type GloamChargeNetwork,
  type GloamChargeReceipt,
  type GloamChargeRequest,
  type GloamMode,
} from "./charge.js";
import { assertKeepsFreshNotes, settleGloamCharge, validateGloamCharge, type GloamChargeServerConfig } from "./server.js";
import {
  createPaymentChallenge,
  extractPaymentCredential,
  formatPaymentChallenge,
  isExpired,
  parseCredential,
  problem,
  serializeReceipt,
  verifyChallengeId,
  MalformedCredentialError,
  PAYMENT_AUTHORIZATION_HEADER,
  PAYMENT_RECEIPT_HEADER,
  type ProblemCode,
} from "./wire.js";

export interface GloamPaywallConfig {
  /** Server secret for HMAC-bound challenge ids (at least 32 random bytes). Never sent to clients. */
  secretKey: string;
  server: GloamChargeServerConfig;
  /** Protection space. Default: the request's host. */
  realm?: string;
  /** "tempo-mainnet" or "robinhood-mainnet" (mainnet), "tempo" or "robinhood" (testnet), or a chain id; "base-mainnet", "base" and "ethereum" once their pools are in, "elysium-mainnet" and "elysium" (Elysium testnet) once the SDK has Elysium's values. Default "tempo". */
  network?: GloamChargeNetwork | number;
  /** Token address; default the network's first stablecoin (USDC.e on Tempo mainnet, USDG on Robinhood Chain mainnet, USDC on Base, PathUSD on Tempo testnet), native ETH on Robinhood Chain testnet. */
  currency?: Address;
  /** Decimals of `currency`, to read display amounts. Default: the asset's own (6 for the stablecoins, 18 for ETH and GLOAM). */
  decimals?: number;
  /** Seconds a challenge stays valid. Default 600: a push payment proves and confirms before it is presented. */
  expiresIn?: number;
  /** Ask for the credential in Payment-Authorization, leaving Authorization to your own auth. */
  paymentAuthorizationHeader?: boolean;
}

export interface GloamChargeOptions {
  /** Price in display units ("0.01"), or `amountWei` in base units. */
  amount?: string;
  amountWei?: bigint;
  description?: string;
  externalId?: string;
  modes?: GloamMode[];
}

export type GloamPaywallResult =
  | { status: 402; challenge: Response }
  | { status: 200; receipt: GloamChargeReceipt; withReceipt: (response: Response) => Response };

export function createGloamPaywall(config: GloamPaywallConfig) {
  assertKeepsFreshNotes(config.server);
  const net = resolveNetwork(config.network);
  const known = config.decimals ?? assetDecimals(config.currency ?? net.currency);
  if (known === undefined) throw new Error(`Pass decimals for currency ${config.currency}.`);
  const decimals: number = known;

  function termsFor(o: GloamChargeOptions): GloamChargeRequest {
    const amountWei = o.amountWei ?? (o.amount !== undefined ? parseUnits(o.amount, decimals) : undefined);
    if (amountWei === undefined) throw new Error("Give the price as amount or amountWei.");
    return buildGloamChargeRequest({
      amountWei,
      recipient: config.server.receiveKey.tag,
      network: config.network,
      currency: config.currency,
      decimals,
      modes: o.modes ?? config.server.modes,
      // The description travels as the challenge's display parameter (as mppx does), not inside the request.
      externalId: o.externalId,
      pools: config.server.pools,
    });
  }

  async function challengeResponse(
    realm: string,
    terms: GloamChargeRequest,
    o: GloamChargeOptions,
    code: ProblemCode,
    detail: string,
    retryAfter?: number
  ): Promise<Response> {
    const now = config.server.now?.() ?? Date.now();
    const ch = await createPaymentChallenge({
      secretKey: config.secretKey,
      realm,
      method: GLOAM_METHOD,
      intent: GLOAM_CHARGE_INTENT,
      request: terms as unknown as Record<string, unknown>,
      expires: new Date(now + (config.expiresIn ?? 600) * 1000),
      ...(o.description !== undefined ? { description: o.description } : {}),
      paymentAuthorizationHeader: config.paymentAuthorizationHeader,
    });
    const headers = new Headers({
      "WWW-Authenticate": formatPaymentChallenge(ch),
      "Cache-Control": "no-store",
      "Content-Type": "application/problem+json",
    });
    if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));
    // Every refusal is a 402 with a fresh challenge, so a client can always pay again (fail closed).
    return new Response(JSON.stringify(problem(code, detail, { challengeId: ch.id, status: 402 })), { status: 402, headers });
  }

  function charge(o: GloamChargeOptions) {
    const terms = termsFor(o);
    return async (input: Request): Promise<GloamPaywallResult> => {
      const realm = config.realm ?? new URL(input.url).host;
      const field = config.paymentAuthorizationHeader ? PAYMENT_AUTHORIZATION_HEADER : "Authorization";
      const raw = extractPaymentCredential(input.headers.get(field));
      const deny = async (code: ProblemCode, detail: string, retryAfter?: number) => ({
        status: 402 as const,
        challenge: await challengeResponse(realm, terms, o, code, detail, retryAfter),
      });
      if (!raw) return deny("payment-required", "Payment is required for this resource.");

      let credential;
      try {
        credential = parseCredential(raw);
      } catch (e) {
        return deny("malformed-credential", e instanceof MalformedCredentialError ? e.message : "The credential does not parse.");
      }
      const ch = credential.challenge;
      if (!isGloamChargeChallenge(ch)) return deny("invalid-challenge", `This route takes ${GLOAM_METHOD}/${GLOAM_CHARGE_INTENT}.`);
      if (!(await verifyChallengeId(ch, config.secretKey))) return deny("invalid-challenge", "The challenge was not issued by this server.");
      if (ch.realm !== realm) return deny("invalid-challenge", "The challenge was issued for a different realm.");
      if ((ch.header !== undefined) !== !!config.paymentAuthorizationHeader) {
        return deny("invalid-challenge", "The credential arrived in a different field than the challenge selected.");
      }
      if (isExpired(ch, config.server.now?.() ?? Date.now())) return deny("payment-expired", "The challenge has expired.");
      try {
        const mismatch = termsMismatch(terms, parseGloamChargeRequest(ch.request));
        if (mismatch) return deny("invalid-challenge", `The credential was issued for a different ${mismatch}.`);
        const validated = await validateGloamCharge({ challenge: ch, payload: credential.payload, config: config.server });
        const receipt = await settleGloamCharge({ challenge: ch, payload: credential.payload, config: config.server, validated });
        return {
          status: 200,
          receipt,
          withReceipt(response: Response) {
            const headers = new Headers(response.headers);
            headers.set(PAYMENT_RECEIPT_HEADER, serializeReceipt(receipt));
            headers.set("Cache-Control", "private");
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
          },
        };
      } catch (e) {
        if (e instanceof GloamChargeError) return deny(e.code, e.message, e.retryable ? 5 : undefined);
        return deny("internal-payment-error", "The payment could not be processed.");
      }
    };
  }

  return { charge, terms: termsFor };
}
