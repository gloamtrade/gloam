"use client";

import { useCallback, useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { HowItWorks } from "@/components/ui/HowItWorks";
import { Select } from "@/components/ui/Select";
import { PartnerBreakdown, type BreakdownStats } from "@/components/partners/PartnerBreakdown";
import type { BackfillResult } from "@/lib/partnerBackfill";

/**
 * Admin > Partners, one partner: their figures for one tier by source, kind, day
 * and token (the same view the partner sees, plus each link private payment the
 * partner does not see), the link codes Gloam issued them or they made, and their
 * own receiving addresses for the on-chain match, each proven by its signature.
 */

type CodeView = {
  code: string;
  label: string;
  createdAt: number;
  createdBy: "partner" | "admin";
  expiresAt: number | null;
  revokedAt: number | null;
  state: "live" | "revoked" | "expired";
};

type AddressView = { chainId: number; address: string; verifiedAt: number | null; message: string; addedAt: number };

type Detail = {
  partner: { id: string; name: string };
  stats: BreakdownStats;
  codes: CodeView[];
  addresses: AddressView[];
  addressCount: { total: number; verified: number };
  chains: { chainId: number; key: string; name: string }[];
  migration: string | null;
  notMatched: { privatePayments: string; swaps: string };
};

type Envelope<T> = { ok?: boolean; data?: T; error?: { message?: string } };

async function call<T>(url: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    credentials: "include",
    cache: "no-store",
    headers: init ? { "Content-Type": "application/json" } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json?.ok || !json.data) throw new Error(json?.error?.message ?? `Failed (${res.status})`);
  return json.data;
}

function Box({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] text-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p className="mt-2 text-[13px] text-danger" role="alert">
      {text}
    </p>
  ) : null;
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Never");

export function AdminPartnerDetail({ id, tier, onChanged }: { id: string; tier: "mainnet" | "testnet"; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await call<Detail>(`/api/partners/admin/partner?id=${encodeURIComponent(id)}&tier=${tier}`));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load this partner");
    }
  }, [id, tier]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  if (err) return <ErrorLine text={err} />;
  if (!d) {
    return (
      <p className="flex items-center gap-2.5 py-3 text-[14px] text-mute" role="status">
        <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
        Loading {id}
      </p>
    );
  }
  const changed = () => {
    void load();
    onChanged();
  };
  return (
    <div className="space-y-4">
      {d.migration && (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-[13px] text-warn">
          {d.migration.slice("partial:".length)} older transactions of this partner fell out of its activity list before mainnet and
          testnet were kept apart, so they are not in these figures.
        </p>
      )}
      <PartnerBreakdown
        stats={d.stats}
        days={30}
        notMatched={d.notMatched}
        csv={{
          daily: `/api/partners/admin/export?id=${encodeURIComponent(d.partner.id)}&type=daily&tier=${tier}`,
          transactions: `/api/partners/admin/export?id=${encodeURIComponent(d.partner.id)}&type=transactions&tier=${tier}`,
        }}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Codes id={d.partner.id} codes={d.codes} onChanged={changed} />
        <Addresses id={d.partner.id} addresses={d.addresses} count={d.addressCount} chains={d.chains} onChanged={changed} />
      </div>
    </div>
  );
}

function Codes({ id, codes, onChanged }: { id: string; codes: CodeView[]; onChanged: () => void }) {
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  async function run(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setErr(null);
    try {
      const r = await call<{ code: CodeView }>("/api/partners/admin/partner", { method: "POST", body: { id, ...body } });
      if (body.action === "issueCode") {
        setMade(r.code.code);
        setLabel("");
        setDays("");
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Box title="Link codes">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run("issue", { action: "issueCode", label, expiresInDays: days.trim() ? Number(days) : undefined });
        }}
      >
        <label className="min-w-[160px] flex-1 text-[12.5px] text-mute">
          Label
          <input className="gl-input mt-1 h-10 text-[14px]" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Fund button" />
        </label>
        <label className="w-[120px] text-[12.5px] text-mute">
          Expires in days
          <input className="gl-input mt-1 h-10 text-[14px]" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} placeholder="Never" />
        </label>
        <button type="submit" disabled={busy !== null} className="btn btn-ink btn-sm h-10">
          {busy === "issue" ? "Issuing" : "Issue code"}
        </button>
      </form>
      {made && (
        <p className="mt-3 rounded-xl bg-surface px-3.5 py-2.5 text-[13px] text-soft">
          New code <span className="tnum select-all text-foreground">{made}</span>. Send it to the partner; it goes in their links as{" "}
          <span className="tnum">p={made}</span>.
        </p>
      )}
      <ErrorLine text={err} />
      {codes.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-mute">No codes yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
          {codes.map((c) => (
            <li key={c.code} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-[13px] ${c.state === "live" ? "" : "opacity-60"}`}>
              <span className="min-w-0 flex-1">
                <span className="tnum block select-all text-foreground [overflow-wrap:anywhere]">{c.code}</span>
                <span className="block text-mute">
                  {c.label || "No label"} · {c.state === "live" ? "Live" : c.state === "revoked" ? "Revoked" : "Expired"} ·{" "}
                  {c.createdBy === "admin" ? "by Gloam" : "by partner"} · expires {when(c.expiresAt)}
                </span>
              </span>
              {c.state === "live" && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run(c.code, { action: "revokeCode", code: c.code })}
                  className="rounded-full border border-line px-3 py-1 text-[12.5px] text-danger hover:border-line-strong disabled:opacity-50"
                >
                  {busy === c.code ? "Revoking" : "Revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function csvQuote(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function Addresses({
  id,
  addresses,
  count,
  chains,
  onChanged,
}: {
  id: string;
  addresses: AddressView[];
  count: { total: number; verified: number };
  chains: Detail["chains"];
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [sigs, setSigs] = useState("");
  const [chain, setChain] = useState<string>(String(chains[0]?.chainId ?? ""));
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [busy, setBusy] = useState<"save" | "verify" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);

  const name = (chainId: number) => chains.find((c) => c.chainId === chainId)?.name ?? String(chainId);
  const waiting = addresses.filter((a) => !a.verifiedAt);

  async function send(kind: "save" | "verify") {
    setBusy(kind);
    setErr(null);
    setResult(null);
    setProblems([]);
    try {
      if (kind === "save") {
        const r = await call<{ read: number; rejectedCount: number; rejected: { line: number; reason: string }[] }>("/api/partners/admin/partner", {
          method: "POST",
          body: { id, action: "setAddresses", text, chainId: chain ? Number(chain) : null, mode },
        });
        setResult(`Read ${r.read.toLocaleString("en-US")} ${r.read === 1 ? "address" : "addresses"}. New ones wait for their signature before they count.`);
        setProblems(r.rejected.map((x) => `Line ${x.line}: ${x.reason}`));
        setText("");
      } else {
        const r = await call<{ proven: number; refused: number; results: { address: string; ok: boolean; reason?: string }[]; rejected: { line: number; reason: string }[] }>(
          "/api/partners/admin/partner",
          { method: "POST", body: { id, action: "verifyAddresses", text: sigs, chainId: chain ? Number(chain) : null } }
        );
        setResult(`${r.proven} proven, ${r.refused} refused.`);
        setProblems([
          ...r.results.filter((x) => !x.ok).map((x) => `${x.address.slice(0, 8)}…${x.address.slice(-4)}: ${x.reason ?? "refused"}`),
          ...r.rejected.map((x) => `Line ${x.line}: ${x.reason}`),
        ]);
        setSigs("");
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>, into: (t: string) => void) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 600_000) {
      setErr("That file is too large. Up to 5,000 addresses.");
      return;
    }
    into(await f.text());
  }

  /** The messages still to sign, as a CSV to send the partner: chain, address, message. */
  function messagesCsv() {
    const rows = [["chain", "address", "message"], ...waiting.map((a) => [String(a.chainId), a.address, a.message])];
    const blob = new Blob([rows.map((r) => r.map(csvQuote).join(",")).join("\r\n") + "\r\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gloam-partner-${id}-messages-to-sign.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Box title={`Receiving addresses (${count.verified.toLocaleString("en-US")} proven of ${count.total.toLocaleString("en-US")})`}>
      <p className="text-[13px] text-mute">The partner&apos;s own addresses. Each counts once it signs its message.</p>
      <HowItWorks
        title="How proving works"
        items={[
          "One list per mainnet.",
          "The message names the partner, the chain and the date (EIP-191).",
          "Send the partner the messages, then paste back chain,address,signature.",
          "Nothing about who sent the money is kept.",
        ]}
      />
      {count.total > 0 && (
        <div className="mt-3 rounded-xl bg-surface px-3.5 py-2.5 text-[12.5px] text-soft">
          {[...new Set(addresses.map((a) => a.chainId))].map((c) => (
            <p key={c}>
              {name(c)}: {addresses.filter((a) => a.chainId === c && a.verifiedAt).length} proven,{" "}
              {addresses.filter((a) => a.chainId === c && !a.verifiedAt).length} waiting for a signature
            </p>
          ))}
          <div className="mt-1 flex flex-wrap gap-3">
            <button type="button" className="underline underline-offset-4" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Hide the list" : "Show the list"}
            </button>
            {waiting.length > 0 && (
              <button type="button" className="underline underline-offset-4" onClick={messagesCsv}>
                Download the {waiting.length} {waiting.length === 1 ? "message" : "messages"} to sign
              </button>
            )}
          </div>
          {showAll && (
            <pre className="tnum mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[12px] text-foreground">
              {addresses.map((a) => `${name(a.chainId)},${a.address},${a.verifiedAt ? "proven" : "waiting"}`).join("\n")}
            </pre>
          )}
        </div>
      )}
      <textarea
        className="gl-input mt-3 min-h-[90px] w-full py-2.5 font-mono text-[12.5px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"0x… one per line, or chain,address\nTempo,0x…"}
        aria-label="Addresses to add"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-mute">
        <span className="inline-flex items-center gap-1.5">
          Lines with no chain are on
          <Select
            label="Chain for lines with no chain"
            className="h-9 w-auto min-w-[150px] text-[13px]"
            value={chain}
            onChange={setChain}
            options={chains.map((c) => ({ value: String(c.chainId), label: c.name }))}
          />
        </span>
        <Select
          label="Add or replace"
          className="h-9 w-auto min-w-[160px] text-[13px]"
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { value: "add" as const, label: "Add to the list" },
            { value: "replace" as const, label: "Replace the list" },
          ]}
        />
        <label className="btn btn-ghost btn-sm cursor-pointer">
          Upload CSV
          <input type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => void onFile(e, setText)} />
        </label>
        <button type="button" disabled={busy !== null || (!text.trim() && mode === "add")} onClick={() => void send("save")} className="btn btn-ink btn-sm">
          {busy === "save" ? "Saving" : mode === "replace" && !text.trim() ? "Clear the list" : "Save"}
        </button>
      </div>
      {waiting.length > 0 && (
        <>
          <textarea
            className="gl-input mt-3 min-h-[90px] w-full py-2.5 font-mono text-[12.5px]"
            value={sigs}
            onChange={(e) => setSigs(e.target.value)}
            placeholder={"chain,address,signature\nRobinhood Chain,0x…,0x…"}
            aria-label="Signatures"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="btn btn-ghost btn-sm cursor-pointer">
              Upload signatures
              <input type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => void onFile(e, setSigs)} />
            </label>
            <button type="button" disabled={busy !== null || !sigs.trim()} onClick={() => void send("verify")} className="btn btn-ink btn-sm">
              {busy === "verify" ? "Checking" : "Check signatures"}
            </button>
          </div>
        </>
      )}
      <ErrorLine text={err} />
      {result && (
        <div className="mt-2 text-[12.5px] text-soft" role="status">
          <p>{result}</p>
          {problems.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-warn">
              {problems.slice(0, 10).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Box>
  );
}

/** The on-chain match over every mainnet, for every partner's receiving addresses. */
export function AdminBackfill({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState<"dry" | "run" | null>(null);
  const [fromStart, setFromStart] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [r, setR] = useState<BackfillResult | null>(null);

  async function go(dryRun: boolean) {
    setBusy(dryRun ? "dry" : "run");
    setErr(null);
    try {
      const out = await call<BackfillResult>("/api/partners/admin/backfill", { method: "POST", body: { dryRun, from: fromStart ? "deploy" : "cursor" } });
      setR(out);
      if (!dryRun) onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The pass failed");
    } finally {
      setBusy(null);
    }
  }

  const notDone = r?.chains.some((c) => !c.done);
  const LABEL: Record<string, string> = {
    recorded: "Counted",
    would_record: "Would count",
    moved: "Moved from a link",
    would_move: "Would move from a link",
    settled: "Counted to its link",
    would_settle: "Would count to its link",
    already_counted: "Already counted",
  };
  const label = (m: BackfillResult["matches"][number]) => LABEL[m.result] ?? m.reason ?? "Left out";
  return (
    <Box
      title="Match past cash outs on chain"
      action={
        <span className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[12.5px] text-mute">
            <input type="checkbox" checked={fromStart} onChange={(e) => setFromStart(e.target.checked)} />
            From each vault&apos;s deploy block
          </label>
          <button type="button" disabled={busy !== null} onClick={() => void go(true)} className="btn btn-ghost btn-sm">
            {busy === "dry" ? "Reading…" : "Dry run"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void go(false)} className="btn btn-ink btn-sm">
            {busy === "run" ? "Matching…" : "Match and count"}
          </button>
        </span>
      }
    >
      <p className="text-[13px] text-mute">Counts past cash outs to partners&apos; proven addresses. Read-only. Run a dry run first.</p>
      <HowItWorks
        title="How the match works"
        items={[
          "Reads every mainnet vault's cash outs.",
          "A cash out to a proven address counts as matched on chain. One a link counted elsewhere moves to that partner.",
          "Also counts link cash outs whose tie is still kept: a wallet registration for an hour, the relay's tie for a week.",
          "A transaction is never counted twice.",
          "Private payments and swaps can't be matched. Neither pays a public address.",
          "A dry run counts nothing. Counting needs a dry run of the same addresses first.",
        ]}
      />
      <ErrorLine text={err} />
      {r && (
        <div className="mt-3 space-y-2 text-[12.5px] text-soft" role="status">
          <p className="text-foreground">
            {r.dryRun ? "Dry run" : "Pass"} over {r.addresses.toLocaleString("en-US")} {r.addresses === 1 ? "address" : "addresses"} took{" "}
            {(r.ms / 1000).toFixed(1)}s. {r.matches.filter((m) => m.result === (r.dryRun ? "would_record" : "recorded")).length}{" "}
            {r.dryRun ? "would be counted" : "counted"}.
            {notDone ? " A chain failed or ran out of time: run it again with the deploy-block box off to carry on from where it stopped." : ""}
          </p>
          {r.byAddress.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="tnum w-full text-left text-[12.5px]">
                <thead className="border-b border-line bg-surface">
                  <tr>
                    {["Partner", "Chain", "Address", "Cash outs found", r.dryRun ? "Would count" : "Counted", "Amount"].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium text-mute">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.byAddress.map((a) => (
                    <tr key={`${a.chainId}-${a.address}`} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">{a.partnerId}</td>
                      <td className="px-3 py-2">{a.chainId}</td>
                      <td className="px-3 py-2" title={a.address}>
                        {a.address.slice(0, 8)}…{a.address.slice(-4)}
                      </td>
                      <td className="px-3 py-2">{a.matches}</td>
                      <td className="px-3 py-2">{a.counted}</td>
                      <td className="px-3 py-2">
                        {Object.entries(a.byToken)
                          .map(([sym, v]) => `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${sym}`)
                          .join(", ") || "None"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ul className="tnum space-y-0.5">
            {r.chains.map((c) => (
              <li key={c.chainId}>
                {c.network}: blocks {c.from} to {c.scannedTo} of {c.to}, {c.queries} queries, {c.logs} cash outs, {c.matches} matched,{" "}
                {(c.ms / 1000).toFixed(1)}s{c.error ? `, failed: ${c.error}` : c.done ? "" : ", not finished"}
              </li>
            ))}
          </ul>
          {r.matches.length > 0 && (
            <ul className="tnum max-h-56 space-y-0.5 overflow-auto rounded-xl bg-surface px-3.5 py-2.5">
              {r.matches.slice(0, 200).map((m) => (
                <li key={`${m.chainId}-${m.txHash}`}>
                  {m.network} {m.txHash.slice(0, 12)}… {m.symbol ?? m.asset.slice(0, 8)} to {m.partnerId || "a link"}: {label(m)}
                  {m.from ? ` (was ${m.from})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Box>
  );
}
