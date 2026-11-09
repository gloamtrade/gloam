import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { DailyChart } from "@/components/stats/DailyChart";
import { TokenLogo } from "@/components/app/TokenLogo";
import { chainLogoSrc } from "@/lib/chainLogo";
import { liveMainnetCountWords, liveMainnetNames } from "@/lib/mainnet";
import { getPublicStats, type PublicNetwork, type PublicStats } from "@/lib/publicStats";

/**
 * Public numbers for every Gloam mainnet, server-rendered from the cached
 * on-chain figures (lib/publicStats). The HTML is regenerated at most once a
 * minute (ISR), and each regeneration reads a snapshot that is itself shared
 * for a minute, so visitors never reach an RPC. /transparency is the other
 * half: one vault at a time, read in the visitor's own browser.
 *
 * force-static: the chain read's price lookups are no-store fetches, which
 * would otherwise flip this page to dynamic (and fail its regeneration). Here
 * they simply run on each regeneration, which is what the page wants.
 */
export const dynamic = "force-static";
export const revalidate = 60;
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Stats",
  description:
    `Live public numbers for Gloam on ${liveMainnetNames()}: what the vaults hold, and how many deposits, private transfers, cash-outs and payment messages there have been since launch.`,
  alternates: { canonical: "/stats" },
};

/* ---------------------------------------------------------------- format */

const intFmt = new Intl.NumberFormat("en-US");
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return usdFmt.format(n);
}

function fmtHeld(held: string, stable: boolean): string {
  const n = Number(held);
  if (!Number.isFinite(n)) return held;
  if (n > 0 && n < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", { maximumFractionDigits: stable ? 2 : 4 });
}

function utcDate(ms: number, withYear = true): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

function utcTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* ---------------------------------------------------------------- pieces */

function ChainMark({ chainId, size = 28 }: { chainId: number; size?: number }) {
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(chainId)} alt="" width={size} height={size} className="h-full w-full object-cover dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(chainId, true)} alt="" width={size} height={size} className="hidden h-full w-full object-cover dark:block" />
    </span>
  );
}

function Section({ id, title, lead, children }: { id?: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-line py-16 sm:py-24">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
        <div>
          <h2 className="t-display-m max-w-[16ch]">{title}</h2>
          {lead && <p className="mt-4 max-w-[38ch] text-[15px] leading-relaxed text-mute">{lead}</p>}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

const COUNTS = [
  { key: "deposits", label: "Deposits", caption: "Money added to a vault from a public wallet." },
  { key: "transfers", label: "Private transfers", caption: "Payments inside the pool. Sender, recipient and amount stay private." },
  { key: "cashouts", label: "Cash-outs", caption: "Money sent from a vault to a public address." },
  { key: "memos", label: "Payment messages", caption: "Encrypted notes to a recipient. Only the count is public." },
] as const;

function HeldList({ stats }: { stats: PublicStats }) {
  const rows = stats.networks
    .flatMap((n) => n.holdings.map((h) => ({ ...h, network: n.label, chainId: n.chainId })))
    .sort((a, b) => (b.heldUsd ?? -1) - (a.heldUsd ?? -1));
  if (rows.length === 0) {
    return <p className="text-[15px] text-mute">The vaults are empty right now.</p>;
  }
  return (
    <>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((r) => (
          <li key={`${r.chainId}-${r.symbol}`} className="flex min-h-[60px] items-center gap-3 py-2.5">
            {/* the token's own mark, with its network as a small badge */}
            <span className="relative inline-block shrink-0" style={{ width: 28, height: 28 }}>
              <TokenLogo id={r.symbol.toLowerCase().replace(/[^a-z0-9]/g, "")} symbol={r.symbol} size={28} />
              <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-background">
                <ChainMark chainId={r.chainId} size={12} />
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-foreground">{r.symbol}</span>
              <span className="block truncate text-[12.5px] text-mute">{r.network}</span>
            </span>
            <span className="tnum shrink-0 text-right">
              <span className="block text-[15px] text-foreground">{r.heldUsd == null ? "No price" : fmtUsd(r.heldUsd)}</span>
              <span className="block text-[12.5px] text-mute">
                {/* `stable` means a $1 coin, where the amount is the dollar figure. `held` is cut to two
                    decimals and dollars are rounded, so using it here would read a cent apart. */}
                {r.stable && r.heldUsd != null ? fmtHeld(String(r.heldUsd), true) : fmtHeld(r.held, r.stable)} {r.symbol}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {stats.total.unpriced.length > 0 && (
        <p className="mt-3 text-[13px] leading-relaxed text-mute">
          Held but not in the total, with no dollar price: {stats.total.unpriced.join(", ")}.
        </p>
      )}
    </>
  );
}

function NetworkRow({ n }: { n: PublicNetwork }) {
  const counts = [
    [n.deposits, n.deposits === 1 ? "deposit" : "deposits"],
    [n.transfers, n.transfers === 1 ? "private transfer" : "private transfers"],
    [n.cashouts, n.cashouts === 1 ? "cash-out" : "cash-outs"],
    [n.memos, n.memos === 1 ? "payment message" : "payment messages"],
  ] as const;
  return (
    <li className="py-6">
      <div className="flex items-center gap-3">
        <ChainMark chainId={n.chainId} />
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] text-foreground">{n.label}</span>
          <span className="block text-[12.5px] text-mute">
            {n.openedMs ? `Open since ${utcDate(n.openedMs)}` : "Open"}
          </span>
        </span>
        <span className="tnum shrink-0 text-right text-[17px] text-foreground">{fmtUsd(n.heldUsd)}</span>
      </div>
      <ul className="tnum mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[14px] text-mute sm:flex sm:flex-wrap sm:gap-x-6">
        {counts.map(([v, label]) => (
          <li key={label}>
            <span className="text-foreground">{intFmt.format(v)}</span> {label}
          </li>
        ))}
      </ul>
      {(n.readFailed || n.catchingUp) && (
        <p className="mt-3 rounded-xl bg-warn-soft px-4 py-2.5 text-[13px] leading-relaxed text-warn">
          {n.readFailed
            ? "The last read of this network failed, so these are the figures from the read before it."
            : "Still reading this network's history, so its counts may go up."}
        </p>
      )}
      <Link
        href={`/transparency?chain=${n.key}`}
        className="mt-3 inline-flex min-h-[40px] items-center gap-1.5 text-[13.5px] text-mute underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        Check this vault in your browser <span aria-hidden>→</span>
      </Link>
    </li>
  );
}

/** Our own wallets, the same address on every chain, so anyone can take us out of the numbers. */
const TEAM_WALLETS = [
  { label: "Owner", address: "0x76b7E410a227c888aBD2Bdc24Ee32E094B0FD4D8", note: "Runs the vaults and created $GLOAM. Most deposits so far are this wallet testing and paying people." },
  { label: "Treasury", address: "0xB3900ac9350903218e4c7597bAb0f008F01B30B8", note: "Receives the cash-out and swap fees." },
  { label: "Deployer", address: "0x891E74a11abC5D0eC2EE855B2BD521fF9D18F411", note: "Deployed the contracts." },
  { label: "Relayer", address: "0xb1E994586E62994648a0b866BF33F2EDd942512e", note: "Sends private payments and cash-outs and pays their gas." },
] as const;

function TeamWallets() {
  return (
    <ul className="-mt-6 divide-y divide-line">
      {TEAM_WALLETS.map((w) => (
        <li key={w.label} className="py-6">
          <span className="block text-[17px] text-foreground">{w.label}</span>
          <span className="mt-1 block break-all font-mono text-[13px] text-foreground">{w.address}</span>
          <span className="mt-2 block text-[14px] leading-relaxed text-mute">{w.note}</span>
        </li>
      ))}
    </ul>
  );
}

function HowWeCount({ stats }: { stats: PublicStats | null }) {
  const launch = Date.parse(stats?.countedSince ?? "2026-10-21T13:00:00Z");
  const later = (stats?.networks ?? []).filter((n) => n.openedMs && n.openedMs > launch);
  const laterLine = later.length
    ? ` ${listJoin(later.map((n) => n.label))} opened later, on ${listJoin([...new Set(later.map((n) => utcDate(n.openedMs!, false)))])}, and count from then.`
    : "";
  const items = [
    {
      title: "What is counted",
      body: `Every deposit, private transfer, cash-out and payment message recorded by the Gloam vaults on ${liveMainnetNames()}, plus what each vault holds right now. Testnets are not included.`,
    },
    {
      title: "Since when",
      body: `Counts start at the public launch, ${utcDate(launch)} at ${utcTime(launch)} UTC. Team test transactions before then are left out. After launch everything counts, the team's own use included.${laterLine}`,
    },
    {
      title: "Actions, not payments",
      body: "These are counts of on-chain actions. A private cash-out goes out in a few pieces, and each piece is a private transfer and then a cash-out, so one private cash-out adds several to both counts. Cashing out part of a balance adds a transfer too. A private swap adds one cash-out and one deposit.",
    },
    {
      title: "What is not public",
      body: "Settlement is public, amounts and people are not. How much each private transfer moved, and who holds what inside the pool, is not readable on chain, so it is not here. We do not count people either: one person can use many wallets, and cash-outs often go to new addresses.",
    },
    {
      title: "How value is priced",
      body: "Stablecoins count as one dollar. ETH, stock tokens and $GLOAM use live market prices at the time of the read. Anything without a price is named and left out of the total, never counted as zero.",
    },
    {
      title: "Check it yourself",
      body: "Every number comes from public events and balances. The transparency page reads each vault straight from public nodes in your browser, with no Gloam server in between.",
    },
  ];
  return (
    <ul className="grid grid-cols-1 gap-x-10 gap-y-9 sm:grid-cols-2">
      {items.map((i) => (
        <li key={i.title} className="border-t border-foreground pt-5">
          <p className="text-[17px] leading-snug tracking-[-0.01em] text-foreground">{i.title}</p>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-mute">{i.body}</p>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- page */

export default async function StatsPage() {
  const stats = await getPublicStats();
  const readAt = stats ? Date.parse(stats.asOf) : null;
  // A snapshot older than a quarter of an hour: a newer read did not finish in time.
  const stale = stats != null && stats.ageSec > 900;
  const chainNames = stats?.networks.length ? listJoin(stats.networks.map((n) => n.label)) : liveMainnetNames();

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <Header />

      <main className="mx-auto max-w-[1400px] px-4 sm:px-7">
        <section className="pb-16 pt-16 sm:pb-24 sm:pt-24">
          <h1 className="t-display-xl max-w-[14ch]">Gloam in numbers</h1>
          <p className="mt-6 max-w-[54ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
            Every figure here is read from the Gloam vaults on {chainNames} mainnet. Settlement is public, so anyone can
            check it. Amounts and people inside the pool are not.
          </p>
          {readAt != null && (
            <p className="tnum mt-6 text-[13.5px] text-mute">
              Counted since launch on {utcDate(Date.parse(stats!.countedSince))}, {utcTime(Date.parse(stats!.countedSince))} UTC.
              Read from the chains at {utcTime(readAt)} UTC on {utcDate(readAt)}.
            </p>
          )}
          <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-3">
            <a href="#how" className="gl-arrowlink">
              How we count <span aria-hidden>→</span>
            </a>
            <Link href="/transparency" className="gl-arrowlink">
              Check a vault yourself <span aria-hidden>→</span>
            </Link>
          </div>
        </section>

        {!stats ? (
          <section className="border-t border-line py-16 sm:py-24">
            <div role="status" className="max-w-[60ch]">
              <p className="text-[17px] text-foreground">The numbers could not be read just now.</p>
              <p className="mt-2 text-[15px] leading-relaxed text-mute">
                Public nodes sometimes slow down. Reload in a minute, or check each vault yourself on the{" "}
                <Link href="/transparency" className="text-foreground underline underline-offset-4">
                  transparency page
                </Link>
                .
              </p>
            </div>
          </section>
        ) : (
          <>
            {stale && (
              <p role="status" className="mb-6 rounded-xl bg-warn-soft px-4 py-3 text-[13.5px] leading-relaxed text-warn">
                A newer read did not finish in time, so these figures are from {utcTime(readAt!)} UTC on {utcDate(readAt!)}.
              </p>
            )}

            <Section
              title="Held right now"
              lead="The live balance of every vault, added up. It is everyone's money together; nobody can split it back into one person's share."
            >
              <p className="t-display-xl tnum">{fmtUsd(stats.total.heldUsd)}</p>
              <div className="mt-8">
                <HeldList stats={stats} />
              </div>
            </Section>

            <Section title="Since launch" lead={`All ${liveMainnetCountWords()} together.`}>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
                {COUNTS.map((c) => (
                  <div key={c.key} className="border-t border-line-strong pt-4">
                    <dt className="text-[14px] text-mute">{c.label}</dt>
                    <dd className="m-0">
                      <span className="t-display-m tnum mt-2 block text-foreground">{intFmt.format(stats.total[c.key])}</span>
                      <span className="mt-2 block text-[13px] leading-relaxed text-mute">{c.caption}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>

            {stats.daily.length > 0 && (
              <Section
                title="Each day"
                lead={`Deposits, private transfers and cash-outs per UTC day, all ${liveMainnetCountWords()} together. Tap or point at a bar to read its day.`}
              >
                <DailyChart days={stats.daily} />
                {stats.undated > 0 && (
                  <p className="tnum mt-4 text-[13px] leading-relaxed text-mute">
                    {intFmt.format(stats.undated)} {stats.undated === 1 ? "action is" : "actions are"} in the totals above but
                    not in a day yet: the chain read is still dating {stats.undated === 1 ? "its block" : "their blocks"}.
                  </p>
                )}
              </Section>
            )}

            <Section title="By network">
              <ul className="-mt-6 divide-y divide-line">
                {stats.networks.map((n) => (
                  <NetworkRow key={n.key} n={n} />
                ))}
              </ul>
            </Section>
          </>
        )}

        <Section
          id="team"
          title="Our own wallets"
          lead="Team activity counts in the totals above. These are our wallets, the same address on every network, so you can take us out of the numbers."
        >
          <TeamWallets />
        </Section>

        <Section id="how" title="How we count">
          <HowWeCount stats={stats} />
        </Section>
      </main>

      <Footer />
    </div>
  );
}
