/**
 * Reading a wallet error for one question: could the transaction have gone
 * out? Secrets kept ahead of a send (a note, a claim code) may only be dropped
 * when it surely did not. A timeout or a lost reply, from WalletConnect say,
 * can come after the wallet already sent it, so anything else keeps them.
 */

type ErrorLike = { name?: string; code?: number; message?: string; shortMessage?: string; cause?: unknown };

/**
 * The error and its causes, outermost first. It stops at a Gloam wallet's maybe-sent
 * error (lib/embeddedErrors): that is the verdict, and nothing it wraps (a 5xx whose
 * text happens to say "request rejected", say) may turn it into "declined" or "never
 * sent".
 */
function chain(e: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let x = e as ErrorLike | undefined;
  for (let i = 0; x && typeof x === "object" && i < 8; i++, x = x.cause as ErrorLike | undefined) {
    out.push(x);
    if (x.name === "EmbeddedMaybeSentError") break;
  }
  return out;
}

/**
 * A Gloam wallet's maybe-sent verdict is in the chain: Turnkey took the send, or may
 * have, so it was neither declined nor stopped before it went out. Its message (and a
 * wrapper's) can carry the text of the error under it, so no text test may override it.
 */
function maybeSent(links: ErrorLike[]): boolean {
  return links.some((x) => x.name === "EmbeddedMaybeSentError");
}

/** The person turned the wallet prompt down. */
export function walletDeclined(e: unknown): boolean {
  const links = chain(e);
  if (maybeSent(links)) return false;
  return links.some(
    (x) =>
      x.name === "UserRejectedRequestError" ||
      x.code === 4001 ||
      (typeof x.message === "string" && /user (rejected|denied)|rejected the request|request rejected/i.test(x.message))
  );
}

/** Failed before anything reached the network: the wrong chain, a call that would revert, no gas. */
const BEFORE_SEND = new Set([
  "ChainMismatchError",
  "ConnectorChainMismatchError",
  "ConnectorNotConnectedError",
  "SwitchChainError",
  "ContractFunctionRevertedError",
  "EstimateGasExecutionError",
  "InsufficientFundsError",
  // a Gloam wallet with no way to pay the fee, or a sponsored send Turnkey refused before any
  // work (lib/embeddedErrors). EmbeddedMaybeSentError is left out on purpose: it may have gone out.
  "EmbeddedNotSentError",
]);

export function failedBeforeSend(e: unknown): boolean {
  const links = chain(e);
  if (maybeSent(links)) return false;
  // viem names any -32603 internal error from the wallet a ContractFunctionRevertedError,
  // and a wallet can answer that after it already sent the transaction: not sure then
  const internal = links.some((x) => x.code === -32603 || x.name === "InternalRpcError");
  return links.some(
    (x) => typeof x.name === "string" && BEFORE_SEND.has(x.name) && !(internal && x.name === "ContractFunctionRevertedError")
  );
}

/** The transaction surely never went out, so what was kept ahead of it can go. */
export function surelyNotSent(e: unknown): boolean {
  return walletDeclined(e) || failedBeforeSend(e);
}

/**
 * A Solana wallet asked to sign and send. These errors carry no code to lean on,
 * so this goes by the words, and only ones that can't come after a send. A
 * channel or connection that closed says nothing about the transaction: an
 * extension's worker can stop after it sent, so that keeps what was kept.
 */
const SOLANA_DECLINED = /reject|denied|declin|cancel|(?:plugin|popup|window|wallet|extension)(?: was| is)? closed/i;
const SOLANA_NOT_SENT = /simulat|blockhash|insufficient|not enough/i;

export function solanaDeclined(message: string): boolean {
  return SOLANA_DECLINED.test(message);
}

export function solanaSurelyNotSent(message: string): boolean {
  return solanaDeclined(message) || SOLANA_NOT_SENT.test(message);
}

/** The short, human part of a wallet or viem error (viem's long message lists the chain and call). */
export function walletErrorText(e: unknown): string {
  const links = chain(e);
  // A Gloam wallet's own words say what to do: they win over whatever wrapped them.
  const first = links.find((x) => x.name === "EmbeddedNotSentError" || x.name === "EmbeddedMaybeSentError") ?? links[0];
  const text = first?.shortMessage || first?.message || "";
  return text.split("\n")[0] ?? "";
}

/**
 * What a person reads when a wallet send fails: a decline in plain words, else the
 * short first line of the error. Never viem's long message, which lists the account,
 * the contract and the calldata.
 */
export const WALLET_DECLINED_TEXT = "You declined it in your wallet, so it wasn't sent.";

export function walletErrorForPeople(e: unknown, fallback = "It didn't go through. Try again."): string {
  if (walletDeclined(e)) return WALLET_DECLINED_TEXT;
  const text = walletErrorText(e).trim();
  if (!text) return fallback;
  return text.length > 280 ? `${text.slice(0, 277).trimEnd()}…` : text;
}
