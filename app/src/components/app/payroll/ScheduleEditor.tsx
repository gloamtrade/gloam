"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { formatUnits, type Address } from "viem";
import { TokenLogo } from "../TokenLogo";
import { assetDecimals, formatAssetAmount, parseAssetAmount } from "@/lib/shield";
import { amountTextError } from "@/lib/amountText";
import { useModalFocus } from "@/hooks/useModalFocus";
import { NAME_PENDING, PAYROLL_TEMPLATE, draftTotal, parsePayrollCsv } from "@/lib/payroll";
import {
  dayLabel,
  isIsoDay,
  ordinal,
  paydaysAhead,
  peopleFromDraft,
  relativeDay,
  scheduleCsv,
  weekdayName,
  type PayrollSchedule,
  type ScheduleCadence,
} from "@/lib/payrollSchedule";
import { ScheduleIcon, SELF_CUSTODY_NOTE, type AssetOption } from "./scheduleUi";
import { usePayrollNames } from "./usePayrollNames";
import { Select, type SelectOption } from "@/components/ui/Select";

const noopSubscribe = () => () => {};
const ease = [0.22, 1, 0.36, 1] as const;

type Kind = ScheduleCadence["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "monthly", label: "Monthly" },
  { kind: "biweekly", label: "Every two weeks" },
  { kind: "weekly", label: "Weekly" },
  { kind: "once", label: "One time" },
];

/** Monday first, the way a work week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const MONTH_DAYS: SelectOption<number>[] = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: ordinal(i + 1) }));

function people(n: number) {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[13px] text-mute">{label}</p>
      {children}
      {hint ? <p className="mt-1.5 text-[12.5px] leading-relaxed text-mute">{hint}</p> : null}
    </div>
  );
}

/**
 * Create or edit a payroll schedule: a name, a cadence, the currency, a cap per
 * run, an optional end date and the people. Portaled so AppShell transforms
 * cannot pin the fixed layer mid-page.
 */
export function ScheduleEditor({
  base,
  isNew,
  assetOptions,
  today,
  onSave,
  onClose,
}: {
  /** The schedule to edit, or a new one prefilled from a list or a past run. */
  base: PayrollSchedule;
  isNew: boolean;
  assetOptions: AssetOption[];
  today: string;
  onSave: (s: PayrollSchedule) => Promise<void> | void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus starts on the name, stays in the dialog, and goes back to the button
  // that opened it; Escape closes.
  useModalFocus(dialogRef, onClose, { initial: nameRef, open: mounted });

  const c = base.cadence;
  const [name, setName] = useState(base.name);
  const [kind, setKind] = useState<Kind>(c.kind);
  const [monthDay, setMonthDay] = useState(c.kind === "monthly" ? c.day : 1);
  const [weekday, setWeekday] = useState(c.kind === "weekly" ? c.weekday : 5);
  const [from, setFrom] = useState(c.kind === "biweekly" ? c.from : today);
  const [on, setOn] = useState(c.kind === "once" ? c.on : today);
  const [asset, setAsset] = useState<Address>(base.asset);
  const [capInput, setCapInput] = useState(() =>
    BigInt(base.cap) > 0n ? formatUnits(BigInt(base.cap), assetDecimals(base.asset)) : ""
  );
  const [endsOn, setEndsOn] = useState(base.endsOn ?? "");
  const [peopleText, setPeopleText] = useState(() => (base.people.length ? scheduleCsv(base.people, base.asset) : ""));
  const [peopleOpen, setPeopleOpen] = useState(base.people.length === 0);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const token = assetOptions.find((o) => o.address.toLowerCase() === asset.toLowerCase()) ?? assetOptions[0];
  const symbol = token?.symbol ?? "";

  const rawParsed = useMemo(() => parsePayrollCsv(peopleText, asset), [peopleText, asset]);
  // "@ada" in the list: looked up like Payroll does, so a name can be saved (it stays a name)
  const names = usePayrollNames(rawParsed.rows);
  const parsed = useMemo(() => ({ ...rawParsed, rows: names.rows }), [rawParsed, names.rows]);
  const valid = parsed.rows.filter((r) => !r.error);
  // a name still being looked up isn't a mistake to fix: it is counted once its answer is in
  const bad = parsed.rows.filter((r) => r.error && r.error !== NAME_PENDING).length;
  const total = draftTotal(parsed.rows);
  const cap = parseAssetAmount(capInput, asset);
  const over = cap != null && total > cap ? total - cap : 0n;

  const cadence: ScheduleCadence =
    kind === "monthly"
      ? { kind, day: monthDay }
      : kind === "weekly"
        ? { kind, weekday }
        : kind === "biweekly"
          ? { kind, from }
          : { kind, on };
  const datesOk =
    (kind !== "biweekly" || isIsoDay(from)) && (kind !== "once" || isIsoDay(on)) && (!endsOn || isIsoDay(endsOn));
  const paydays = datesOk
    ? paydaysAhead({ cadence, startsOn: base.startsOn, paidThrough: base.paidThrough, endsOn: endsOn || undefined }, 3)
    : [];

  const problem = !name.trim()
    ? "Give the schedule a name."
    : !datesOk
      ? "Check the dates."
      : parsed.error
        ? parsed.error
        : names.pending
          ? "Looking up the @names in the list…"
        : valid.length === 0
          ? "Add at least one person to pay."
          : bad > 0
            ? `Fix ${bad} ${bad === 1 ? "line" : "lines"} in the list first.`
            : amountTextError(capInput, assetDecimals(asset))
              ? `Cap: ${amountTextError(capInput, assetDecimals(asset))}`
            : cap == null || cap <= 0n
              ? "Set a cap above zero."
              : over > 0n
                ? `The list is ${formatAssetAmount(over, asset)} ${symbol} over the cap. Raise the cap or trim the list.`
                : paydays.length === 0
                  ? "With these dates there is no payday left. Pick a later date."
                  : null;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function save() {
    setTried(true);
    if (problem || cap == null) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await onSave({
        ...base,
        name: name.trim().slice(0, 60),
        asset,
        cadence,
        cap: cap.toString(),
        endsOn: endsOn || undefined,
        people: peopleFromDraft(parsed.rows),
      });
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "The schedule could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!mounted) return null;

  const first = paydays[0];
  const preview = first
    ? `${isNew || !base.paidThrough ? "First" : "Next"} payday ${dayLabel(first, today)} (${relativeDay(first, today)})${
        paydays.length > 1
          ? `, then ${paydays
              .slice(1)
              .map((p) => dayLabel(p, today))
              .join(" and ")}`
          : ""
      }.`
    : "No payday left with these dates.";

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-[200] flex items-end justify-center outline-none sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-editor-title"
    >
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative z-[1] flex max-h-[min(92dvh,820px)] w-full max-w-[600px] flex-col overflow-hidden bg-panel shadow-pop max-sm:rounded-t-[22px] sm:rounded-[24px]"
        initial={reduce ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line max-sm:px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
          <div className="min-w-0">
            <p className="t-eyebrow">{isNew ? "New schedule" : "Edit schedule"}</p>
            <h2
              id="schedule-editor-title"
              className="mt-1.5 truncate text-[22px] font-light leading-tight tracking-[-0.012em] text-foreground"
            >
              {name.trim() || "Untitled schedule"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
          >
            <ScheduleIcon name="x" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto max-sm:px-5 py-5 sm:px-7">
          <label className="block">
            <span className="mb-1.5 block text-[13px] text-mute">Name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="Team payroll"
              className="gl-input h-11 text-[14px]"
            />
          </label>

          <Field label="Repeats">
            <div className="grid grid-cols-2 gap-1.5 rounded-[14px] bg-surface p-1 sm:grid-cols-4" role="radiogroup" aria-label="Repeats">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.kind}
                  onClick={() => setKind(k.kind)}
                  className={`h-10 rounded-[10px] px-2 text-[13px] transition-colors duration-200 ${
                    kind === k.kind ? "bg-panel text-foreground shadow-card" : "text-mute hover:text-foreground"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>

            <div className="mt-3">
              {kind === "monthly" && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[14px] text-foreground">On the</span>
                  <div className="w-[112px]">
                    <Select
                      label="Day of the month"
                      value={monthDay}
                      onChange={setMonthDay}
                      options={MONTH_DAYS}
                      className="h-11 text-[14px]"
                    />
                  </div>
                  <span className="text-[13px] text-mute">
                    {monthDay > 28 ? "or the last day, in shorter months" : "of every month"}
                  </span>
                </div>
              )}
              {kind === "weekly" && (
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Weekday">
                  {WEEK.map((d) => (
                    <button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={weekday === d}
                      aria-label={weekdayName(d)}
                      onClick={() => setWeekday(d)}
                      className={`h-10 min-w-[52px] rounded-full border px-3 text-[13px] transition-colors duration-200 ${
                        weekday === d
                          ? "border-foreground bg-panel text-foreground"
                          : "border-line text-mute hover:border-line-strong hover:text-foreground"
                      }`}
                    >
                      {weekdayName(d, true)}
                    </button>
                  ))}
                </div>
              )}
              {kind === "biweekly" && (
                <label className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[14px] text-foreground">Starting</span>
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="gl-input h-11 w-auto min-w-[170px] text-[14px]"
                  />
                  <span className="text-[13px] text-mute">then every 14 days</span>
                </label>
              )}
              {kind === "once" && (
                <label className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[14px] text-foreground">On</span>
                  <input
                    type="date"
                    value={on}
                    min={today}
                    onChange={(e) => setOn(e.target.value)}
                    className="gl-input h-11 w-auto min-w-[170px] text-[14px]"
                  />
                </label>
              )}
            </div>
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Pay in">
              <Select
                label="Currency"
                value={token?.address ?? asset}
                onChange={setAsset}
                options={assetOptions.map((o) => ({
                  value: o.address,
                  label: o.symbol,
                  icon: <TokenLogo id={o.logoId} symbol={o.symbol} size={26} />,
                }))}
                className="h-11 text-[14px]"
              />
            </Field>
            <Field
              label="Cap per run"
              hint={
                total > 0n && cap != null && cap > 0n
                  ? over > 0n
                    ? <span className="text-warn">The list is over the cap, so a run would be blocked.</span>
                    : `This list is ${formatAssetAmount(total, asset)} ${symbol}.`
                  : "A run above this is blocked before anything is sent."
              }
            >
              <div className="relative">
                <input
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`Cap per run, in ${symbol}`}
                  className="gl-input tnum h-11 pr-20 text-[14px]"
                />
                <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[13px] text-mute">
                  {symbol}
                </span>
              </div>
            </Field>
          </div>

          <Field label="Ends" hint={endsOn ? "No runs after this day." : "Optional. Leave it open and it repeats until you stop it."}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={endsOn}
                min={today}
                onChange={(e) => setEndsOn(e.target.value)}
                aria-label="End date"
                className="gl-input h-11 w-auto min-w-[170px] text-[14px]"
              />
              {endsOn && (
                <button type="button" onClick={() => setEndsOn("")} className="btn btn-quiet btn-sm h-10 text-mute">
                  No end date
                </button>
              )}
            </div>
          </Field>

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13px] text-mute">People</p>
              <button
                type="button"
                onClick={() => setPeopleOpen((v) => !v)}
                aria-expanded={peopleOpen}
                className="btn btn-quiet btn-sm -mr-3 h-9 text-mute hover:text-foreground"
              >
                <ScheduleIcon name="pencil" className="h-3.5 w-3.5" />
                {peopleOpen ? "Hide list" : "Edit list"}
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 rounded-[14px] bg-surface px-4 py-3 text-[13.5px]">
              <span className="min-w-0 truncate text-foreground">
                {valid.length ? people(valid.length) : "No one yet"}
                {bad > 0 && <span className="text-warn">, {bad} to fix</span>}
              </span>
              <span className="tnum shrink-0 text-foreground">
                {formatAssetAmount(total, asset)} <span className="text-mute">{symbol}</span>
              </span>
            </div>
            <AnimatePresence initial={false}>
              {peopleOpen && (
                <motion.div
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease }}
                  className="overflow-hidden"
                >
                  <label className="block pt-3">
                    <span className="mb-2 block text-[12.5px] text-mute">
                      One person per line: name, Gloam address (blank for a claim link), amount, and a
                      private note if you like
                    </span>
                    <textarea
                      value={peopleText}
                      onChange={(e) => setPeopleText(e.target.value)}
                      rows={6}
                      spellCheck={false}
                      placeholder={PAYROLL_TEMPLATE}
                      wrap="off"
                      className="gl-input tnum h-auto resize-y overflow-x-auto whitespace-pre py-3 text-[13px] leading-[1.7]"
                    />
                  </label>
                  {parsed.rows.some((r) => r.error && r.error !== NAME_PENDING) && (
                    <ul className="mt-2 space-y-1 text-[12.5px] text-warn">
                      {parsed.rows
                        .filter((r) => r.error && r.error !== NAME_PENDING)
                        .slice(0, 3)
                        .map((r) => (
                          <li key={r.line}>
                            Line {r.line}: {r.error}
                          </li>
                        ))}
                    </ul>
                  )}
                  {names.failed && (
                    <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={names.retry}>
                      Look the names up again
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="flex items-start gap-3 rounded-[14px] border border-line px-4 py-3.5">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-foreground">
              <ScheduleIcon name="calendar" className="h-4 w-4" />
            </span>
            <div className="min-w-0 text-[13px] leading-relaxed">
              <p className="text-foreground">{preview}</p>
              <p className="mt-1 text-mute">{SELF_CUSTODY_NOTE}</p>
            </div>
          </div>
        </div>

        <footer className="border-t border-line max-sm:px-5 py-4 sm:px-7">
          {((tried && problem) || saveErr) && (
            <p className="mb-3 flex items-start gap-2 text-[13px] text-warn" role="alert">
              <ScheduleIcon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{tried && problem ? problem : saveErr}</span>
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={() => void save()} disabled={saving} className="btn btn-ink">
              {isNew ? "Save schedule" : "Save changes"}
            </button>
          </div>
        </footer>
      </motion.div>
    </div>,
    document.body
  );
}
