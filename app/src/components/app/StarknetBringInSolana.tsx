"use client";

/**
 * Add privately on Starknet, from a Solana wallet: the wallet burns USDC on
 * Solana with Circle's CCTP (built and simulated by Gloam,
 * lib/starknetPrivacy/cctpSolanaServer), then it is the same bring-in as from
 * an EVM chain: Circle signs, Gloam's relay brings it to the Starknet account,
 * the private add follows.
 */
import { getBase58Decoder } from "@solana/kit";
import { useEffect, useState } from "react";
import { cctpSourceByDomain, bringInCosts, circleFee } from "@/lib/starknetPrivacy/cctp";
import type { StarknetToken } from "@/lib/starknetPrivacy/config";
import { connectSolana, signOrSendSolana, useSolanaWallets, type SolanaAccount, type SolanaWallet } from "@/lib/solanaWallet";
import { solanaDeclined } from "@/lib/walletErrors";
import { parseStarkAmount, shortStark, useStarknet } from "./StarknetAccount";
import { STARKNET_NAME, StarknetActionButton, StarknetAmountCard, StarknetError, StarknetSteps, starkAmount } from "./StarknetParts";

const SOLANA = cctpSourceByDomain(5)!;
/** The least a bring-in may be: a dollar, and more than the fees it pays. */
const MIN_BRING_IN = 1_000_000n;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Bring USDC in from a Solana wallet and add it privately. */
export function StarknetBringInSolana({ token, onDone }: { token: StarknetToken; onDone: (hash: string, lands: bigint) => void }) {
  const sn = useStarknet()!;
  const wallets = useSolanaWallets();
  const [conn, setConn] = useState<{ wallet: SolanaWallet; account: SolanaAccount } | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const owner = conn?.account.address ?? null;

  // The wallet's USDC, read through Gloam (no Solana RPC in the page).
  useEffect(() => {
    if (!owner) return;
    let live = true;
    const read = () =>
      void fetch(`/api/starknet/cctp/solana?owner=${encodeURIComponent(owner)}`, { cache: "no-store" })
        .then((r) => r.json() as Promise<{ ok?: boolean; usdc?: string | null }>)
        .then((b) => live && setUsdc(b.ok && b.usdc != null ? BigInt(b.usdc) : null))
        .catch(() => {});
    read();
    const t = window.setInterval(read, 30_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [owner]);

  const value = parseStarkAmount(amount, token.decimals);
  const bps = sn.cctp?.sources.find((s) => s.domain === SOLANA.domain)?.fastBps ?? null;
  const receiveFee = BigInt(sn.cctp?.fee ?? "0");
  const costs = value !== null && bps !== null ? bringInCosts(value, SOLANA, bps, receiveFee, sn.fee) : null;
  const working = sn.task?.kind === "bringin";
  const cap = sn.maxAdd > 0n ? sn.maxAdd + receiveFee : 0n;
  const stop =
    !sn.relay?.funded || sn.relay.moves === "off"
      ? "Paused for a moment"
      : !conn
        ? "Connect a Solana wallet"
        : bps === null
          ? "Circle's fee isn't available right now"
          : !amount.trim() || !value
            ? "Enter an amount"
            : usdc !== null && value > usdc
              ? `More than you have: ${starkAmount(usdc, token)} USDC`
              : value < MIN_BRING_IN
                ? `At least ${starkAmount(MIN_BRING_IN, token)} ${token.symbol}`
                : !costs
                  ? "That is less than the fees"
                  : cap > 0n && value > cap
                    ? `At most ${starkAmount(cap, token)} ${token.symbol} at once`
                    : null;

  const start = async () => {
    if (!conn || !value || !sn.address) return;
    const lands = costs?.lands ?? 0n;
    const hash = await sn.bringIn({
      sourceSteps: ["Sending from Solana"],
      burn: async (step) => {
        step(0, "Getting it ready");
        const res = await fetch("/api/starknet/cctp/solana", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: conn.account.address, amount: amount.trim(), account: sn.address }) });
        const built = (await res.json().catch(() => null)) as { ok?: boolean; tx?: string; lastValidBlockHeight?: number; error?: { message?: string } } | null;
        if (!res.ok || !built?.ok || !built.tx || !built.lastValidBlockHeight) throw new Error(built?.error?.message ?? "Couldn't make that transfer on Solana. Try again.");
        step(0, "Confirm in your wallet");
        let signature: string;
        try {
          const out = await signOrSendSolana(conn.wallet, conn.account, fromB64(built.tx), "solana:mainnet");
          if ("sent" in out) signature = getBase58Decoder().decode(out.sent);
          else {
            const sent = await fetch("/api/bridge/solana-send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: b64(out.signed) }) });
            const s = (await sent.json().catch(() => null)) as { ok?: boolean; data?: { signature?: string }; error?: { message?: string } } | null;
            if (!sent.ok || !s?.ok || !s.data?.signature) throw new Error(s?.error?.message ?? "Couldn't send it to Solana. Try again.");
            signature = s.data.signature;
          }
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          throw new Error(solanaDeclined(m) ? "You cancelled it in your wallet. Nothing moved." : m);
        }
        // Wait for Solana to confirm it, or for its blockhash to run out unseen (then it never went).
        step(0, "Waiting for Solana");
        for (let i = 0; i < 90; i++) {
          const st = (await fetch(`/api/starknet/cctp/solana?signature=${signature}&lastValid=${built.lastValidBlockHeight}`, { cache: "no-store" })
            .then((r) => r.json())
            .catch(() => null)) as { status?: string } | null;
          if (st?.status === "landed") return { domain: SOLANA.domain, chainId: SOLANA.chainId, tx: signature, amount: value.toString(), at: Date.now() };
          if (st?.status === "failed") throw new Error("It didn't go through on Solana. Nothing moved.");
          if (st?.status === "expired") throw new Error("Solana didn't take it in time. Nothing moved. Try again.");
          await sleep(2_000);
        }
        throw new Error("Solana hasn't confirmed it yet. Check your wallet before you try again.");
      },
    });
    if (!hash) return;
    setAmount("");
    onDone(hash, lands);
  };

  return (
    <>
      <div className="gl-inputcard p-5 sm:p-6">
        <p className="text-[13px] text-mute">Solana wallet</p>
        {conn ? (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="tnum min-w-0 truncate text-[15px] text-foreground">
              {conn.wallet.name}, {shortStark(conn.account.address)}
            </span>
            <button type="button" className="btn btn-quiet btn-sm h-10 shrink-0" disabled={working} onClick={() => setConn(null)}>
              Change
            </button>
          </div>
        ) : wallets.length === 0 ? (
          <p className="mt-2 text-[14px] leading-relaxed text-mute">No Solana wallet found in this browser. Install one, such as Phantom or Solflare, then come back.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {wallets.map((w) => (
              <button
                key={w.name}
                type="button"
                className="btn btn-ghost h-10"
                onClick={() => {
                  setConnectError(null);
                  void connectSolana(w)
                    .then((account) => setConn({ wallet: w, account }))
                    .catch((e: unknown) => setConnectError(e instanceof Error ? e.message : "That wallet didn't connect."));
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own icon */}
                <img src={w.icon} alt="" width={20} height={20} className="h-5 w-5 rounded" />
                {w.name}
              </button>
            ))}
          </div>
        )}
        {connectError && (
          <p role="alert" className="mt-2 text-[13px] text-danger">
            {connectError}
          </p>
        )}
      </div>
      <div className="mt-3">
        <StarknetAmountCard
          id="sn-bring-solana"
          label="Bring in"
          balanceLabel=""
          balanceText={conn ? `USDC in your Solana wallet: ${usdc === null ? "..." : starkAmount(usdc, token)}` : ""}
          balance={null}
          token={token}
          amount={amount}
          onAmount={setAmount}
          problem={null}
          disabled={working}
        />
      </div>
      <dl className="mt-3 divide-y divide-line text-[13.5px]">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">You add privately</dt>
          <dd className="tnum text-right text-foreground">{costs ? `${starkAmount(costs.lands, token)} ${token.symbol} or a little more` : value !== null && bps !== null ? "Less than the fees" : `0.00 ${token.symbol}`}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Circle&apos;s fee</dt>
          <dd className="tnum text-right text-foreground">{bps === null ? "Not available right now" : value !== null ? `${starkAmount(circleFee(value, bps), token)} ${token.symbol} at most` : `${Number((bps / 100).toFixed(4))}% of the amount`}</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Gloam&apos;s fee</dt>
          <dd className="tnum text-right text-foreground">
            {starkAmount(receiveFee + sn.fee, token)} {token.symbol}
          </dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Network fee</dt>
          <dd className="text-right text-foreground">In your wallet, on Solana, with about 0.004 SOL held for Circle&apos;s message</dd>
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <dt className="text-mute">Arrives</dt>
          <dd className="text-right text-foreground">In a few minutes</dd>
        </div>
      </dl>
      <StarknetActionButton kind="bringin" label="Bring in privately" stop={stop} className="mt-5" onClick={() => void start()} />
      <StarknetSteps task={working ? sn.task : null} className="mt-4" />
      <StarknetError kind="bringin" className="mt-4" />
      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">
        Your Solana wallet sends USDC to your {STARKNET_NAME} account through Circle. That transfer is public. It becomes private once it is added.
      </p>
    </>
  );
}
