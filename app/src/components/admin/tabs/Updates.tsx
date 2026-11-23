"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { BusyLabel } from "@/components/ui/Spinner";
import type { AdminUpdate, SendProgress } from "@/lib/updatesMail";
import type { DeliveryProblem } from "@/lib/updatesDelivery";
import { BODY_MAX, SITE, SUBJECT_MAX, checkUpdate, fmtDay, renderUpdateEmail } from "@/lib/updatesMailRender";
import { TickDonut } from "../charts";
import { useAdminResource } from "../data";
import { n } from "../format";
import { CsvLink, DataTable, Note, Notice, Panel, PanelSkeleton, StatStrip } from "../ui";

type UpdatesData = { backend: string; count: number; bySource: { "sign-in": number; settings: number; site: number; contest?: number } };
type ContestImport = { found: number; added: number; already: number; skipped: number };

/** Adds every video and writing contest entrant's email to the list (api/updates/import). */
function AddContestEmails({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/updates/import", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "contests" }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: ContestImport; error?: { message?: string } } | null;
      if (!res.ok || !json?.ok || !json.data) throw new Error(json?.error?.message ?? `That didn't work (${res.status}).`);
      const d = json.data;
      setNote({
        ok: true,
        text: `Added ${n(d.added)} new from the contests. ${n(d.already)} were on the list already.${d.skipped ? ` ${n(d.skipped)} weren't valid emails.` : ""}`,
      });
      onDone();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4">
      <button type="button" className="btn btn-ghost btn-sm h-10" disabled={busy} aria-busy={busy} onClick={() => void go()}>
        <BusyLabel busy={busy}>Add contest entrants</BusyLabel>
      </button>
      {note && (
        <p className={`mt-2 text-[13px] ${note.ok ? "text-soft" : "text-danger"}`} role={note.ok ? "status" : "alert"}>
          {note.text}
        </p>
      )}
    </div>
  );
}
type MailData = {
  mail: { on: boolean; reason: string | null; from: string; replyTo: string };
  backend: string;
  subscribers: number;
  updates: AdminUpdate[];
  /** Resend's delivery webhook is set up (RESEND_WEBHOOK_SECRET). */
  tracking?: boolean;
  problems?: DeliveryProblem[];
};

const DRAFT_KEY = "gloam-admin-update-draft";
const TEST_TO = "hello@gloam.trade";

/** POSTs an action to api/updates/mail and gives back its data, or throws with the server's message. */
async function mailCall<T>(body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/updates/mail", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("No connection. Check your internet and try again; nobody gets an update twice.");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok || json.data === undefined) throw new Error(json?.error?.message ?? `That didn't work (${res.status}).`);
  return json.data;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Run = { id: string; subject: string; progress: SendProgress | null; running: boolean; error: string | null };

/**
 * Drives a send: calls one step after another (each about 25 seconds on the
 * server) until the update is done or something stops it. Resuming is the same
 * call: the server only sends to people who haven't been sent it.
 */
function useSendRunner(onChanged: () => void) {
  const [run, setRun] = useState<Run | null>(null);
  const active = useRef(false);

  /** Sends until done or stopped; gives back where it ended. */
  const go = async (id: string, subject: string, first?: "retryFailed"): Promise<SendProgress | null> => {
    if (active.current) return null;
    active.current = true;
    setRun({ id, subject, progress: null, running: true, error: null });
    let last: SendProgress | null = null;
    try {
      if (first === "retryFailed") {
        const p = await mailCall<SendProgress>({ action: "retryFailed", id });
        last = p;
        setRun((r) => (r ? { ...r, progress: p } : r));
      }
      // a step that is busy elsewhere, or moved nobody (Resend asked for a wait), waits before the next
      let idle = 0;
      let settled = -1;
      for (;;) {
        const p = await mailCall<SendProgress>({ action: "send", id });
        last = p;
        setRun((r) => (r ? { ...r, progress: p } : r));
        if (p.done) break;
        if (p.stopped) {
          setRun((r) => (r ? { ...r, error: p.stopped } : r));
          break;
        }
        const now = p.sent + p.failed + p.unknown;
        if (p.busy || now === settled) {
          if (++idle > 40) {
            const why = p.busy ? "Another send of this update is still running." : "Sending isn't moving.";
            setRun((r) => (r ? { ...r, error: `${why} Check back in a few minutes, then resume.` } : r));
            break;
          }
          await wait(3000);
        } else idle = 0;
        settled = now;
      }
    } catch (e) {
      setRun((r) => (r ? { ...r, error: e instanceof Error ? e.message : "That didn't work." } : r));
    } finally {
      active.current = false;
      setRun((r) => (r ? { ...r, running: false } : r));
      onChanged();
    }
    return last;
  };

  return { run, go, busy: run?.running === true };
}

function readDraft(): { subject: string; body: string } {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as { subject?: unknown; body?: unknown }) : null;
    return { subject: typeof d?.subject === "string" ? d.subject : "", body: typeof d?.body === "string" ? d.body : "" };
  } catch {
    return { subject: "", body: "" };
  }
}

function saveDraft(subject: string, body: string) {
  try {
    if (!subject && !body) window.localStorage.removeItem(DRAFT_KEY);
    else window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ subject, body }));
  } catch {
    // a private window: the draft just isn't kept
  }
}

const SAMPLE = "Write the update here.\n\n**Bold**, [a link](https://www.gloam.trade) and lists:\n\n- one point\n- another\n\n[Open Gloam](https://www.gloam.trade/app)";

function RunStatus({ run }: { run: Run }) {
  const p = run.progress;
  const total = p ? p.sent + p.failed + p.unknown + p.left + p.pending : 0;
  const pct = p && total > 0 ? Math.round(((p.sent + p.failed + p.unknown) / total) * 100) : 0;
  return (
    <div className="mt-5 rounded-[14px] bg-surface px-4 py-3.5" role="status" aria-live="polite">
      <p className="text-[14px] text-foreground">
        {run.running ? "Sending" : p?.done ? "Sent" : "Stopped"}: <span className="text-soft">{run.subject}</span>
      </p>
      {p && (
        <>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${p.done ? 100 : pct}%` }}
            />
          </div>
          <p className="tnum mt-2.5 text-[13px] text-mute">
            {n(p.sent)} sent
            {p.failed > 0 && <> · {n(p.failed)} failed</>}
            {p.unknown > 0 && <> · {n(p.unknown)} unknown</>}
            {!p.done && (
              <>
                {" "}
                · {n(p.left + p.pending)} to go
              </>
            )}
          </p>
        </>
      )}
      {run.error && <p className="mt-2 text-[13px] text-danger">{run.error}</p>}
    </div>
  );
}

function Compose({ data, runner }: { data: MailData; runner: ReturnType<typeof useSendRunner> }) {
  // the draft lives in this browser only, so a reload doesn't lose it (this panel only draws in the browser)
  const [subject, setSubject] = useState(() => readDraft().subject);
  const [body, setBody] = useState(() => readDraft().body);
  const [testTo, setTestTo] = useState(TEST_TO);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [startErr, setStartErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => saveDraft(subject, body), [subject, body]);

  const dSubject = useDeferredValue(subject);
  const dBody = useDeferredValue(body);
  const preview = useMemo(
    () =>
      renderUpdateEmail({
        subject: dSubject.trim() || "Your subject",
        body: dBody.trim() ? dBody : SAMPLE,
        day: new Date().toISOString().slice(0, 10),
        webUrl: `${SITE}/updates`,
        unsubscribeUrl: `${SITE}/unsubscribe`,
      }),
    [dSubject, dBody],
  );

  const problem = checkUpdate(subject, body);
  const on = data.mail.on;
  const count = data.subscribers;
  const busy = runner.busy || starting;

  const sendTest = async () => {
    if (testing || problem) return;
    setTesting(true);
    setTestNote(null);
    try {
      await mailCall({ action: "test", subject, body, to: testTo });
      setTestNote({ ok: true, text: `Test sent to ${testTo.trim()}. Its subject starts with [Test].` });
    } catch (e) {
      setTestNote({ ok: false, text: e instanceof Error ? e.message : "The test didn't send." });
    } finally {
      setTesting(false);
    }
  };

  const sendAll = async () => {
    if (typed !== "SEND" || busy || problem) return;
    setStarting(true);
    setStartErr(null);
    let id: string;
    try {
      const s = await mailCall<{ id: string; status: "sending" | "sent"; day: string; existing: boolean }>({ action: "start", subject, body });
      if (s.existing && s.status === "sent") {
        setStartErr(`This update already went out on ${fmtDay(s.day)}. Change the text to send a new one.`);
        return;
      }
      id = s.id;
    } catch (e) {
      setStartErr(e instanceof Error ? e.message : "That didn't work.");
      return;
    } finally {
      setStarting(false);
    }
    setConfirming(false);
    setTyped("");
    const end = await runner.go(id, subject.trim());
    // once it went to everyone, the draft has done its job
    if (end?.done) {
      setSubject("");
      setBody("");
    }
  };

  return (
    <Panel title="Write an update" sub={`From ${data.mail.from}, replies to ${data.mail.replyTo}`}>
      {!on && (
        <div className="mb-5">
          <Notice tone="warn">Sending is off. {data.mail.reason} You can still write and preview an update.</Notice>
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <label className="block text-[13px] text-mute">
            Subject
            <input
              className="gl-input mt-1.5 h-11 w-full text-[15px]"
              maxLength={SUBJECT_MAX}
              value={subject}
              onChange={(e) => setSubject(e.target.value.replace(/[\r\n]/g, " "))}
              placeholder="Private payroll is live on Solana"
            />
          </label>
          <label className="block text-[13px] text-mute">
            Update
            <textarea
              className="gl-input mt-1.5 min-h-[320px] w-full py-3 font-mono text-[13.5px] leading-relaxed"
              maxLength={BODY_MAX}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={SAMPLE}
            />
          </label>
          <p className="text-[12.5px] leading-relaxed text-mute">
            Markdown: # heading, **bold**, *italic*, [link](https://…), - list, 1. list. A link alone on its own line becomes a button. A new line is a line break; a blank line starts a paragraph.
          </p>

          <div className="border-t border-line pt-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[200px] flex-1 text-[13px] text-mute">
                Send a test to
                <input
                  className="gl-input mt-1.5 h-10 w-full text-[14px]"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
              </label>
              <button type="button" className="btn btn-ghost btn-sm h-10" disabled={!on || !!problem || testing || !testTo.trim()} aria-busy={testing} onClick={() => void sendTest()}>
                <BusyLabel busy={testing}>Send a test</BusyLabel>
              </button>
            </div>
            {testNote && (
              <p className={`mt-2 text-[13px] ${testNote.ok ? "text-soft" : "text-danger"}`} role={testNote.ok ? "status" : "alert"}>
                {testNote.text}
              </p>
            )}
          </div>

          <div className="border-t border-line pt-4">
            {!confirming ? (
              <button
                type="button"
                className="btn btn-ink h-10"
                disabled={!on || !!problem || busy || count === 0}
                onClick={() => {
                  setConfirming(true);
                  setTyped("");
                  setStartErr(null);
                }}
              >
                Send to everyone ({n(count)})
              </button>
            ) : (
              <div className="rounded-[14px] border border-line-strong p-4">
                <p className="text-[14px] leading-relaxed text-foreground">
                  This sends &ldquo;{subject.trim()}&rdquo; to {n(count)} {count === 1 ? "person" : "people"} and puts it on gloam.trade/updates. It can&apos;t be taken back.
                </p>
                <label className="mt-3 block text-[13px] text-mute">
                  Type SEND to confirm
                  <input
                    className="gl-input mt-1.5 block h-10 w-full max-w-[220px] text-[14px] tracking-[0.04em]"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void sendAll();
                    }}
                  />
                </label>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn btn-ink btn-sm h-10" disabled={typed !== "SEND" || busy || !!problem} aria-busy={starting} onClick={() => void sendAll()}>
                    <BusyLabel busy={starting}>Send now</BusyLabel>
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm h-10 text-mute" disabled={starting} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {startErr && (
              <p className="mt-2 text-[13px] text-danger" role="alert">
                {startErr}
              </p>
            )}
            {problem && (subject || body) && <p className="mt-2 text-[13px] text-mute">{problem}</p>}
          </div>
          {runner.run && <RunStatus run={runner.run} />}
        </div>

        <div className="min-w-0">
          <p className="mb-1.5 text-[13px] text-mute">Preview</p>
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={preview.html}
            className="h-[640px] w-full rounded-[14px] border border-line bg-white"
          />
          <details className="mt-3 text-[13px] text-mute">
            <summary className="cursor-pointer py-1.5 hover:text-foreground">Plain text version</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-[12px] bg-surface p-3 text-[12.5px] leading-relaxed text-soft">{preview.text}</pre>
          </details>
        </div>
      </div>
    </Panel>
  );
}

function statusText(u: AdminUpdate): string {
  if (u.done) return "Sent";
  if (u.note) return "Stopped";
  return "Not finished";
}

function SentUpdates({ data, runner }: { data: MailData; runner: ReturnType<typeof useSendRunner> }) {
  const rows = data.updates.map((u) => [
    fmtDay(u.day),
    u.published ? (
      <a key="s" href={`/updates/${u.id}`} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
        {u.subject}
      </a>
    ) : (
      u.subject
    ),
    n(u.sent),
    data.tracking ? n(u.delivery?.delivered ?? 0) : "Off",
    data.tracking ? n(u.delivery?.bounced ?? 0) : "Off",
    data.tracking ? n(u.delivery?.complained ?? 0) : "Off",
    n(u.failed),
    n(u.unknown),
    u.done ? "0" : n(u.left + u.pending),
    <span key="st" title={u.note ?? undefined}>
      {statusText(u)}
    </span>,
    <span key="a" className="flex gap-1.5">
      {!u.done && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={runner.busy || !data.mail.on} onClick={() => void runner.go(u.id, u.subject)}>
          Resume
        </button>
      )}
      {u.failed > 0 && (
        <button type="button" className="btn btn-quiet btn-sm" disabled={runner.busy || !data.mail.on} onClick={() => void runner.go(u.id, u.subject, "retryFailed")}>
          Retry failed
        </button>
      )}
    </span>,
  ]);
  const stoppedNotes = data.updates.filter((u) => u.note && (!u.done || u.failed > 0));
  return (
    <Panel title="Sent updates" sub="Each one is public at gloam.trade/updates once its first batch goes out">
      <DataTable
        headers={["Day", "Subject", "Sent", "Delivered", "Bounced", "Spam", "Failed", "Unknown", "Left", "Status", ""]}
        rows={rows}
        empty="No updates sent yet"
        minWidth={980}
        wrap={[1]}
      />
      {stoppedNotes.map((u) => (
        <p key={u.id} className="mt-3 text-[13px] text-mute">
          <span className="text-foreground">{u.subject}:</span> {u.note}
        </p>
      ))}
      <Note>
        Nobody gets an update twice: a retry, a resume or a second click only sends to people not yet sent it. Unknown means a batch got no clear
        answer from Resend for a day, so it is never sent again. Failed means Resend refused the address; Retry failed tries them once more.
        Delivered, Bounced and Spam come from Resend after the send.
      </Note>
    </Panel>
  );
}

const PROBLEM_KIND: Record<DeliveryProblem["kind"], string> = { bounced: "Bounced", complained: "Marked as spam" };

/** Bounces and spam complaints Resend reported, and whether the address came off the list. */
function DeliveryProblems({ data }: { data: MailData }) {
  const subjectOf = new Map(data.updates.map((u) => [u.id, u.subject]));
  const problems = data.problems ?? [];
  const rows = problems.map((p) => [
    <span key="e" className="break-all">
      {p.email}
    </span>,
    PROBLEM_KIND[p.kind],
    <span key="d" className="text-mute">
      {p.detail}
    </span>,
    p.updateId ? (subjectOf.get(p.updateId) ?? p.updateId) : "Test or other email",
    new Date(p.at).toISOString().slice(0, 16).replace("T", " "),
    p.removed ? "Taken off" : "Wasn't on it",
  ]);
  return (
    <Panel title="Bounces and spam reports" sub="From Resend after each send. These addresses get no more updates.">
      {data.tracking ? (
        <DataTable headers={["Email", "What", "Detail", "Update", "When (UTC)", "List"]} rows={rows} empty="None so far" minWidth={860} wrap={[0, 2, 3]} />
      ) : (
        <p className="text-[14px] leading-relaxed text-soft">
          Off. In Resend, open Webhooks, add https://www.gloam.trade/api/updates/webhook with the events email.delivered, email.bounced,
          email.complained and email.delivery_delayed, then put its signing secret in Vercel as RESEND_WEBHOOK_SECRET (Production) and redeploy.
        </p>
      )}
      <Note>
        A hard bounce (an address that doesn&apos;t exist) or a spam report takes the address off the list at once, so it is never mailed
        again. A soft bounce, like a full mailbox, is only counted. Opens and clicks aren&apos;t tracked.
      </Note>
    </Panel>
  );
}

/**
 * The "Email me Gloam updates" list: how many, from where, and the CSV, then
 * writing an update and sending it to everyone on the list (api/updates/mail).
 * The emails themselves are only in the CSV, which holds email, day and source
 * (and each person's unsubscribe link), nothing about wallets.
 */
export function UpdatesTab() {
  const res = useAdminResource<UpdatesData>("/api/updates", "Updates list");
  const mail = useAdminResource<MailData>("/api/updates/mail", "Email updates");
  const runner = useSendRunner(() => {
    mail.reload();
    res.reload();
  });
  if (res.err && !res.data) return <Notice tone="danger">{res.err}</Notice>;
  const data = res.data;
  if (!data) return <PanelSkeleton label="Loading the updates list" />;
  const src = data.bySource;
  return (
    <>
      {res.err && <Notice tone="danger">{res.err}. Showing the last answer.</Notice>}
      <StatStrip
        items={[
          { label: "Subscribed", value: n(data.count), sub: "emails on the list" },
          { label: "From sign-in", value: n(src["sign-in"]), sub: "Gloam wallet sign-in" },
          { label: "From Settings", value: n(src.settings), sub: "in the app" },
          { label: "From the site", value: n(src.site), sub: "footer field" },
          { label: "From contests", value: n(src.contest ?? 0), sub: "video and writing" },
        ]}
        cols={5}
      />
      {mail.err && !mail.data && <Notice tone="danger">{mail.err}</Notice>}
      {mail.data && <Compose data={mail.data} runner={runner} />}
      {mail.data && <SentUpdates data={mail.data} runner={runner} />}
      {mail.data && <DeliveryProblems data={mail.data} />}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Panel title="Where people joined">
          <TickDonut
            label="Email updates list by where people joined"
            centerLabel="Subscribed"
            total={n(data.count)}
            segments={[
              { key: "sign-in", label: "Sign-in", value: src["sign-in"], display: n(src["sign-in"]) },
              { key: "settings", label: "Settings", value: src.settings, display: n(src.settings) },
              { key: "site", label: "Site", value: src.site, display: n(src.site) },
              { key: "contest", label: "Contests", value: src.contest ?? 0, display: n(src.contest ?? 0) },
            ].filter((s) => s.value > 0)}
          />
        </Panel>
        <Panel title="Email updates list" action={<CsvLink href="/api/updates?format=csv">Download CSV</CsvLink>}>
          <p className="text-[14px] leading-relaxed text-soft">
            The CSV has each email, the day it joined and where, plus its unsubscribe link.
          </p>
          <AddContestEmails onDone={res.reload} />
          <Note>
            Add contest entrants puts every video and writing contest email on the list, marked Contests; anyone on it already stays as they
            were. Each gets their own unsubscribe link. Emails are kept alone: no wallet, address or IP is stored with them. Store: {data.backend}.
          </Note>
        </Panel>
      </div>
    </>
  );
}
