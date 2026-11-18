/**
 * Client side of the gloam method for mppx.
 *
 *   import { Mppx } from "mppx/client"
 *   import { gloam } from "@gloamtrade/mppx-gloam/client"
 *
 *   const mppx = Mppx.create({
 *     polyfill: false,
 *     // maxAmountWei is in the asset's base units: 50_000n is 0.05 of a 6-decimal stablecoin,
 *     // but USDT and USDC on BNB Chain have 18, so size it with parseUnits("0.05", decimals).
 *     methods: [gloam({ getNote, prove, submit, beforeSubmit, policy: { maxAmountWei: parseUnits("0.05", 6) } })],
 *   })
 *   const res = await mppx.fetch("https://api.example.com/answer")
 *
 * On a 402 that offers gloam/charge, mppx calls createCredential: the payer
 * checks the terms, proves a private send of exactly the amount from one of its
 * notes, seals the payment note to the payee, and retries with the credential.
 */

import type { Address } from "viem";
import { Credential, Method } from "mppx";
import { payGloamCharge, type PayGloamChargeParams, type GloamSpendableNote } from "../client.js";
import { charge } from "./method.js";

export declare namespace gloam {
  type Parameters = Omit<PayGloamChargeParams, "challenge" | "note" | "beforeSubmit"> & {
    /** Find a note in the pool that covers the charge, with its membership path (syncTree). */
    getNote: (want: { chainId: number; pool: Address; currency: Address; amountWei: bigint }) => Promise<GloamSpendableNote>;
    /** Persist built.changeNote here: it is the payer's remaining balance, and it comes out nowhere else. */
    beforeSubmit: NonNullable<PayGloamChargeParams["beforeSubmit"]>;
  };
}

/** The configured client method (what `Mppx.create` takes). */
export type GloamClientMethod = Method.Client<typeof charge, undefined>;

/** A gloam charge client method for `Mppx.create({ methods: [...] })`. */
export function gloam(parameters: gloam.Parameters): GloamClientMethod {
  const { getNote, ...pay } = parameters;
  if (typeof pay.beforeSubmit !== "function") {
    throw new Error("Pass beforeSubmit to keep each change note: it is the rest of the balance, and it comes out nowhere else.");
  }
  return Method.toClient(charge, {
    async createCredential({ challenge }) {
      const request = challenge.request as unknown as {
        amount: string;
        currency: Address;
        methodDetails: { chainId: number; pool: Address };
      };
      const note = await getNote({
        chainId: request.methodDetails.chainId,
        pool: request.methodDetails.pool,
        currency: request.currency,
        amountWei: BigInt(request.amount),
      });
      const paid = await payGloamCharge({ ...pay, challenge, note });
      return Credential.serialize(Credential.from({ challenge, payload: paid.payload }));
    },
  });
}

/** Same factory, mppx style: `gloam.charge({...})`. */
gloam.charge = gloam;
