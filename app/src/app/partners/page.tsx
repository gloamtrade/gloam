import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";
import { CodeTabs, type CodeTab } from "@/app/sdk/SdkClient";
import { EMBEDDED_WALLETS } from "@/lib/embeddedWallet";
import { LivePartnersSection } from "@/components/LivePartners";

export const metadata: Metadata = {
  title: "Partners",
  description:
    "Add private payments to your app with one API key. Set your own fee and see every payment your app brings in. Partner fees are not charged yet, on mainnet or testnet.",
  alternates: { canonical: "/partners" },
};

/* ---------- the statement: what a partner sees ---------- */

type Row = {
  kind: "private" | "public";
  title: string;
  sub: string;
  amount: string | null;
  fee: string;
};

const ROWS: Row[] = [
  { kind: "private", title: "Private payment", sub: "Robinhood Chain, 2 min ago", amount: null, fee: "$0.05" },
  { kind: "public", title: "Cash out", sub: "Tempo, 9 min ago", amount: "400 OUSD", fee: "1.00 OUSD" },
  { kind: "private", title: "Private payment", sub: "Tempo, 14 min ago", amount: null, fee: "$0.05" },
  { kind: "public", title: "Deposit", sub: "Robinhood Chain, 1 hr ago", amount: "1,000 USDG", fee: "1.00 USDG" },
];

function LockGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function EdgeGlyph({ up }: { up: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d={up ? "M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14" : "M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Statement() {
  return (
    <div className="rounded-[12px] bg-panel p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-mute">Example statement</p>
          <p className="mt-0.5 truncate text-[15px] text-foreground">Acme Pay, this week</p>
        </div>
        <span className="shrink-0 rounded-full bg-surface px-2.5 py-1 text-[12px] text-mute">Your fee</span>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {ROWS.map((r, i) => (
          <li key={i} className="flex min-h-[58px] items-center gap-3 py-2">
            <span
              aria-hidden
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                r.kind === "private" ? "bg-sealed-soft text-sealed" : "bg-surface text-soft"
              }`}
            >
              {r.kind === "private" ? <LockGlyph /> : <EdgeGlyph up={r.title === "Cash out"} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-foreground">{r.title}</span>
              <span className="block truncate text-[12px] text-mute">
                {r.amount ?? (
                  <span className="inline-flex items-center gap-1.5">
                    <SealDots n={4} className="text-sealed" label="Amount hidden" /> Amount hidden
                  </span>
                )}
                <span className="max-sm:hidden">{` · ${r.sub}`}</span>
              </span>
            </span>
            <span className="tnum shrink-0 text-right text-[14px] text-foreground">{r.fee}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between gap-3 rounded-[10px] bg-surface px-3.5 py-2.5 text-[13px]">
        <span className="text-mute">Would have earned</span>
        <span className="tnum text-foreground">$2.10</span>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-mute">
        Nothing charged yet. Fees show what your setting would earn.
      </p>
    </div>
  );
}

/* ---------- how fees work ---------- */

const FEES = [
  {
    what: "Private payments",
    how: "A flat fee per payment",
    cap: "Up to $1.00",
    why: "The amount is hidden from everyone, Gloam included, so a share of it cannot be worked out. A flat fee can.",
    sealed: true,
  },
  {
    what: "Cash outs",
    how: "A share of the amount",
    cap: "Up to 1%",
    why: "Money leaving the vault for a public wallet shows its amount on chain, so a percentage is fair and checkable.",
    sealed: false,
  },
  {
    what: "Deposits",
    how: "A share of the amount",
    cap: "Up to 1%",
    why: "Money entering the vault is public too. Many partners leave this at zero so adding money stays free.",
    sealed: false,
  },
];

const STEPS = [
  {
    title: "Get a key",
    body: EMBEDDED_WALLETS
      ? "Sign in with your wallet or email, name your app, and make an API key. It is shown once; we keep only a fingerprint of it."
      : "Sign in with your wallet, name your app, and make an API key. It is shown once; we keep only a fingerprint of it.",
  },
  {
    title: "Set your fee",
    body: "Pick a flat fee for private payments and a share of cash outs and deposits. Change it any time; new payments use the new setting.",
  },
  {
    title: "Earn on every payment",
    body: "Send your users' payments through the Gloam API with your key. Each one is counted to you, live, with the fee it carries.",
  },
];

const CURL = `curl https://gloam.trade/api/v1/relay \\
  -H "Authorization: Bearer $GLOAM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "chainId": 46630,
    "action": "transfer",
    "proof": "0x…", "root": "0x…", "nullifier": "0x…",
    "commitments": ["0x…", "0x…"]
  }'`;

const SDK = `import { GloamApiClient, buildPrivateSendIntent } from "@gloamtrade/sdk";

const gloam = new GloamApiClient({ apiKey: process.env.GLOAM_API_KEY! });

// Build the private payment as usual, then relay it with your key.
const send = await buildPrivateSendIntent({ /* note, amounts, path, prover */ });
const { hash, attribution } = await gloam.relay(send);

// attribution.activity.feeUsd is the fee this payment carries for you.`;

const RESPONSE = `{
  "v": 1,
  "ok": true,
  "data": {
    "hash": "0x9c1e…",
    "network": "robinhood",
    "action": "transfer",
    "attribution": {
      "recorded": true,
      "kind": "private_payment",
      "activity": { "feeUsd": 0.05, "feeBasis": "$0.05 per private payment" }
    },
    "charged": false
  },
  "requestId": "req_5e0c2a91d4b7f310"
}`;

const TABS: CodeTab[] = [
  { id: "sdk", label: "SDK", file: "pay.ts", code: SDK },
  { id: "curl", label: "curl", file: "relay.sh", code: CURL, lang: "bash" },
  { id: "res", label: "Response", file: "200 OK", code: RESPONSE, lang: "json" },
];

export default function PartnersPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          {/* The promise runs the full width in two lines; the how and the
              statement it earns sit under it, side by side. */}
          <div className="gl-panel flex min-h-[560px] flex-col justify-end gap-10 px-5 pb-8 pt-24 sm:px-12 sm:pb-12 lg:min-h-[640px] lg:gap-14">
            <FlowField />
            <div className="relative">
              <p className="text-[15px] text-mute">Partner program</p>
              <h1 className="t-display-xl mt-4">
                <span className="sm:block">Add privacy to your app.</span>{" "}
                <span className="text-soft sm:block">Earn on every payment.</span>
              </h1>
            </div>
            <div className="relative grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-14">
              <div className="max-w-[520px]">
                <p className="text-[16px] leading-relaxed text-soft sm:text-[17px]">
                  Give your users private payments with one API key. You set your
                  own fee, and every payment your app brings in is counted to you
                  as it happens.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Link href="/partners/dashboard" className="btn btn-ink btn-lg">
                    {EMBEDDED_WALLETS ? "Connect wallet" : "Sign in with your wallet"}
                  </Link>
                  {EMBEDDED_WALLETS && (
                    <Link href="/partners/dashboard?with=email" className="btn btn-ghost btn-lg">
                      Sign in with email
                    </Link>
                  )}
                  <Link href="/docs/partners" className="gl-arrowlink">
                    Read the API docs <span aria-hidden>→</span>
                  </Link>
                </div>
              </div>

              <div className="gl-glass w-full p-2">
                <Statement />
              </div>
            </div>
          </div>
        </section>

        {/* partners already live */}
        <LivePartnersSection />

        {/* how it works */}
        <section className="mx-auto max-w-[1240px] px-6 py-20 sm:py-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[12ch]">How it works</h2>
              <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-mute">
                Your users keep their own keys and their own money. Your app sends
                their already-proven payments through the Gloam relay with your
                key, and that is how a payment becomes yours.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.title} className="border-t border-foreground pt-5">
                  <p className="text-[18px] leading-snug tracking-[-0.01em]">{s.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* what you can charge */}
        <section id="fees" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 sm:px-7">
          <div className="gl-panel bg-surface px-5 py-14 sm:px-12 sm:py-20">
            <SealedField tone="soft" />
            <div className="relative mx-auto max-w-[1120px]">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-[640px]">
                  <p className="text-[14px] text-mute">Your fee</p>
                  <h2 className="t-display-l mt-4">What you can charge, and why</h2>
                  <p className="mt-5 max-w-[54ch] text-[16px] leading-relaxed text-mute">
                    Fees follow what the chain can see. You are paid in the same
                    token your user moved, to the payout address you choose for
                    each network.
                  </p>
                </div>
              </div>

              <div className="mt-12 overflow-hidden rounded-[18px] border border-line bg-panel">
                {FEES.map((f) => (
                  <div
                    key={f.what}
                    className="grid grid-cols-1 gap-3 border-b border-line px-5 py-5 last:border-0 sm:grid-cols-[1fr_1fr_1.6fr] sm:items-center sm:gap-6 sm:px-7"
                  >
                    <p className="flex items-center gap-2.5 text-[16px] text-foreground">
                      <span
                        aria-hidden
                        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${
                          f.sealed ? "bg-sealed-soft text-sealed" : "bg-surface text-soft"
                        }`}
                      >
                        {f.sealed ? <LockGlyph size={11} /> : <EdgeGlyph up={f.what === "Cash outs"} />}
                      </span>
                      {f.what}
                    </p>
                    <p className="text-[15px] text-foreground">
                      {f.how}
                      <span className="ml-2 text-[13px] text-mute">{f.cap}</span>
                    </p>
                    <p className="text-[14px] leading-relaxed text-mute">{f.why}</p>
                  </div>
                ))}
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-[18px] bg-panel p-6 sm:p-7">
                  <p className="text-[16px] text-foreground">Partner fees are not charged yet</p>
                  <p className="mt-2 text-[14px] leading-relaxed text-mute">
                    Gloam is live on mainnet, and the testnet stays open for
                    practice. On both, your portal counts every payment your
                    key brings in and shows the fee your setting would have
                    earned, labeled as such. No partner fee is taken from
                    anyone. Use a live key (gloam_live_) on mainnet and a test
                    key (gloam_test_) on testnet.
                  </p>
                </div>
                <div className="rounded-[18px] bg-panel p-6 sm:p-7">
                  <p className="text-[16px] text-foreground">Real partner fees come later</p>
                  <p className="mt-2 text-[14px] leading-relaxed text-mute">
                    Taking a fee for real needs a fee output inside the
                    zero-knowledge circuits and the vault contract, so the fee
                    is paid by the proof itself and nobody can skip it. The
                    mainnet pools do not have one yet. The only fee on mainnet
                    today is Gloam&apos;s own 0.5% on cash outs.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* code */}
        <section className="mx-auto max-w-[1400px] px-4 py-14 sm:px-7 sm:py-20">
          <div className="theme-dark gl-panel grid grid-cols-1 gap-12 border border-line bg-background px-5 py-14 text-foreground sm:px-12 sm:py-20 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <SealedField tone="soft" />
            <div className="relative">
              <p className="text-[14px] text-mute">The API</p>
              <h2 className="t-display-l mt-4 max-w-[14ch]">One call per payment</h2>
              <p className="mt-5 max-w-[46ch] text-[16px] leading-relaxed text-mute">
                Your users prove their payments in their own browser or agent.
                You relay them with your key. The relay checks each proof before
                sending, and it can only submit or refuse a payment, never
                redirect it.
              </p>
              <ul className="mt-10 divide-y divide-line border-y border-line text-[15px]">
                {[
                  ["Relay a payment or cash out", "POST /api/v1/relay"],
                  ["Count a deposit your app made", "POST /api/v1/deposits"],
                  ["Check a proof", "POST /api/v1/proofs/verify"],
                  ["Your volume and fees", "GET /api/v1/activity"],
                ].map(([k, v]) => (
                  <li key={k} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4">
                    <span>{k}</span>
                    <span className="text-[13.5px] text-mute">{v}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/docs/partners"
                className="gl-arrowlink mt-8"
              >
                Full API reference <span aria-hidden>→</span>
              </Link>
            </div>
            <div className="relative min-w-0">
              <CodeTabs tabs={TABS} />
            </div>
          </div>
        </section>

        {/* what we keep */}
        <section className="mx-auto max-w-[1240px] px-6 pb-20 sm:pb-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[12ch]">What we keep about your users</h2>
              <div className="mt-8">
                <Link href="/partners/dashboard" className="btn btn-ink">
                  Open the portal
                </Link>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
              {[
                {
                  title: "Per payment",
                  body: "The network, the kind (private payment, cash out or deposit), the transaction hash and the time. That is what your volume and fees are counted from.",
                },
                {
                  title: "Amounts only when public",
                  body: "Deposits and cash outs already show their token and amount on chain, so those are kept. A private payment's amount is never known to us.",
                },
                {
                  title: "Never",
                  body: "Notes, secrets, balances, or who received a private payment. Your API key itself is never stored, only a keyed fingerprint of it.",
                },
                {
                  title: "Your account",
                  body: "Your wallet address, app name, website, fee setting and payout addresses. Sign-in is a free signature; it moves no money.",
                },
              ].map((t) => (
                <div key={t.title} className="border-t border-foreground pt-5">
                  <p className="text-[18px] leading-snug tracking-[-0.01em]">{t.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{t.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
