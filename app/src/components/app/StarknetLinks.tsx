"use client";

/**
 * Claim links on Starknet (lib/starknetPrivacy/claimLink, claim, claimSession):
 *
 *  - StarknetPayOrLink: Pay privately, to a private account or as a claim link.
 *  - StarknetLinkView: make one. It runs as a one-row payroll run (the same
 *    engine, saved before anything is sent, so a closed tab resumes it), and
 *    says what it costs before it starts: Gloam's fee three times (opening the
 *    link's one-time account, paying it, and its claim, which the link carries).
 *  - StarknetSentLinks: the links this account sent, whether each is still
 *    waiting, Copy, and Take back for one nobody used.
 *  - StarknetClaimCard: the claim a link opens, on Receive.
 *
 * What shows on Starknet, said once: paying a link shows its one-time account
 * (it is new, so the payment opens a channel to it), never who paid; a claim
 * shows the claimer's private account (each link is a new payer to it, so its
 * payment opens a channel), never which link it came from or how much.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { claimFromHash, type StarknetClaim } from "@/lib/starknetPrivacy/claimLink";
import { claimMessage, linkStanding, type ClaimResult, type LinkHolding } from "@/lib/starknetPrivacy/claim";
import { newRun, runOpen, runPayroll, type PayrollRun } from "@/lib/starknetPrivacy/payroll";
import { sentLinkUrl, type StarknetSentLink } from "@/lib/starknetPrivacy/sentLinks";
import type { StarknetToken } from "@/lib/starknetPrivacy/config";
import { Spinner } from "@/components/ui/Spinner";
import { SolanaSteps } from "./SolanaParts";
import { parseStarkAmount, useStarknet, type StarknetLinksEngine, type StarknetPayrollEngine } from "./StarknetAccount";
import { STARKNET_NAME, StarknetAmountCard, starkAmount, starkAmountProblem } from "./StarknetParts";

/** What a link costs and shows, said where links are made. */
export const LINK_PRIVACY_NOTE =
  "Paying a link shows its one-time account, never who paid. A claim shows the private account it lands in, never which link or how much.";

const ONE_LINK_STEPS = ["Keeping the link in this browser", "Opening the link", "Paying it privately"];

/** A new one-link run, stamped now. */
function linkRun(engine: StarknetPayrollEngine, name: string, amount: bigint): PayrollRun {
  return newRun({
    id: crypto.randomUUID(),
    network: engine.network,
    owner: engine.owner,
    token: engine.token.address,
    rows: [{ line: 1, name: name.trim().slice(0, 60) || "Claim link", address: "", amountInput: "", amount, error: null, link: true }],
    now: Date.now(),
  });
}

function CopyButton({ text, label = "Copy link", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn-quiet btn-sm h-10 shrink-0 ${className}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {});
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** A link, shown whole, with Copy: it is a bearer secret, and the line under it says so. */
export function LinkBox({ url }: { url: string }) {
  return (
    <div className="rounded-[16px] border border-line px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="tnum min-w-0 flex-1 break-all text-[13.5px] leading-relaxed text-foreground">{url}</span>
        <CopyButton text={url} label="Copy" />
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-mute">Anyone with this link can claim it. Send it to them privately.</p>
    </div>
  );
}

/** Pay privately on Starknet: to a private account (the Vault's own view), or as a claim link. */
export function StarknetPayOrLink({ spend }: { spend: ReactNode }) {
  const sn = useStarknet();
  const [mode, setMode] = useState<"account" | "link">("account");
  if (!sn?.payroll || !sn.links) return <>{spend}</>;
  return (
    <div className="max-w-[720px] space-y-4">
      <div className="grid w-full max-w-[420px] grid-cols-2 gap-1.5 rounded-[14px] bg-surface p-1" role="radiogroup" aria-label="Pay">
        {(
          [
            ["account", "To a private account"],
            ["link", "As a claim link"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={`h-10 rounded-[10px] px-2 text-[13px] transition-colors duration-200 ${mode === m ? "bg-panel text-foreground shadow-card" : "text-mute hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "account" ? spend : <StarknetLinkView engine={sn.payroll} links={sn.links} balance={sn.privateBalance} fee={sn.fee} />}
    </div>
  );
}

/** Make a claim link: an amount, what it costs, then the link. */
export function StarknetLinkView({ engine, links, balance, fee }: { engine: StarknetPayrollEngine; links: StarknetLinksEngine; balance: bigint | null; fee: bigint }) {
  const sn = useStarknet();
  const token = engine.token;
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [open, setOpen] = useState<PayrollRun | null>(null);
  const [working, setWorking] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const stopRef = useRef(false);

  // A link left half made (a closed tab, a pause): it resumes here, never a second one.
  useEffect(() => {
    let live = true;
    void links
      .linkRuns()
      .then((s) => s.load())
      .then((runs) => {
        if (live) setOpen(runs.find(runOpen) ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [links, tick]);
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    []
  );

  const value = parseStarkAmount(amount, token.decimals);
  const cost = 3n * fee;
  const problem = starkAmountProblem(amount, token, balance, cost);
  const relayStop = sn?.relay?.funded === false ? "Paused for a moment" : sn?.relay?.moves === "off" ? "Not open yet" : null;
  const stop = relayStop ?? (!amount.trim() || !value ? "Enter an amount" : problem);

  const go = useCallback(
    async (start: PayrollRun) => {
      setWorking(true);
      setError(null);
      setMade(null);
      stopRef.current = false;
      try {
        const store = await links.linkRuns();
        const deps = { ...(await engine.deps()), ...(await links.linkDeps()) };
        await store.save(start);
        const done = await runPayroll(start, {
          ...deps,
          message: engine.message,
          save: (x) => store.save(x),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
          stopRequested: () => stopRef.current,
          onChange: (x, d) => {
            const row = x.rows[0];
            setStep(row?.link?.open ? 2 : row?.link?.id ? 1 : 0);
            setDetail(d ?? null);
          },
        });
        const row = done.rows[0];
        if (done.state === "done" && row?.status === "paid" && row.link?.id) {
          const l = (await (await links.sentLinks()).load()).find((x) => x.id === row.link!.id);
          if (l) setMade(sentLinkUrl(l, window.location.origin));
          setAmount("");
          setName("");
        } else if (done.error) setError(done.error);
        else if (row?.status === "unknown") setError(row.reason ?? "Couldn't tell whether the link was paid. Check Sent links before paying again.");
      } catch (e) {
        setError(engine.message(e));
      } finally {
        setWorking(false);
        setDetail(null);
        setTick((n) => n + 1);
        await engine.sync().catch(() => undefined);
      }
    },
    [engine, links]
  );

  return (
    <div className="space-y-4">
      <section className="gl-card p-5 sm:p-7">
        <h2 className="t-title text-foreground">Send a claim link</h2>
        <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
          Whoever opens the link claims it into their own private account on {STARKNET_NAME}. You can take back a link nobody used.
        </p>
        {open && !working ? (
          <div className="mt-5 rounded-[16px] bg-surface px-4 py-3.5">
            <p className="text-[14px] text-foreground">A link wasn&apos;t finished</p>
            <p className="mt-1 text-[13px] leading-relaxed text-mute">
              {open.rows[0]?.name}, {starkAmount(BigInt(open.rows[0]?.amount ?? "0"), token)} {token.symbol}. {open.error ?? "Finish it before making another."}
            </p>
            <button type="button" className="btn btn-ink btn-sm mt-3 h-10" disabled={Boolean(relayStop)} onClick={() => void go(open)}>
              Finish this link
            </button>
          </div>
        ) : (
          <>
            <div className="mt-5 space-y-3">
              <StarknetAmountCard
                id="sn-link-amount"
                label="Amount"
                balanceLabel="Private balance"
                balance={balance}
                token={token}
                amount={amount}
                onAmount={setAmount}
                problem={problem}
                disabled={working}
              />
              <label className="gl-inputcard block p-5 sm:p-6">
                <span className="text-[13px] text-mute">For (only you see this)</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  disabled={working}
                  placeholder="Ada"
                  className="mt-2 w-full min-w-0 bg-transparent text-[16px] text-foreground outline-none! placeholder:text-faint"
                />
              </label>
            </div>
            {fee > 0n && (
              <p className="tnum mt-3 text-[13px] text-mute">
                Gloam&apos;s fee: {starkAmount(cost, token)} {token.symbol}, from your private balance. That is {starkAmount(fee, token)} each to open the link, to pay it, and for its claim, so they get the
                whole amount.
              </p>
            )}
            <p className="mt-2 text-[12.5px] leading-relaxed text-mute">It takes two proofs now and one when it is claimed. {LINK_PRIVACY_NOTE}</p>
            <button
              type="button"
              aria-busy={working || undefined}
              disabled={working || Boolean(stop)}
              onClick={() => value && void go(linkRun(engine, name, value))}
              className="btn btn-ink btn-lg btn-block mt-5"
            >
              {working ? (
                <>
                  <Spinner />
                  <span className="truncate">{ONE_LINK_STEPS[step]}</span>
                </>
              ) : (
                (stop ?? "Create link")
              )}
            </button>
          </>
        )}
        {working && <SolanaSteps className="mt-4" task={{ kind: "pay", steps: ONE_LINK_STEPS, at: step, detail: detail ?? undefined }} />}
        {error && !working && (
          <p role="alert" className="mt-4 break-words rounded-xl bg-danger-soft px-4 py-3 text-[13.5px] leading-relaxed text-danger">
            {error}
          </p>
        )}
        {made && (
          <div className="mt-5" aria-live="polite">
            <p className="mb-2 text-[14px] text-foreground">Your link is ready</p>
            <LinkBox url={made} />
          </div>
        )}
      </section>
      <StarknetSentLinks links={links} token={token} refreshKey={tick} />
    </div>
  );
}

type Standing = { at: "waiting" | "used" | "not_paid" | "reading" | "unknown"; holding?: LinkHolding };

/** The links this account sent: still waiting or used, Copy, Take back. */
export function StarknetSentLinks({ links, token, refreshKey = 0 }: { links: StarknetLinksEngine; token: StarknetToken; refreshKey?: number }) {
  const [list, setList] = useState<StarknetSentLink[] | null>(null);
  const [standing, setStanding] = useState<Record<string, Standing>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    const all = await (await links.sentLinks()).load();
    setList(all);
    return all;
  }, [links]);

  const read = useCallback(
    async (l: StarknetSentLink) => {
      setStanding((m) => ({ ...m, [l.id]: { at: "reading" } }));
      try {
        const { bytesOf } = await import("@/lib/starknetPrivacy/claimLink");
        const h = await links.read(bytesOf(l.secret));
        const at = linkStanding(h, l.state === "paid" || l.state === "used");
        setStanding((m) => ({ ...m, [l.id]: { at, holding: h } }));
        // Empty after it was paid: claimed (or taken back). Saved, so it stops being read.
        if (at === "used" && l.state !== "used") await (await links.sentLinks()).update(l.id, (x) => ({ ...x, state: "used" }));
      } catch {
        setStanding((m) => ({ ...m, [l.id]: { at: "unknown" } }));
      }
    },
    [links]
  );

  useEffect(() => {
    let live = true;
    void links
      .sentLinks()
      .then((st) => st.load())
      .then((all) => {
        if (!live) return;
        setList(all);
        // The ones that may still hold money are read now, a few at most.
        for (const l of all.filter((x) => x.state !== "used").slice(0, 5)) void read(l);
      })
      .catch(() => live && setError("This browser can't read your sent links."));
    return () => {
      live = false;
    };
  }, [links, read, refreshKey]);

  if (!list || list.length === 0) {
    return list ? <p className="px-1 text-[12.5px] leading-relaxed text-mute">Claim links you send show up here, so you can copy one again or take back one nobody used.</p> : null;
  }

  async function takeBack(l: StarknetSentLink) {
    setBusy(l.id);
    setError(null);
    setConfirm(null);
    try {
      const { bytesOf } = await import("@/lib/starknetPrivacy/claimLink");
      const r: ClaimResult = await links.claim(bytesOf(l.secret), (at) => setStep(at));
      const said = claimMessage(r);
      if (r.state === "claimed") await (await links.sentLinks()).update(l.id, (x) => ({ ...x, state: "used", takenBack: true }));
      else if (said) setError(said);
      await load();
      await read(l);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="gl-card p-5 sm:p-6" aria-labelledby="sn-sent-links">
      <h3 id="sn-sent-links" className="text-[15px] text-foreground">
        Sent links
      </h3>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {list.map((l) => {
          const st = standing[l.id]?.at ?? (l.state === "used" ? "used" : l.state === "paid" ? "waiting" : "not_paid");
          const label = l.takenBack ? "Taken back" : st === "used" ? "Claimed" : st === "waiting" ? "Waiting" : st === "reading" ? "Checking" : st === "unknown" ? "Couldn't check" : "Not paid";
          const mine = busy === l.id;
          return (
            <li key={l.id} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] text-foreground">{l.name || "Claim link"}</p>
                  <p className="tnum mt-0.5 text-[12.5px] text-mute">
                    {starkAmount(BigInt(l.amount), token)} {token.symbol}, {new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </div>
                <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium ${st === "waiting" ? "bg-surface text-soft" : st === "used" ? "bg-sealed-soft text-foreground" : "bg-surface text-mute"}`}>
                  {st === "reading" && <Spinner className="h-3 w-3" />}
                  {label}
                </span>
              </div>
              {st === "waiting" && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <CopyButton text={sentLinkUrl(l, window.location.origin)} />
                  <button type="button" className={`btn btn-quiet btn-sm h-10 ${confirm === l.id ? "text-warn" : ""}`} disabled={Boolean(busy)} onClick={() => (confirm === l.id ? void takeBack(l) : setConfirm(l.id))}>
                    {mine ? (
                      <>
                        <Spinner />
                        {["Waiting for Starknet", "Taking it back"][step]}
                      </>
                    ) : confirm === l.id ? (
                      "Take it back now"
                    ) : (
                      "Take back"
                    )}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-[13px] leading-relaxed text-warn">
          {error}
        </p>
      )}
      <p className="mt-3 text-[12.5px] leading-relaxed text-mute">Kept in this browser only, sealed with your private account. Taking one back moves it into your private balance, less Gloam&apos;s fee the link carries.</p>
    </section>
  );
}

/** The claim in the address bar (a "#sn=" link), read once on arrival and on each new link. */
export function useStarknetClaimInHash(): StarknetClaim | null {
  const [claim, setClaim] = useState<StarknetClaim | null>(null);
  useEffect(() => {
    const read = () => setClaim(claimFromHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return claim;
}

/** Above the open-your-account card when a claim link brought someone here. */
export function StarknetClaimLead({ claim, token }: { claim: StarknetClaim; token: StarknetToken | null }) {
  return (
    <section className="gl-card p-5 sm:p-6">
      <p className="t-eyebrow">A claim link</p>
      <p className="tnum mt-2 text-[28px] font-light leading-none tracking-[-0.02em] text-foreground">
        {token ? `${starkAmount(claim.amount, token)} ${token.symbol}` : "..."}
      </p>
      <p className="mt-2 text-[14px] leading-relaxed text-mute">Open your private account on {STARKNET_NAME} below, then claim it into it.</p>
    </section>
  );
}

/** Receive on Starknet with a claim link in the address bar: claim it into this account. */
export function StarknetClaimCard({ claim }: { claim: StarknetClaim }) {
  const sn = useStarknet();
  const [holding, setHolding] = useState<LinkHolding | null>(null);
  const [readError, setReadError] = useState(false);
  const [working, setWorking] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const links = sn?.links ?? null;
  const token = sn?.token ?? null;
  const wrongNetwork = Boolean(sn && claim.network !== sn.network);

  useEffect(() => {
    if (!links || wrongNetwork) return;
    let live = true;
    void links
      .read(claim.secret)
      .then((h) => live && setHolding(h))
      .catch(() => live && setReadError(true));
    return () => {
      live = false;
    };
  }, [links, claim, wrongNetwork]);

  if (!sn || !links || !token) return null;
  const done = result?.state === "claimed";
  const said = result ? claimMessage(result) : holding && (!holding.open || holding.balance === 0n) ? claimMessage({ state: "empty", open: holding.open }) : null;
  const canClaim = Boolean(holding && holding.open && holding.balance > 0n) && !done && !wrongNetwork;

  return (
    <section className="gl-card max-w-[720px] p-5 sm:p-7" aria-live="polite">
      <p className="t-eyebrow">A claim link</p>
      <p className="tnum mt-2 text-[34px] font-light leading-none tracking-[-0.02em] text-foreground">
        {starkAmount(done ? result.amount : claim.amount, token)} {token.symbol}
      </p>
      <p className="mt-3 max-w-[56ch] text-[14px] leading-relaxed text-mute">
        {done
          ? "Claimed. It's in your private balance now."
          : wrongNetwork
            ? "This link is for another Starknet network than this app."
            : `Claiming moves it into your private account on ${STARKNET_NAME}. The claim shows your private account, never this link or the amount.`}
      </p>
      {!done && !wrongNetwork && holding === null && !readError && (
        <p className="mt-4 flex items-center gap-2 text-[13.5px] text-mute">
          <Spinner /> Checking the link
        </p>
      )}
      {readError && <p className="mt-4 text-[13.5px] text-warn">Couldn&apos;t read the link on {STARKNET_NAME}. Try again in a moment.</p>}
      {said && !done && <p className="mt-4 rounded-[16px] bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-soft">{said}</p>}
      {canClaim && (
        <button
          type="button"
          aria-busy={working || undefined}
          disabled={working}
          className="btn btn-ink btn-lg btn-block mt-5"
          onClick={() => {
            setWorking(true);
            setError(null);
            void links
              .claim(claim.secret, (at) => setStep(at))
              .then((r) => {
                setResult(r);
                if (r.state === "claimed") history.replaceState(null, "", window.location.pathname + window.location.search);
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : "That didn't go through. Try again."))
              .finally(() => setWorking(false));
          }}
        >
          {working ? (
            <>
              <Spinner />
              {["Waiting for Starknet", "Claiming privately"][step]}
            </>
          ) : (
            "Claim to my private account"
          )}
        </button>
      )}
      {working && <SolanaSteps className="mt-4" task={{ kind: "pay", steps: ["Waiting for Starknet", "Claiming privately"], at: step }} />}
      {error && (
        <p role="alert" className="mt-4 break-words rounded-xl bg-danger-soft px-4 py-3 text-[13.5px] leading-relaxed text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
