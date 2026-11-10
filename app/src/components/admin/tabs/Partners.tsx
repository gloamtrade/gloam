"use client";

import { useState, type ReactNode } from "react";
import { HowItWorks } from "@/components/ui/HowItWorks";
import { BusyLabel } from "@/components/ui/Spinner";
import { shortAddress } from "@/lib/chain";
import { MAINNET_ENABLED } from "@/lib/networks";
import { AdminBackfill, AdminPartnerDetail } from "../AdminPartnerDetail";
import { useAdminResource, type Env } from "../data";
import { fmtUsd, n } from "../format";
import { CsvLink, Empty, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

export type AdminPartner = {
  id: string;
  owner: string;
  name: string;
  website: string | null;
  fees: { privatePaymentCents: number; cashoutBps: number; depositBps: number };
  relayApproved: boolean;
  /** The name approved to show in links, or null. */
  approvedName?: string | null;
  nameAwaitingApproval?: boolean;
  createdAt: number;
  activeKeys: number;
  /** Live link codes. */
  liveCodes?: number;
  /** Receiving addresses for the on-chain match: all, and proven by signature. */
  addresses?: { total: number; verified: number };
  /** "partial:<n>" when older activity outran what could be split into mainnet and testnet. */
  migration?: string | null;
  totals: {
    privatePayments: number;
    cashOuts: number;
    deposits: number;
    privateSwaps?: number;
    publicVolumeUsd: number;
    swapVolumeUsd?: number;
    commissionUsd: number;
    vaultFeeUsd?: number;
    unpriced: number;
    lastActivity: number | null;
    bySource?: Record<"api" | "link" | "chain", { counts: Record<string, number>; volumeUsd: number; vaultFeeUsd: number }>;
  } | null;
};

export type PartnersPayload = {
  backend: "redis" | "memory" | "none";
  partners: AdminPartner[];
  totals: {
    privatePayments: number;
    cashOuts: number;
    deposits: number;
    privateSwaps?: number;
    publicVolumeUsd: number;
    swapVolumeUsd?: number;
    commissionUsd: number;
    vaultFeeUsd?: number;
  } | null;
};

/** How many a source brought in, every kind. */
export function sourceCount(t: AdminPartner["totals"], s: "api" | "link" | "chain"): number {
  const c = t?.bySource?.[s]?.counts;
  return c ? Object.values(c).reduce((a, b) => a + b, 0) : 0;
}

/** Everything a partner brought in, every kind, counted. */
export function partnerActivity(t: AdminPartner["totals"]): number {
  return t ? t.privatePayments + t.cashOuts + t.deposits + (t.privateSwaps ?? 0) : 0;
}

export const partnersUrl = (tier: Env) => `/api/partners/admin?tier=${tier}`;

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

function Fig({ k, v, title }: { k: string; v: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="truncate text-[12px] text-mute">{k}</dt>
      <dd className="tnum mt-0.5 truncate text-[15px] text-foreground">{v}</dd>
    </div>
  );
}

const chip = "inline-flex h-8 items-center rounded-full border px-3 text-[12.5px] transition-colors disabled:opacity-50";

/**
 * The partner program: every partner, their keys, link codes and receiving
 * addresses, and what they brought in by source (API key, link, matched on chain).
 * Details opens one partner's breakdown, codes and addresses.
 */
export function PartnersTab({ tier }: { tier: Env }) {
  const res = useAdminResource<PartnersPayload>(partnersUrl(tier), "Partners");
  const [saving, setSaving] = useState<string | null>(null);
  /** Which button of that row is saving, for its spinner. */
  const [savingWhat, setSavingWhat] = useState<"relay" | "name" | "remove" | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** The account whose Remove was clicked once: a second click removes it. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removedNote, setRemovedNote] = useState<string | null>(null);

  /** Removes an account for good (lib/partnerRemove), after the inline confirm. */
  const remove = async (p: AdminPartner) => {
    setSaving(p.id);
    setSavingWhat("remove");
    setSaveErr(null);
    setRemovedNote(null);
    try {
      const r = await fetch("/api/partners/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, remove: true }),
      });
      const json = (await r.json().catch(() => null)) as {
        ok?: boolean;
        data?: { removed?: { keysRevoked?: number; codesRevoked?: number; addressesDropped?: number } };
        error?: { message?: string };
      } | null;
      if (!r.ok || !json?.ok) {
        setSaveErr(json?.error?.message ?? `Removing failed (${r.status})`);
        return;
      }
      const x = json.data?.removed ?? {};
      setRemovedNote(
        `Removed ${p.name}: ${n(x.keysRevoked ?? 0)} keys revoked, ${n(x.codesRevoked ?? 0)} link codes revoked, ${n(x.addressesDropped ?? 0)} addresses dropped.`
      );
      res.mutate((d) => ({ ...d, partners: d.partners.filter((q) => q.id !== p.id) }));
      setOpen((o) => (o === p.id ? null : o));
      // the program's totals no longer count it
      res.reload();
    } catch {
      setSaveErr("Network error removing the partner");
    } finally {
      setSaving(null);
      setConfirmRemove(null);
    }
  };

  /** Approves an account for the relay's larger message budget, or its name to show in links, or takes either back. */
  const save = async (id: string, change: { relayApproved: boolean } | { approveName: boolean }) => {
    setSaving(id);
    setSavingWhat("relayApproved" in change ? "relay" : "name");
    setSaveErr(null);
    try {
      const r = await fetch("/api/partners/admin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...change }),
      });
      const json = (await r.json().catch(() => null)) as {
        ok?: boolean;
        data?: { partner?: { relayApproved?: boolean; approvedName?: string | null; nameAwaitingApproval?: boolean } };
        error?: { message?: string };
      } | null;
      if (!r.ok || !json?.ok) {
        setSaveErr(json?.error?.message ?? `Saving failed (${r.status})`);
        return;
      }
      const saved = json.data?.partner ?? {};
      res.mutate((d) => ({
        ...d,
        partners: d.partners.map((p) =>
          p.id === id
            ? { ...p, relayApproved: saved.relayApproved === true, approvedName: saved.approvedName ?? null, nameAwaitingApproval: saved.nameAwaitingApproval }
            : p
        ),
      }));
    } catch {
      setSaveErr("Network error saving the partner");
    } finally {
      setSaving(null);
    }
  };

  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Loading partners" />;
  const openPartner = data.partners.find((p) => p.id === open) ?? null;
  const t = data.totals;
  const test = tier === "testnet";
  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        items={[
          { label: "Partners", value: n(data.partners.length), sub: `${n(data.partners.reduce((s, p) => s + p.activeKeys, 0))} active keys` },
          { label: "Private payments", value: n(t?.privatePayments), sub: `through partner keys and links, and ${n(t?.privateSwaps ?? 0)} private swaps`, tone: "sealed" },
          {
            label: "Public volume",
            value: test ? "Not priced" : fmtUsd(t?.publicVolumeUsd ?? 0),
            sub: `${n((t?.cashOuts ?? 0) + (t?.deposits ?? 0))} cash outs and deposits${test ? ", testnet" : ""}`,
          },
          {
            label: "Vault fees",
            value: test ? "Not priced" : fmtUsd(t?.vaultFeeUsd ?? 0),
            sub: `Gloam's cash-out fee on partner flows; would-be partner fees ${fmtUsd(t?.commissionUsd ?? 0)}, ${MAINNET_ENABLED ? "not charged" : "testnet"}`,
          },
        ]}
      />
      <Panel
        title="Partners"
        sub={`${n(data.partners.length)} ${data.partners.length === 1 ? "account" : "accounts"}, ${tier}`}
        action={
          <>
            <CsvLink href={`/api/partners/admin/export?id=all&type=daily&tier=${tier}`}>Daily CSV</CsvLink>
            <CsvLink href={`/api/partners/admin/export?id=all&type=transactions&tier=${tier}`}>Transactions CSV</CsvLink>
          </>
        }
      >
        {data.partners.length === 0 ? (
          <Empty>{data.backend === "none" ? "Partner storage is not configured (set Upstash Redis)." : "No partners yet"}</Empty>
        ) : (
          <ul className="space-y-3">
            {data.partners.map((p) => {
              const busy = saving === p.id;
              const pt = p.totals;
              return (
                <li key={p.id} className={`rounded-[14px] border p-4 transition-colors sm:p-5 ${open === p.id ? "border-line-strong bg-surface" : "border-line"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-[15px] text-foreground">
                        {p.website ? (
                          <a href={p.website} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                            {p.name}
                          </a>
                        ) : (
                          p.name
                        )}
                        <span className="tnum text-[12px] text-faint">{p.id}</span>
                      </p>
                      <p className="tnum mt-1 text-[12.5px] text-mute">
                        <span title={p.owner}>Owner {shortAddress(p.owner, 4)}</span> · Joined {new Date(p.createdAt).toLocaleDateString()} · Last payment{" "}
                        {pt?.lastActivity ? new Date(pt.lastActivity).toLocaleString() : "none yet"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        aria-expanded={open === p.id}
                        onClick={() => setOpen((o) => (o === p.id ? null : p.id))}
                        className={`${chip} border-line-strong text-foreground hover:border-foreground`}
                      >
                        {open === p.id ? "Close details" : "Details"}
                      </button>
                      {confirmRemove === p.id ? (
                        <>
                          <button type="button" disabled={busy} onClick={() => void remove(p)} className={`${chip} border-danger bg-danger text-white hover:opacity-90`}>
                            <BusyLabel busy={busy && savingWhat === "remove"}>Remove for good</BusyLabel>
                          </button>
                          <button type="button" disabled={busy} onClick={() => setConfirmRemove(null)} className={`${chip} border-transparent text-mute hover:text-foreground`}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmRemove(p.id)}
                          className={`${chip} border-line text-mute hover:border-danger hover:text-danger`}
                          title="Ends the account. Keys and links stop at once."
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4 xl:grid-cols-7">
                    <Fig k="Private payments" v={n(pt?.privatePayments)} />
                    <Fig k="Cash outs" v={n(pt?.cashOuts)} />
                    <Fig k="Deposits" v={n(pt?.deposits)} />
                    <Fig k="Swaps" v={n(pt?.privateSwaps ?? 0)} />
                    <Fig k="Public volume" v={test ? "Not priced" : fmtUsd(pt?.publicVolumeUsd ?? 0)} />
                    <Fig k="Vault fees" v={test ? "Not priced" : fmtUsd(pt?.vaultFeeUsd ?? 0)} />
                    <Fig k="Would-be fees" v={test ? "Not priced" : fmtUsd(pt?.commissionUsd ?? 0)} />
                  </dl>

                  <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3 text-[12.5px] text-mute">
                    <span className="tnum">
                      Via API key <span className="text-foreground">{n(sourceCount(pt, "api"))}</span> · via link{" "}
                      <span className="text-foreground">{n(sourceCount(pt, "link"))}</span> · matched on chain{" "}
                      <span className="text-foreground">{n(sourceCount(pt, "chain"))}</span>
                    </span>
                    <span className="tnum">
                      Keys <span className="text-foreground">{n(p.activeKeys)}</span> · codes <span className="text-foreground">{n(p.liveCodes ?? 0)}</span> · addresses{" "}
                      <span className="text-foreground">
                        {n(p.addresses?.total ?? 0)} ({n(p.addresses?.verified ?? 0)} proven)
                      </span>
                    </span>
                    <span className="tnum" title="Per private payment, cash out, deposit">
                      Fee setting{" "}
                      <span className="text-foreground">
                        ${(p.fees.privatePaymentCents / 100).toFixed(2)} · {pct(p.fees.cashoutBps)} · {pct(p.fees.depositBps)}
                      </span>
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
                    <span className="inline-flex flex-wrap items-center gap-2 text-mute">
                      Name in links
                      <span className={p.approvedName ? "text-foreground" : "text-faint"} title={p.nameAwaitingApproval ? `Account name now: ${p.name}` : undefined}>
                        {p.approvedName ?? "Not shown"}
                      </span>
                      {p.nameAwaitingApproval ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void save(p.id, { approveName: true })}
                          className={`${chip} border-line-strong text-foreground hover:border-foreground`}
                          title={`Show "${p.name}" in links as a Gloam partner. Check it is the partner's real name, not Gloam or another brand.`}
                        >
                          <BusyLabel busy={busy && savingWhat === "name"}>Approve {p.name}</BusyLabel>
                        </button>
                      ) : p.approvedName ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void save(p.id, { approveName: false })}
                          className={`${chip} border-line text-mute hover:border-line-strong hover:text-foreground`}
                          title="Stop showing this name in links. The account and its keys stay."
                        >
                          <BusyLabel busy={busy && savingWhat === "name"}>Hide name</BusyLabel>
                        </button>
                      ) : null}
                    </span>
                    <span className="inline-flex items-center gap-2 text-mute">
                      Messages
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void save(p.id, { relayApproved: !p.relayApproved })}
                        className={`${chip} ${p.relayApproved ? "border-transparent bg-sealed-soft text-sealed" : "border-line-strong text-foreground hover:border-foreground"}`}
                        title={p.relayApproved ? "Their keys use the larger message budget. Click to take it back." : "Their keys share the small message budget. Click to approve."}
                      >
                        <BusyLabel busy={busy && savingWhat === "relay"}>{p.relayApproved ? "Approved" : "Approve"}</BusyLabel>
                      </button>
                    </span>
                    {p.migration && <span className="text-warn">Some older activity could not be split into mainnet and testnet</span>}
                  </div>

                  {open === p.id && openPartner && (
                    <div className="mt-5 border-t border-line pt-5">
                      <AdminPartnerDetail key={`${openPartner.id}-${tier}`} id={openPartner.id} tier={tier} onChanged={res.reload} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {saveErr && (
          <p className="mt-3 text-[13px] text-danger" role="alert">
            {saveErr}
          </p>
        )}
        {removedNote && (
          <p className="mt-3 text-[13px] text-foreground" role="status">
            {removedNote}
          </p>
        )}
        <Note>Remove ends the account: keys and links stop, history is kept but not counted. Hide name keeps the account.</Note>
        {data.partners.some((p) => p.migration) && (
          <p className="mt-1 text-[13px] text-warn">Some older activity could not be split into mainnet and testnet. See the details.</p>
        )}
        <HowItWorks
          items={[
            "Via API key: payments relayed with a partner key, and deposits partners reported. Checked on chain.",
            "Via link: payments, cash outs and swaps opened from a partner's link. Checked on chain.",
            "Matched on chain: past cash outs to the partner's proven addresses.",
            "Name in links: shows only once approved. A rename needs approving again.",
            "Messages: approved keys get the relay's larger message budget.",
            "Fee setting: per private payment, cash out, deposit.",
            test ? "Testnet: counted, never valued." : "Mainnet only. Testnet is counted apart.",
            "Only public transaction facts are kept. Never a payer's wallet or IP.",
            `Store: ${data.backend}.`,
          ]}
        />
      </Panel>
      <Panel title="On-chain match" sub="Past cash outs to partners' proven addresses">
        <AdminBackfill onDone={res.reload} />
      </Panel>
    </>
  );
}
