/**
 * Server side of the gloam method for mppx.
 *
 *   import { Mppx } from "mppx/server"
 *   import { gloam } from "@gloamtrade/mppx-gloam/server"
 *
 *   const mppx = Mppx.create({
 *     secretKey: process.env.MPP_SECRET_KEY!,
 *     methods: [gloam({ receiveKey, chain, prove, submit, beforeSubmit, network: "tempo" })],
 *   })
 *   const r = await mppx.charge({ amount: "0.01" })(request)
 *   if (r.status === 402) return r.challenge
 *   return r.withReceipt(Response.json(data))
 *
 * mppx checks the challenge HMAC, expiry and route binding; `validate` checks
 * the gloam payment read-only and `broadcast` sweeps it and returns the receipt.
 */

import type { Address } from "viem";
import { Errors, Method, Receipt } from "mppx";
import {
  chargeDecimals,
  chargeTerms,
  noDefaultCurrencyMessage,
  noPoolMessage,
  officialPool,
  resolveNetwork,
  GloamChargeError,
  GLOAM_CHARGE_INTENT,
  GLOAM_METHOD,
  GLOAM_MODES,
  type GloamChargeNetwork,
  type GloamChargeRequest,
} from "../charge.js";
import { assertKeepsFreshNotes, settleGloamCharge, validateGloamCharge, type GloamChargeServerConfig, type ValidatedGloamCharge } from "../server.js";
import { charge } from "./method.js";

/** Translate a gloam failure into the mppx error that answers with the right Problem Details. */
export function toMppxError(e: unknown, challengeId?: string): Error {
  if (e instanceof Errors.PaymentError) return e;
  if (e instanceof GloamChargeError) {
    // mppx ends the problem detail with its own period.
    const reason = e.message.replace(/\.$/, "");
    switch (e.code) {
      case "payment-expired":
        return new Errors.PaymentExpiredError({});
      case "invalid-payload":
        return new Errors.InvalidPayloadError({ reason });
      case "invalid-challenge":
        return new Errors.InvalidChallengeError({ id: challengeId, reason });
      default:
        return new Errors.VerificationFailedError({ reason, details: { retryable: e.retryable } });
    }
  }
  // Anything else came from the RPC, the store or the submitter. That text is for the operator, so the
  // client gets the same words as on the plain paywall.
  return new Errors.VerificationFailedError({ reason: "The payment could not be processed" });
}

export declare namespace gloam {
  type Parameters = GloamChargeServerConfig &
    Method.ComposableHooks<typeof charge> & {
      /** "tempo" (default), "robinhood", a "-mainnet" key, "base" / "base-mainnet" once their pools are in, "bnb-mainnet" once BNB Chain's is, or a chain id. */
      network?: GloamChargeNetwork | number;
      /** Token address; default the network's first asset (USDT on BNB Chain, PathUSD on Tempo testnet, native ETH on Robinhood Chain testnet). Required for a chain id the SDK has no network for. */
      currency?: Address;
      /**
       * Decimals of `currency`, to read route amounts. Leave it out: a listed
       * asset always counts in its own (PathUSD 6, ETH 18, USDT and USDC on BNB
       * Chain 18), and a value that disagrees throws. Only for a token Gloam does not list.
       */
      decimals?: number;
    };
}

/** Request fields the method fills in, so a route only passes `{ amount }`. */
export type GloamServerDefaults = {
  chainId: number;
  pool: Address;
  currency: Address;
  decimals: number;
  recipient: string;
  supportedModes?: ("push" | "pull")[];
};

/** The configured server method (what `Mppx.create` takes). */
export type GloamServerMethod = Method.Server<typeof charge, GloamServerDefaults, undefined, {}, undefined>;

/** A gloam charge method for `Mppx.create({ methods: [...] })`. Routes pass `{ amount: "0.01" }`. */
export function gloam(parameters: gloam.Parameters): GloamServerMethod {
  const { network, currency, decimals, canOffer, onPaymentSuccess, ...config } = parameters;
  assertKeepsFreshNotes(config);
  const net = resolveNetwork(network);
  const pool = officialPool(net.chainId, config.pools);
  if (!pool) throw new Error(noPoolMessage(net.chainId));
  const modes = config.modes ?? GLOAM_MODES;
  const asset = currency ?? net.currency;
  if (asset === undefined) throw new Error(noDefaultCurrencyMessage(net.chainId));
  const assetDec = chargeDecimals(asset, net.chainId, decimals);
  if (assetDec === undefined) throw new Error(`Pass decimals for currency ${asset}.`);
  // validate and broadcast receive the same credential object; carry the opened payment between them.
  const validated = new WeakMap<object, ValidatedGloamCharge>();

  return Method.toServer(charge, {
    canOffer,
    onPaymentSuccess,
    defaults: {
      chainId: net.chainId,
      pool,
      currency: asset,
      decimals: assetDec,
      recipient: config.receiveKey.tag,
      ...(modes.length < GLOAM_MODES.length ? { supportedModes: [...modes] } : {}),
    } as GloamServerDefaults,
    stableBinding: (request) => chargeTerms(request as unknown as GloamChargeRequest),
    async validate({ credential }) {
      try {
        const v = await validateGloamCharge({ challenge: credential.challenge, payload: credential.payload, config });
        validated.set(credential, v);
        return {
          challenge: credential.challenge,
          credential,
          details: { mode: v.mode, amount: v.request.amount, currency: v.request.currency, chainId: v.request.methodDetails.chainId },
          intent: GLOAM_CHARGE_INTENT,
          method: GLOAM_METHOD,
          request: credential.challenge.request,
        };
      } catch (e) {
        throw toMppxError(e, credential.challenge.id);
      }
    },
    async broadcast({ credential }) {
      try {
        const receipt = await settleGloamCharge({
          challenge: credential.challenge,
          payload: credential.payload,
          config,
          validated: validated.get(credential),
        });
        return Receipt.from(receipt);
      } catch (e) {
        throw toMppxError(e, credential.challenge.id);
      } finally {
        validated.delete(credential);
      }
    },
  });
}

/** Same factory, mppx style: `gloam.charge({...})`. */
gloam.charge = gloam;
