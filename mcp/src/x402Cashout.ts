/**
 * x402 scheme gloam-cashout, for gloam_fetch_paid: a private payer and a public payee.
 *
 * A gateway that pays out to a public address (a creator's splitter) lists
 * { scheme: "gloam-cashout", network: "eip155:4663", asset: USDG, payTo, amount: G,
 * quoteId } in its 402. This server pays it with a cash out of exactly G from its
 * private notes to payTo, sent through the Gloam relay, and presents
 * X-PAYMENT = base64 JSON { scheme, txHash, quoteId }. The chain shows USDG leaving
 * the vault to payTo; not this server's wallet, and not which note paid.
 *
 * The rules are the swaps' (src/swaps.ts): a larger note is split first with a private
 * send to this server's own notes (sendToSelf), every note is kept before anything is
 * sent, and it goes out through the relay, never from the wallet. The note set aside
 * for a quote carries a key made from the quote (cashOutKey), so the same quote asked
 * again finds its payment and is never cashed out twice.
 */
import { createHash } from "node:crypto";
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";
import {
  GLOAM_CASHOUT_ASSET,
  GLOAM_CASHOUT_CHAIN_ID,
  GLOAM_CASHOUT_DECIMALS,
  GLOAM_CASHOUT_SCHEME,
  GLOAM_CASHOUT_VAULT,
  GloamRelayError,
  RELAY_MAYBE_SENT,
  buildGloamCashoutIntent,
  cashOutFee,
  encodeGloamCashoutHeader,
  fieldToHex,
  gloamCashoutProblem,
  hexToField,
  noteCommitmentPoseidon,
  readCashOutFeeBps,
  receiptPaysEscrow,
  type GloamCashoutRequirement,
} from "@gloamtrade/sdk";
import { authorizeSpend, settleSpend } from "./spendGuard.js";
import { isHeld, noteView, type NoteStore, type StoredNote } from "./noteStore.js";
import { networkByChainId } from "./networks.js";
import { sendToSelf, swapRelayUrl, type SwapToolContext } from "./swaps.js";

export type CashoutPaid = { ok: true; header: string; result: Record<string, unknown> } | { ok: false; result: Record<string, unknown> };

const POOL_READS = [
  { type: "function", name: "isSpent", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const usdg = (wei: bigint) => `${formatUnits(wei, GLOAM_CASHOUT_DECIMALS)} USDG`;

export const CASHOUT_PRIVACY =
  "The cash out is public: the chain shows the USDG leaving the Gloam vault to the payee's address, the amount, and the transaction. The Gloam relay sent it, so this server's wallet is not next to it, and nothing on chain ties it to this server's deposits or other payments.";

/** What makes two calls the same purchase: the quote's id, its payee and its amount. */
export function cashOutKeyOf(req: GloamCashoutRequirement): string {
  return createHash("sha256").update(`${GLOAM_CASHOUT_SCHEME}|${req.quoteId}|${String(req.payTo).toLowerCase()}|${req.amount}`).digest("hex").slice(0, 32);
}

/** The X-PAYMENT value for a quote paid by `hash`. */
export const cashoutHeaderFor = (req: GloamCashoutRequirement, hash: Hex) => encodeGloamCashoutHeader({ txHash: hash, quoteId: req.quoteId });

/** One payment per quote at a time in this process. */
const running = new Set<string>();

/**
 * Pay a gloam-cashout quote from this server's notes. `maxAmount` is in USDG units and required.
 * The result never carries a secret; the header carries the tx hash and the gateway's quote id.
 */
export async function payGloamCashoutQuote(
  ctx: SwapToolContext,
  req: GloamCashoutRequirement,
  opts: { maxAmount: number | undefined; note?: string; requested: string }
): Promise<CashoutPaid> {
  const fail = (result: Record<string, unknown>): CashoutPaid => ({ ok: false, result });
  const { env, tryStore, errMsg } = ctx;
  const net = networkByChainId(GLOAM_CASHOUT_CHAIN_ID);
  if (!net || !same(net.pool, GLOAM_CASHOUT_VAULT)) {
    return fail({ status: "refused", code: "unknown_network", message: "This build has no Gloam vault on Robinhood Chain mainnet, so it cannot pay a gloam-cashout price." });
  }
  if (opts.maxAmount === undefined) {
    return fail({
      status: "refused",
      code: "no_max_amount",
      message: `This resource asks for a ${GLOAM_CASHOUT_SCHEME} payment${/^[0-9]{1,40}$/.test(req.amount) ? ` of ${usdg(BigInt(req.amount))}` : ""}. Pass maxAmount (in USDG), the most to cash out for it. Nothing was paid.`,
    });
  }
  let max: bigint;
  try {
    max = parseUnits(String(opts.maxAmount), GLOAM_CASHOUT_DECIMALS);
  } catch {
    return fail({ status: "refused", code: "bad_max_amount", message: "maxAmount is not an amount of USDG. Nothing was paid." });
  }
  const problem = gloamCashoutProblem(req, { maxAmount: max });
  if (problem) return fail({ status: "refused", code: problem.code, message: problem.message });
  const gross = BigInt(req.amount);
  const payTo = getAddress(req.payTo);
  const key = cashOutKeyOf(req);
  if (running.has(key)) {
    return fail({ status: "payment_in_progress", message: "This quote is being paid right now by another call. Wait for it; nothing was paid by this call." });
  }
  running.add(key);
  try {
    return await payOnce();
  } finally {
    running.delete(key);
  }

  async function payOnce(): Promise<CashoutPaid> {
    const opened = ctx.openStore();
    if (!opened.ok) return fail({ status: "error", error: opened.error });
    const store = opened.store;
    const client = ctx.client(net!);
    const url = swapRelayUrl(env);

    // The same quote asked again: its payment, or the note already set aside for it.
    const mine = store.list().filter((n) => n.cashOutKey === key);
    const paid = mine.find((n) => n.status === "spent" && n.spentTx);
    if (paid) {
      return {
        ok: true,
        header: cashoutHeaderFor(req, paid.spentTx!),
        result: { status: "paid", reused: true, hash: paid.spentTx, explorer: `${net!.explorer}/tx/${paid.spentTx}`, message: "This quote was already paid, so that cash out is presented and nothing new was paid." },
      };
    }
    const busy = mine.find((n) => n.status === "pending");
    if (busy) {
      return fail({
        status: "payment_in_progress",
        message: "A cash out for this quote went out and has not confirmed, or its answer was lost. Nothing was paid by this call. Call gloam_list_notes with refresh, then ask again: once it lands it is presented, never paid twice.",
        ...(busy.spentTx ? { hash: busy.spentTx } : {}),
      });
    }

    const gate = authorizeSpend({ tool: "pay", network: net!.key, chainId: net!.chainId, asset: GLOAM_CASHOUT_ASSET, amountWei: gross, recipient: payTo }, env);
    if (!gate.ok) return fail(gate.refusal);

    const spentOnChain = async (n: StoredNote) => {
      const spent = await client.readContract({ address: net!.pool, abi: POOL_READS, functionName: "isSpent", args: [n.nullifier] }).catch(() => false);
      if (spent) tryStore(() => void store.update(n.handle, { status: "spent", recheck: false }));
      return spent;
    };
    const fits = (n: StoredNote, need: bigint) =>
      n.chainId === net!.chainId && same(n.pool, net!.pool) && same(n.asset, GLOAM_CASHOUT_ASSET) && BigInt(n.amountWei) >= need && n.origin !== "payment";

    // A note of exactly G: one kept for this quote, else the smallest that covers it (split first when larger).
    let exact: StoredNote | undefined = mine.find((n) => n.status === "unspent" && !isHeld(n) && BigInt(n.amountWei) === gross);
    let splitHash: Hex | null = null;
    if (!exact) {
      let chosen: StoredNote | undefined;
      if (opts.note) {
        chosen = store.get(opts.note);
        const why = !chosen
          ? `There is no note "${opts.note}". Call gloam_list_notes.`
          : chosen.status !== "unspent" || isHeld(chosen)
            ? `Note ${chosen.handle} is not spendable now.`
            : !fits(chosen, gross)
              ? `Note ${chosen.handle} does not hold ${usdg(gross)} of USDG on Robinhood Chain.`
              : (await spentOnChain(chosen))
                ? `Note ${chosen.handle} is already spent on chain. It is marked spent; call gloam_list_notes with refresh.`
                : null;
        if (why) {
          settleSpend(gate, "failed", { reason: why });
          return fail({ status: "error", error: why });
        }
      } else {
        const candidates = store
          .list()
          .filter((n) => n.status === "unspent" && !isHeld(n) && fits(n, gross))
          .sort((a, b) => (BigInt(a.amountWei) === gross ? -1 : BigInt(b.amountWei) === gross ? 1 : BigInt(a.amountWei) < BigInt(b.amountWei) ? -1 : 1));
        for (const c of candidates) {
          if (!(await spentOnChain(c))) {
            chosen = c;
            break;
          }
        }
      }
      if (!chosen) {
        settleSpend(gate, "failed", { reason: "no note covers the quote" });
        return fail({ status: "error", error: `No single private USDG note on Robinhood Chain holds ${usdg(gross)}. A cash out spends one note; notes are not combined. Shield more first.` });
      }
      if (BigInt(chosen.amountWei) > gross) {
        const r = await sendToSelf(ctx, store, net!, chosen, gross, url, {
          what: "Setting the payment's amount aside",
          label: `set aside for a ${GLOAM_CASHOUT_SCHEME} payment of ${usdg(gross)}`,
          exact: { cashOutKey: key },
        });
        if (!r.ok) {
          settleSpend(gate, r.maybeSent ? "unconfirmed" : "failed", { reason: String(r.result.error ?? r.result.message ?? "split failed") });
          return fail(r.result);
        }
        exact = r.note;
        splitHash = r.hash;
      } else {
        exact = store.update(chosen.handle, { cashOutKey: key }) ?? chosen;
      }
    }

    try {
      store.reserveForSpend(exact.handle, (n) => (fits(n, gross) && BigInt(n.amountWei) === gross ? null : `Note ${n.handle} no longer matches this payment.`));
    } catch (e) {
      settleSpend(gate, "failed", { reason: errMsg(e) });
      return fail({ status: "error", error: errMsg(e) });
    }
    const note = exact;
    const back = (recheck: boolean) => tryStore(() => void store.update(note.handle, { status: "unspent", ...(recheck ? { recheck: true } : {}) }));
    const firstStep = splitHash ? { splitHash, split: `A larger note was split first; ${note.handle} held the amount.` } : {};

    let hash: Hex | undefined;
    let sending = false;
    try {
      const commitment = fieldToHex(await noteCommitmentPoseidon(hexToField(note.secret), gross, GLOAM_CASHOUT_ASSET)) as Hex;
      const synced = await ctx.syncTree(client, { pool: net!.pool, fromBlock: net!.deployBlock });
      const path = await synced.pathForCommitment(commitment);
      if (!path) throw new Error(`Note ${note.handle} is not in the vault's tree yet. Wait for it to confirm.`);
      const intent = await buildGloamCashoutIntent({
        requirement: req,
        maxAmount: max,
        note: { secretHex: note.secret, amountWei: gross, path },
        prove: await ctx.unshieldProver(net!),
      });
      sending = true;
      hash = await ctx.relay(intent, { url });
      const sentHash = hash;
      tryStore(() => void store.update(note.handle, { spentTx: sentHash }));
      const receipt = await client.waitForTransactionReceipt({ hash });
      const landed =
        receipt.status === "success" &&
        receiptPaysEscrow(receipt.logs as never, GLOAM_CASHOUT_VAULT, { nullifier: note.nullifier, asset: GLOAM_CASHOUT_ASSET, escrow: payTo, amount: gross });
      if (!landed) {
        const spentElsewhere = await client.readContract({ address: net!.pool, abi: POOL_READS, functionName: "isSpent", args: [note.nullifier] }).catch(() => null);
        if (spentElsewhere === false) {
          back(true);
          settleSpend(gate, "reverted", { hash });
          return fail({ status: "error", error: `The cash out reverted (${hash}). Nothing moved; the note is spendable again.`, ...firstStep });
        }
        settleSpend(gate, "unconfirmed", { hash });
        return fail({ status: "error", error: `The cash out (${hash}) did not show as landed. Call gloam_list_notes with refresh before paying this quote again.`, hash, ...firstStep });
      }
      tryStore(() => void store.update(note.handle, { status: "spent", spentTx: sentHash }));
      const logWarning = settleSpend(gate, "sent", { hash });
      const bps = await readCashOutFeeBps(client, net!.pool).catch(() => null);
      const fee = bps === null ? null : cashOutFee(gross, bps);
      return {
        ok: true,
        header: cashoutHeaderFor(req, hash),
        result: {
          status: "paid",
          scheme: GLOAM_CASHOUT_SCHEME,
          ...(logWarning ? { logWarning } : {}),
          network: net!.key,
          realMoney: true,
          submittedBy: "gloam-relay (agent wallet hidden)",
          hash,
          explorer: `${net!.explorer}/tx/${hash}`,
          paid: { amount: usdg(gross), payTo, resource: req.resource ?? opts.requested },
          ...(fee !== null ? { fee: { bps, amount: usdg(fee), note: "Kept by the vault." }, payeeReceives: usdg(gross - fee) } : {}),
          spentNote: note.handle,
          ...firstStep,
          privacy: CASHOUT_PRIVACY,
        },
      };
    } catch (e) {
      // Turned away by the relay: it never went out, but the relay saw the proof, which stays valid until the note is spent.
      const turnedAway = e instanceof GloamRelayError && !RELAY_MAYBE_SENT.has(e.code);
      const maybeSent = Boolean(hash) || (sending && !turnedAway);
      if (maybeSent) {
        settleSpend(gate, "unconfirmed", { hash, reason: errMsg(e) });
        return fail({
          status: "error",
          error: `The cash out may have gone out: ${errMsg(e)}`,
          ...(hash ? { hash } : {}),
          check: "Call gloam_list_notes with refresh, then call gloam_fetch_paid again with the same arguments: a cash out that landed is presented, never paid twice.",
          ...firstStep,
        });
      }
      back(sending);
      settleSpend(gate, "failed", { reason: errMsg(e) });
      return fail({ status: "error", error: errMsg(e), ...firstStep, ...(splitHash ? { note: noteView(store.get(note.handle) ?? note) } : {}) });
    }
  }
}
