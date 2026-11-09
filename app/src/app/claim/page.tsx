"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";
import { ClaimSafetyLine } from "@/components/app/ClaimSafetyLine";
import { appClaimPath, codeFromHash, shortCodeFromHash } from "@/lib/claimLink";
import { countLinkOpened, isClaimLink } from "@/lib/funnel";
import { NETWORK_KEYS, getNetwork, isNetworkKey, type NetworkKey } from "@/lib/networks";
import { liveMainnetNames } from "@/lib/mainnet";
import { decodeNotePackage, isEncryptedPackage, paymentCodeIn } from "@/lib/notePackage";
import { inWalletBrowser } from "@/lib/passkey";
import { relayFor } from "@/lib/relay/client";
import { WALLETCONNECT_ENABLED } from "@/lib/walletConnect";
import { formatAssetLabel } from "@/lib/shield";
import { SHORT_CLAIM_PREFIX, readShortClaim } from "@gloamtrade/sdk";

/**
 * Where a claim link lands (gloam.trade/c#<code>, or the older
 * gloam.trade/claim?net=...#claim=<code>; /c renders this page). Phone
 * first: what was sent, one button into the app to claim it, and what to
 * expect. The code stays in the fragment, so it never reaches a server; this
 * page only reads it in the browser.
 */

type View =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; code: string; net: NetworkKey; amount: string | null; locked: boolean; note?: string };

/**
 * A claim view for a code, with its amount and note when the code is not locked.
 * "damaged": an unlocked code that doesn't open (cut short on the way), so the
 * page asks for the whole message instead of offering a claim that will fail.
 */
async function readyView(code: string, linkNet: NetworkKey): Promise<View | "damaged"> {
  let amount: string | null = null;
  let note: string | undefined;
  let net = linkNet;
  const locked = isEncryptedPackage(code);
  if (!locked) {
    try {
      // A short link's fields read without the commitment, so this page never
      // loads Poseidon; the claim screen works it out.
      const pack = code.startsWith(SHORT_CLAIM_PREFIX)
        ? readShortClaim(code.slice(SHORT_CLAIM_PREFIX.length))
        : await decodeNotePackage(code);
      amount = formatAssetLabel(pack.amountWei, pack.asset);
      note = pack.note;
      // A code that names its chain is on that network, whatever ?net= says (a chat app can cut it off).
      const own = pack.chainId === undefined ? undefined : NETWORK_KEYS.find((k) => getNetwork(k).chainId === pack.chainId);
      if (own) net = own;
    } catch {
      return "damaged";
    }
  }
  return { kind: "ready", code, net, amount, locked, note };
}

/** The network a link or pasted message names (?net=...), or null. */
function netIn(text: string): NetworkKey | null {
  const m = text.match(/[?&]net=([a-z-]+)/i);
  return m && isNetworkKey(m[1]) ? m[1] : null;
}

export default function ClaimPage() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [walletBrowser, setWalletBrowser] = useState(false);
  const [copied, setCopied] = useState(false);
  // The network the link names, known on every screen (the missing-payment one too).
  const [linkNet, setLinkNet] = useState<NetworkKey | null>(null);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  // Whether the Gloam relay is up on the link's network: then it pays the
  // network fee and claiming is free. Unknown (null) until it answers.
  const [relayUp, setRelayUp] = useState<boolean | null>(null);
  const readyNet = view.kind === "ready" ? view.net : null;
  // Counts the payments this page has started reading; only the newest one is
  // shown, so a slow read can never put an older payment back on screen.
  const reads = useRef(0);

  useEffect(() => {
    if (!readyNet) return;
    let live = true;
    void relayFor(getNetwork(readyNet).chainId).then((r) => {
      if (live) setRelayUp(Boolean(r?.enabled));
    });
    return () => {
      live = false;
    };
  }, [readyNet]);

  // The payment in the address bar: read on load, and again when another claim
  // link is opened in this tab. That only changes the fragment, which reloads
  // nothing, so without this the page kept showing (and claiming) the first one.
  useEffect(() => {
    let cancelled = false;
    const readLink = async () => {
      const n = ++reads.current;
      const current = () => !cancelled && n === reads.current;
      const code =
        codeFromHash(window.location.hash) ??
        (/^\/c\/?$/.test(window.location.pathname) ? shortCodeFromHash(window.location.hash) : null);
      const q = new URLSearchParams(window.location.search).get("net");
      const known = isNetworkKey(q) ? q : null;
      const net: NetworkKey = known ?? "tempo";
      const wb = inWalletBrowser();
      if (!code || !isClaimLink(code)) {
        if (current()) {
          setWalletBrowser(wb);
          setLinkNet(known);
          setView({ kind: "missing" });
        }
        return;
      }
      countLinkOpened(code, q);
      const ready = await readyView(code, net);
      if (current()) {
        setWalletBrowser(wb);
        setLinkNet(known);
        setView(ready === "damaged" ? { kind: "missing" } : ready);
      }
    };
    const onHash = () => {
      setView({ kind: "loading" });
      setCopied(false);
      setPasteError(null);
      void readLink();
    };
    void readLink();
    window.addEventListener("hashchange", onHash);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  /** A message pasted on the missing-payment screen: the whole link, or the rest of a link a chat app cut. */
  async function openPasted() {
    const code = paymentCodeIn(pasted);
    if (!isClaimLink(code)) {
      setPasteError("That doesn't look like a Gloam payment. Paste the whole message the link came in.");
      return;
    }
    setPasteError(null);
    const n = ++reads.current;
    const net = netIn(pasted) ?? linkNet ?? "tempo";
    countLinkOpened(code, net);
    setLinkNet(netIn(pasted) ?? linkNet);
    const ready = await readyView(code, net);
    if (n !== reads.current) return;
    if (ready === "damaged") {
      setPasteError("That payment code is cut off or damaged. Paste the whole message the link came in, or ask the sender to send it again.");
      return;
    }
    setView(ready);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* the address bar has it too */
    }
  }

  // The link's own network, mainnet or testnet, and no claim either way when
  // the link names none.
  const shownNet = view.kind === "ready" ? view.net : linkNet;
  const net = shownNet ? getNetwork(shownNet) : null;
  const realNet = net && !net.testnet ? net : null;

  return (
    <div className="relative flex min-h-[100svh] flex-col bg-surface text-foreground">
      <header className="mx-auto flex w-full max-w-[560px] items-center justify-between px-5 pt-6">
        <Link href="/" className="inline-flex items-center gap-2.5 text-[18px] font-medium tracking-[-0.01em]">
          <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="9" className="fill-foreground" />
            <rect x="15" y="4" width="12" height="12" rx="3.5" className="fill-surface" />
          </svg>
          Gloam
        </Link>
        {net && <span className="text-[12.5px] text-mute">{realNet ? "Mainnet" : "Testnet"}</span>}
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col px-5 pb-10 pt-8">
        {view.kind === "loading" && (
          <div className="rounded-[24px] bg-panel p-7 shadow-card">
            <div className="h-4 w-40 animate-pulse rounded bg-surface" />
            <div className="mt-5 h-12 w-56 animate-pulse rounded bg-surface" />
            <div className="mt-8 h-12 w-full animate-pulse rounded-full bg-surface" />
          </div>
        )}

        {view.kind === "missing" && (
          <div className="rounded-[24px] bg-panel p-7 shadow-card">
            <p className="t-eyebrow">Claim link</p>
            <h1 className="mt-3 text-[30px] font-light leading-[1.1] tracking-[-0.02em]">This link lost its payment on the way</h1>
            <p className="mt-4 text-[15px] leading-relaxed text-soft">
              Some chat apps cut long links short. The payment is still in the message you got: copy the whole message and
              paste it here.
            </p>
            <label htmlFor="claim-paste" className="mt-6 block text-[13px] text-mute">
              The whole message
            </label>
            <textarea
              id="claim-paste"
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setPasteError(null);
              }}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste it here"
              className="gl-input mt-1.5 h-auto resize-none px-3.5 py-3 text-[16px] leading-relaxed sm:text-[14px]"
            />
            {pasteError && (
              <p role="alert" className="mt-2 text-[13px] leading-relaxed text-danger">
                {pasteError}
              </p>
            )}
            <button
              type="button"
              disabled={!pasted.trim()}
              onClick={() => void openPasted()}
              className="btn btn-ink btn-lg btn-block mt-4"
            >
              Open the payment
            </button>
            {!pasted.trim() && <p className="mt-2 text-center text-[12.5px] text-mute">Paste the whole message first.</p>}
            <Link href="/app/vault?tab=move&mode=receive" className="btn btn-ghost btn-sm mt-3">
              Or open Gloam
            </Link>
          </div>
        )}

        {view.kind === "ready" && (
          <>
            <div className="relative overflow-hidden rounded-[24px] bg-panel p-7 shadow-card">
              <SealedField tone="soft" />
              <div className="relative">
                <p className="t-eyebrow inline-flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-sealed" aria-hidden />
                  A private payment for you
                </p>
                {view.locked ? (
                  <>
                    <h1 className="mt-4 text-[34px] font-light leading-[1.08] tracking-[-0.02em]">Someone sent you money, locked with a phrase</h1>
                    <p className="mt-3 text-[15px] leading-relaxed text-soft">
                      The sender gives you the phrase separately. You&apos;ll type it on the next screen to see the amount and claim it.
                    </p>
                  </>
                ) : view.amount ? (
                  <>
                    <h1 className="tnum mt-4 text-[44px] font-light leading-none tracking-[-0.025em]">{view.amount}</h1>
                    <p className="mt-3 text-[15px] leading-relaxed text-soft">
                      sent to you privately on {getNetwork(view.net).label}. Only you will see it once it&apos;s claimed.
                    </p>
                  </>
                ) : (
                  <>
                    <h1 className="mt-4 text-[34px] font-light leading-[1.08] tracking-[-0.02em]">Someone sent you money, privately</h1>
                    <p className="mt-3 text-[15px] leading-relaxed text-soft">Open it in Gloam to see the amount and claim it.</p>
                  </>
                )}
                {view.note && (
                  <p className="mt-4 rounded-xl bg-surface px-4 py-3 text-[14px] leading-relaxed text-soft">
                    <span className="text-mute">Their note: </span>
                    {view.note}
                  </p>
                )}
                <a href={appClaimPath(view.code, view.net)} className="btn btn-ink btn-lg btn-block mt-7">
                  Claim it
                </a>
                {relayUp !== null && <ClaimSafetyLine free={relayUp} centered className="mt-4" />}
                <p className="mt-3 text-center text-[13px] text-mute">
                  {view.net === "tempo"
                    ? "No wallet needed: sign in with a passkey on the next screen."
                    : walletBrowser
                      ? "Connect your wallet on the next screen, then tap Claim."
                      : WALLETCONNECT_ENABLED
                        ? "Connect a wallet app such as MetaMask on the next screen, then tap Claim."
                        : `You'll need a wallet app such as MetaMask or Rabby to claim on ${getNetwork(view.net).label}.`}
                </p>
              </div>
            </div>

            {view.net !== "tempo" && !walletBrowser && !WALLETCONNECT_ENABLED && (
              <div className="mt-3 rounded-[20px] bg-panel p-5 text-[14px] leading-relaxed text-soft shadow-card">
                <p className="text-foreground">On a phone?</p>
                <p className="mt-1">Open this link inside your wallet app&apos;s browser, then tap Claim it.</p>
                <button type="button" onClick={() => void copyLink()} className="btn btn-ghost btn-sm mt-3">
                  {copied ? "Copied" : "Copy this link"}
                </button>
              </div>
            )}

            <ol className="mt-8 grid gap-4 px-1">
              {[
                ["Sign in or connect a wallet", realNet ? "It takes a few seconds." : "It takes a few seconds and costs nothing on testnet."],
                ["Tap Claim", "The money moves into your private balance on this device."],
                ["It stays private", "The explorer never shows how much you hold or who paid you."],
              ].map(([t, s], i) => (
                <li key={t} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                  <span className="tnum grid h-7 w-7 place-items-center rounded-full bg-sealed-soft text-[13px] font-medium text-sealed">{i + 1}</span>
                  <span>
                    <span className="block text-[15px] text-foreground">{t}</span>
                    <span className="block text-[13.5px] leading-relaxed text-mute">{s}</span>
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-8 flex items-start gap-3 rounded-[20px] border border-line px-5 py-4 text-[13.5px] leading-relaxed text-soft">
              <span className="mt-1 shrink-0 text-sealed" aria-hidden>
                <SealDots n={3} />
              </span>
              <span>Every new person in the vault makes every payment in it harder to trace. Claiming this makes it more private for everyone, you included.</span>
            </div>
          </>
        )}

        <p className="mt-auto pt-10 text-center text-[12.5px] leading-relaxed text-mute">
          {realNet
            ? `This link is on ${realNet.label} mainnet.`
            : net
              ? "This link is on a testnet."
              : `Gloam runs on ${liveMainnetNames()}.`}{" "}
          <Link href="/docs/private-pay" className="underline underline-offset-4">
            How private payments work
          </Link>
        </p>
      </main>
    </div>
  );
}
