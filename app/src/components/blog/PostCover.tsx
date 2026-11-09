import Image from "next/image";
import type { CSSProperties } from "react";
import type { PostCoverId } from "@/lib/posts";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";

/*
 * Post covers: each post's one real artifact (a payment, the pools, who sees
 * what) on the sealed field, in place of an illustration. The artifacts lay
 * out by the width of their container, not the window, so the same markup is
 * the full-size figure on the post and a scaled thumbnail on /research.
 */

/* ---------- Come build with Gloam: what a builder adds, and what they get ---------- */

const BUILD_STEPS: { name: string; line: string; sealed?: boolean }[] = [
  { name: "Your app or agent", line: "What you're building for the hackathon" },
  { name: "@gloamtrade/sdk", line: "One package. No circuits to write" },
  { name: "Private money", line: "Balances and payments only your users can see", sealed: true },
];

function BuildArt() {
  return (
    <ol className="grid w-full max-w-[860px] grid-cols-1 gap-3 @xl:grid-cols-3">
      {BUILD_STEPS.map((s, i) => (
        <li key={s.name} className="gl-glass p-2 shadow-pop">
          <div className="flex h-full flex-col rounded-[12px] bg-panel p-5">
            <p className="tnum text-[12px] text-faint">{i + 1}</p>
            <p className={`mt-2 text-[15px] ${s.sealed ? "text-sealed" : "text-foreground"}`}>{s.name}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-mute">{s.line}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------- Agents should not do business in public: one ACP job, twice ---------- */

type JobRow = { k: string; v: string; sealed?: boolean };

const JOB_PUBLIC: JobRow[] = [
  { k: "Job", v: "Client to provider" },
  { k: "Fee in escrow", v: "0.05 USDC" },
  { k: "Payout to 0x7a1f…e2c9", v: "7.00 USDC" },
  { k: "Payout to 0x5d90…41ab", v: "3.00 USDC" },
  { k: "Agent balance", v: "40.00 USDC" },
];

const JOB_GLOAM: JobRow[] = [
  { k: "Job", v: "Client to provider" },
  { k: "Fee in escrow", v: "0.05 USDC" },
  { k: "Private transfer", v: "", sealed: true },
  { k: "Private transfer", v: "", sealed: true },
  { k: "Agent balance", v: "", sealed: true },
];

function AcpArt() {
  return (
    <div className="grid w-full max-w-[860px] grid-cols-1 gap-3 @xl:grid-cols-2">
      {(
        [
          ["Paid in public", JOB_PUBLIC, false],
          ["Paid with Gloam", JOB_GLOAM, true],
        ] as const
      ).map(([name, rows, gloam]) => (
        <div key={name} className="gl-glass p-2 shadow-pop">
          <div className="h-full rounded-[12px] bg-panel p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px] text-foreground">{name}</span>
              <span className="text-[12px] text-mute">What the explorer shows</span>
            </div>
            <ul className="mt-3 divide-y divide-line">
              {rows.map((r, i) => (
                <li key={`${r.k}-${i}`} className="flex min-h-[44px] items-center justify-between gap-4 text-[14px]">
                  <span className={r.sealed ? "text-sealed" : "text-soft"}>{r.k}</span>
                  {r.sealed ? (
                    <span className="inline-flex items-center gap-2 text-[13px] text-sealed">
                      <SealDots n={4} className="text-sealed" />
                      Private
                    </span>
                  ) : (
                    <span className={`tnum ${gloam ? "text-mute" : "text-foreground"}`}>{r.v}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Agents that pay privately: one payment, checked on the way ---------- */

const AGENT_STEPS: { name: string; line: string; sealed?: boolean }[] = [
  { name: "Your agent", line: "Gets a price back: pay 2 USDG for this" },
  { name: "Agent Wormhole", line: "Checks the payment request. Only allow goes on" },
  { name: "Gloam", line: "Pays from a private balance", sealed: true },
  { name: "The service", line: "Gets paid. Nobody else sees how much, or by whom" },
];

function AgentsArt() {
  return (
    <ol className="grid w-full max-w-[1000px] grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-4">
      {AGENT_STEPS.map((s, i) => (
        <li key={s.name} className="gl-glass p-2 shadow-pop">
          <div className="flex h-full flex-col rounded-[12px] bg-panel p-5">
            <p className="tnum text-[12px] text-faint">{i + 1}</p>
            <p className={`mt-2 text-[15px] ${s.sealed ? "text-sealed" : "text-foreground"}`}>{s.name}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-mute">{s.line}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------- Live on mainnet: both pools and what each one takes ---------- */

type Asset = { symbol: string; logo: string; limit: string };

const NETWORKS: { name: string; logo: string; assets: Asset[] }[] = [
  {
    name: "Robinhood Chain",
    logo: "/brand/chains/4663.png",
    assets: [
      { symbol: "USDG", logo: "/brand/logos/usdg.png", limit: "500 / 25,000" },
      { symbol: "$GLOAM", logo: "/brand/kit/gloam-avatar-ink.png", limit: "25,000 / 250,000" },
    ],
  },
  {
    name: "Tempo",
    logo: "/brand/logos/tempo.svg",
    assets: [
      { symbol: "USDC.e", logo: "/brand/logos/usdce.png", limit: "500 / 25,000" },
      { symbol: "pathUSD", logo: "/brand/logos/pathusd.svg", limit: "500 / 25,000" },
      { symbol: "USDT0", logo: "/brand/logos/usdt0.png", limit: "500 / 25,000" },
      { symbol: "OUSD", logo: "/brand/logos/ousd.svg", limit: "500 / 25,000" },
    ],
  },
];

function MainnetArt() {
  return (
    <div className="grid w-full max-w-[820px] grid-cols-1 gap-3 @xl:grid-cols-2">
      {NETWORKS.map((n) => (
        <div key={n.name} className="gl-glass p-2 shadow-pop">
          <div className="h-full rounded-[12px] bg-panel p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-[15px] text-foreground">
                <Image src={n.logo} alt="" width={20} height={20} className="h-5 w-5 rounded-md ring-1 ring-line" />
                {n.name}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 py-1 text-[12px] font-medium text-sealed">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sealed" /> Live
              </span>
            </div>
            <div className="mt-4 flex items-center justify-between text-[12px] text-mute">
              <span>Asset</span>
              <span>Deposit limit, per deposit / total</span>
            </div>
            <ul className="mt-1 divide-y divide-line">
              {n.assets.map((a) => (
                <li key={a.symbol} className="flex min-h-[44px] items-center justify-between gap-4 text-[14px]">
                  <span className="inline-flex items-center gap-2 text-foreground">
                    <Image src={a.logo} alt="" width={18} height={18} className="h-[18px] w-[18px] rounded-full" />
                    {a.symbol}
                  </span>
                  <span className="tnum text-soft">{a.limit}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Privacy with and without an operator: who sees a payment ---------- */

const SEES: { who: string; zone: boolean; gloam: boolean }[] = [
  { who: "You", zone: true, gloam: true },
  { who: "The operator or the team", zone: true, gloam: false },
  { who: "The public", zone: false, gloam: false },
];

function SeesMark({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-foreground">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Sees it
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-mute">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Does not
    </span>
  );
}

function OperatorArt() {
  return (
    <div className="grid w-full max-w-[860px] grid-cols-1 gap-3 @xl:grid-cols-2">
      {(
        [
          ["A Tempo Zone", "zone", "Private from the public. The operator sees the whole zone."],
          ["A Gloam vault", "gloam", "Private from everyone, Gloam included. You choose who sees what."],
        ] as const
      ).map(([name, key, line]) => (
        <div key={key} className="gl-glass p-2 shadow-pop">
          <div className="h-full rounded-[12px] bg-panel p-5">
            <p className="text-[15px] text-foreground">{name}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-mute">{line}</p>
            <ul className="mt-4 divide-y divide-line">
              {SEES.map((s) => (
                <li key={s.who} className="flex min-h-[44px] items-center justify-between gap-4 text-[14px]">
                  <span className="text-soft">{s.who}</span>
                  <SeesMark on={key === "zone" ? s.zone : s.gloam} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Live on Tempo: one private payment ---------- */

function TempoArt() {
  return (
    <div className="gl-glass w-full max-w-[380px] p-2 shadow-pop">
      <div className="rounded-[12px] bg-panel p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-[13px] text-foreground">
            <Image src="/brand/logos/tempo.svg" alt="" width={20} height={20} className="h-5 w-5 rounded-md ring-1 ring-line" />
            Tempo
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 py-1 text-[12px] font-medium text-sealed">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sealed" /> Private
          </span>
        </div>
        <div className="mt-4 rounded-[12px] bg-surface p-3.5">
          <p className="text-[12px] text-mute">Send to</p>
          <p className="mt-1.5 truncate text-[15px] text-foreground">gloamr1.4tPm…q2Ks</p>
        </div>
        <div className="mt-2 rounded-[12px] bg-surface p-3.5">
          <div className="flex items-center justify-between text-[12px] text-mute">
            <span>Amount</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-panel px-2 py-0.5 text-foreground">
              <Image src="/brand/logos/pathusd.svg" alt="" width={16} height={16} className="h-4 w-4 rounded-full" />
              PathUSD
            </span>
          </div>
          <p className="tnum mt-2 text-[26px] font-light leading-none tracking-[-0.02em]">1,200</p>
        </div>
        <div className="mt-2 flex items-center justify-between px-1 py-2 text-[12px]">
          <span className="text-mute">The explorer shows</span>
          <span className="inline-flex items-center gap-1.5 text-foreground">
            Private transfer <SealDots n={4} className="text-foreground/60" />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Each artifact with the size it is drawn at as a thumbnail (its stage), so the
 * thumbnail can scale it to fit any card. Measured from the rendered artifact.
 */
const COVERS: Record<PostCoverId, { Art: () => React.JSX.Element; w: number; h: number }> = {
  acp: { Art: AcpArt, w: 860, h: 330 },
  agents: { Art: AgentsArt, w: 1040, h: 196 },
  build: { Art: BuildArt, w: 860, h: 176 },
  mainnet: { Art: MainnetArt, w: 820, h: 364 },
  operator: { Art: OperatorArt, w: 860, h: 300 },
  tempo: { Art: TempoArt, w: 380, h: 300 },
};

/**
 * size "figure": the full-size cover at the top of a post; the artifact lays out
 * for the width it gets. "feature": the same at a fixed shape, for the latest
 * post on /research. "thumb": a picture of the same cover for the cards, the
 * artifact drawn at its stage size and scaled to fit (globals.css .post-thumb).
 * Feature and thumb are decoration inside a link: the card says it all.
 */
export function PostCover({
  id,
  size = "figure",
  className = "",
}: {
  id: PostCoverId;
  size?: "figure" | "feature" | "thumb";
  className?: string;
}) {
  const { Art, w, h } = COVERS[id];
  if (size === "thumb") {
    return (
      <div aria-hidden className={`post-thumb gl-panel ${className}`}>
        <SealedField />
        <div className="post-thumb-stage @container" style={{ "--sw": w, "--sh": h } as CSSProperties}>
          <div className="flex justify-center">
            <Art />
          </div>
        </div>
      </div>
    );
  }
  if (size === "feature") {
    return (
      <div aria-hidden className={`post-feature gl-panel flex items-center justify-center p-6 sm:p-10 ${className}`}>
        <SealedField />
        <div className="@container relative flex w-full justify-center">
          <Art />
        </div>
      </div>
    );
  }
  return (
    <div className={`gl-panel flex min-h-[360px] items-center justify-center px-5 py-12 sm:min-h-[480px] sm:px-10 sm:py-16 ${className}`}>
      <SealedField drift />
      <div className="@container relative flex w-full justify-center">
        <Art />
      </div>
    </div>
  );
}
