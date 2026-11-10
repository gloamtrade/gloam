"use client";

import { useState, type FormEvent } from "react";
import { isAddress } from "viem";
import { getNetwork } from "@/lib/networks";
import { portal, PortalError, type PartnerAccount } from "./client";
import { Card, Field, fmtUsd, Notice } from "./ui";

/** "0.05" dollars -> 5 cents; "0.25" percent -> 25 bps. Null when not a number in range. */
function toHundredths(raw: string, max: number): number | null {
  const s = raw.trim();
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === "" || s === ".") return null;
  const v = Math.round(Number(s) * 100);
  return v >= 0 && v <= max ? v : null;
}

const hundredths = (n: number) => (n / 100).toFixed(2);

export function SettingsPanel({ partner, onSaved }: { partner: PartnerAccount; onSaved: (p: PartnerAccount) => void }) {
  const [name, setName] = useState(partner.name);
  const [website, setWebsite] = useState(partner.website ?? "");
  const [flat, setFlat] = useState(hundredths(partner.fees.privatePaymentCents));
  const [cashout, setCashout] = useState(hundredths(partner.fees.cashoutBps));
  const [deposit, setDeposit] = useState(hundredths(partner.fees.depositBps));
  const [rh, setRh] = useState(partner.payout.robinhood ?? "");
  const [tempo, setTempo] = useState(partner.payout.tempo ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const cents = toHundredths(flat, 100);
  const cBps = toHundredths(cashout, 100);
  const dBps = toHundredths(deposit, 100);
  const badAddr = (v: string) => v.trim() !== "" && !isAddress(v.trim(), { strict: false });

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    if (cents == null) return setErr("The fee per private payment must be between $0.00 and $1.00.");
    if (cBps == null || dBps == null) return setErr("Cash out and deposit fees must be between 0% and 1%, in steps of 0.01%.");
    if (badAddr(rh) || badAddr(tempo)) return setErr("A payout address is not a valid wallet address.");
    setBusy(true);
    try {
      const r = await portal<{ partner: PartnerAccount }>("/account", {
        method: "PUT",
        body: {
          name,
          website,
          fees: { privatePaymentCents: cents, cashoutBps: cBps, depositBps: dBps },
          payout: { robinhood: rh.trim(), tempo: tempo.trim() },
        },
      });
      onSaved(r.partner);
      // Show what was stored (checksummed addresses, cleaned name and link).
      setName(r.partner.name);
      setWebsite(r.partner.website ?? "");
      setRh(r.partner.payout.robinhood ?? "");
      setTempo(r.partner.payout.tempo ?? "");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof PortalError ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const example = (amount: number, bps: number | null) => (bps == null ? "?" : fmtUsd(Math.floor(amount * bps) / 10_000));

  return (
    <form onSubmit={save} className="space-y-4">
      <Card
        title="Your fee"
        foot="Partner fees are not charged yet, on mainnet or testnet. Your dashboard counts what this setting would earn on each payment."
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <Field label="Per private payment" htmlFor="fee-flat" hint="A flat amount, up to $1.00. The payment's amount is hidden, even from us.">
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[15px] text-mute">$</span>
              <input id="fee-flat" inputMode="decimal" className="gl-input tnum pl-8" value={flat} onChange={(e) => setFlat(e.target.value)} />
            </div>
          </Field>
          <Field label="Per cash out" htmlFor="fee-cashout" hint="A share of the amount, up to 1%. Cash outs are public.">
            <div className="relative">
              <input id="fee-cashout" inputMode="decimal" className="gl-input tnum pr-9" value={cashout} onChange={(e) => setCashout(e.target.value)} />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[15px] text-mute">%</span>
            </div>
          </Field>
          <Field label="Per deposit" htmlFor="fee-deposit" hint="A share of the amount, up to 1%. Zero keeps adding money free.">
            <div className="relative">
              <input id="fee-deposit" inputMode="decimal" className="gl-input tnum pr-9" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[15px] text-mute">%</span>
            </div>
          </Field>
        </div>
        <div className="mt-6 rounded-xl bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-soft">
          You would earn <span className="tnum text-foreground">{cents == null ? "?" : fmtUsd(cents / 100)}</span> on every private payment,{" "}
          <span className="tnum text-foreground">{example(1000, cBps)}</span> on a $1,000 cash out and{" "}
          <span className="tnum text-foreground">{example(1000, dBps)}</span> on a $1,000 deposit, paid in the token your user moved.
        </div>
      </Card>

      <Card title="Payout addresses" foot="Fees would be paid here, in the token of each payment, once fees are live on mainnet.">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {(
            [
              ["robinhood", rh, setRh],
              ["tempo", tempo, setTempo],
            ] as const
          ).map(([key, value, set]) => (
            <Field
              key={key}
              label={getNetwork(key).label}
              htmlFor={`payout-${key}`}
              hint={badAddr(value) ? <span className="text-danger">Not a valid wallet address.</span> : "A wallet you control on this network."}
            >
              <input
                id={`payout-${key}`}
                className="gl-input tnum text-[14px]"
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                value={value}
                onChange={(e) => set(e.target.value)}
              />
            </Field>
          ))}
        </div>
      </Card>

      <Card title="Your app">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Field label="Name" htmlFor="acct-name">
            <input id="acct-name" className="gl-input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Website" htmlFor="acct-site">
            <input id="acct-site" className="gl-input" placeholder="https://" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </Field>
        </div>
      </Card>

      {err && <Notice tone="danger">{err}</Notice>}
      <div className="flex items-center gap-4">
        <button type="submit" disabled={busy} className="btn btn-ink btn-lg">
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && (
          <span role="status" className="text-[13.5px] text-mute">
            Saved. New payments use this setting.
          </span>
        )}
      </div>
    </form>
  );
}
