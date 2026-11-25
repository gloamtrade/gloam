"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { motion, useReducedMotion } from "framer-motion";
import { useModalFocus } from "@/hooks/useModalFocus";
import { useConfig, useConnect } from "wagmi";
import { WALLETCONNECT_ID, WALLET_APPS, isTouchDevice } from "@/lib/walletConnect";

const noopSubscribe = () => () => {};

type Stage =
  | { kind: "starting" }
  | { kind: "ready"; uri: string; qr: string | null }
  | { kind: "failed"; text: string };

/**
 * Connect a wallet app through WalletConnect, drawn by us instead of the
 * stock Reown modal (which sends analytics). Phone: buttons that open a
 * wallet app, which asks the person to approve. Desktop: a QR to scan with a
 * phone wallet. Closes itself once the wallet approves.
 */
export function WalletConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useConfig();
  const { connectors, connectAsync } = useConnect();
  const reduce = useReducedMotion();
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [stage, setStage] = useState<Stage>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [phone, setPhone] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  // the latest hooks values, read by the connect effect without restarting it
  const latest = useRef({ connectors, connectAsync, onClose });
  useEffect(() => {
    latest.current = { connectors, connectAsync, onClose };
  });

  const close = useCallback(() => {
    // A request nobody will approve leaves wagmi "connecting" until it
    // expires; put the button back now.
    if (pending.current) {
      pending.current = false;
      config.setState((x) => ({ ...x, status: x.current ? "connected" : "disconnected" }));
    }
    onClose();
  }, [config, onClose]);

  useEffect(() => {
    if (!open) return;
    const { connectors, connectAsync } = latest.current;
    const connector = connectors.find((c) => c.id === WALLETCONNECT_ID);
    let live = true;
    let gotUri = false;
    const touch = isTouchDevice();
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type !== "display_uri" || typeof data !== "string" || !live) return;
      gotUri = true;
      const uri = data;
      if (touch) {
        setStage({ kind: "ready", uri, qr: null });
        return;
      }
      void import("qrcode")
        .then((QR) => QR.toDataURL(uri, { margin: 1, width: 480, errorCorrectionLevel: "M" }))
        .then((qr) => live && setStage({ kind: "ready", uri, qr }))
        .catch(() => live && setStage({ kind: "ready", uri, qr: null }));
    };
    const t = window.setTimeout(() => {
      setPhone(touch);
      setStage({ kind: "starting" });
      if (!connector) {
        setStage({ kind: "failed", text: "Wallet apps are not set up here yet." });
        return;
      }
      connector.emitter.on("message", onMessage);
      pending.current = true;
      connectAsync({ connector })
        .then(() => {
          pending.current = false;
          if (live) latest.current.onClose();
        })
        .catch((e: unknown) => {
          if (!live) return;
          pending.current = false;
          const name = e instanceof Error ? e.name : "";
          const message = e instanceof Error ? e.message : "";
          setStage({
            kind: "failed",
            text:
              name === "UserRejectedRequestError"
                ? "The wallet did not approve it. Try again when you're ready."
                : /chains?/i.test(message) && /not supported|unsupported/i.test(message)
                  ? "This wallet app can't use Gloam's networks yet. Try MetaMask, which lets you add them."
                  : "Couldn't reach your wallet app. Try again.",
          });
        });
    }, 0);
    // A relay that never answers (offline, blocked, bad project id) leaves
    // the request hanging, so stop waiting for a link after a while.
    const slow = window.setTimeout(() => {
      if (live && !gotUri) setStage({ kind: "failed", text: "Couldn't reach WalletConnect. Check your connection and try again." });
    }, 15_000);
    return () => {
      live = false;
      window.clearTimeout(t);
      window.clearTimeout(slow);
      connector?.emitter.off("message", onMessage);
    };
  }, [open, attempt]);

  useModalFocus(dialog, close, { open });

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  async function copyUri(uri: string) {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* nothing to fall back to: the QR and buttons still work */
    }
  }

  if (!open || !mounted) return null;

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-[210] flex items-end justify-center outline-none sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wc-title"
    >
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={close}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        className="relative z-[1] max-h-[92dvh] w-full max-w-[420px] overflow-y-auto rounded-t-[24px] bg-panel px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 shadow-pop sm:rounded-[24px] sm:px-7 sm:pb-7"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 36 }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="wc-title" className="text-[20px] font-medium tracking-[-0.01em] text-foreground">
              {phone ? "Open your wallet app" : "Scan with your phone"}
            </h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-mute">
              {phone
                ? "Pick your wallet, approve the connection there, then come back to this tab."
                : "Open a wallet app such as MetaMask on your phone and scan this code."}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="-mr-2 -mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-5" aria-live="polite">
          {stage.kind === "starting" && (
            <div className={phone ? "grid gap-2" : "mx-auto aspect-square w-full max-w-[240px]"}>
              {phone ? (
                [0, 1, 2, 3].map((i) => <div key={i} className="h-[56px] animate-pulse rounded-2xl bg-surface" />)
              ) : (
                <div className="h-full w-full animate-pulse rounded-2xl bg-surface" />
              )}
              <span className="sr-only">Getting a connection link</span>
            </div>
          )}

          {stage.kind === "failed" && (
            <div className="rounded-2xl bg-surface px-4 py-4 text-[13.5px] leading-relaxed text-soft">
              <p>{stage.text}</p>
              <p className="mt-2 text-mute">
                {phone
                  ? "You can also open gloam.trade in your wallet app's own browser, or close this and sign in with email."
                  : "You can also use a wallet extension in this browser, or close this and sign in with email."}
              </p>
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn btn-ink btn-sm mt-3">
                Try again
              </button>
            </div>
          )}

          {stage.kind === "ready" && phone && (
            <div className="grid gap-2">
              {WALLET_APPS.map((w) => {
                const href = w.link(stage.uri);
                const web = href.startsWith("https://");
                return (
                  <a
                    key={w.id}
                    href={href}
                    {...(web ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="flex h-[56px] items-center gap-3 rounded-2xl border border-line pl-3 pr-4 text-[15px] text-foreground transition-colors hover:bg-surface"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-white ring-1 ring-line">
                      <Image
                        src={w.logo}
                        alt=""
                        width={32}
                        height={32}
                        className={w.id === "metamask" ? "h-6 w-6 object-contain" : "h-8 w-8 object-cover"}
                      />
                    </span>
                    <span className="min-w-0 flex-1">{w.name}</span>
                    <Chevron />
                  </a>
                );
              })}
              <a
                href={stage.uri}
                className="flex h-[56px] items-center gap-3 rounded-2xl pl-3 pr-4 text-[14px] text-mute transition-colors hover:bg-surface hover:text-foreground"
              >
                <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-surface text-mute">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">Another wallet app</span>
                <Chevron />
              </a>
            </div>
          )}

          {stage.kind === "ready" && !phone && (
            <div className="text-center">
              {stage.qr ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local data URL
                <img
                  src={stage.qr}
                  alt="WalletConnect code to scan with a wallet app"
                  width={240}
                  height={240}
                  className="mx-auto aspect-square w-full max-w-[240px] rounded-2xl bg-white p-2"
                />
              ) : (
                <p className="text-[13.5px] text-mute">The code didn&apos;t draw. Copy the link into your wallet app instead.</p>
              )}
              <button type="button" onClick={() => void copyUri(stage.uri)} className="btn btn-ghost btn-sm mt-4">
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          )}
        </div>

        <p className="mt-5 text-[12px] leading-relaxed text-mute">
          Your keys stay in your wallet. WalletConnect carries encrypted messages between this page and the app.
        </p>
      </motion.div>
    </div>,
    document.body
  );
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="text-faint">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
