"use client";

/**
 * /admin: sign-in, the metrics read, and the frame (header, the section list,
 * the mainnet/testnet switch). Each section lives in ./tabs; the traction
 * sections share one read of /api/admin/metrics, worked out per side in
 * ./side. Mainnet and the testnets are two separate views, never mixed.
 */
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Logo } from "@/components/Logo";
import { SealedField } from "@/components/ui/SealedField";
import { ThemeToggle } from "@/components/ThemeToggle";
import { VotesPanel } from "./AdminVotes";
import { ADMIN_REFRESH_MS, chainsOn, type Env, type MetricsPayload, type Tab } from "./data";
import { agoMs, fmtAge, fmtWhen } from "./format";
import { useSide } from "./side";
import { Loading, Notice } from "./ui";
import { BugsTab } from "./tabs/Bugs";
import { ContestTab } from "./tabs/Contest";
import { EventsTab } from "./tabs/Events";
import { HuntTab } from "./tabs/Hunt";
import { OverviewTab } from "./tabs/Overview";
import { PartnersTab } from "./tabs/Partners";
import { RelayTab } from "./tabs/Relay";
import { RevenueTab } from "./tabs/Revenue";
import { TestersTab } from "./tabs/Testers";
import { UpdatesTab } from "./tabs/Updates";
import { WalletsTab } from "./tabs/Wallets";

const ENV_KEY = "gloam.admin.env";

/** The view to open: ?env= in the address, then the last one picked here, else mainnet. */
function readEnv(): Env {
  if (typeof window === "undefined") return "mainnet";
  const q = new URLSearchParams(window.location.search).get("env");
  if (q === "testnet" || q === "mainnet") return q;
  try {
    return window.localStorage.getItem(ENV_KEY) === "testnet" ? "testnet" : "mainnet";
  } catch {
    return "mainnet";
  }
}

const TABS: Tab[] = ["overview", "revenue", "relay", "users", "events", "partners", "testers", "contest", "updates", "bugs", "votes", "hunt"];

/** The section to open: ?tab= in the address, else the overview. */
function readTab(): Tab {
  if (typeof window === "undefined") return "overview";
  const q = new URLSearchParams(window.location.search).get("tab");
  return TABS.includes(q as Tab) ? (q as Tab) : "overview";
}

/** Sections whose figures follow the mainnet/testnet switch. */
const SIDED: Tab[] = ["overview", "revenue", "relay", "users", "events", "partners"];

function tabTitle(t: Tab, isMain: boolean): string {
  return {
    overview: "Overview",
    revenue: isMain ? "Revenue" : "Fees",
    relay: "Bridge and swaps",
    users: "Wallets",
    events: "Product events",
    partners: "Partners",
    testers: "Testers",
    contest: "Contest",
    updates: "Email updates",
    bugs: "Bug reports",
    votes: "Votes",
    hunt: "Hunt",
  }[t];
}

function tabLine(t: Tab, isMain: boolean): string {
  switch (t) {
    case "overview":
      return isMain
        ? `${chainsOn("mainnet")} mainnet: money people really moved, what it earned, and the product funnel.`
        : `${chainsOn("testnet")} testnets: activity from testing. None of it counts toward mainnet.`;
    case "revenue":
      return isMain ? "Cash-out fees kept by the mainnet vaults, by window, asset and day." : "Testnet cash-out fees from testing. Not revenue.";
    case "relay":
      return "Bridges in through Relay deposit addresses, and same-chain swaps of the gas coin.";
    case "users":
      return "Different wallets using Gloam, counted one way, and the depositors read from the chain.";
    case "events":
      return "What the app records, for visitors who accepted analytics. Never amounts, names or addresses.";
    case "partners":
      return "Every partner, what they brought in by source, and their link codes and addresses.";
    case "testers":
      return "Tester applications, paid spots and volunteers.";
    case "contest":
      return "Video contest entries, with the flags to check before judging.";
    case "updates":
      return "People who asked for Gloam updates by email, and where they joined.";
    case "bugs":
      return "Reports the Telegram helper saved from Testers, Feedback and /bug.";
    case "votes":
      return "Every vote's tallies and ballots, the holders who connected, and private feedback.";
    case "hunt":
      return "The treasure hunt: how far people got, and whether the prize is claimed.";
  }
}

export function AdminDashboard() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTabState] = useState<Tab>(readTab);
  const [env, setEnvState] = useState<Env>(readEnv);

  /** Keeps a setting in the address (and the env in this browser) without a reload. */
  const setParam = (key: string, value: string | null) => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  };

  /** Mainnet or testnet, kept in the address (?env=testnet) and in this browser. */
  const setEnv = useCallback((next: Env) => {
    setEnvState(next);
    try {
      window.localStorage.setItem(ENV_KEY, next);
    } catch {
      /* private window: the address still keeps it */
    }
    setParam("env", next === "testnet" ? "testnet" : null);
  }, []);

  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    setParam("tab", next === "overview" ? null : next);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/session", { credentials: "include" });
      if (res.status === 503) {
        setAuthed(false);
        setLoginErr("ADMIN_ACCESS_CODE is not set on the server.");
        return false;
      }
      if (res.status === 401) {
        setAuthed(false);
        return false;
      }
      if (!res.ok) {
        setAuthed(false);
        setLoginErr("Could not verify session.");
        return false;
      }
      setAuthed(true);
      return true;
    } catch {
      setAuthed(false);
      setLoginErr("Network error checking session.");
      return false;
    }
  }, []);

  const loadMetrics = useCallback(async (fresh = false) => {
    setLoadErr(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/metrics${fresh ? "?fresh=1" : ""}`, { credentials: "include" });
      if (res.status === 401) {
        setAuthed(false);
        setData(null);
        return;
      }
      // Session is valid if we got past 401, don't freeze on metrics failure
      setAuthed(true);
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setLoadErr(json?.error ?? `Metrics failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as MetricsPayload;
      setData(json);
    } catch (e) {
      // Keep dashboard shell if session was already true
      setLoadErr(e instanceof Error ? e.message : "Network error loading metrics");
      setAuthed((prev) => (prev === null ? false : prev));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const ok = await checkSession();
      if (ok) await loadMetrics();
    })();
  }, [checkSession, loadMetrics]);

  useEffect(() => {
    if (!authed) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMetrics();
    }, ADMIN_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [authed, loadMetrics]);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginErr(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        credentials: "include",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setLoginErr(json.error ?? "Login failed");
        setAuthed(false);
        return;
      }
      setCode("");
      setAuthed(true);
      await loadMetrics();
    } catch {
      setLoginErr("Network error");
      setAuthed(false);
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    setAuthed(false);
    setData(null);
  }

  // Hooks must run every render (before any early return), React #310
  const side = useSide(data, env);

  // On a phone the section strip scrolls sideways: keep the open section in view.
  useEffect(() => {
    document.querySelector<HTMLElement>("[data-strip-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, env, authed]);

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3" role="status">
          <span className="livedot h-2 w-2 rounded-full bg-foreground/60" />
          <p className="text-[13px] text-mute">Checking your session</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex min-h-dvh flex-col bg-background p-3 sm:p-4">
        <div className="gl-panel flex flex-1 flex-col">
          <SealedField />
          <header className="flex h-16 items-center justify-between px-5 sm:px-8">
            <Logo />
            <span className="rounded-full bg-panel/70 px-3 py-1 text-[12px] text-mute">Restricted</span>
          </header>

          <main className="flex flex-1 flex-col items-center justify-center px-2 py-12 sm:px-5">
            <div className="w-full max-w-[420px]">
              <div className="gl-glass p-2 shadow-pop">
                <div className="rounded-[12px] bg-panel p-6 sm:p-7">
                  <p className="t-eyebrow">Admin</p>
                  <h1 className="t-display-m mt-2 text-foreground">Traction</h1>
                  <p className="mt-2 text-[14px] leading-relaxed text-mute">
                    On-chain volume, unique wallets, and product funnel. Access code required. Not public.
                  </p>

                  <form onSubmit={onLogin} className="mt-7 space-y-4">
                    <label className="block">
                      <span className="text-[13px] text-mute">Access code</span>
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder="••••••••••••"
                        className="gl-input mt-2"
                        required
                      />
                    </label>
                    {loginErr && (
                      <p className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger" role="alert">
                        {loginErr}
                      </p>
                    )}
                    <button type="submit" disabled={busy} className="btn btn-ink btn-lg btn-block">
                      {busy ? "Checking…" : "Enter console"}
                    </button>
                  </form>
                </div>
              </div>
              <p className="mt-5 text-center text-[12px] text-mute">
                Set <code className="rounded-md bg-panel/70 px-1.5 py-0.5 text-foreground">ADMIN_ACCESS_CODE</code> on Vercel
              </p>
            </div>
          </main>
        </div>
      </div>
    );
  }

  const isMain = env === "mainnet";
  // Bridge and swaps run on mainnet only.
  const shown: Tab = !isMain && tab === "relay" ? "overview" : tab;
  const sided = SIDED.includes(shown);
  const groups: { title: string; tabs: Tab[] }[] = [
    { title: "Traction", tabs: ["overview", "revenue", ...(isMain ? (["relay"] as Tab[]) : []), "users", "events"] },
    { title: "Operations", tabs: ["partners", "testers", "contest", "updates", "bugs", "votes", "hunt"] },
  ];
  const backend = data?.product?.backend;
  const oc = side.oc;

  const navButton = (id: Tab, strip = false) => (
    <button
      key={id}
      type="button"
      aria-current={shown === id ? "page" : undefined}
      data-strip-current={strip && shown === id ? "" : undefined}
      onClick={() => setTab(id)}
      className={
        strip
          ? `h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] transition-colors ${
              shown === id ? "bg-panel font-medium text-foreground shadow-card" : "text-mute hover:text-foreground"
            }`
          : `flex h-9 w-full items-center rounded-[10px] px-3 text-left text-[14px] transition-colors ${
              shown === id ? "bg-surface-2 font-medium text-foreground" : "text-mute hover:bg-surface hover:text-foreground"
            }`
      }
    >
      {tabTitle(id, isMain)}
    </button>
  );

  return (
    <div className="gloam-app min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-line bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Logo />
            <span className="hidden rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-mute sm:inline">Admin</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-2 hidden text-[12px] text-mute md:inline" role="status">
              {loading ? "Reading…" : data?.generatedAt ? `Read ${agoMs(Date.parse(data.generatedAt))}` : "Not read yet"}
              {backend ? ` · ${backend === "redis" ? "Redis" : "Memory"}, every minute` : ""}
            </span>
            <button type="button" onClick={() => void loadMetrics(true)} disabled={loading} className="btn btn-ghost btn-sm" aria-busy={loading}>
              {loading ? "Reading…" : "Refresh"}
            </button>
            <ThemeToggle />
            <button type="button" onClick={() => void onLogout()} className="btn btn-quiet btn-sm">
              Log out
            </button>
          </div>
        </div>
      </header>

      <div className="adm-shell mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <aside className="adm-side">
          <div className="sticky top-16 space-y-7 py-8">
            <EnvSwitch env={env} onChange={setEnv} block />
            <nav aria-label="Admin sections" className="space-y-6">
              {groups.map((g) => (
                <div key={g.title}>
                  <p className="mb-1.5 px-3 text-[12px] text-faint">{g.title}</p>
                  <ul className="space-y-0.5">{g.tabs.map((t) => <li key={t}>{navButton(t)}</li>)}</ul>
                </div>
              ))}
            </nav>
            <p className="px-3 text-[12px] leading-relaxed text-faint">
              The switch applies to Traction and Partners. Mainnet and testnet are never added together.
            </p>
          </div>
        </aside>

        <main className="min-w-0 space-y-5 pb-16 pt-6 sm:pt-8 lg:pt-10">
          <div className="adm-tabs space-y-3">
            <EnvSwitch env={env} onChange={setEnv} />
            <nav aria-label="Admin sections" className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
              <div className="flex w-max items-center gap-0.5 rounded-full bg-surface-2 p-1">
                {groups[0]!.tabs.map((t) => navButton(t, true))}
                <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-line-strong" />
                {groups[1]!.tabs.map((t) => navButton(t, true))}
              </div>
            </nav>
          </div>

          <div className="gl-pagehead gap-3 pb-1">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="t-display-m">{shown === "overview" && !isMain ? "Testnet overview" : tabTitle(shown, isMain)}</h1>
                {sided && (
                  <span className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${isMain ? "bg-sealed-soft text-sealed" : "bg-warn-soft text-warn"}`}>
                    {isMain ? "Mainnet" : "Testnet"}
                  </span>
                )}
              </div>
              <p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-mute">{tabLine(shown, isMain)}</p>
            </div>
            {shown === "overview" && (
              <dl className="tnum flex shrink-0 gap-6 text-[12.5px]">
                <div>
                  <dt className="text-faint">Last activity</dt>
                  <dd className="mt-0.5 text-soft">{fmtWhen(side.agg?.lastActivity)}</dd>
                </div>
                <div>
                  <dt className="text-faint">Chain read</dt>
                  <dd className="mt-0.5 text-soft">{oc ? `${fmtAge(oc.ageSec)}, ${oc.source === "fresh" ? "just now" : `cached in ${oc.source}`}` : "Not yet"}</dd>
                </div>
              </dl>
            )}
          </div>

          {sided && !isMain && (
            <Notice tone="warn">You are looking at the testnets. Everything here is from testing; switch to Mainnet for the mainnet numbers.</Notice>
          )}

          {loadErr && <Notice tone="danger">{loadErr}</Notice>}

          {sided && shown !== "partners" && !data && !loadErr && <Loading label="Reading the chains. The first read after a deploy can take half a minute." />}

          {sided && shown !== "partners" && side.ocError && <Notice tone="danger">On-chain: {side.ocError}</Notice>}

          {sided &&
            shown !== "partners" &&
            side.nets
              .filter((m) => m.error || m.catchingUp)
              .map((m) => (
                <Notice key={m.key} tone={m.error ? "danger" : "warn"}>
                  {m.error
                    ? `${side.nameOf(m)}: the last read failed (${m.error}). Showing what was read before.`
                    : `${side.nameOf(m)}: still reading its history, up to block ${m.scannedTo} of ${m.latestBlock}. The next refresh continues.`}
                </Notice>
              ))}

          {shown === "overview" && <OverviewTab side={side} go={setTab} />}
          {shown === "revenue" && <RevenueTab side={side} bridgeFeeBps={data?.revenueConfig?.bridgeFeeBps ?? null} />}
          {shown === "relay" && <RelayTab side={side} />}
          {shown === "users" && <WalletsTab side={side} />}
          {shown === "events" && <EventsTab side={side} />}
          {shown === "partners" && <PartnersTab tier={env} />}
          {shown === "testers" && <TestersTab />}
          {shown === "contest" && <ContestTab />}
          {shown === "updates" && <UpdatesTab />}
          {shown === "bugs" && <BugsTab />}
          {shown === "votes" && <VotesPanel />}
          {shown === "hunt" && <HuntTab />}

          <p className="tnum border-t border-line pt-5 text-[12px] text-mute">
            Generated {data?.generatedAt ?? "not yet"} ·{" "}
            <Link href="/app" className="text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground">
              Open app
            </Link>
          </p>
        </main>
      </div>
    </div>
  );
}

/** Mainnet or Testnet: two separate views, never mixed. */
function EnvSwitch({ env, onChange, block = false }: { env: Env; onChange: (e: Env) => void; block?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Network" className={`${block ? "grid w-full grid-cols-2" : "inline-flex"} rounded-full bg-surface-2 p-1 text-[13px]`}>
      {(
        [
          ["mainnet", "Mainnet", "bg-sealed"],
          ["testnet", "Testnet", "bg-warn"],
        ] as const
      ).map(([id, label, dot]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={env === id}
          onClick={() => onChange(id)}
          className={`inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 transition-colors ${
            env === id ? "bg-panel font-medium text-foreground shadow-card" : "text-mute hover:text-foreground"
          }`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {label}
        </button>
      ))}
    </div>
  );
}
