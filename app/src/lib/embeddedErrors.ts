/**
 * How a Gloam wallet's send can end without a transaction hash, in the two
 * kinds the app must tell apart (lib/walletErrors):
 *  - EmbeddedNotSentError: surely never went out (no gas, the wrong chain, or
 *    Turnkey refused the first submit before doing any work). The app may drop
 *    what it saved ahead of the send.
 *  - EmbeddedMaybeSentError: Turnkey took it, or might have, and the outcome is
 *    unknown. The app keeps what it saved: the send may still land.
 */
import { BaseError } from "viem";

export class EmbeddedNotSentError extends BaseError {
  override name = "EmbeddedNotSentError";
  constructor(shortMessage: string) {
    super(shortMessage);
  }
}

export class EmbeddedMaybeSentError extends BaseError {
  override name = "EmbeddedMaybeSentError";
  constructor(shortMessage: string, cause?: unknown) {
    super(shortMessage, cause instanceof Error ? { cause } : {});
  }
}
