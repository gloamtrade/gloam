"use client";

/**
 * Gloam on Solana: a private account opened by the main wallet's signature,
 * on Helius Solana Privacy Rings (lib/solanaRings). One idea per screen:
 * connect, set up, then the balance with Add, Pay, Payroll and Cash out.
 *
 * What stays private, said where it applies: a private payment hides the asset
 * and the amount; the two private accounts it moves between show. Adding money
 * shows the wallet it came from, and a cash out shows where it went.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ringsAssets, RINGS_PRIVACY_NOTE, SOLANA_RINGS_NETWORK, type RingsAsset } from "@/lib/solanaRings/config";
import type { RelayStatus, RingsSession } from "@/lib/solanaRings/client";
import { canSignMessage, connectSolana, useSolanaWallets, type SolanaAccount, type SolanaWallet } from "@/lib/solanaWallet";
import { CopyButton } from "@/components/ui/CodeBlock";
import { SolanaPayrollView } from "./SolanaPayrollView";

type Tab = "balance" | "add" | "pay" | "payroll" | "cashout";

const lib = () => import("@/lib/solanaRings/client");

function short(a: string) {
  return `${a.slice(0, 4)}...${a.slice(-4)}`;
}

/** "1.5" in `decimals` places, or null. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const v = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return v > 0n ? v : null;
}

import { displayAmount } from "@/lib/amountShort";
export function formatAmount(v: bigint, decimals: number): string {
  return displayAmount(v, decimals);
}

export function SolanaRingsView() {
  const wallets = useSolanaWallets();
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [main, setMain] = useState<{ wallet: SolanaWallet; account: SolanaAccount } | null>(null);
  const [session, setSession] = useState<RingsSession | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("balance");
  // Payroll stays mounted once opened, so a run keeps paying (and showing) while another tab is open.
  const [payrollOpened, setPayrollOpened] = useState(false);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [ready, setReady] = useState<Record<string, boolean>>({ sol: true });

  useEffect(() => {
    void lib().then(async (l) => {
      setRelay(await l.relayStatus());
      setReady(await l.assetsReady());
    });
  }, []);

  useEffect(() => {
    return () => {
      if (session) void lib().then((l) => l.closeRingsAccount(session));
    };
  }, [session]);

  const run = useCallback(async (label: string, fn: () => Promise<string | void>): Promise<boolean> => {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      const out = await fn();
      if (out) setDone(out);
      return true;
    } catch (e) {
      if (process.env.NODE_ENV !== "production") console.error("solana rings:", e);
      const l = await lib();
      setError(l.ringsErrorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const refresh = useCallback(
    async (s: RingsSession) => {
      const l = await lib();
      await l.syncRings(s);
      setBalances(l.ringsBalances(s));
    },
    []
  );

  const usable = useMemo(() => wallets.filter(canSignMessage), [wallets]);
  // each step of a send (lib/solanaRings/client ringsStepLabel) shows in place of the busy label
  const steps = useMemo(() => ({ onStep: (_step: unknown, label: string) => setBusy(label) }), []);

  if (!relay) return <div aria-busy="true" className="gl-card h-[320px] max-w-[560px] motion-safe:animate-pulse" />;

  if (!relay.on) {
    return (
      <Card title="Not open yet">
        <p className="mt-2 text-[14px] leading-relaxed text-soft">Private accounts on Solana open here soon.</p>
      </Card>
    );
  }

  // 1. Connect
  if (!main) {
    return (
      <Card title="Connect a Solana wallet">
        <p className="mt-2 text-[14px] leading-relaxed text-soft">Your wallet opens your private account. It never holds your private balance.</p>
        <div className="mt-5 space-y-2">
          {usable.map((w) => (
            <button
              key={w.name}
              type="button"
              className="btn btn-ghost w-full justify-start gap-3"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("Connecting", async () => {
                  const account = await connectSolana(w);
                  setMain({ wallet: w, account });
                })
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- the wallet's own data-URL icon */}
              {w.icon && <img src={w.icon} alt="" width={20} height={20} className="h-5 w-5 rounded" />}
              {w.name}
            </button>
          ))}
          {usable.length === 0 && (
            <p className="rounded-[16px] bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-mute">
              No Solana wallet here. Install Phantom, Solflare or Backpack, then reload.
            </p>
          )}
        </div>
        <Status busy={busy} error={error} />
      </Card>
    );
  }

  // 2. Set up
  if (!session) {
    return (
      <Card title="Set up your private account">
        <p className="mt-2 text-[14px] leading-relaxed text-soft">
          {main.wallet.name} signs one message. That signature opens the same private account on any device, so there is nothing to back up.
        </p>
        <p className="mt-3 text-[12.5px] text-mute">Wallet {short(main.account.address)}</p>
        {!relay.funded && <p className="mt-3 text-[12.5px] leading-relaxed text-warn">Private payments on Solana are paused for a moment. Try again later.</p>}
        <button
          type="button"
          className="btn btn-ink btn-lg mt-6 w-full"
          disabled={Boolean(busy) || !relay.funded}
          onClick={() =>
            void run("Opening your private account", async () => {
              const l = await lib();
              const s = await l.openRingsAccount({ wallet: main.wallet, account: main.account });
              try {
                setBusy("Getting it ready");
                await l.ensureRegistered(s, steps);
                setBusy("Reading your balance");
                await refresh(s);
              } catch (e) {
                l.closeRingsAccount(s);
                throw e;
              }
              setSession(s);
            })
          }
        >
          {busy ?? "Sign and set up"}
        </button>
        <Status busy={null} error={error} />
      </Card>
    );
  }

  // 3. The account
  return (
    <div className="max-w-[560px] space-y-4">
      <div role="tablist" aria-label="Private account" className="grid grid-cols-5 gap-1.5 sm:gap-2">
        {(
          [
            ["balance", "Balance"],
            ["add", "Add"],
            ["pay", "Pay"],
            ["payroll", "Payroll"],
            ["cashout", "Cash out"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`gl-chip min-h-10 justify-center px-1! ${tab === k ? "border-foreground! text-foreground!" : ""}`}
            onClick={() => {
              setTab(k);
              if (k === "payroll") setPayrollOpened(true);
              setError(null);
              setDone(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "balance" && (
        <Card title="Private balance">
          <dl className="mt-4 space-y-2">
            {ringsAssets().map((a) => (
              <div key={a.id} className="flex items-baseline justify-between gap-3">
                <dt className="text-[14px] text-mute">{a.symbol}</dt>
                <dd className="tnum text-[22px] font-light text-foreground">{formatAmount(balances[a.id] ?? 0n, a.decimals)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[12.5px] leading-relaxed text-mute">Read and decrypted on this device.</p>
          <div className="mt-5 rounded-[16px] bg-surface px-4 py-3">
            <p className="text-[12.5px] text-mute">Your private address. Share it to get paid privately.</p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-foreground">{session.address}</code>
              <CopyButton text={session.address} />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost mt-5 w-full"
            disabled={Boolean(busy)}
            onClick={() => void run("Reading your balance", () => refresh(session))}
          >
            {busy ?? "Refresh"}
          </button>
          <Status busy={null} error={error} />
        </Card>
      )}

      {tab === "add" && (
        <MoveForm
          title="Add to your private balance"
          note={`Adding shows ${short(main.account.address)}, the asset and the amount. What you do with it after stays private.`}
          action="Add"
          ready={ready}
          balances={null}
          busy={busy}
          error={error}
          done={done}
          onSubmit={(asset, amount) =>
            run(`Confirm in ${main.wallet.name}`, async () => {
              const l = await lib();
              await l.addToPrivate(session, asset, amount, steps);
              setBalances(l.ringsBalances(session));
              return `Added ${formatAmount(amount, asset.decimals)} ${asset.symbol}.`;
            })
          }
        />
      )}

      {tab === "pay" && (
        <MoveForm
          title="Pay privately"
          note={RINGS_PRIVACY_NOTE}
          action="Pay"
          withRecipient={{ label: "To a Gloam private address", initial: "" }}
          ready={ready}
          balances={balances}
          busy={busy}
          error={error}
          done={done}
          onSubmit={(asset, amount, to) =>
            run("Paying privately", async () => {
              const l = await lib();
              if (!(await l.isRegistered(session, to!))) {
                throw new Error("That address has no Gloam private account. Use Cash out to pay any Solana address.");
              }
              await l.payPrivately(session, to!, asset, amount, steps);
              setBalances(l.ringsBalances(session));
              return `Paid ${formatAmount(amount, asset.decimals)} ${asset.symbol} privately to ${short(to!)}.`;
            })
          }
        />
      )}

      {payrollOpened && (
        <div hidden={tab !== "payroll"}>
          <SolanaPayrollView session={session} balances={balances} ready={ready} relayFunded={relay.funded} onBalances={setBalances} />
        </div>
      )}

      {tab === "cashout" && (
        <MoveForm
          title="Cash out"
          note="A cash out shows the address it goes to, the asset and the amount."
          action="Cash out"
          withRecipient={{ label: "To any Solana address", initial: main.account.address }}
          ready={ready}
          balances={balances}
          busy={busy}
          error={error}
          done={done}
          onSubmit={(asset, amount, to) =>
            run("Cashing out", async () => {
              const l = await lib();
              await l.cashOut(session, to!, asset, amount, steps);
              setBalances(l.ringsBalances(session));
              return `Sent ${formatAmount(amount, asset.decimals)} ${asset.symbol} to ${short(to!)}.`;
            })
          }
        />
      )}

      <p className="px-1 text-[12px] leading-relaxed text-mute">
        Solana {SOLANA_RINGS_NETWORK === "devnet" ? "devnet" : "mainnet"}, through Helius Privacy Rings. Gloam pays the network fees.
      </p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="gl-card max-w-[560px] p-5 sm:p-7">
      <h2 className="t-title">{title}</h2>
      {children}
    </div>
  );
}

function Status({ busy, error, done }: { busy: string | null; error: string | null; done?: string | null }) {
  if (busy) {
    return (
      <p aria-live="polite" className="mt-4 rounded-[16px] bg-sealed-soft px-4 py-3 text-[13px] text-foreground">
        {busy}. Keep this tab open.
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="mt-4 text-[13px] leading-relaxed text-warn">
        {error}
      </p>
    );
  }
  if (done) {
    return (
      <p role="status" className="mt-4 rounded-[16px] bg-sealed-soft px-4 py-3 text-[13px] text-foreground">
        {done}
      </p>
    );
  }
  return null;
}

function MoveForm(props: {
  title: string;
  note: string;
  action: string;
  withRecipient?: { label: string; initial: string };
  ready: Record<string, boolean>;
  balances: Record<string, bigint> | null;
  busy: string | null;
  error: string | null;
  done: string | null;
  onSubmit: (asset: RingsAsset, amount: bigint, to?: string) => Promise<boolean>;
}) {
  const assets = ringsAssets();
  const [assetId, setAssetId] = useState(assets[0]!.id);
  const [amountText, setAmountText] = useState("");
  const [to, setTo] = useState(props.withRecipient?.initial ?? "");
  const asset = assets.find((a) => a.id === assetId)!;
  const amount = parseAmount(amountText, asset.decimals);
  const setUp = props.ready[asset.id] !== false;
  const have = props.balances?.[asset.id];
  const tooMuch = have !== undefined && amount !== null && amount > have;
  const toOk = !props.withRecipient || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to.trim());
  const can = setUp && amount !== null && !tooMuch && toOk && !props.busy;

  return (
    <div className="gl-card p-5 sm:p-7">
      <h2 className="t-title">{props.title}</h2>
      <div className="mt-5 flex flex-wrap gap-2">
        {assets.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`gl-chip min-h-10 ${a.id === assetId ? "border-foreground! text-foreground!" : ""}`}
            onClick={() => setAssetId(a.id)}
          >
            {a.symbol}
          </button>
        ))}
      </div>
      {!setUp && <p className="mt-2 text-[12.5px] text-warn">{asset.symbol} is not set up on Gloam yet.</p>}

      {props.withRecipient && (
        <div className="mt-5">
          <label htmlFor="sol-to" className="text-[13px] text-mute">
            {props.withRecipient.label}
          </label>
          <input
            id="sol-to"
            className="gl-input mt-1 font-mono text-[14px]"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="Solana address"
          />
        </div>
      )}

      <div className="gl-inputcard mt-5 px-4 py-3.5" data-invalid={Boolean(amountText && (amount === null || tooMuch))}>
        <label htmlFor="sol-amount" className="text-[13px] text-mute">
          Amount
        </label>
        <input
          id="sol-amount"
          inputMode="decimal"
          className="tnum mt-1 w-full min-w-0 bg-transparent text-[34px] font-light leading-[1.15] tracking-[-0.02em] text-foreground outline-none! placeholder:text-faint"
          placeholder="0"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
        />
        {have !== undefined && (
          <p className={`tnum mt-1 text-[12.5px] ${tooMuch ? "text-warn" : "text-mute"}`}>
            {tooMuch ? "More than your private balance. " : ""}
            {formatAmount(have, asset.decimals)} {asset.symbol} private
          </p>
        )}
      </div>

      <p className="mt-4 text-[12.5px] leading-relaxed text-mute">{props.note}</p>

      <button
        type="button"
        className="btn btn-ink btn-lg mt-5 w-full"
        disabled={!can}
        onClick={() => {
          if (amount === null) return;
          void props.onSubmit(asset, amount, props.withRecipient ? to.trim() : undefined).then((ok) => ok && setAmountText(""));
        }}
      >
        {props.busy ?? props.action}
      </button>
      <Status busy={null} error={props.error} done={props.done} />
    </div>
  );
}
