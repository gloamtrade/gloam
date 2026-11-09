/**
 * VEYA's budget check before a payment (optional, off by default).
 *
 * A Gloam note is spent with a proof, so wallet rules can't stop a payment: a
 * budget only holds before the payment, on the server that keeps the notes. With
 * GLOAM_VEYA_KEY set, every 402 this server is about to pay goes to VEYA first,
 * and the payment goes ahead only on an exact allow.
 *
 * What is sent: the operator's opaque agent id, the chain, the asset, the amount
 * and the payee, with the key as a bearer token. resource_host is always null, as
 * agreed with VEYA on 31 Oct 2026, and no payment request text goes out. Nothing
 * else: never a note, a secret, a balance, a wallet, a signing key, the resource or
 * the 402 the payee sent.
 *
 * It fails closed. A refuse, an answer this code does not know, an HTTP error, a
 * body that is not JSON, no answer within the timeout, or a setting that is
 * missing or unusable all mean: do not pay. A request VEYA can't use as sent
 * (bad_request, or HTTP 400 or 422) is a refusal too, never a reason to send
 * more. VEYA's reason is untrusted text, so only a stripped, capped copy of it
 * goes any further.
 *
 * An allow carries a check id. With GLOAM_VEYA_ANCHOR_URL set, the payment's
 * receipt is bound to that id afterwards (veyaReceipt.ts), so an allow without a
 * usable id does not pay: a payment can't be undone, and without the id it could
 * never get its receipt. With receipts off the id is optional.
 *
 * VEYA is never told how a payment it allowed ended, so if one fails afterwards
 * its running budget can sit ahead of what was really paid.
 *
 * The answers are as VEYA documented them on 1 Nov 2026 (backend 1.2.12) and as
 * its live endpoints gave them that day. The request is the trimmed one above. The
 * format is the block below and nowhere else, so a change stays there.
 */
import { cleanReceiptLabel } from "@gloamtrade/sdk";
import type { Hex } from "viem";
import { guardBody, guardTimeoutMs, keyMayGoTo, plainText, postToGuard, type GuardEndpoint } from "./guardCall.js";

type Env = Record<string, string | undefined>;

export const VEYA_TIMEOUT_MS = 5_000;
/** An anchor writes to chain before it answers, which has taken 5.6 to 10 seconds, so it can't share the check's limit. */
export const VEYA_ANCHOR_TIMEOUT_MS = 20_000;

export interface VeyaConfig extends GuardEndpoint {
  agentId: string;
  /** Where receipt leaves go; null with receipts off. */
  anchorUrl: string | null;
  anchorTimeoutMs: number;
}

/** The payment being checked: these four fields and the agent id are all VEYA gets. */
export interface VeyaPayment {
  chainId: number;
  asset: string;
  amountWei: bigint;
  /** The requirement's payTo. */
  payee: string;
}

export type VeyaOutcome =
  | {
      pay: true;
      decision: "allow";
      /** VEYA's check id, when it sent a usable one. */
      checkId: string | null;
      /** What this payment's receipt is bound to. Null with receipts off. */
      receipt: { checkId: string; agentId: string } | null;
    }
  | {
      pay: false;
      /** "refuse" only when VEYA said so; "unchecked" for everything that is not an answer. */
      decision: "refuse" | "unchecked";
      /** VEYA's reason, stripped and capped. */
      reason: string | null;
      /** One line for the agent: plain, says not to pay. */
      message: string;
    };

/** A wallet address anywhere in the value, with or without 0x. A private key is longer and matches too. */
const WALLET_SHAPED = /(?:0x)?[0-9a-f]{40}/i;

// ── VEYA's format ─────────────────────────────────────────────────────────────

/**
 * POST <GLOAM_VEYA_URL>. `amount` is base units as a decimal string, whatever form the price wrote it in.
 * `chain_id` is how VEYA tells its chain (it refuses another with wrong_chain). `resource_host` is always
 * null, as agreed with VEYA on 31 Oct 2026, and there is no `content`.
 */
function veyaRequest(agentId: string, p: VeyaPayment) {
  return {
    agent_id: agentId,
    chain_id: p.chainId,
    asset: p.asset,
    amount: p.amountWei.toString(),
    payee: p.payee,
    resource_host: null,
  };
}

/** What VEYA says when it can't use the request as sent: a refuse with this reason, or one of these statuses. */
const MALFORMED_REASON = "bad_request";
const MALFORMED_STATUS = new Set([400, 422]);
const malformed = (how: string) =>
  `VEYA did not accept the check as sent (${how}). This server sends it only the agent id, chain, asset, amount and payee, with resource_host null and no payment request text, and will not send more to get an answer. If VEYA now needs more, its format changed and this server has to be updated.`;

/** The only HTTP status that can carry an answer. */
const ANSWER_STATUS = 200;

/**
 * An allow's "attestation": VEYA's check id, sealed as written into a receipt's
 * verifier. So it is checked and never cleaned: an id that would change is no id.
 */
function readCheckId(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(raw) || WALLET_SHAPED.test(raw)) return null;
  try {
    return cleanReceiptLabel(raw) === raw ? raw : null;
  } catch {
    return null; // over the label limit
  }
}

/** {"decision": "allow" | "refuse", "reason"?: string, "attestation"?: string}. Only an exact allow pays; null is not an answer. */
function readAnswer(body: Record<string, unknown> | null): { allow: true; checkId: string | null } | { allow: false; reason: string | null } | null {
  if (!body) return null;
  if (body.decision === "allow") return { allow: true, checkId: readCheckId(body.attestation) };
  if (body.decision === "refuse") return { allow: false, reason: plainText(body.reason) || null };
  return null;
}

/** POST <GLOAM_VEYA_ANCHOR_URL>. Only these two: never the record, proof, amount, payee, note or transaction hash. */
function anchorRequest(leaf: string, agentId: string) {
  return { leaf, agent_id: agentId };
}

/** The same leaf can simply go again, and VEYA writes it once. */
const ANCHOR_RETRY: Record<number, string> = {
  409: "it is still writing this leaf",
  502: "its chain write was not available",
  503: "its chain write was not available",
};

/** Sending it again gets the same answer until the operator changes something. */
const ANCHOR_BLOCKED: Record<number, string> = {
  400: "it could not read the request (bad_request)",
  401: "it did not accept the key (unauthorized), so check GLOAM_VEYA_KEY",
  403: "this agent is at its limit (agent_limit)",
  404: "it does not know this agent id (unknown_agent)",
};

/**
 * {"status": "anchored", "leaf", "tx_hash", "duplicate", "explorer_url"}. A leaf sent
 * twice answers the first write's tx_hash with duplicate true. Null unless it names
 * this leaf and a transaction. explorer_url is VEYA's text, so it goes no further.
 */
function readAnchor(body: Record<string, unknown> | null, leaf: string): { txHash: Hex; duplicate: boolean } | null {
  if (body?.status !== "anchored" || typeof body.leaf !== "string" || body.leaf.toLowerCase() !== leaf.toLowerCase()) return null;
  if (typeof body.tx_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.tx_hash)) return null;
  return { txHash: body.tx_hash as Hex, duplicate: body.duplicate === true };
}

// ── the check ─────────────────────────────────────────────────────────────────

/**
 * Off (null) unless GLOAM_VEYA_KEY is set. A key with an unusable GLOAM_VEYA_URL,
 * GLOAM_VEYA_AGENT_ID or GLOAM_VEYA_ANCHOR_URL (or an anchor URL on another origin
 * than the check's) is an error, so a typo can't quietly turn the check or the
 * receipts off, or send the key somewhere else. The errors name the setting and never repeat
 * its value.
 */
export function veyaConfig(env: Env): VeyaConfig | { error: string } | null {
  const key = env.GLOAM_VEYA_KEY?.trim();
  if (!key) return null;
  const raw = env.GLOAM_VEYA_URL?.trim();
  if (!raw) return { error: "GLOAM_VEYA_URL is not set." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "GLOAM_VEYA_URL is not a URL." };
  }
  if (!keyMayGoTo(url)) return { error: `GLOAM_VEYA_URL must be https (or http on localhost), not ${url.protocol}//${url.host}.` };
  const agentId = env.GLOAM_VEYA_AGENT_ID?.trim();
  if (!agentId) return { error: "GLOAM_VEYA_AGENT_ID is not set." };
  if (WALLET_SHAPED.test(agentId)) return { error: "GLOAM_VEYA_AGENT_ID looks like a wallet address. Set an opaque id, so a wallet never goes out as the id." };
  const rawAnchor = env.GLOAM_VEYA_ANCHOR_URL?.trim();
  let anchorUrl: string | null = null;
  if (rawAnchor) {
    let anchor: URL;
    try {
      anchor = new URL(rawAnchor);
    } catch {
      return { error: "GLOAM_VEYA_ANCHOR_URL is not a URL." };
    }
    if (!keyMayGoTo(anchor)) return { error: `GLOAM_VEYA_ANCHOR_URL must be https (or http on localhost), not ${anchor.protocol}//${anchor.host}.` };
    // The key goes to both, so both must be VEYA's: one origin, never a second host the key would reach.
    if (anchor.origin !== url.origin) return { error: "GLOAM_VEYA_ANCHOR_URL must be on the same origin (scheme, host and port) as GLOAM_VEYA_URL, since the key goes to both." };
    anchorUrl = anchor.toString();
  }
  return {
    key,
    url: url.toString(),
    timeoutMs: guardTimeoutMs(env.GLOAM_VEYA_TIMEOUT_MS, VEYA_TIMEOUT_MS),
    agentId,
    anchorUrl,
    anchorTimeoutMs: guardTimeoutMs(env.GLOAM_VEYA_ANCHOR_TIMEOUT_MS, VEYA_ANCHOR_TIMEOUT_MS),
  };
}

/**
 * Check a payment against the agent's budget before paying it. Returns null when
 * the check is off, else whether to pay. Never throws.
 */
export async function checkVeyaBudget(payment: VeyaPayment, env: Env, fetchImpl: typeof fetch = fetch): Promise<VeyaOutcome | null> {
  const config = veyaConfig(env);
  if (config === null) return null;
  const refuse = (why: string, decision: "refuse" | "unchecked" = "unchecked", reason: string | null = null): VeyaOutcome => ({
    pay: false,
    decision,
    reason,
    message: `${why} Not paying.`,
  });
  if ("error" in config) return refuse(`The VEYA check is on but misconfigured: ${config.error}`);

  const call = await postToGuard(config, veyaRequest(config.agentId, payment), fetchImpl);
  if ("failed" in call) {
    return refuse(call.failed === "timeout" ? `VEYA did not answer within ${config.timeoutMs / 1000}s.` : "VEYA could not be reached.");
  }
  if (MALFORMED_STATUS.has(call.res.status)) return refuse(malformed(`HTTP ${call.res.status}`));
  if (call.res.status !== ANSWER_STATUS) return refuse(`VEYA answered HTTP ${call.res.status}, so the budget was not checked.`);

  const answer = readAnswer(await guardBody(call.res));
  if (!answer) return refuse("VEYA's answer was not an allow or a refuse, so the budget was not checked.");
  if (!answer.allow) {
    if (answer.reason === MALFORMED_REASON) return refuse(malformed(MALFORMED_REASON), "refuse", answer.reason);
    return refuse(answer.reason ? `VEYA refused this payment (${answer.reason}).` : "VEYA refused this payment.", "refuse", answer.reason);
  }
  // A payment can't be undone, and without the id it could never get its receipt.
  if (config.anchorUrl && !answer.checkId) {
    return refuse("VEYA allowed this payment without a usable check id, and receipts are on, so it could never get its receipt.");
  }
  return {
    pay: true,
    decision: "allow",
    checkId: answer.checkId,
    receipt: config.anchorUrl && answer.checkId ? { checkId: answer.checkId, agentId: config.agentId } : null,
  };
}

export type AnchorResult =
  | { anchored: true; txHash: Hex; duplicate: boolean }
  /** `retry`: the same leaf may go through as it is. Otherwise something has to change first. */
  | { anchored: false; why: string; retry: boolean };

/** Tries for one leaf while VEYA answers 409, 502 or 503. */
const ANCHOR_TRIES = 3;

/**
 * Send VEYA a receipt's leaf. Taken only on a 200 that names this leaf and a
 * transaction. 409, 502 and 503 are tried again here, a quarter of the timeout
 * apart, which leaves a write in progress time to finish. Never throws.
 */
export async function anchorLeaf(leaf: string, agentId: string, env: Env, fetchImpl: typeof fetch = fetch): Promise<AnchorResult> {
  const config = veyaConfig(env);
  if (config === null || "error" in config || !config.anchorUrl) return { anchored: false, why: "receipts are not set up on this server", retry: false };
  const to = { ...config, url: config.anchorUrl, timeoutMs: config.anchorTimeoutMs };
  for (let tries = 1; ; tries++) {
    const call = await postToGuard(to, anchorRequest(leaf, agentId), fetchImpl);
    if ("failed" in call) return { anchored: false, why: call.failed === "timeout" ? `it did not answer within ${to.timeoutMs / 1000}s` : "it could not be reached", retry: true };
    const { status } = call.res;
    if (status === ANSWER_STATUS) {
      const took = readAnchor(await guardBody(call.res), leaf);
      return took ? { anchored: true, ...took } : { anchored: false, why: "its answer did not show this leaf written", retry: true };
    }
    const blocked = ANCHOR_BLOCKED[status];
    if (blocked) return { anchored: false, why: `${blocked}, HTTP ${status}`, retry: false };
    const busy = ANCHOR_RETRY[status];
    if (!busy || tries === ANCHOR_TRIES) return { anchored: false, why: busy ? `${busy}, HTTP ${status}` : `it answered HTTP ${status}`, retry: true };
    await new Promise((r) => setTimeout(r, to.timeoutMs / 4));
  }
}
