"use client";

import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toHex } from "viem";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FlowField } from "@/components/ui/FlowField";
import {
  LEGACY_DISCLOSURE,
  decodeDisclosure,
  verifyDisclosureProof,
  type Disclosure,
} from "@/lib/disclosure";
import {
  decodeProof,
  isGloamProof,
  verifyProof,
  type AnyProof,
  type VerifyResult,
} from "@/lib/proofs";
import { ProofVerdict, amountOf, symbolOf } from "@/components/verify/ProofVerdict";
import { networkForChain } from "@/lib/proofs/chain";
import { track } from "@/lib/track";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { useMainnetLive } from "@/components/MainnetCountdown";
import { ContractsSection } from "@/components/verify/ContractsSection";
import { OwnershipStatement } from "@/components/verify/OwnershipStatement";
import { CheckMark } from "@/components/verify/VerifyBits";
import { GLOAM_OWNER } from "@/lib/contractDirectory";

type Result =
  | { kind: "idle" }
  | { kind: "checking"; step: string }
  /** An older balance disclosure: never verified, whatever its math (lib/disclosure). */
  | { kind: "legacy"; d: Disclosure }
  | { kind: "proof"; p: AnyProof; r: VerifyResult; at: number }
  | { kind: "bad"; reason: string; title?: string };

/**
 * A proof handed over in the link: `#proof=` (stays in the browser) or
 * `?proof=`. URLSearchParams turns a bare "+" into a space, and base64 never
 * has spaces, so those go back to "+".
 */
function proofFromUrl(): string | null {
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    const raw = hash.get("proof") || query.get("proof");
    return raw ? raw.trim().replace(/ /g, "+") : null;
  } catch {
    return null;
  }
}

function onUrlChange(cb: () => void) {
  window.addEventListener("hashchange", cb);
  window.addEventListener("popstate", cb);
  return () => {
    window.removeEventListener("hashchange", cb);
    window.removeEventListener("popstate", cb);
  };
}
const noProof = () => null;

/** A disclosure carries its asset as a field element; back to an address. */
function assetAddress(asset: string): string {
  try {
    return toHex(BigInt(asset), { size: 20 });
  } catch {
    return asset;
  }
}

const GITHUB = "https://github.com/gloamtrade/gloam";

type Fact = { title: string; body: string; link?: { href: string; label: string } };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** What the contracts allow, each checked against contracts/src (ShieldPoolCore, ChangeTimelock). */
const FACTS: Fact[] = [
  {
    title: "No admin withdraw",
    body: "The vault has no emergency withdraw and no function that lets anyone, the Gloam team included, take a balance out. Only a valid proof from the person who holds it can. The vault owner's one other money call sweeps native coin sent to the vault by mistake, never money behind a balance or an owed fee.",
  },
  {
    title: "Three days of public notice",
    body: "Setup is closed on every vault. A new asset, a higher limit or a higher fee must be queued on chain and waits 3 days before it can run. So must a new proof checker, on a vault the owner guard does not hold yet; on one it holds, there can be no new proof checker at all. Lowering a limit or the fee works at once.",
  },
  {
    title: "Code that cannot change",
    body: "The vault is not a proxy and has no upgrade function, so its code is fixed. Only the settings above can change, and only in public.",
  },
  {
    title: "One owner wallet, then the owner guard",
    body: `${short(GLOAM_OWNER)} owned every mainnet vault at launch. Each vault moves to the owner guard, a contract that forwards only deposit limit and fee changes and the sweep of coin sent by mistake, so it can then never get a new proof checker or a new owner. The checks above show which holds each vault. A handover takes two steps on chain: the new owner has to accept it, and a pending one shows above.`,
  },
  {
    title: "Keys from a public ceremony",
    body: "Mainnet proofs use the final keys from a trusted setup with 13 contributors, sealed with drand round 6561386.",
    link: { href: `${GITHUB}/releases/tag/ceremony-final`, label: "The ceremony-final release" },
  },
  {
    title: "The relay cannot redirect",
    body: "Private sends and cash outs can go through the Gloam relay, and swaps always do. The proofs fix where the money goes, so the relay can only submit or refuse.",
  },
  {
    title: "Open source",
    body: "Contracts, circuits, app and SDK are public. Compare what is deployed with the repo yourself.",
  },
];

/** Once mainnet is live: the deposit limits sit next to the facts above. */
const LIVE_FACTS: Fact[] = [
  ...FACTS,
  {
    title: "Deposit limits",
    body: "On mainnet each stablecoin takes up to 50,000 per deposit and 2,500,000 in total, and $GLOAM 2,500,000 and 25,000,000. Cash outs and private payments are never limited. Raising a limit waits the same three days; lowering one is instant.",
  },
];

/** What Gloam's servers do hold, said exactly (lib/recovery, lib/relay/scheduled, mcp/src/noteStore, lib/mcpRemote). */
const SERVER_HOLDS: { title: string; body: string }[] = [
  {
    title: "Recovery, if you turn it on",
    body: "An encrypted copy of your notes. The key comes from your wallet signature or your passkey, in your browser, so Gloam cannot open it.",
  },
  {
    title: "A cash out for later",
    body: "Its finished proof, until it goes out. The proof holds no secret and fixes the amount and the address, which are public once it lands.",
  },
  {
    title: "The relay",
    body: "Sees your IP address and when it sends for you. It never gets a note secret.",
  },
  {
    title: "Agents",
    body: "The local MCP server keeps an agent's notes on the machine that runs it. The hosted one at gloam.trade/mcp only reads and plans, and never takes a key.",
  },
];

/**
 * After a proof is checked: the person who opened it can make one of their
 * own. Shown under every finished result, shared link or pasted.
 */
function MakeYourOwn({ from }: { from: "link" | "page" }) {
  const live = useMainnetLive();
  return (
    <div className="gl-card mt-4 p-5 sm:p-7">
      <p className="text-[18px] leading-snug tracking-[-0.01em] text-foreground">Make your own proof</p>
      <p className="mt-1.5 max-w-[52ch] text-[14px] leading-relaxed text-mute">
        Prove you hold at least an amount, that you paid someone, or what a payroll run added up to.
        Nothing else about you shows.
      </p>
      <AppLink
        href="/app/disclose"
        onClick={() => track("verify_make_own", { from })}
        className="btn btn-ink btn-lg btn-block mt-5 sm:w-auto"
      >
        Make your own proof
      </AppLink>
      <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
        {live
          ? "Add money privately, then prove only what you choose. You can try it on testnet first."
          : "On testnet: add money privately, then prove only what you choose."}
      </p>
    </div>
  );
}

/** The result of a check, in the order it appears: working, refused, or the verdict. */
function ResultView({ result }: { result: Result }) {
  if (result.kind === "checking") {
    return (
      <div className="gl-card mt-4 p-5 sm:p-7" aria-live="polite">
        <div className="h-6 w-24 animate-pulse rounded-full bg-surface" />
        <div className="mt-5 h-9 w-3/4 animate-pulse rounded-lg bg-surface" />
        <p className="mt-4 text-[13.5px] text-mute">{result.step}…</p>
      </div>
    );
  }
  if (result.kind === "bad") {
    return (
      <div role="alert" className="mt-4 rounded-[18px] bg-danger-soft p-5 sm:p-6">
        <p className="text-[13px] font-medium text-danger">{result.title ?? "Not verified"}</p>
        <p className="mt-1.5 text-[15px] text-foreground">{result.reason}</p>
      </div>
    );
  }
  if (result.kind === "proof") return <ProofVerdict proof={result.p} result={result.r} checkedAt={result.at} />;
  if (result.kind === "legacy") {
    return (
      <div role="alert" className="mt-4 rounded-[18px] bg-warn-soft p-5 sm:p-6">
        <p className="text-[13px] font-medium text-warn">Can&apos;t confirm who holds this</p>
        <p className="tnum mt-1.5 text-[15px] text-foreground">
          {`It claims ${amountOf(result.d.amount, assetAddress(result.d.asset))} ${symbolOf(
            assetAddress(result.d.asset),
            Number(result.d.chainId)
          )} in Gloam's vault.`}
        </p>
        <p className="mt-1.5 text-[14px] leading-relaxed text-soft">{LEGACY_DISCLOSURE}</p>
      </div>
    );
  }
  return null;
}

export default function VerifyPage() {
  const urlProof = useSyncExternalStore(onUrlChange, proofFromUrl, noProof);
  const [typed, setTyped] = useState<string | null>(null);
  const token = typed ?? urlProof ?? "";
  const [result, setResult] = useState<Result>({ kind: "idle" });
  // Opened from a shared link (and not swapped for another proof): the result
  // leads the page, phone first, instead of the hero.
  const shared = Boolean(urlProof) && typed === null;
  const live = useMainnetLive();

  // Opened from a shared link: check the proof straight away.
  useEffect(() => {
    if (!urlProof) return;
    const t = window.setTimeout(() => {
      setTyped(null); // a new link replaces whatever was pasted
      void onVerify(urlProof);
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per proof in the link
  }, [urlProof]);

  /** Proof of funds, payment, exact balance and payroll total: decode, then every check in lib/proofs. */
  async function onVerifyProof(text: string) {
    setResult({ kind: "checking", step: "Reading the proof" });
    let p: AnyProof;
    try {
      p = decodeProof(text);
    } catch (e) {
      setResult({
        kind: "bad",
        title: "Could not read this proof",
        reason:
          e instanceof Error && e.message !== "Not a Gloam proof."
            ? e.message
            : "That does not look like a Gloam proof. Check that you copied all of it.",
      });
      return;
    }
    try {
      setResult({ kind: "checking", step: "Checking it against the vault" });
      const r = await verifyProof(p);
      setResult({ kind: "proof", p, r, at: Math.floor(Date.now() / 1000) });
      // Which kind and whether it held, never the proof or who it was for.
      track("proof_verified", { kind: p.kind, ok: r.ok });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setResult({
        kind: "bad",
        title: "Could not check this proof",
        reason: /not built yet/i.test(msg)
          ? "This version of the verifier cannot check this kind of proof yet. Try again after the next update."
          : msg || "Something went wrong while checking. Try again in a moment.",
      });
    }
  }

  async function onVerify(input: string = token) {
    if (isGloamProof(input)) return onVerifyProof(input);
    setResult({ kind: "checking", step: "Reading the proof" });
    let d: Disclosure;
    try {
      d = decodeDisclosure(input);
    } catch {
      setResult({ kind: "bad", reason: "That is not a valid Gloam proof." });
      return;
    }

    try {
      setResult({ kind: "checking", step: "Checking the proof" });
      const proofOk = await verifyDisclosureProof(d);
      track("proof_verified", { kind: "balance", ok: false });
      if (!proofOk) {
        setResult({ kind: "bad", reason: "The proof did not verify." });
        return;
      }
      const net = networkForChain(Number(d.chainId));
      if (!net?.pool || typeof d.pool !== "string" || net.pool.toLowerCase() !== d.pool.toLowerCase()) {
        setResult({
          kind: "bad",
          reason: "This proof points at a vault that is not Gloam's current vault, so its balance cannot be trusted.",
        });
        return;
      }
      // Every deposit publishes a valid proof of this same statement, so a
      // copy of it shows nothing about who holds the money. No chain lookup.
      setResult({ kind: "legacy", d });
    } catch (e) {
      setResult({
        kind: "bad",
        reason: e instanceof Error ? e.message : "Verification failed.",
      });
    }
  }

  const checking = result.kind === "checking";
  const finished = result.kind === "proof" || result.kind === "legacy" || result.kind === "bad";

  /** Leave the shared proof for the paste box, without the old proof in the address bar. */
  function checkAnother() {
    window.history.replaceState(null, "", "/verify");
    setTyped("");
    setResult({ kind: "idle" });
    // straight to the paste box (on a phone the section heading sits far above it)
    window.setTimeout(() => {
      const box = document.getElementById("disc");
      box?.scrollIntoView({ block: "center" });
      box?.focus({ preventScroll: true });
    }, 0);
  }

  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main>
        {shared && (
          <section className="mx-auto max-w-[680px] px-5 pb-16 pt-8 sm:pb-24 sm:pt-14">
            <p className="t-label">Shared with you</p>
            <h1 className="mt-3 text-balance text-[34px] font-light leading-[1.08] tracking-[-0.02em] sm:text-[46px]">
              A Gloam proof, checked here
            </h1>
            <p className="mt-3 max-w-[52ch] text-[15px] leading-relaxed text-soft">
              Your browser checks it against Gloam&apos;s vault on chain. Nothing is sent to Gloam, and you
              need no wallet or account.
            </p>
            <ResultView result={result} />
            {finished && <MakeYourOwn from="link" />}
            <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
              <button
                type="button"
                onClick={checkAnother}
                className="gl-arrowlink min-h-10"
              >
                Check a different proof <span aria-hidden>→</span>
              </button>
              <Link
                href="/docs/proofs"
                className="gl-arrowlink min-h-10"
              >
                How proofs work <span aria-hidden>→</span>
              </Link>
            </div>
          </section>
        )}

        {/* hero */}
        {!shared && (
          <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
            <div className="gl-panel flex min-h-[560px] flex-col justify-end px-6 pb-8 pt-24 sm:px-12 sm:pb-12 lg:min-h-[620px]">
              <FlowField />
              <div className="grid grid-cols-1 items-end gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:gap-14">
                <div className="max-w-[720px]">
                  <p className="t-label">Verify</p>
                  <h1 className="t-display-xl mt-5">Check it yourself</h1>
                  <p className="mt-6 max-w-[48ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                    Two things anyone can check without asking us: a proof someone
                    shared with you, and the contracts that hold the money. No
                    wallet, no account.
                  </p>
                  <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                    <a href="#proof" className="btn btn-ink btn-lg">
                      Verify a proof
                    </a>
                    <a href="#contracts" className="gl-arrowlink">
                      See the contracts <span aria-hidden>→</span>
                    </a>
                  </div>
                </div>

                <div className="gl-glass w-full p-2 lg:max-w-[420px] lg:justify-self-end">
                  <div className="rounded-[12px] bg-panel p-4 sm:p-5">
                    <p className="text-[13px] text-mute">What the code allows</p>
                    <ul className="mt-2 divide-y divide-line">
                      {[
                        ["Admin withdraw", "Does not exist"],
                        ["Rule changes", "3-day public notice"],
                        ["Relay", "Submit or refuse only"],
                        ["Source", "Public on GitHub"],
                      ].map(([k, v]) => (
                        <li key={k} className="flex min-h-[48px] items-center justify-between gap-4 text-[14px]">
                          <span className="text-mute">{k}</span>
                          <span className="inline-flex items-center gap-2 text-right text-foreground">
                            {v}
                            <span className="text-sealed">
                              <CheckMark size={15} />
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* verify a proof */}
        {!shared && (
          <section id="proof" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 py-20 sm:py-28">
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
              <div>
                <h2 className="t-display-l max-w-[12ch]">Verify a proof</h2>
                <p className="mt-5 max-w-[46ch] text-[16px] leading-relaxed text-mute">
                  Someone sent you a Gloam proof. Paste it here to check it: an
                  exact balance, a minimum they hold, a private payment, or the
                  total of a payroll run they paid. You see only what they chose
                  to prove, and nothing about who they are or what else they hold.
                </p>
                <ul className="mt-10 divide-y divide-line border-y border-line text-[15px]">
                  <li className="flex justify-between gap-6 py-4">
                    <span>The proof</span>
                    <span className="text-right text-mute">Checked in your browser</span>
                  </li>
                  <li className="flex justify-between gap-6 py-4">
                    <span>The vault</span>
                    <span className="text-right text-mute">Looked up on chain</span>
                  </li>
                  <li className="flex justify-between gap-6 py-4">
                    <span>Sent to Gloam</span>
                    <span className="text-right text-mute">Nothing</span>
                  </li>
                </ul>
                <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3">
                  <AppLink
                    href="/app/disclose"
                    className="gl-arrowlink"
                  >
                    Make a proof of your own <span aria-hidden>→</span>
                  </AppLink>
                  <Link
                    href="/docs/proofs"
                    className="gl-arrowlink"
                  >
                    How proofs work <span aria-hidden>→</span>
                  </Link>
                </div>
              </div>

              <div className="min-w-0">
                <div className="gl-card p-5 sm:p-7">
                  <label htmlFor="disc" className="text-[13px] text-mute">
                    Proof
                  </label>
                  <textarea
                    id="disc"
                    value={token}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="gloamfunds1:…"
                    rows={6}
                    spellCheck={false}
                    className="tnum mt-2 w-full resize-y break-all rounded-xl border border-line-strong bg-panel px-4 py-3.5 text-[16px] leading-relaxed sm:text-[14px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-foreground focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--foreground)_12%,transparent)]"
                  />
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[12.5px] text-faint">
                      Starts with gloamfunds1:, gloampay1:, gloamroll1: or gloambal1:
                    </p>
                    <button
                      type="button"
                      onClick={() => void onVerify()}
                      disabled={!token.trim() || checking}
                      className="btn btn-ink"
                    >
                      {checking ? (result as { step: string }).step + "…" : "Verify"}
                    </button>
                  </div>
                </div>

                {result.kind !== "checking" && <ResultView result={result} />}
                {finished && <MakeYourOwn from="page" />}
              </div>
            </div>
          </section>
        )}

        {/* the contracts */}
        <ContractsSection live={live} />

        {/* no middlemen */}
        <section className="mx-auto max-w-[1240px] px-6 pb-8 pt-20 sm:pt-28">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[10ch]">No middlemen</h2>
              <p className="mt-5 max-w-[34ch] text-[15px] leading-relaxed text-mute">
                {live ? (
                  <>
                    Mainnet proofs use the final keys from the trusted setup, which
                    closed on 17 October with 13 contributors, and Base Sepolia and
                    Ethereum Sepolia use them too. The Robinhood Chain and Tempo
                    testnets keep development keys. Gloam was reviewed internally
                    before launch, and Kann Audits has since reviewed the vault
                    contracts (
                    <Link href="/security" className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                      report, 1 November 2026
                    </Link>
                    ) and found no Critical, High or Medium issues.
                  </>
                ) : (
                  <>
                    Testnet proofs still use development
                    keys. The production trusted setup closed on 17 October with 13
                    contributors, and mainnet uses its final keys. It was reviewed
                    internally before launch, and Kann Audits has since reviewed the
                    vault contracts.
                  </>
                )}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
              {(live ? LIVE_FACTS : FACTS).map((f) => (
                <div key={f.title} className="border-t border-foreground pt-5">
                  <p className="flex items-center gap-2.5 text-[18px] leading-snug tracking-[-0.01em]">
                    <span className="shrink-0 text-sealed">
                      <CheckMark size={17} />
                    </span>
                    {f.title}
                  </p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{f.body}</p>
                  {f.link && (
                    <a href={f.link.href} target="_blank" rel="noreferrer" className="gl-arrowlink mt-3 min-h-10 text-[14px]">
                      {f.link.label} <ArrowUpRight />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* what Gloam can't see */}
        <section id="keys" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pt-20 sm:pt-28">
          <div className="grid grid-cols-1 gap-12 border-t border-line pt-14 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[12ch]">What Gloam can&apos;t see</h2>
              <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-soft">
                Gloam can&apos;t see or hand over a private balance. The keys that open one, your note secrets and your
                receive key, are made and kept on your device.
              </p>
              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
                <Link href="/docs/threat-model" className="gl-arrowlink min-h-10">
                  Threat model <span aria-hidden>→</span>
                </Link>
                <Link href="/docs/privacy-model" className="gl-arrowlink min-h-10">
                  What stays private <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <div>
              <p className="text-[13px] text-mute">What Gloam&apos;s servers do hold</p>
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {SERVER_HOLDS.map((h) => (
                  <li key={h.title} className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-8">
                    <span className="text-[15px] text-foreground">{h.title}</span>
                    <span className="text-[14px] leading-relaxed text-mute">{h.body}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* report a problem, and the owner's statement */}
        <section id="contact" className="mx-auto max-w-[1240px] scroll-mt-20 px-6 pb-8 pt-20 sm:pt-28">
          <div className="grid grid-cols-1 gap-12 border-t border-line pt-14 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 className="t-display-l max-w-[12ch]">Report a problem</h2>
              <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-soft">
                Found a bug or something that does not match this page? Tell us privately, and please don&apos;t post
                details until a fix ships.
              </p>
            </div>
            <div className="space-y-10">
              <ul className="divide-y divide-line border-y border-line text-[15px]">
                <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
                  <span className="text-mute">Email</span>
                  <a href="mailto:hello@gloam.trade?subject=Security" className="inline-flex min-h-10 items-center text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                    hello@gloam.trade, with Security in the subject
                  </a>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
                  <span className="text-mute">Direct message</span>
                  <a href="https://x.com/gloamtrade" target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                    @gloamtrade on X <ArrowUpRight />
                  </a>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
                  <span className="text-mute">Policy</span>
                  <a href={`${GITHUB}/blob/main/SECURITY.md#reporting-a-vulnerability`} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                    SECURITY.md <ArrowUpRight />
                  </a>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
                  <span className="text-mute">Machine-readable</span>
                  <a href="/.well-known/security.txt" className="inline-flex min-h-10 items-center text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                    security.txt
                  </a>
                </li>
              </ul>
              <div id="statement" className="scroll-mt-20">
                <p className="text-[18px] leading-snug tracking-[-0.01em] text-foreground">Signed ownership statement</p>
                <p className="mb-4 mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-mute">
                  A message from the owner key, so you can check who controls these vaults without taking our word for it.
                </p>
                <OwnershipStatement />
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
