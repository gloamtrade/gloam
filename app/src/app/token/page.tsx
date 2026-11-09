import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import { SealedField } from "@/components/ui/SealedField";
import { MainnetCopy } from "@/components/MainnetCountdown";
import { robinhood } from "@/lib/chain";
import { joinNames, liveMainnetNames, mainnetPool } from "@/lib/mainnet";
import { CopyAddress, TokenFilm } from "./TokenClient";
import { VOTES } from "@/lib/vote/config";
import { CASH_OUT_FEE_BPS, MAX_CASH_OUT_FEE_BPS, bpsPercent } from "@/lib/cashOutFee";
import { BURN_ADDRESS, BUYBACKS, GLOAM_TOKEN, TREASURY_ADDRESS, buybackBurnedUnits, toUnits } from "@/lib/buybacks";
import { readTokenLive, type TokenLive, type VaultFee } from "@/lib/tokenLive";
import { ELYSIUM } from "@/lib/elysium";
import { chainLogoSrc } from "@/lib/chainLogo";

/**
 * The fees and the burn address are read from chain on the server
 * (lib/tokenLive). force-static keeps the page static between regenerations:
 * the RPC reads run at most once every 10 minutes, never per visitor.
 */
export const dynamic = "force-static";
export const revalidate = 600;
export const maxDuration = 60;

const ORYNTH_URL = "https://www.orynth.dev/projects/gloam";
const RH_EXPLORER = robinhood.blockExplorers.default.url;
const EXPLORER_URL = `${RH_EXPLORER}/token/${GLOAM_TOKEN}`;
/** The launch pool: Uniswap v4 on Robinhood Chain, $GLOAM and ETH. DEX Screener names it by its v4 pool id. */
const DEXSCREENER_URL = "https://dexscreener.com/robinhood/0xc5f373710186d788eee3048f9ff92608d344e3360b2a35bea98068146e18dd1a";
const BURN_URL = `${RH_EXPLORER}/token/${GLOAM_TOKEN}?a=${BURN_ADDRESS}`;
const RH_TX = (hash: string) => `${RH_EXPLORER}/tx/${hash}`;
const GITHUB = "https://github.com/gloamtrade/gloam";

/**
 * Independent review. Says only that one is requested, never that it started
 * or finished. Change the line when that changes, with the report linked.
 */
const INDEPENDENT_REVIEW_REQUESTED = true;

/** A holder vote is published (lib/vote/config): the hero links to it. */
const HOLDER_VOTE = VOTES.some((v) => v.published);

/** The Robinhood Chain mainnet pool (the one that lists $GLOAM) is filled in. */
const RH_MAINNET = mainnetPool(4663) !== null;

export const metadata: Metadata = {
  title: "$GLOAM",
  // Fixed at build time: says the pool holds it once the Robinhood Chain mainnet pool is filled in.
  description: RH_MAINNET
    ? "$GLOAM is the Gloam token on Robinhood Chain. Holders steer Gloam, half of Gloam's fees buy it back, and you can hold it privately in the Robinhood Chain mainnet pool."
    : "$GLOAM is the Gloam token on Robinhood Chain. Holders steer Gloam, half of Gloam's fees buy it back, and from mainnet you can hold it privately.",
  alternates: { canonical: "/token" },
  openGraph: {
    title: "$GLOAM, the Gloam token",
    description: "Governance, buybacks from Gloam's fees, private holding and first access. Live on Robinhood Chain.",
    images: ["/media/gloam-token-poster.jpg"],
  },
  // without this, /token takes the site's X card, and Telegram showed that instead of the poster
  twitter: { card: "summary_large_image", images: ["/media/gloam-token-poster.jpg"] },
};

/* ---------- the facts ---------- */

const FACTS = [
  { value: "500,000", body: "Fixed supply. The contract has no way to mint more." },
  { value: "Locked", body: "The launch liquidity is locked for good." },
  { value: "No presale", body: "Every token started in the pool. No team allocation." },
  { value: "Robinhood Chain", body: "Live on mainnet today, launched on Orynth." },
];

/* ---------- what it does ---------- */

/** The copy that names the cash-out fee, built from the fee the vaults read. */
function pageCopy(fee: string) {
const USES: Use[] = [
  {
    n: "01",
    title: "Governance",
    body: "Holders vote on what Gloam does next: new assets, new chains, deposit limits and fees. The first votes run in the open. Private voting, where you prove your balance without showing your wallet, comes after.",
    when: "First vote at mainnet",
  },
  {
    n: "02",
    title: "Buybacks",
    body: `At mainnet, direct deposits and private payments are free and cash-outs carry ${fee}. The plan: half of Gloam's fees buy $GLOAM from the market, then half of that is burned and half goes to the Gloam treasury.`,
    when: "Starts when fees go live",
  },
  {
    n: "03",
    title: "Private holding",
    body: "The Robinhood Chain mainnet pool lists $GLOAM next to USDG. Shield it and your balance leaves the public record, and you can still prove it to someone when you need to.",
    when: "At mainnet",
  },
  {
    n: "04",
    title: "First access",
    body: "Holders get new Gloam features first, from agent tools to payroll upgrades.",
    when: "After mainnet",
  },
];

/* ---------- what holders ask ---------- */

const QUESTIONS: Question[] = [
  {
    q: "What is it for, besides governance?",
    a: "Buybacks tie it to how much Gloam gets used, you can hold it privately in the vault from mainnet, and holders get new features first.",
  },
  {
    q: "How much does the team hold?",
    a: "None. There was no team allocation and no presale, so there is nothing to vest or unlock. Every token started in the pool, and the launch liquidity is locked.",
  },
  {
    q: "Then how is the team paid?",
    a: `By the product, not the token. From mainnet a cash-out carries ${fee}: half of Gloam's fees run the team and the service, half buy back $GLOAM. Orynth also pays a small creator fee on trades. Payroll and API fees come later.`,
  },
  {
    q: "Burned or kept?",
    a: "The plan is half of every buyback burned and half to the Gloam treasury. So far every round was burned in full. Burned tokens sit at the burn address and can never move.",
  },
  {
    q: "Can I check all this myself?",
    a: "Yes. The fees and the burn address on this page are read from chain, and every buyback links its transactions. See Fees and Buybacks above.",
  },
  {
    q: "Is there staking?",
    a: "Not for yield. Later, relayers that help run Gloam will stake $GLOAM to take part.",
  },
  {
    q: "Is there an airdrop for testnet users?",
    a: "Nothing is decided. If that changes, you will hear it from @gloamtrade on X first.",
  },
];

/* ---------- roadmap ---------- */

const PHASES: Phase[] = [
  {
    tag: "Done",
    title: "Rails first",
    done: true,
    items: [
      "$GLOAM live on Robinhood Chain, with a fixed supply and locked liquidity",
      "Private payments live on Tempo and Robinhood Chain testnet",
      "Trusted setup closed with 13 contributors",
      "$GLOAM listed in the mainnet pool, ready for deploy",
    ],
  },
  {
    tag: "Next",
    title: "Mainnet",
    items: [
      "Gloam goes live on Tempo and Robinhood Chain mainnet",
      "Shield $GLOAM in the Robinhood Chain pool: the deposit limits sit above the 500,000 supply, so they don't cap a deposit",
      "Fees switch on, and half of them start buying back $GLOAM",
      "The first holder vote, held in the open",
    ],
  },
  {
    tag: "Then",
    title: "After mainnet",
    items: ["Private voting with a proof of your balance", "Holders get new features first"],
  },
  {
    tag: "Later",
    title: "Run the network",
    items: ["Relayers stake $GLOAM to help run Gloam"],
  },
];

/* ---------- the same, once mainnet is live ---------- */

const LIVE_USES: Use[] = [
  { ...USES[0], when: "First vote ran 29 Oct to 1 Nov", whenHref: "/vote" },
  {
    ...USES[1],
    body: `On mainnet, direct deposits and private payments are free and cash-outs carry ${fee}. The plan: half of Gloam's fees buy $GLOAM from the market, then half of that is burned and half goes to the Gloam treasury.`,
    when: "Fees live on mainnet",
  },
  RH_MAINNET
    ? {
        ...USES[2],
        body: "The Robinhood Chain mainnet pool lists $GLOAM next to USDG. Shield it (the deposit limits sit above the 500,000 supply) and your balance leaves the public record, and you can still prove it to someone when you need to.",
        when: "Live on mainnet",
      }
    : USES[2],
  { ...USES[3], when: "Next" },
];

const LIVE_QUESTIONS: Question[] = QUESTIONS.map((x, i) =>
  i === 0 && RH_MAINNET
    ? { ...x, a: "Buybacks tie it to how much Gloam gets used, you can hold it privately in the Robinhood Chain mainnet vault, and holders get new features first." }
    : i === 2
      ? { ...x, a: `By the product, not the token. On mainnet a cash-out carries ${fee}: half of Gloam's fees run the team and the service, half buy back $GLOAM. Orynth also pays a small creator fee on trades. Payroll and API fees come later.` }
      : x
);

const LIVE_PHASES: Phase[] = [
  {
    tag: "Done",
    title: "Rails first",
    done: true,
    items: [
      "$GLOAM live on Robinhood Chain, with a fixed supply and locked liquidity",
      "Private payments live on Tempo and Robinhood Chain testnet",
      "Trusted setup closed with 13 contributors",
    ],
  },
  {
    tag: "Done",
    title: "Mainnet",
    done: true,
    items: [
      `Gloam live on ${liveMainnetNames()} mainnet`,
      ...(RH_MAINNET ? ["Shield $GLOAM in the Robinhood Chain pool: the deposit limits sit above the 500,000 supply, so they don't cap a deposit"] : []),
      `Fees on: direct deposits and payments free, ${fee} on cash-outs, and half of Gloam's fees set to buy back $GLOAM`,
      { text: "First buybacks done, every round burned. See the log", href: "#buybacks" },
    ],
  },
  {
    tag: "Done",
    title: "First holder vote",
    done: true,
    items: [{ text: "Ran in the open from 29 October to 1 November 2026. See what holders chose", href: "/vote" }],
  },
  {
    tag: "Next",
    title: "Holders",
    items: ["Private voting with a proof of your balance", "Holders get new features first"],
  },
  {
    tag: "Later",
    title: "Run the network",
    items: ["Relayers stake $GLOAM to help run Gloam"],
  },
];

return { USES, QUESTIONS, PHASES, LIVE_USES, LIVE_QUESTIONS, LIVE_PHASES };
}

/** One of the token's jobs; `whenHref` links the line that says when it arrives. */
type Use = { n: string; title: string; body: string; when: string; whenHref?: string };
type Question = { q: string; a: string };
/** A roadmap line, or a line that links somewhere. */
type PhaseItem = string | { text: string; href: string };
type Phase = { tag: string; title: string; done?: boolean; items: PhaseItem[] };

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UseRows({ uses }: { uses: Use[] }) {
  return (
    <>
      {uses.map((u) => (
        <div
          key={u.n}
          className="grid grid-cols-1 gap-3 border-b border-line px-5 py-6 last:border-0 sm:grid-cols-[180px_minmax(0,1fr)_200px] sm:items-start sm:gap-8 sm:px-7"
        >
          <p className="text-[18px] tracking-[-0.01em] text-foreground">{u.title}</p>
          <p className="max-w-[60ch] text-[14.5px] leading-relaxed text-mute">{u.body}</p>
          {/* When each job arrives: a plain line, since the green tint is kept for what is private. */}
          <p className="text-[13.5px] text-soft sm:text-right">
            {u.whenHref ? (
              <Link href={u.whenHref} className="underline decoration-line-strong underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground">
                {u.when}
              </Link>
            ) : (
              u.when
            )}
          </p>
        </div>
      ))}
    </>
  );
}

function QuestionRows({ questions }: { questions: Question[] }) {
  return (
    <>
      {questions.map((x) => (
        <div key={x.q} className="grid grid-cols-1 gap-2 py-6 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-8">
          <dt className="text-[17px] leading-snug tracking-[-0.01em]">{x.q}</dt>
          <dd className="text-[14.5px] leading-relaxed text-mute">{x.a}</dd>
        </div>
      ))}
    </>
  );
}

function PhaseList({ phases }: { phases: Phase[] }) {
  return (
    <ol className="relative">
      {phases.map((p, i) => (
        <li key={p.title} className="relative grid grid-cols-[28px_1fr] gap-5 pb-12 last:pb-0">
          {i < phases.length - 1 && (
            <span aria-hidden className="absolute left-[13px] top-8 bottom-0 w-px bg-line" />
          )}
          <span
            aria-hidden
            className={`relative mt-0.5 grid h-7 w-7 place-items-center rounded-full ${
              p.done ? "bg-sealed text-panel" : "border border-line-strong bg-panel text-mute"
            }`}
          >
            {p.done ? <Check /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
          </span>
          <div className="min-w-0">
            <p className="text-[14px] text-mute">{p.tag}</p>
            <p className="mt-1.5 text-[22px] leading-snug tracking-[-0.015em]">{p.title}</p>
            <ul className="mt-4 space-y-2.5">
              {p.items.map((it) => (
                <li key={typeof it === "string" ? it : it.text} className="flex gap-3 text-[14.5px] leading-relaxed text-mute">
                  <span aria-hidden className={`mt-[9px] h-1 w-1 shrink-0 rounded-full ${p.done ? "bg-sealed" : "bg-faint"}`} />
                  <span className="min-w-0">
                    {typeof it === "string" ? (
                      it
                    ) : (
                      <Link href={it.href} className="underline decoration-line-strong underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground">
                        {it.text}
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------- live numbers ---------- */

const amountFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Base units as a token amount for display, to the nearest hundredth. The exact amount is in each row's title. */
function fmtUnits(units: bigint, decimals = 18): string {
  const base = 10n ** BigInt(decimals);
  const cents = (units * 100n + base / 2n) / base;
  return amountFmt.format(Number(cents / 100n) + Number(cents % 100n) / 100);
}

/** "2026-10-31" -> "31 October 2026". */
function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function shortHash(h: string): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

/**
 * The fee as copy says it: the one every vault reads, or the constant when no
 * vault could be read. When the vaults read different fees, copy points to the
 * per-chain list instead of naming one.
 */
function feePhrase(fees: readonly VaultFee[]): string {
  const read = [...new Set(fees.map((f) => f.feeBps).filter((b): b is number => b !== null))];
  if (read.length === 0) return `a ${bpsPercent(CASH_OUT_FEE_BPS)} fee`;
  if (read.length === 1) return `a ${bpsPercent(read[0]!)} fee`;
  return "a fee set per chain (see Fees)";
}

const LINK = "underline decoration-line-strong underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground";

function ChainMark({ chainId, size = 22 }: { chainId: number; size?: number }) {
  return (
    <span className="relative inline-block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(chainId)} alt="" width={size} height={size} className="h-full w-full object-cover dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- small local logos */}
      <img src={chainLogoSrc(chainId, true)} alt="" width={size} height={size} className="hidden h-full w-full object-cover dark:block" />
    </span>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
      {children}
    </a>
  );
}

function SectionHead({ label, title, children }: { label: string; title: string; children?: ReactNode }) {
  return (
    <div>
      <p className="text-[14px] text-mute">{label}</p>
      <h2 className="t-display-l mt-4 max-w-[12ch]">{title}</h2>
      {children && <div className="mt-5 max-w-[38ch] space-y-3 text-[15px] leading-relaxed text-mute">{children}</div>}
    </div>
  );
}

function FeesSection({ live }: { live: TokenLive }) {
  const { fees } = live;
  const toTreasury = fees.filter((f) => f.feeRecipient?.toLowerCase() === TREASURY_ADDRESS.toLowerCase());
  return (
    <section id="fees" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pt-20 sm:pt-28">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
        <SectionHead label="Fees" title="What Gloam charges">
          <p>
            Read from each vault on chain. The vault caps the cash-out fee at {bpsPercent(MAX_CASH_OUT_FEE_BPS)}, and
            raising it takes three days of public notice.
          </p>
        </SectionHead>
        <div className="min-w-0">
          <ul className="divide-y divide-line border-y border-line text-[15px]">
            {[
              ["Deposits", "Free"],
              ["Private payments", "Free"],
            ].map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-6 py-4">
                <span>{k}</span>
                <span className="text-[14px] text-foreground">{v}</span>
              </li>
            ))}
            {fees.map((f) => (
              <li
                key={f.chainId}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 py-4 sm:grid-cols-[minmax(0,1fr)_auto_140px]"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <ChainMark chainId={f.chainId} />
                  <span className="min-w-0">Cash-out on {f.name}</span>
                </span>
                <span className="tnum text-right text-[14px] text-foreground">
                  {f.feeBps === null ? <span className="text-mute">Could not read</span> : bpsPercent(f.feeBps)}
                </span>
                <span className="col-span-2 pl-[34px] text-[13px] text-mute sm:col-span-1 sm:pl-0 sm:text-right">
                  {f.feeRecipient ? (
                    <ExtLink href={f.explorerAddress(f.feeRecipient)}>
                      <span className="tnum">to {shortHash(f.feeRecipient)}</span>
                    </ExtLink>
                  ) : (
                    "Recipient not read"
                  )}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-10">
            <p className="text-[17px] tracking-[-0.01em]">Fees go to the Gloam treasury</p>
            <p className="mt-2 max-w-[60ch] text-[14.5px] leading-relaxed text-mute">
              A cash-out leaves its fee in the vault. Anyone can call collectFees on the vault to send it on, and it can only
              go to the fee recipient above.
            </p>
            <div className="mt-5">
              <CopyAddress address={TREASURY_ADDRESS} />
            </div>
            {toTreasury.length > 0 && (
              <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-mute">
                {toTreasury.map((f) => (
                  <ExtLink key={f.chainId} href={f.explorerAddress(TREASURY_ADDRESS)}>
                    {f.name} <span aria-hidden>↗</span>
                  </ExtLink>
                ))}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function BuybacksSection({ live }: { live: TokenLive }) {
  const decimals = live.decimals ?? 18;
  const fromLog = buybackBurnedUnits();
  const atBurn = live.burnedDead === null ? null : live.burnedDead + (live.burnedZero ?? 0n);
  const byOthers = atBurn !== null && atBurn > fromLog ? atBurn - fromLog : 0n;
  const stats = [
    {
      label: "Burned so far",
      value: atBurn === null ? "Could not read" : `${fmtUnits(atBurn, decimals)}`,
      body:
        byOthers > 0n
          ? `$GLOAM held by the burn address now. ${fmtUnits(fromLog, decimals)} of it came from Gloam buybacks, the rest from other wallets.`
          : "$GLOAM held by the burn address now.",
    },
    {
      label: "Treasury holds",
      value: live.treasury === null ? "Could not read" : `${fmtUnits(live.treasury, decimals)}`,
      body: "$GLOAM in the treasury wallet now.",
    },
  ];
  return (
    <section id="buybacks" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pt-20 sm:pt-28">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
        <SectionHead label="Buybacks" title="Buybacks and burns">
          <p>
            The plan: half of Gloam&apos;s fees buy $GLOAM from the market. Half of what is bought is burned, half goes to
            the treasury.
          </p>
          <p>A buyback runs when the fees are worth a real one. There is no fixed schedule.</p>
        </SectionHead>
        <div className="min-w-0">
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
            {stats.map((x) => (
              <div key={x.label} className="border-t border-foreground pt-5">
                <p className="text-[14px] text-mute">{x.label}</p>
                <p className="tnum mt-2 text-[26px] leading-tight tracking-[-0.02em]">{x.value}</p>
                <p className="mt-3 text-[14px] leading-relaxed text-mute">{x.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-10">
            <p className="text-[14px] text-mute">Burn address on Robinhood Chain</p>
            <div className="mt-3">
              <CopyAddress address={BURN_ADDRESS} />
            </div>
            <p className="mt-3 text-[13.5px] text-mute">
              <ExtLink href={BURN_URL}>
                $GLOAM at the burn address on RobinScan <span aria-hidden>↗</span>
              </ExtLink>
            </p>
          </div>

          <p className="mt-12 text-[17px] tracking-[-0.01em]">Every round</p>
          <ol className="mt-4 divide-y divide-line border-y border-line">
            {[...BUYBACKS].reverse().map((b) => (
              <li key={b.txHash} className="py-6">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <p className="text-[17px] tracking-[-0.01em]">{fmtDay(b.date)}</p>
                  <p className="text-[13.5px] text-mute">Robinhood Chain</p>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-4 text-[14px]">
                  {[
                    ["Bought", b.gloamBought],
                    ["Burned", b.burned],
                    ["To treasury", b.toTreasury],
                  ].map(([k, v]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-[13px] text-mute">{k}</dt>
                      <dd className="tnum mt-1 text-foreground" title={`${v} $GLOAM`}>
                        {fmtUnits(toUnits(v!), decimals)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 max-w-[62ch] text-[14px] leading-relaxed text-mute">
                  {b.note} The burn also took {fmtUnits(toUnits(b.fromFees), decimals)} $GLOAM the treasury already held from
                  Gloam&apos;s fees.
                </p>
                <p className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-mute">
                  {b.buyTxs.map((h, i) => (
                    <ExtLink key={h} href={RH_TX(h)}>
                      {b.buyTxs.length > 1 ? `Buy ${i + 1}` : "Buy"} <span className="tnum">{shortHash(h)}</span>{" "}
                      <span aria-hidden>↗</span>
                    </ExtLink>
                  ))}
                  <ExtLink href={RH_TX(b.txHash)}>
                    Burn <span className="tnum">{shortHash(b.txHash)}</span> <span aria-hidden>↗</span>
                  </ExtLink>
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function SecuritySection({ live }: { live: TokenLive }) {
  const elysiumId = ELYSIUM?.chainId ?? null;
  const elysiumLive = elysiumId !== null && live.fees.some((f) => f.chainId === elysiumId);
  // Read 9 November 2026: owner() on these vaults is a wallet, on Elysium the guard.
  const walletOwned = joinNames(live.fees.filter((f) => f.chainId !== elysiumId).map((f) => f.name));
  const items: { title: string; body: ReactNode }[] = [
    {
      title: "Open source",
      body: (
        <>
          The vault contracts and the circuits are public: <ExtLink href={`${GITHUB}/tree/main/contracts`}>contracts</ExtLink>{" "}
          and <ExtLink href={`${GITHUB}/tree/main/contracts/circuits`}>circuits</ExtLink>.
        </>
      ),
    },
    {
      title: "Trusted setup",
      body: (
        <>
          Closed on 17 October 2026 with 13 contributors, sealed with drand round 6561386. Mainnet uses its final keys:{" "}
          <ExtLink href={`${GITHUB}/releases/tag/ceremony-final`}>the ceremony-final release</ExtLink>.
        </>
      ),
    },
    {
      title: "Proofs checked on chain",
      body: "Every private payment and cash-out carries a Groth16 proof, and the vault checks it on chain before anything moves.",
    },
    {
      title: "Three days of notice",
      body: (
        <>
          On every mainnet vault, a new proof checker, a higher fee or higher deposit limits wait three days in a public
          queue on chain. Lowering a fee or a limit is instant.
          {elysiumLive && <> The Elysium vault is owned by a guard contract (VaultOwnerGuard), so its proof checkers can never be replaced.</>}
          {walletOwned && <> The {walletOwned} vaults are owned by a team wallet.</>} Follow it on{" "}
          <Link href="/transparency" className={LINK}>
            Transparency
          </Link>
          .
        </>
      ),
    },
  ];
  return (
    <section id="security" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pb-20 sm:pb-28">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
        <SectionHead label="Security" title="Security and reviews">
          <p>Only what you can check yourself.</p>
        </SectionHead>
        <div className="min-w-0">
          <ul className="divide-y divide-line border-y border-line">
            {items.map((x) => (
              <li key={x.title} className="grid grid-cols-1 gap-2 py-6 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-8">
                <p className="text-[17px] leading-snug tracking-[-0.01em]">{x.title}</p>
                <p className="text-[14.5px] leading-relaxed text-mute">{x.body}</p>
              </li>
            ))}
          </ul>
          {INDEPENDENT_REVIEW_REQUESTED && (
            <p className="mt-6 max-w-[62ch] text-[14.5px] leading-relaxed text-mute">
              An independent review by Zero Cool (<ExtLink href="https://zerocool.ai">zerocool.ai</ExtLink>) has been
              requested, funded by Kinetiq&apos;s Elysium builder credits. We will publish the report and the fix review
              here.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function GetSection() {
  const ways: { title: string; body: ReactNode }[] = [
    {
      title: "Buy it on Robinhood Chain",
      body: (
        <>
          $GLOAM launched on Orynth into a single-sided Uniswap v4 pool, paired with ETH. The launch liquidity is locked for
          good in Orynth&apos;s fee locker.
        </>
      ),
    },
    {
      title: "Get money onto Robinhood Chain",
      body: (
        <>
          In the{" "}
          <Link href="/app" className={LINK}>
            Gloam app
          </Link>
          , Bring money over moves money from other chains, or straight from an exchange, to your Robinhood Chain wallet. It
          lands as USDG. You also need a little ETH there for gas.
        </>
      ),
    },
    {
      title: "Check the address",
      body: (
        <>
          Copy the contract from{" "}
          <a href="#contract" className={LINK}>
            below
          </a>{" "}
          or from @gloamtrade on X. Anything else claiming to be $GLOAM is not ours.
        </>
      ),
    },
  ];
  return (
    <section id="get" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pb-20 sm:pb-28">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
        <SectionHead label="How to get it" title="How to get $GLOAM" />
        <div className="min-w-0">
          <ol className="divide-y divide-line border-y border-line">
            {ways.map((w, i) => (
              <li key={w.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-4 py-6">
                <span className="tnum pt-0.5 text-[14px] text-mute">{String(i + 1).padStart(2, "0")}</span>
                <div className="min-w-0">
                  <p className="text-[17px] leading-snug tracking-[-0.01em]">{w.title}</p>
                  <p className="mt-2 max-w-[62ch] text-[14.5px] leading-relaxed text-mute">{w.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
            <a href={ORYNTH_URL} target="_blank" rel="noopener noreferrer" className="gl-arrowlink">
              Orynth <span aria-hidden>↗</span>
            </a>
            <a href={DEXSCREENER_URL} target="_blank" rel="noopener noreferrer" className="gl-arrowlink">
              DEX Screener <span aria-hidden>↗</span>
            </a>
            <a href={EXPLORER_URL} target="_blank" rel="noopener noreferrer" className="gl-arrowlink">
              RobinScan <span aria-hidden>↗</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Jump links to the parts people ask about. */
const JUMPS = [
  { href: "#fees", label: "Fees" },
  { href: "#buybacks", label: "Buybacks" },
  { href: "#get", label: "How to get it" },
  { href: "#security", label: "Security" },
];

export default async function TokenPage() {
  const live = await readTokenLive();
  const { USES, QUESTIONS, PHASES, LIVE_USES, LIVE_QUESTIONS, LIVE_PHASES } = pageCopy(feePhrase(live.fees));
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          {/* The name is the hero: $GLOAM set across the foot of the field,
              with the line, the action and the launch film above it. */}
          <div className="gl-panel flex min-h-[560px] flex-col justify-between gap-12 px-5 pb-6 pt-24 sm:px-12 sm:pb-8 lg:min-h-[640px]">
            <FlowField />
            {/* first in the page outline, drawn last at the foot */}
            <h1 className="relative order-last pb-[0.04em] text-[clamp(84px,17vw,232px)] font-light leading-[0.9] tracking-[-0.045em] text-foreground">
              $GLOAM
            </h1>
            <div className="relative grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14">
              <div className="max-w-[460px] lg:pt-4">
                <p className="text-[18px] leading-relaxed text-soft sm:text-[19px]">
                  Private money is coming onchain, and $GLOAM holders get a say in
                  where it goes. Live on Robinhood Chain.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <a href={ORYNTH_URL} target="_blank" rel="noopener noreferrer" className="btn btn-ink btn-lg">
                    Get $GLOAM on Orynth
                  </a>
                  {HOLDER_VOTE ? (
                    <Link href="/vote" className="gl-arrowlink">
                      Holder votes <span aria-hidden>→</span>
                    </Link>
                  ) : (
                    <Link href="#roadmap" className="gl-arrowlink">
                      See the roadmap <span aria-hidden>→</span>
                    </Link>
                  )}
                </div>
              </div>

              <div className="gl-glass min-w-0 p-2">
                <TokenFilm />
              </div>
            </div>
          </div>
        </section>

        {/* facts */}
        <section className="mx-auto max-w-[1240px] px-6 py-20 sm:py-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[12ch]">Built to last</h2>
              <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-mute">
                $GLOAM has been live for a while. We let it sit quietly and put
                every hour into the rails first. Now the token goes to work.
              </p>
              <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[14px] text-mute">
                {JUMPS.map((j) => (
                  <a key={j.href} href={j.href} className={LINK}>
                    {j.label}
                  </a>
                ))}
              </nav>
            </div>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
              {FACTS.map((f) => (
                <div key={f.value} className="border-t border-foreground pt-5">
                  <p className="tnum text-[26px] leading-tight tracking-[-0.02em]">{f.value}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* what it does */}
        <section className="mx-auto max-w-[1400px] px-4 sm:px-7">
          <div className="gl-panel bg-surface px-5 py-14 sm:px-12 sm:py-20">
            <SealedField tone="soft" />
            <div className="relative mx-auto max-w-[1120px]">
              <p className="text-[14px] text-mute">What it does</p>
              <h2 className="t-display-l mt-4 max-w-[18ch]">Four jobs for one token</h2>

              <div className="mt-12 overflow-hidden rounded-[18px] border border-line bg-panel">
                <MainnetCopy live={<UseRows uses={LIVE_USES} />} before={<UseRows uses={USES} />} />
              </div>
            </div>
          </div>
        </section>

        <FeesSection live={live} />
        <BuybacksSection live={live} />

        {/* what holders ask */}
        <section id="questions" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pt-20 sm:pt-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <p className="text-[14px] text-mute">Questions</p>
              <h2 className="t-display-l mt-4 max-w-[12ch]">What holders ask</h2>
            </div>
            <dl className="divide-y divide-line border-y border-line">
              <MainnetCopy live={<QuestionRows questions={LIVE_QUESTIONS} />} before={<QuestionRows questions={QUESTIONS} />} />
            </dl>
          </div>
        </section>

        {/* roadmap */}
        <section id="roadmap" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 py-20 sm:py-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <p className="text-[14px] text-mute">Roadmap</p>
              <h2 className="t-display-l mt-4 max-w-[12ch]">Where $GLOAM goes from here</h2>
              <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-mute">
                Each step lands with the product, not before it.{" "}
                <MainnetCopy
                  live="Mainnet went live Wednesday 21 October, 13:00 UTC."
                  before="Mainnet goes live Wednesday 21 October, 13:00 UTC."
                />
              </p>
            </div>
            <MainnetCopy live={<PhaseList phases={LIVE_PHASES} />} before={<PhaseList phases={PHASES} />} />
          </div>
        </section>

        <SecuritySection live={live} />
        <GetSection />

        {/* contract */}
        <section id="contract" className="mx-auto scroll-mt-20 max-w-[1400px] px-4 pb-14 sm:px-7 sm:pb-20">
          <div className="theme-dark gl-panel grid grid-cols-1 gap-10 border border-line bg-background px-5 py-14 text-foreground sm:px-12 sm:py-16 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <SealedField tone="soft" />
            <div className="relative">
              <p className="text-[14px] text-mute">Contract</p>
              <h2 className="t-display-l mt-4 max-w-[14ch]">Check it yourself</h2>
              <p className="mt-5 max-w-[42ch] text-[15px] leading-relaxed text-mute">
                Always copy the address from here or from @gloamtrade on X. Anything
                else claiming to be $GLOAM is not ours.
              </p>
            </div>
            <div className="relative min-w-0">
              <CopyAddress address={GLOAM_TOKEN} />
              <ul className="mt-6 divide-y divide-line border-y border-line text-[15px]">
                {[
                  ["Network", "Robinhood Chain (4663)"],
                  ["Standard", "ERC-20, 18 decimals"],
                  ["Supply", "500,000, fixed"],
                ].map(([k, v]) => (
                  <li key={k} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4">
                    <span>{k}</span>
                    <span className="tnum text-[14px] text-mute">{v}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
                <a
                  href={EXPLORER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gl-arrowlink"
                >
                  View on the explorer <span aria-hidden>↗</span>
                </a>
                <a
                  href={ORYNTH_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gl-arrowlink"
                >
                  Trade on Orynth <span aria-hidden>↗</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* note */}
        <section className="mx-auto max-w-[1240px] px-6 pb-20 sm:pb-28">
          <p className="max-w-[72ch] text-[13px] leading-relaxed text-mute">
            No promises on price. $GLOAM is a governance and utility token. It is
            not a share in Gloam and not a claim on its revenue: buybacks are
            how Gloam uses part of its fees, not a payout to holders. Nothing here is financial advice. Read the{" "}
            <Link href="/disclosures" className="text-foreground underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-foreground">
              risk disclosures
            </Link>
            .
          </p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
