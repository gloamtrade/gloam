/**
 * Money at a private account's own Solana address (brought over from another
 * chain by Relay, lib/solanaRings/bridgeIn, or sent there by anyone), made
 * private by the account itself with Gloam's relay as fee payer.
 *
 * Safe to retry by construction: a deposit moves what is at the address, so a
 * deposit that landed leaves nothing to deposit again, and one that didn't
 * leaves the money where it was. Nothing is stored. The relay pays only the
 * fee (relayPolicy readDeposit), so the account never needs SOL. Sent and
 * waited on as every relayed send is (lib/solanaRings/landing).
 *
 * buildRelayedDeposit and settleShield take everything they touch as
 * arguments, so the self-tests run them against a fake chain;
 * makeArrivalPrivate wires them to a session in the browser.
 */
import { getAddressDecoder, getBase64Decoder, getBase64Encoder, getTransactionEncoder, type Address, type Transaction } from "@solana/kit";
import { arrivalsFrom, readTokenAccount, type Arrival } from "./bridgeIn";
import { ringsAssets, ringsUrls, type RingsAsset, type RingsNetwork } from "./config";
import {
  BLOCKHASH_CHECK_MS,
  LANDING_MAX_MS,
  RELAY_PRIORITY_FEE_FLOOR,
  awaitLanding,
  blockhashOfMessage,
  computeUnitsOf,
  priorityFeeFor,
  sigStatusFrom,
  withPriorityFee,
  type Landing,
} from "./landing";

// Public Solana program ids (SPL Token, Token-2022), not secrets.
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // ggignore
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // ggignore

export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

/** One call to Gloam's Solana RPC proxy. */
export const proxyRpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const res = await fetch(ringsUrls(location.origin).rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json().catch(() => null)) as { result?: T; error?: unknown } | null;
  if (!json || json.error || json.result === undefined) throw new Error("Solana is slow to answer. Try again.");
  return json.result;
};

const tokenProgramOf = (a: RingsAsset) => (a.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);

/** What is waiting at `owner` (a private account's address), not private yet. */
export async function readArrivals(rpc: Rpc, owner: string, network: RingsNetwork): Promise<Arrival[]> {
  const programs = [...new Set(ringsAssets(network).filter((a) => a.mint).map(tokenProgramOf))];
  const [balance, ...lists] = await Promise.all([
    rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]),
    ...programs.map((programId) =>
      rpc<{ value: { pubkey: string; account: { data: [string, string] } }[] }>("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "base64", commitment: "confirmed" },
      ])
    ),
  ]);
  const decodeAddress = getAddressDecoder();
  const b64 = getBase64Encoder();
  const tokens: { account: string; mint: string; amount: bigint; frozen: boolean }[] = [];
  for (const list of lists) {
    for (const { pubkey, account } of list.value ?? []) {
      const t = readTokenAccount(new Uint8Array(b64.encode(account.data[0])));
      if (!t || decodeAddress.decode(t.owner) !== owner) continue;
      tokens.push({ account: pubkey, mint: decodeAddress.decode(t.mint), amount: t.amount, frozen: t.frozen });
    }
  }
  return arrivalsFrom({ lamports: BigInt(balance.value ?? 0), tokens }, network);
}

/**
 * The deposit of `amount` of `asset` from the private account (`depositor`,
 * which signs) into its own private balance, the relay (`feePayer`) paying
 * the fee: the SDK's deposit, version 1, with `priorityFeeLamports` (the
 * relay's floor unless the page read Helius's price, lib/solanaRings/landing).
 * Never creates the mint's setup account (Gloam's to do), so it stays one
 * plain deposit, the only shape the relay pays for.
 */
export async function buildRelayedDeposit(input: {
  client: Parameters<typeof import("@heliuslabs/spr/wallet").buildDepositTransaction>[0]["client"];
  feePayer: Address;
  depositor: Address;
  recipient: import("@heliuslabs/spr").ShieldedAddress;
  asset: RingsAsset;
  amount: bigint;
  /** The token account the money sits in; ignored for SOL. */
  tokenAccount: Address | null;
  priorityFeeLamports?: bigint;
}): Promise<Transaction> {
  const { buildDepositTransaction } = await import("@heliuslabs/spr/wallet");
  if (input.asset.mint && !input.tokenAccount) throw new Error("No token account to make private.");
  const built = await buildDepositTransaction({
    client: input.client,
    feePayer: input.feePayer,
    depositor: input.depositor,
    recipient: input.recipient,
    amount: input.amount,
    ...(input.asset.mint
      ? {
          asset: input.asset.mint as Address,
          splTokenAccount: input.tokenAccount as Address,
          splTokenProgram: tokenProgramOf(input.asset) as Address,
          createSplInterface: false,
        }
      : {}),
  });
  return withPriorityFee(built, input.priorityFeeLamports ?? RELAY_PRIORITY_FEE_FLOOR);
}

/** How making it private ended. */
export type ShieldResult =
  /** It went private. `signature` when known. */
  | { state: "landed"; signature: string | null; slot: bigint | null }
  /** Nothing was there any more: already private. */
  | { state: "none" }
  /** Nothing moved; the money is still at the address. Safe to try again. */
  | { state: "notSent"; message: string }
  /** Can't tell yet. The next look at the address does. */
  | { state: "unknown"; message: string };

export type RelayRef = { address: Address; price: number | null };

export type ShieldDeps = {
  /** Gloam's relay: its address (the fee payer) and Helius's fee price. */
  relay(): Promise<RelayRef>;
  /** The signed deposit of what is there now, or null when nothing is. */
  build(relay: RelayRef): Promise<{ wire: Uint8Array; blockhash: string; amount: bigint } | null>;
  /** Hand it to Gloam's relay: its signature and the signed transaction, or a refusal saying whether it may have been sent. */
  send(wire: Uint8Array): Promise<{ ok: true; signature: string; signed: string | null } | { ok: false; message: string; maybeSent: boolean }>;
  /** Wait for it as every relayed send waits (lib/solanaRings/landing awaitLanding: rebroadcast, bounded, dropped only for sure). */
  wait(sent: { signature: string; signed: string | null; blockhash: string }): Promise<Landing>;
  blockhashValid(blockhash: string): Promise<boolean>;
  /** How much of this asset is at the address now (in that token account, or SOL). */
  left(): Promise<bigint>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

const NOT_SENT = "It didn't go through, so nothing moved. Try again.";
const TWICE = "Solana didn't take it, twice, and nothing moved. Try again in a minute.";
const NOT_YET = "Solana hasn't said yet. If it went through, it shows in your private balance in a minute.";

/**
 * Make one arrival private and follow it to an answer. A send Solana dropped
 * for sure (its blockhash expired, never seen) is built and sent once more on
 * its own, as every relayed send is. A relay answer lost with no signature is
 * told apart by the money: once the blockhash has expired, still at the
 * address means it never landed.
 */
export async function settleShield(d: ShieldDeps): Promise<ShieldResult> {
  const relay = await d.relay();
  for (let attempt = 0; attempt < 2; attempt++) {
    const built = await d.build(relay);
    if (!built) return { state: "none" };
    const sent = await d.send(built.wire);
    if (!sent.ok) {
      if (!sent.maybeSent) return { state: "notSent", message: sent.message };
      return byMoney(d, built);
    }
    const r = await d.wait({ signature: sent.signature, signed: sent.signed, blockhash: built.blockhash });
    if (r.state === "landed") return { state: "landed", signature: sent.signature, slot: r.slot };
    if (r.state === "failed") return { state: "notSent", message: "Solana refused it, so nothing moved. Try again." };
    if (r.state === "unknown") return { state: "unknown", message: NOT_YET };
    // dropped: it never landed and never can, so building and sending again is safe
  }
  return { state: "notSent", message: TWICE };
}

/** How long to wait on a send whose signature never came back, before saying it can't tell yet. */
export const SHIELD_WAIT_MS = LANDING_MAX_MS;

async function byMoney(d: ShieldDeps, built: { blockhash: string; amount: bigint }): Promise<ShieldResult> {
  const until = d.now() + SHIELD_WAIT_MS;
  while (d.now() < until) {
    if (!(await d.blockhashValid(built.blockhash).catch(() => true))) {
      const left = await d.left().catch(() => null);
      if (left === null) break;
      return left >= built.amount ? { state: "notSent", message: NOT_SENT } : { state: "landed", signature: null, slot: null };
    }
    await d.sleep(BLOCKHASH_CHECK_MS);
  }
  return { state: "unknown", message: NOT_YET };
}

// ---------------------------------------------------------------- in the browser

/** Relay refusals that come before it sends anything (app/api/solana/relay). */
const RELAY_NOT_SENT = new Set(["relay_off", "relay_unavailable", "relay_empty", "simulate_failed"]);

async function postToRelay(wire: Uint8Array): Promise<Awaited<ReturnType<ShieldDeps["send"]>>> {
  let res: Response;
  try {
    res = await fetch(ringsUrls(location.origin).relay, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: getBase64Decoder().decode(wire) }),
      // past the relay's own limit (45 seconds): a lost answer, which may come after the send
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    return { ok: false, message: "Gloam's relay didn't answer. Check your connection.", maybeSent: true };
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; signature?: string; tx?: unknown; error?: { code?: string; message?: string } } | null;
  if (json?.ok && json.signature) return { ok: true, signature: json.signature, signed: typeof json.tx === "string" ? json.tx : null };
  const code = json?.error?.code ?? "unknown";
  return {
    ok: false,
    message: json?.error?.message ?? "Gloam's relay didn't take it. Try again.",
    maybeSent: res.ok || (res.status >= 500 && !RELAY_NOT_SENT.has(code)),
  };
}

/** One at a time per private account: a second asked for meanwhile waits its turn. */
const queue = new Map<string, Promise<unknown>>();

/**
 * Make `arrival` private from session `s`: re-read what is there, deposit all
 * of it through Gloam's relay, follow it to an answer, and read the private
 * balance back once it landed.
 */
export async function makeArrivalPrivate(
  s: import("./client").RingsSession,
  arrival: Pick<Arrival, "assetId" | "tokenAccount">
): Promise<ShieldResult> {
  const asset = ringsAssets(s.network).find((a) => a.id === arrival.assetId);
  if (!asset) return { state: "notSent", message: "That asset isn't listed on Gloam." };
  const prior = queue.get(s.address) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(async (): Promise<ShieldResult> => {
    const client = await import("./client");
    const now = async () =>
      (await readArrivals(proxyRpc, s.address, s.network)).find(
        (a) => a.assetId === arrival.assetId && (a.tokenAccount ?? null) === (arrival.tokenAccount ?? null)
      ) ?? null;
    const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
    const blockhashValid = async (blockhash: string) => (await proxyRpc<{ value: boolean }>("isBlockhashValid", [blockhash, { commitment: "confirmed" }])).value;
    const result = await settleShield({
      relay: async () => {
        const st = await client.relayStatus();
        if (!st.on || !st.relayer) throw new Error("Gloam's Solana relay isn't set up yet.");
        if (!st.funded) throw new Error("Gloam's Solana relay is paused for a moment. Try again shortly.");
        return { address: st.relayer as Address, price: st.priorityMicroLamports };
      },
      build: async (relay) => {
        const here = await now();
        if (!here) return null;
        const unsigned = await buildRelayedDeposit({
          client: s.client,
          feePayer: relay.address,
          depositor: s.address,
          recipient: s.keypair.shieldedAddress(),
          asset,
          amount: here.amount,
          tokenAccount: (here.tokenAccount as Address | null) ?? null,
        });
        const units = computeUnitsOf(unsigned.messageBytes);
        const tx = units ? withPriorityFee(unsigned, priorityFeeFor(relay.price, units)) : unsigned;
        const [sigs] = await s.keypair.toSolanaSigner().signTransactions([tx as never]);
        const wire = new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, ...sigs } } as Transaction));
        return { wire, blockhash: blockhashOfMessage(tx.messageBytes) ?? "", amount: here.amount };
      },
      send: postToRelay,
      wait: (sent) =>
        awaitLanding({
          status: async () => {
            const st = await proxyRpc<{ value?: unknown[] }>("getSignatureStatuses", [[sent.signature], { searchTransactionHistory: true }]);
            if (!Array.isArray(st.value)) throw new Error("no answer");
            return sigStatusFrom(st.value[0] as never);
          },
          blockhashValid: sent.blockhash ? () => blockhashValid(sent.blockhash) : null,
          ...(sent.signed ? { rebroadcast: () => proxyRpc<string>("sendTransaction", [sent.signed, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]) } : {}),
          sleep,
          now: () => Date.now(),
        }),
      blockhashValid,
      left: async () => (await now())?.amount ?? 0n,
      sleep,
      now: () => Date.now(),
    });
    if (result.state === "landed") {
      // The deposit is in; reading it back can lag the indexer by a few seconds.
      await client.syncRings(s, result.slot ?? undefined).catch(() => undefined);
    }
    return result;
  });
  queue.set(s.address, run);
  try {
    return await run;
  } catch (e) {
    const { ringsErrorMessage } = await import("./client");
    return { state: "notSent", message: ringsErrorMessage(e) };
  } finally {
    if (queue.get(s.address) === run) queue.delete(s.address);
  }
}
