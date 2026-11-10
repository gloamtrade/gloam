/**
 * @gloamtrade/mppx-gloam: private payments for the Machine Payments Protocol.
 *
 * The "gloam" payment method settles an MPP charge as a shielded transfer
 * through a Gloam pool (Tempo, Robinhood Chain, Base, Ethereum or Elysium,
 * whichever networks the installed SDK has). The payment note is
 * sealed to the payee's receive tag and swept into a fresh note before the
 * server serves, so the public sees a shielded transfer and nothing else, and
 * the payer cannot take the payment back.
 *
 *   mppx server:  import { gloam } from "@gloamtrade/mppx-gloam/server"
 *   mppx client:  import { gloam } from "@gloamtrade/mppx-gloam/client"
 *   no library:   import { createGloamPaywall, createGloamChargeCredential } from "@gloamtrade/mppx-gloam/core"
 *
 * Spec: docs/mpp/draft-gloam-charge-00.md in the Gloam repository.
 */

export * from "./core.js";
export { charge as gloamChargeMethod } from "./mppx/method.js";
export { gloam as gloamServer, toMppxError } from "./mppx/server.js";
export { gloam as gloamClient } from "./mppx/client.js";
